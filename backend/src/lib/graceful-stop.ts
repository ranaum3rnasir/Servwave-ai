/**
 * The server's stop signal (#2991). When the hosting platform stops the process (SIGTERM on a deploy or restart, or
 * SIGINT from a terminal), background work that checks `stopRequested()` stops at its next safe point and finishes
 * its own end step, and only then does the process end, the same way it always did: by the signal it received.
 *
 * The Spider sweep (services/spider/sweep.ts) stops between two per-lead alerts, releases the claims it has not reached
 * and writes the records of the alerts it sent, so a deploy no longer leaves claimed leads that were never alerted. The
 * Spider check (services/spider/tick.ts) claims nothing more, and still sends the emails and texts of the alerts it
 * already shows while the bounded wait has time left (stopTimeLeftMs); only what cannot fit is recorded interrupted, and
 * just before the wait ends (onStopTimeLeft) it stops waiting on a send still on its way and records the rest at once.
 *
 * Nothing else about shutdown changes: no work is drained except what `finishing` waits for, and the wait is bounded.
 * When nothing is running the process ends at once. A second signal while waiting ends it at once too (the default
 * action, since the handler is removed on the first).
 */
import { logger } from './logger';

/**
 * The platform waits about 30 s after SIGTERM before it kills the process. 25 s leaves room for the process to end on
 * its own first: a per-lead alert is a few seconds at most (each staff text is bounded at 10 s, #2995) and the
 * sweep's end step is a handful of single statements.
 */
export const STOP_WAIT_MS = 25_000;

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
type StopSignal = (typeof SIGNALS)[number];

let requested = false;
/** When the bounded wait after the stop request ends (ms), the moment the process ends at the latest. */
let stopDeadline = Infinity;

/** True once the process has been told to stop. No query; background work checks it at its safe points. */
export function stopRequested(): boolean {
  return requested;
}

/**
 * How long the process still has before the bounded wait after the stop request ends (ms, never below 0); Infinity while
 * no stop is requested. Work that may finish inside the budget (the Spider check's emails and texts of alerts already
 * shown) asks this instead of stopping at once.
 */
export function stopTimeLeftMs(): number {
  return requested ? Math.max(0, stopDeadline - Date.now()) : Infinity;
}

/** Work waiting for the end of the bounded wait (onStopTimeLeft): each is called once, when `ms` of it is left. */
interface StopWatcher {
  ms: number;
  fn: () => void;
  timer?: NodeJS.Timeout;
}
const stopWatchers = new Set<StopWatcher>();

/**
 * Calls `fn` once a stop is requested and at most `ms` of its bounded wait is left (at once when that is already so),
 * never while no stop is requested. Returns the cancel, which the caller runs when its work is done, so a watcher never
 * outlives it. The timer never keeps the process alive.
 */
export function onStopTimeLeft(ms: number, fn: () => void): () => void {
  const watcher: StopWatcher = { ms, fn };
  stopWatchers.add(watcher);
  if (requested) armWatcher(watcher);
  return () => {
    clearTimeout(watcher.timer);
    stopWatchers.delete(watcher);
  };
}

function armWatcher(watcher: StopWatcher): void {
  watcher.timer = setTimeout(() => {
    stopWatchers.delete(watcher);
    watcher.fn();
  }, Math.max(0, stopDeadline - watcher.ms - Date.now()));
  watcher.timer.unref();
}

/**
 * Marks the process as stopping (the signal handler does this, with its bounded wait; tests call it directly). The first
 * request sets the budget; a later one changes nothing.
 */
export function requestStop(waitMs: number = STOP_WAIT_MS): void {
  if (requested) return;
  requested = true;
  stopDeadline = Date.now() + waitMs;
  for (const watcher of stopWatchers) armWatcher(watcher);
}

/** Test-only: forget an earlier stop request, and every watcher still waiting for one. */
export function _resetStopRequest(): void {
  requested = false;
  stopDeadline = Infinity;
  for (const watcher of stopWatchers) clearTimeout(watcher.timer);
  stopWatchers.clear();
}

/** The part of `process` the handler uses (a test passes its own). */
export interface StopProcess {
  pid: number;
  on(signal: StopSignal, fn: (signal: StopSignal) => void): unknown;
  removeListener(signal: StopSignal, fn: (signal: StopSignal) => void): unknown;
  kill(pid: number, signal: StopSignal): unknown;
}

/**
 * Installs the handler once, where the server starts (index.ts). On the first SIGTERM or SIGINT: the stop is
 * requested, the handler waits for `finishing` (or `maxWaitMs`, whichever comes first), and the same signal is raised
 * again with no handler left, so the process ends by the signal's default action, as it did before this handler.
 */
export function installStopSignals(opts: {
  finishing: () => Promise<unknown>;
  maxWaitMs?: number;
  proc?: StopProcess;
}): void {
  const proc = opts.proc ?? (process as unknown as StopProcess);
  const maxWaitMs = opts.maxWaitMs ?? STOP_WAIT_MS;
  const onSignal = (signal: StopSignal) => {
    for (const s of SIGNALS) proc.removeListener(s, onSignal);
    requestStop(maxWaitMs);
    logger.info(`[shutdown] ${signal} received - letting work in progress finish, at most ${maxWaitMs / 1000} s`);
    let timer: NodeJS.Timeout | undefined;
    const timeUp = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), maxWaitMs);
    });
    const finished = Promise.resolve()
      .then(opts.finishing)
      .then(
        () => 'finished' as const,
        () => 'finished' as const,
      );
    void Promise.race([finished, timeUp]).then((how) => {
      if (timer) clearTimeout(timer);
      if (how === 'timeout') logger.warn(`[shutdown] work in progress did not finish within ${maxWaitMs / 1000} s - stopping anyway`);
      proc.kill(proc.pid, signal);
    });
  };
  for (const s of SIGNALS) proc.on(s, onSignal);
}

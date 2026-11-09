/*
 * Runs one child process under watch: stops it (its whole process group) when the stall rule fires, a deadline passes, the private
 * server dies or the run is cancelled, and tells the caller which of those happened. The decision about what a result MEANS is
 * results.ts; this only watches and kills.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { checkStall, parseEvents, type DbEvent, type Stall } from './results';

export type Ended = 'exit' | 'stall' | 'deadline' | 'server-died' | 'cancelled';

export interface Supervised {
  code: number | null;
  signal: NodeJS.Signals | null;
  ended: Ended;
  stall?: Stall;
  /** Every event the child wrote while it ran, in order. */
  events: DbEvent[];
}

export interface SuperviseOptions {
  cmd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The file the child's reporter and lane setup append events to. */
  eventsFile: string;
  /** 0 turns the stall rule off (a phase with no test files). */
  stallMs?: number;
  /** Milliseconds from now after which the child is stopped. */
  deadlineMs?: number;
  serverAlive?: () => boolean;
  cancelled?: () => boolean;
  pollMs?: number;
  /** How long a stopped child gets to leave on SIGTERM before SIGKILL. */
  graceMs?: number;
  /** Called with the child's pid right after it started, and with undefined when it ended (so a cancel can reach it). */
  onChild?: (pid: number | undefined) => void;
}

/** Reads the lines appended to a file since the last call, starting from what the file holds now. */
function tailer(file: string): () => DbEvent[] {
  let offset = existsSync(file) ? statSync(file).size : 0;
  let partial = '';
  return () => {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    if (size <= offset) return [];
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = partial + buf.toString('utf8');
      const cut = text.lastIndexOf('\n');
      partial = cut < 0 ? text : text.slice(cut + 1);
      return parseEvents(cut < 0 ? '' : text.slice(0, cut));
    } finally {
      closeSync(fd);
    }
  };
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export function supervise(o: SuperviseOptions): Promise<Supervised> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const read = tailer(o.eventsFile);
    const events: DbEvent[] = [];
    let ended: Ended = 'exit';
    let stall: Stall | undefined;
    let stopping = false;
    const child = spawn(o.cmd, [...o.args], { cwd: o.cwd, env: o.env, stdio: 'inherit', detached: true });
    o.onChild?.(child.pid);

    const stop = (why: Ended) => {
      if (stopping) return;
      stopping = true;
      ended = why;
      if (child.pid) {
        signalGroup(child.pid, 'SIGTERM');
        setTimeout(() => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); }, o.graceMs ?? 5_000).unref();
      }
    };

    const poll = setInterval(() => {
      events.push(...read());
      if (stopping) return;
      if (o.cancelled?.()) return stop('cancelled');
      if (o.serverAlive && !o.serverAlive()) return stop('server-died');
      if (o.deadlineMs !== undefined && Date.now() - startedAt > o.deadlineMs) return stop('deadline');
      if (o.stallMs) {
        const s = checkStall(events, Date.now(), startedAt, o.stallMs);
        if (s) {
          stall = s;
          stop('stall');
        }
      }
    }, o.pollMs ?? 1_000);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearInterval(poll);
      o.onChild?.(undefined);
      events.push(...read());
      // Whatever is left of the child's group (a worker that outlived its parent) goes with it.
      if (child.pid) signalGroup(child.pid, 'SIGKILL');
      resolve({ code, signal, ended, stall, events });
    };
    child.on('error', () => finish(null, null));
    child.on('close', finish);
  });
}

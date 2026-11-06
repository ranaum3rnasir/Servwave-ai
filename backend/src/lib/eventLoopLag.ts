import { performance } from 'perf_hooks';

// How long the event loop was last blocked, measured by a timer that fires every 250 ms and notes how late it ran.
//
// A blocked event loop cannot answer anything, /health included, so "the loop is blocked" can only be reported by
// the first answer after it. A timer that is due while the loop is blocked runs as soon as the loop is free, and
// before any request that arrived meanwhile is handled (timers run ahead of I/O in the event loop), so by the time
// /health answers, the lateness of the block is already recorded.
//
// Lateness under-reads a block by at most one interval (the block began part-way through a wait), so the limit is a
// block of "about 2 s", not exactly 2 s.

/**
 * A block longer than this makes /health fail. 2 s: a healthy server never stops for more than tens of milliseconds
 * (a garbage collection, one big JSON parse), a user sees a frozen app long before 2 s, and the platform's own check
 * gives up on a silent server at 5 s, so a block this long is reported while there is still time to say so.
 */
export const EVENT_LOOP_LAG_LIMIT_MS = 2000;

const SAMPLE_INTERVAL_MS = 250;

let lastLagMs = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Start measuring. Safe to call again: it starts once. The timer never keeps the process alive. */
export function startEventLoopLagProbe(): void {
  if (timer) return;
  let expectedAt = performance.now() + SAMPLE_INTERVAL_MS;
  timer = setInterval(() => {
    const now = performance.now();
    lastLagMs = Math.max(0, now - expectedAt);
    expectedAt = now + SAMPLE_INTERVAL_MS;
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
}

/** True when the last measured lateness is over the limit. */
export function eventLoopWasBlocked(): boolean {
  return lastLagMs > EVENT_LOOP_LAG_LIMIT_MS;
}

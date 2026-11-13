/**
 * How much of a company's per-lead alert backlog one Spider sweep run takes on (#2991). The one place these limits
 * live: they are not company settings.
 *
 * - At most SPIDER_ALERTS_PER_COMPANY_RUN per-lead alerts per company per run. The run claims only that many (the
 *   ones overdue longest, sweep.ts pickThisRun), so it never holds a claim for a lead it will not reach. The rest stay
 *   unclaimed and the next run, 2 minutes later, takes the next batch.
 * - At most SPIDER_COMPANY_RUN_MS per company, counted from the start of the company's turn: once it has passed, the
 *   run stops before the company's next per-lead alert, never in the middle of one, and releases the claims it has
 *   not reached. The first alert of a turn always goes, so a slow company still moves forward every run.
 *
 * Neither limit touches the starting summary: it is one message covering every overdue lead and is never split
 * (Ran, 3 Nov).
 */
import { performance } from 'perf_hooks';

/** Per-lead alerts one run sends for one company, at most. */
export const SPIDER_ALERTS_PER_COMPANY_RUN = 100;

/**
 * The flood guard's window (#2991): at most SPIDER_ALERTS_PER_COMPANY_RUN per-lead alerts per company in any window this long,
 * counted across the check (tick.ts) and the sweep (sweep.ts) together, whoever sent them. Both count the company's ALERTED
 * rows in the window, so the guard is one rule, never one budget each (#3471).
 */
export const FLOOD_WINDOW_MS = 2 * 60_000;

/** How long one run spends on one company before it stops between alerts. */
export const SPIDER_COMPANY_RUN_MS = 45_000;

const realClock = () => performance.now();
let clock: () => number = realClock;

/** Milliseconds on a monotonic clock, for the per-company time limit. */
export function spiderRunClock(): number {
  return clock();
}

/** Test-only: a clock the test moves itself, so a case can pass the time limit without waiting. No argument restores it. */
export function _setSpiderRunClock(fn?: () => number): void {
  clock = fn ?? realClock;
}

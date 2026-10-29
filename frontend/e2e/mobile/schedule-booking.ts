/**
 * Where a gate fixture books its visits on the Schedule (mobile slice 75 follow-up 2, and slice 85).
 *
 * The whole gate shares ONE throwaway org and ONE technician. Some specs build a record of their
 * own for each device (a sent estimate to sign, a scheduled job to work, an estimate to edit), and
 * each of those used to book its walkthrough (and job) a day or two ahead, on the SAME board the
 * Schedule checks measure. Across a full sweep (15 devices, retries, repeats) that piled 26 to 43
 * walkthroughs into one day column, so the last 20 px wide cards stuck 1 to 3 px past a 360 px
 * screen: the double-booked self-check (schedule-double-booked.spec.ts) went red on the Fold cover
 * and Firefox for a reason that had nothing to do with the page.
 *
 * The rule now, in two parts:
 *   - 'board': the records `seedGateFixtures` creates once per run. They are the Schedule's fixed
 *     set: four walkthroughs tomorrow, all at the same time (the four-at-once case), and three
 *     jobs the day after, all at the same time. Nothing else is ever booked on the days the
 *     Schedule specs look at.
 *   - 'apart': every record a spec builds for itself. It is booked on a day of its own, more than a
 *     year ahead, which no calendar step (a day, a week, or the four steps the self-check takes)
 *     reaches. Apart is the DEFAULT of `sentEstimate` and `scheduledJob`, so a new spec cannot pile
 *     onto the shared board by forgetting to ask.
 *
 * And the board is booked at a FIXED HOUR of the org's day (slice 85), not "24 hours from now".
 * The Schedule opens on 06:00 to 19:00 and scrolls its time grid to 06:00 a moment after it
 * paints. Booked relative to the moment of seeding, the set sat wherever the clock was: a run at
 * 03:00 put the four walkthroughs above 06:00, scrolled out of the grid but, in the page's
 * coordinates, under the toolbar's buttons (the targets check counted the toolbar as crowding
 * them, and then the scrollReach check moved the grid and nothing was crowded any more); a run at
 * 23:00 put them past the evening edge of the grid, and the self-check found no four-at-once case
 * at all (measured, slice 85). The self-check passed by day and failed by night. Now every run, at any hour, meets the same set in
 * the same place: tomorrow and the day after, mid-morning, well inside the hours the page opens on.
 *
 * Pure data and arithmetic, no browser: the Vitest guard `src/__tests__/mobile-gate-schedule-booking.test.ts`
 * holds the rule from the outside (every hour of the day, a clock change, a date-line; no spec asks
 * for 'board', no spec books a visit itself).
 */

export type Booking = 'board' | 'apart';

/**
 * Where on the board a record sits: a number of days after today by the ORG's calendar (not the
 * machine's), at a whole wall-clock hour of the ORG's day.
 */
export interface BoardSlot { daysAhead: number; hour: number }

/** The four-at-once walkthroughs: tomorrow, 09:00 (the org's clock). */
export const BOARD_WALKTHROUGH_SLOT: BoardSlot = { daysAhead: 1, hour: 9 };
/** The three jobs: the day after tomorrow, 09:00 (the org's clock), two hours long. */
export const BOARD_JOB_SLOT: BoardSlot = { daysAhead: 2, hour: 9 };
/** A job is two hours long. */
export const JOB_LENGTH_HOURS = 2;

/** The Schedule's own fallback when the org has no timezone of its own (`DEFAULT_SCHEDULE_TIMEZONE`). */
export const BOARD_TIMEZONE_FALLBACK = 'America/New_York';

/** Days ahead of a record booked 'apart': past a month view stepped four times, a year of weeks. */
export const APART_DAYS = 420;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The wall clock of `instant` in `timeZone`, as the number of milliseconds it would be if it were UTC. */
function wallClockAsUtcMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

/** The instant at which the wall clock of `timeZone` reads year-month-day hour:00 (month is 1 to 12). */
export function instantAtWallClock(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetAt = (guess: number) => wallClockAsUtcMs(new Date(guess), timeZone) - Math.floor(guess / 1000) * 1000;
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess); // twice: the first guess may sit across a clock change
  return new Date(guess);
}

/**
 * When a record is booked. 'board': `slot.daysAhead` days after TODAY in `timeZone`, at `slot.hour`
 * o'clock there, whatever hour `now` is. 'apart': a day of its own, more than a year ahead (the hour
 * does not matter, nothing reaches it).
 */
export function bookedAt(booking: Booking, slot: BoardSlot, timeZone: string, now: Date = new Date()): Date {
  if (booking === 'apart') return new Date(now.getTime() + (APART_DAYS + slot.daysAhead) * DAY_MS);
  const today = new Date(wallClockAsUtcMs(now, timeZone));
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + slot.daysAhead));
  return instantAtWallClock(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), slot.hour, timeZone);
}

/** When a job booked at `start` ends. */
export function jobEnd(start: Date): Date {
  return new Date(start.getTime() + JOB_LENGTH_HOURS * HOUR_MS);
}

/** Walkthroughs `seedGateFixtures` books on the board: the four-at-once case (all at one time). */
export const BOARD_WALKTHROUGHS = 4;
/** Jobs it books on the board (the paid, the open and the scheduled one). */
export const BOARD_JOBS = 3;

/**
 * The Schedule specs' promise about what is on the calendar. The self-check needs at least the
 * four-at-once case on screen; it also fails, with an explanation, if more than `MAX_CARDS_ON_SCREEN`
 * overlapping cards are on screen, because that means a spec is booking onto the shared board again.
 * The ceiling is the fixed set (4 walkthroughs, and 3 jobs when the week view shows both days) plus
 * the few short-lived cards other specs put on today's column while they run (at most one per other
 * worker: the run has 4 workers) and two cards of slack.
 */
export const FOUR_AT_ONCE = 4;
export const MAX_CARDS_ON_SCREEN = BOARD_WALKTHROUGHS + BOARD_JOBS + 3 + 2;

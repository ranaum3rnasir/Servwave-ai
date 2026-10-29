/**
 * The Schedule's double-booked cards: the one narrow, documented exception to the mobile gate on
 * the Schedule page (`acceptedExceptions.scheduleDoubleBooked` in allowlist.json).
 *
 * Ran decided on 2026-10-08 (Option A) that double-booked jobs stay side by side in one day
 * column. With four or more at the same time each card is narrower than the 24 px touch-target
 * floor and the later cards cover the earlier ones. Everything else on the Schedule is enforced.
 *
 * What is excused, and only this:
 *   - `targets`: an "under 24px and crowded" offender that IS or sits INSIDE a time-grid event card
 *     that overlaps in time with another event card in the same day column;
 *   - `a11y`: an axe `target-size` NODE that is such a card (or inside one); the rest of the rule's
 *     nodes, and every other rule, still fail;
 *   - `scrollReach`: "the last control is covered by X" where the last control is a time-grid event
 *     card and X is (or sits inside) ANOTHER card that overlaps it in time.
 * Not excused: a lone card (nothing overlaps it), a toolbar button, the view switcher, filters, date
 * navigation, the all-day row, a popover, a primary-control (44 px) miss, an off-screen control, a
 * covering element that is not an event card.
 *
 * How a card is recognised: structurally, by the calendar's own markup. A time-grid event card is
 * a `.rbc-event` inside a `.rbc-day-slot` (the day column). The all-day row and the month grid draw
 * their events in `.rbc-row-segment`s, outside any `.rbc-day-slot`, so they never match. Two cards
 * overlap in time when they sit in the same day column and their vertical extents intersect: the
 * calendar places a card from its start time down by its duration, and a time is a vertical position
 * in the column, so a shared vertical stretch is a shared stretch of time. Cards that merely touch
 * (one ends where the next starts) do not overlap.
 *
 * This file is pure data in, data out (no browser, no Playwright), so the Vitest guard
 * `src/__tests__/mobile-gate-schedule-double-booked.test.ts` can try every case both ways. The page
 * functions that collect the data (`scheduleCardProbe` and the `offenderCard` / `cover` fields of
 * targetsCheck and scrollReachCheck) are in checks.ts.
 */

/** A time-grid event card: the calendar's own markup. Used in the page, so it is a plain string. */
export const SCHEDULE_CARD_SELECTOR = '.rbc-day-slot .rbc-event';
/** A day column of the time grid. */
export const SCHEDULE_COLUMN_SELECTOR = '.rbc-day-slot';

/** Where one event card sits: its day column and its vertical extent, in CSS pixels. */
export interface CardFact {
  /** Index of the card's day column among the page's `.rbc-day-slot` elements. */
  column: number;
  top: number;
  bottom: number;
  /** A card with no size (display none, collapsed) is not on screen and overlaps nothing. */
  width: number;
  height: number;
}

/** Vertical overlap under this many pixels is layout rounding, not a shared stretch of time. */
const MIN_SHARED_PX = 1;

/** True when cards `a` and `b` (indexes into `cards`) are different cards that overlap in time. */
export function overlapInTime(cards: readonly CardFact[], a: number, b: number): boolean {
  if (a === b) return false;
  const x = cards[a];
  const y = cards[b];
  if (!x || !y) return false;
  if (x.width <= 0 || x.height <= 0 || y.width <= 0 || y.height <= 0) return false;
  if (x.column !== y.column) return false;
  return Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > MIN_SHARED_PX;
}

/** True when card `i` overlaps in time with at least one other card in its day column. */
export function isDoubleBooked(cards: readonly CardFact[], i: number): boolean {
  for (let j = 0; j < cards.length; j++) if (overlapInTime(cards, i, j)) return true;
  return false;
}

export interface Split {
  /** What still fails. */
  offenders: string[];
  /** What the exception excuses; printed as EXEMPT. */
  exempt: string[];
}

/** The `targets` offender kind the exception covers: the 24 px floor, never the 44 px primary-control rule. */
export const UNDER_24_PREFIX = 'under 24px and crowded:';

/**
 * `targets`: `offenderCard[i]` is the index (into `cards`) of the event card offender `i` is or sits
 * inside, or -1 when it is not in a card. Only the 24 px floor is excused.
 */
export function splitTargetOffenders(offenders: readonly string[], offenderCard: readonly number[] | undefined, cards: readonly CardFact[]): Split {
  const out: Split = { offenders: [], exempt: [] };
  offenders.forEach((o, i) => {
    const card = offenderCard?.[i] ?? -1;
    if (o.startsWith(UNDER_24_PREFIX) && card >= 0 && isDoubleBooked(cards, card)) out.exempt.push(o);
    else out.offenders.push(o);
  });
  return out;
}

/** The `scrollReach` offender kind the exception covers: the last control is covered by something. */
const COVERED_RE = /^last control ".*" is covered by /;

/**
 * `scrollReach`: `cover` names the last control and the element that covers it as event-card indexes
 * (-1 when that element is not in a card). Excused only when BOTH are cards and they overlap in time.
 */
export function splitScrollReachOffenders(offenders: readonly string[], cover: { last: number; hit: number } | undefined, cards: readonly CardFact[]): Split {
  const excused = !!cover && cover.last >= 0 && cover.hit >= 0 && overlapInTime(cards, cover.last, cover.hit);
  const out: Split = { offenders: [], exempt: [] };
  for (const o of offenders) {
    if (excused && COVERED_RE.test(o)) out.exempt.push(o);
    else out.offenders.push(o);
  }
  return out;
}

/** The only axe rule the exception covers. */
export const A11Y_RULE = 'target-size';

/**
 * `a11y`: for the nodes of one violated axe rule, `nodeCard[i]` is the card node `i` is or sits
 * inside (-1 otherwise). Returns the node indexes that stay failures and the ones excused. A rule
 * other than `target-size` excuses nothing.
 */
export function splitA11yNodes(rule: string, nodeCard: readonly number[], cards: readonly CardFact[]): { keep: number[]; exempt: number[] } {
  const out = { keep: [] as number[], exempt: [] as number[] };
  nodeCard.forEach((card, i) => {
    if (rule === A11Y_RULE && card >= 0 && isDoubleBooked(cards, card)) out.exempt.push(i);
    else out.keep.push(i);
  });
  return out;
}

/** The line the gate prints for the excused offenders of one check. */
export function exemptLine(check: string, exempt: readonly string[]): string {
  const shown = exempt.slice(0, 2).map((o) => o.slice(0, 90)).join(' | ');
  return `  EXEMPT scheduleDoubleBooked: ${exempt.length} ${check} offender(s) on double-booked event cards (${shown}${exempt.length > 2 ? ' | ...' : ''}) - accepted exception (allowlist.json acceptedExceptions)`;
}

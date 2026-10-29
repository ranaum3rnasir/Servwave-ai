// backend/src/lib/orgDayRange.ts
//
// The list filters' date boundary. A filter chip reading "08/24/2026 - 08/24/2026" is a
// question about the ORG's calendar day, but it arrives on the wire as a bare 'YYYY-MM-DD'
// string, which carries no zone at all. `new Date('2026-08-24')` resolves that to midnight
// UTC, and that single line was wrong twice over:
//
//   1. `_before` is the INCLUSIVE "to" day, so `lte: <start of that day>` is a zero-width
//      window for a single-day range ("Today" could never match anything) and silently
//      dropped the last day of every longer range.
//   2. The cut landed on UTC's midnight rather than the org's, so in America/New_York the
//      boundary sat at 8:00 PM the previous evening - the `_after` edge was wrong too.
//
// The Scheduled COLUMN already renders on the org clock, so the column and the filter
// disagreed about which day a job was on. The semantics below are the ones the chip
// promises:
//
//   `_after=YYYY-MM-DD`  ->  >= the instant that org-zone day BEGINS
//   `_before=YYYY-MM-DD` ->  <  the instant the NEXT org-zone day begins  (to-day inclusive)
//
// A `_before` bound is expressed as `lt` on the next day's start rather than `lte` on
// "23:59:59.999" because a DST day is 23 or 25 hours long: any hardcoded end-of-day offset
// over- or under-shoots twice a year. Deriving the far edge from the next day's start is
// exact in every zone.
//
// FULL ISO INSTANTS PASS THROUGH UNTOUCHED. The schedule board reuses these same
// `scheduled_after`/`scheduled_before` params but sends real instants
// (`useScheduleData.ts` converts its org-zone WallClock window through `toInstant`), and it
// passed the whole org-zone QA campaign. Only a BARE 'YYYY-MM-DD' is treated as an org-zone
// day; anything else keeps the previous `new Date(raw)` behaviour byte-for-byte.
//
// The day -> instant conversion goes through date-fns-tz's `fromZonedTime`, the same
// primitive the frontend's `orgDayStart` uses (frontend/src/lib/schedule-tz.ts), so the two
// sides cannot drift and neither hand-rolls UTC-offset arithmetic. It also resolves the
// zones where a calendar day does NOT begin at 00:00 local (a spring-forward day in e.g.
// America/Santiago starts at 01:00).
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';

/** A bare, zoneless calendar day as the filter wire contract sends it. */
const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Prisma range filter this module builds. `lt` is only ever the org-day-exclusive far edge. */
export type DateWindow = { gte?: Date; lte?: Date; lt?: Date };

/** True for a zoneless 'YYYY-MM-DD' - the only shape read as an ORG day rather than an instant. */
export function isBareOrgDay(value: unknown): value is string {
  return typeof value === 'string' && BARE_DAY.test(value);
}

/**
 * Shift an org-zone 'YYYY-MM-DD' by whole calendar days. Pure calendar-number arithmetic:
 * the day is anchored at UTC midnight purely as a counting device, so the result is never
 * reinterpreted through the server's own zone (which is UTC in production and the
 * developer's zone locally). Mirrors the frontend's `addOrgDays`.
 */
export function addOrgDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instant an org-zone calendar day BEGINS. Not always midnight local - see the file
 * header on zones that skip 00:00; `fromZonedTime` resolves that for us.
 */
export function orgDayStart(day: string, timeZone: string): Date {
  return fromZonedTime(`${day}T00:00:00`, timeZone);
}

/** A zoneless wall clock as a picker emits it: 'YYYY-MM-DDTHH:MM' (seconds optional). */
const BARE_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** True for a zoneless 'YYYY-MM-DDTHH:MM' - a wall clock, never an instant. */
export function isBareWallClock(value: unknown): value is string {
  return typeof value === 'string' && BARE_WALL_CLOCK.test(value);
}

/**
 * A zoneless wall clock ON THE ORG'S CLOCK -> the instant it names.
 *
 * The write-path twin of `orgDayStart` (same `fromZonedTime` primitive, same reason it is not
 * hand-rolled offset arithmetic), for a form that captures a whole date AND time rather than a
 * calendar day. `orgDayStart(day, tz)` is this function with the time pinned to 00:00.
 *
 * It takes the STRING, not a Date, and that is the whole point: `new Date('2026-08-26T16:00')`
 * has already resolved the value against the executing process's zone before this function could
 * see it, and the process is UTC in production and the developer's own zone locally. Resolving
 * the string against the target zone directly makes the result independent of both - and of the
 * BROWSER's zone, which is the recurring bug this codebase keeps paying for (a Manila dispatcher
 * picking 9:00 AM storing 9:00 PM New York). The frontend's `pickerValueToIso` is the mirror of
 * this on the client side; a write path should use one or the other, never neither and never a
 * bare `new Date(value)`.
 *
 * Returns null for anything that is not a bare wall clock, so a caller can 400 rather than
 * silently accepting an instant whose zone some client already chose.
 */
export function orgWallClockToInstant(value: unknown, timeZone: string): Date | null {
  if (!isBareWallClock(value)) return null;
  const at = fromZonedTime(value.length === 16 ? `${value}:00` : value, timeZone);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The ORG-zone calendar day an instant falls on, as 'YYYY-MM-DD'. The inverse of
 * `orgDayStart`, and the backend twin of the frontend's `isoToOrgDay`.
 */
export function orgDayOf(at: Date, timeZone: string): string {
  return formatInTimeZone(at, timeZone, 'yyyy-MM-dd');
}

/**
 * The ORG-ZONE WALL CLOCK an instant reads as, 'YYYY-MM-DDTHH:MM' - the exact inverse of
 * `orgWallClockToInstant`, closing the round trip.
 *
 * Exists so that a form which CAPTURED a wall clock can be reopened on the same wall clock. The
 * alternative - handing the client the instant and letting it derive the wall clock - resolves it
 * against whatever zone the client has, and that is the recurring bug this codebase keeps paying
 * for: an editor in Manila reopening a New York entry would be shown a different time from the
 * one that was typed, and saving the form unchanged would then MOVE it.
 *
 * The frontend cannot safely do this itself even knowing the org's zone, because its own
 * `useScheduleTimezone()` answers with a guess while the organisation query is in flight. Seeding
 * a picker off a guess and saving is a silent shift.
 */
export function orgWallClockOf(at: Date, timeZone: string): string {
  return formatInTimeZone(at, timeZone, "yyyy-MM-dd'T'HH:mm");
}

/**
 * The instant the org's CURRENT calendar day began - the OVERDUE boundary.
 *
 * `due_date: { lt: orgTodayStart(tz) }` is the Prisma expression of the frontend's
 * `orgDayDiff(due_date, tz) < 0` (invoicesColumns.tsx / invoiceMoney.ts). `orgDayDiff`
 * reduces BOTH sides to a 'YYYY-MM-DD' string before subtracting, so every instant sharing
 * today's org calendar day is at diff 0 and is NOT overdue - at 00:00:00 org-local and at
 * 23:59:59.999 org-local alike. A row becomes overdue the moment the ORG's clock ticks into
 * the next calendar day, not the moment the server's does.
 *
 * Cutting at `new Date()` instead is a different question, and it is the one the backend used
 * to ask: it selects every invoice due EARLIER TODAY, which the chip beside it then renders as
 * a plain SENT. `lt` also excludes NULL `due_date` in Postgres, matching `isOverdue`'s
 * `if (!invoice.due_date) return false` - no `NOT: { due_date: null }` is needed.
 *
 * Pass `at` explicitly when several queries in one response must share a boundary, so they
 * cannot straddle a midnight tick.
 */
export function orgTodayStart(timeZone: string, at: Date = new Date()): Date {
  return orgDayStart(orgDayOf(at, timeZone), timeZone);
}

/**
 * Whole CALENDAR days from `from` to `to`, both reduced to the org's calendar day first.
 *
 * This is the only correct way to answer "how many days late is this?". Dividing the raw
 * millisecond gap instead is wrong three times over:
 *
 *   1. It measures ELAPSED 24-hour periods, not calendar days, so any due date whose
 *      time-of-day is not midnight loses a day to the floor/ceil - an invoice due at
 *      02:35 reads "45 days overdue" for the whole of the 46th day.
 *   2. It answers in whichever zone the reader happens to be standing in. A due instant of
 *      02:35 UTC is the PREVIOUS calendar day in America/New_York, so UTC arithmetic and
 *      the org-local date printed next to it name two different days.
 *   3. It is an hour out on the two DST days a year, where a calendar day is 23 or 25 hours.
 *
 * Both days are re-anchored at UTC midnight purely as a counting device (same trick as
 * `addOrgDays`), so the subtraction is pure calendar arithmetic and never re-enters a zone.
 */
export function orgDayDiff(from: Date, to: Date, timeZone: string): number {
  return daysBetweenOrgDays(orgDayOf(from, timeZone), orgDayOf(to, timeZone));
}

/**
 * Whole calendar days between two org-zone 'YYYY-MM-DD' strings. The counting half of
 * `orgDayDiff`, exported for callers that already hold a day string (a due date derived
 * from net terms, say) and must not pay a pointless day -> instant -> day round trip.
 */
export function daysBetweenOrgDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Turn a raw `_after`/`_before` pair into the Prisma range filter, honouring the org clock.
 *
 * Each bound is resolved independently, so a mixed request (one bare day, one full instant)
 * is well-defined rather than all-or-nothing. Returns `null` when neither bound is usable,
 * so the caller can leave `where` untouched instead of writing an empty range object.
 */
export function orgDayRange(
  after: unknown,
  before: unknown,
  timeZone: string,
): DateWindow | null {
  const range: DateWindow = {};

  if (after) {
    const raw = String(after);
    // A bare day starts at the org's midnight; a full ISO instant is already an instant.
    range.gte = isBareOrgDay(raw) ? orgDayStart(raw, timeZone) : new Date(raw);
  }

  if (before) {
    const raw = String(before);
    if (isBareOrgDay(raw)) {
      // The "to" DAY is inclusive: everything strictly before the next org day begins.
      range.lt = orgDayStart(addOrgDays(raw, 1), timeZone);
    } else {
      // Unchanged instant semantics - this is the schedule board's path.
      range.lte = new Date(raw);
    }
  }

  return Object.keys(range).length > 0 ? range : null;
}

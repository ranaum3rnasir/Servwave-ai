/**
 * aggregate.ts — pure punch aggregation into shifts + daily/weekly hour buckets.
 *
 * Shift pairing mirrors the frontend `buildSessions`: per user, chronologically,
 * each IN→next OUT is a closed shift; a trailing (or superseded) unpaired IN is
 * an OPEN shift (end null, hours 0) — we NEVER fabricate an OUT. An OUT with no
 * open IN is ignored.
 *
 * Overtime: backend v1 is WEEKLY-OVER-40 ONLY (daily-8h / double-time deferred).
 * Hours are bucketed by the org's IANA timezone — both the calendar day and the
 * ISO week are derived from the shift START's LOCAL date in `orgTimezone`, never
 * from UTC.
 *
 * Keys: dailyHours `${userId}:${YYYY-MM-DD}`, weeklyHours/weeklyOtHours
 * `${userId}:${YYYY-Www}` (e.g. `u1:2026-W24`).
 */
import type { PunchLike } from './types';

export interface Shift {
  userId: string;
  start: number; // epoch ms of the IN punch
  end: number | null; // epoch ms of the paired OUT, or null while still open
  hours: number; // 0 while open
}

const WEEKLY_REGULAR_HOURS = 40;

/** Local YYYY-MM-DD for an epoch instant in the given IANA timezone. */
function localDateKey(ts: number, timeZone: string): string {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ts);
}

/**
 * ISO-8601 week label (`YYYY-Www`) computed from a plain local calendar date.
 * ISO weeks start Monday; week 1 is the week containing the year's first Thursday.
 * We operate on a UTC-anchored Date built from the local Y/M/D so no second
 * timezone shift is introduced.
 */
function isoWeekKey(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  // Shift to the Thursday of this ISO week.
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const isoYear = date.getUTCFullYear();
  // Thursday of week 1 is the Thursday in the week of Jan 4th.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Aggregate raw punches into shifts and per-user daily/weekly hour buckets.
 *
 * `range`, if given, is applied by shift START: only shifts whose `start` falls
 * within [from, to] are kept (simple, documented inclusion rule — a shift is
 * counted in full once its start is in range; partial-overlap clipping is out of
 * scope for v1).
 */
export function aggregate(
  punches: PunchLike[],
  orgTimezone: string,
  range?: { from: number; to: number },
): {
  shifts: Shift[];
  dailyHours: Record<string, number>;
  weeklyHours: Record<string, number>;
  weeklyOtHours: Record<string, number>;
} {
  // Group by user, then pair chronologically.
  const byUser = new Map<string, PunchLike[]>();
  for (const punch of punches) {
    const arr = byUser.get(punch.userId) ?? [];
    arr.push(punch);
    byUser.set(punch.userId, arr);
  }

  let shifts: Shift[] = [];
  for (const [userId, list] of byUser) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    let openIn: PunchLike | null = null;
    for (const punch of sorted) {
      if (punch.type === 'IN') {
        // A new IN before the previous one closed ⇒ previous becomes an open shift.
        if (openIn) shifts.push({ userId, start: openIn.ts, end: null, hours: 0 });
        openIn = punch;
      } else {
        // OUT
        if (openIn) {
          shifts.push({
            userId,
            start: openIn.ts,
            end: punch.ts,
            hours: Math.max(0, (punch.ts - openIn.ts) / 3600000),
          });
          openIn = null;
        }
        // OUT with no open IN ⇒ ignored.
      }
    }
    if (openIn) shifts.push({ userId, start: openIn.ts, end: null, hours: 0 });
  }

  shifts.sort((a, b) => a.start - b.start);

  if (range) {
    shifts = shifts.filter((s) => s.start >= range.from && s.start <= range.to);
  }

  const dailyHours: Record<string, number> = {};
  const weeklyHours: Record<string, number> = {};
  for (const shift of shifts) {
    if (shift.hours === 0) continue; // open shifts contribute no hours
    const localDate = localDateKey(shift.start, orgTimezone);
    const dayKey = `${shift.userId}:${localDate}`;
    const weekKey = `${shift.userId}:${isoWeekKey(localDate)}`;
    dailyHours[dayKey] = (dailyHours[dayKey] ?? 0) + shift.hours;
    weeklyHours[weekKey] = (weeklyHours[weekKey] ?? 0) + shift.hours;
  }

  const weeklyOtHours: Record<string, number> = {};
  for (const [key, hours] of Object.entries(weeklyHours)) {
    weeklyOtHours[key] = Math.max(0, hours - WEEKLY_REGULAR_HOURS);
  }

  return { shifts, dailyHours, weeklyHours, weeklyOtHours };
}

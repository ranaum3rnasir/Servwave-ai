/**
 * payroll.ts — per-employee payroll aggregation built on top of `buildSessions`.
 *
 * Two pure builders:
 *  - buildDays(sessions)            → one row per employee-per-day (Time Cards view)
 *  - buildPayroll(days, otReviews)  → one row per employee (Payroll Summary view)
 *
 * Overtime rule (mock, daily + weekly, take the greater):
 *  Per day:  reg = min(worked, 8h), ot1 = clamp(worked-8h, 0, 4h), ot2 = max(worked-12h, 0)
 *  Per week: weeklyOt = max(0, totalWorked - 40h)
 *  If weeklyOt > (Σ daily ot1 + Σ daily ot2): the surplus over the daily total
 *  becomes OT1; otherwise the daily split wins. (A simplification of true
 *  California daily-then-weekly stacking — good enough for mock data.)
 */
import type { Session } from './aggregate';
import { isLate } from './aggregate';
import type { ReviewState } from './types';

export const OT1_THRESHOLD_MIN = 8 * 60; // hours over 8/day → OT1
export const OT2_THRESHOLD_MIN = 12 * 60; // hours over 12/day → OT2
export const WEEKLY_REGULAR_MIN = 40 * 60; // hours over 40/week → weekly OT

export type DayRow = {
  userId: string;
  userName: string;
  dayKey: string; // `${userId}:${YYYY-MM-DD}` — stable approval key
  dateTs: number; // local midnight of the day
  dayName: string; // Mon, Tue, ...
  workedMin: number;
  regMin: number;
  ot1Min: number;
  ot2Min: number;
  inTs: number; // first clock-in of the day
  outTs: number | null; // last clock-out of the day (null if a session is still open)
  sessions: Session[]; // raw sessions for the punch-detail expansion
  isJobOt: boolean; // has OT AND a job-attributed session that day
};

export type PayrollRow = {
  userId: string;
  userName: string;
  regMin: number;
  ot1Min: number;
  ot2Min: number;
  otApprovedMin: number; // OT minutes on days marked approved
  otPendingMin: number; // OT minutes on days still pending (default)
  jobOtMin: number; // OT minutes on isJobOt days
  totalMin: number;
  days: number;
  lateCount: number;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Org-local ISO-8601 week key, e.g. `2026-W24`. Weeks start Monday; week 1 is the
 * week containing the year's first Thursday. This is the per-week `period_key` the
 * backend OT-review endpoint expects (v1 OT = weekly-over-40, approved per week).
 *
 * The week MUST be computed in the org's IANA timezone (not the viewer's browser
 * zone) so two admins in different zones agree on the bucket for a boundary punch.
 * This mirrors `backend/src/lib/timeclock/aggregate.ts` EXACTLY: derive the local
 * calendar date in `timeZone`, then anchor a UTC Date from that Y/M/D so no second
 * timezone shift is introduced.
 */
export function isoWeekKey(timeZone: string, ts: number): string {
  const localDate = localDateKey(timeZone, ts);
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
 * Local YYYY-MM-DD for an epoch instant in the given IANA timezone, matching the
 * day the punch is displayed under. en-CA renders ISO-style YYYY-MM-DD.
 */
function localDateKey(timeZone: string, ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ts);
}

function localMidnight(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function splitDaily(workedMin: number) {
  const regMin = Math.min(workedMin, OT1_THRESHOLD_MIN);
  const ot1Min = Math.min(Math.max(workedMin - OT1_THRESHOLD_MIN, 0), OT2_THRESHOLD_MIN - OT1_THRESHOLD_MIN);
  const ot2Min = Math.max(workedMin - OT2_THRESHOLD_MIN, 0);
  return { regMin, ot1Min, ot2Min };
}

/** One row per employee-per-day with the daily OT split. Days are bucketed in `timeZone`. */
export function buildDays(sessions: Session[], timeZone: string): DayRow[] {
  const byDay = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = `${s.userId}:${localDateKey(timeZone, s.inTs)}`;
    const arr = byDay.get(key) ?? [];
    arr.push(s);
    byDay.set(key, arr);
  }

  const rows: DayRow[] = [];
  for (const [dayKey, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.inTs - b.inTs);
    const first = sorted[0];
    if (!first) continue;
    const workedMin = sorted.reduce((a, s) => a + s.minutes, 0);
    const { regMin, ot1Min, ot2Min } = splitDaily(workedMin);
    const closes = sorted.map((s) => s.outTs).filter((t): t is number => t !== null);
    const hasOpen = sorted.some((s) => s.outTs === null);
    const isJobOt = ot1Min + ot2Min > 0 && sorted.some((s) => s.zoneKind === 'job');
    rows.push({
      userId: first.userId,
      userName: first.userName,
      dayKey,
      dateTs: localMidnight(first.inTs),
      dayName: DAY_NAMES[new Date(first.inTs).getDay()] ?? '',
      workedMin,
      regMin,
      ot1Min,
      ot2Min,
      inTs: first.inTs,
      outTs: hasOpen ? null : closes.length ? Math.max(...closes) : null,
      sessions: sorted,
      isJobOt,
    });
  }
  return rows.sort((a, b) => a.dateTs - b.dateTs);
}

/**
 * One row per employee.
 *
 * Overtime is WEEKLY-OVER-40 (v1): OT = Σ over each ISO week of max(0, weekWorked − 40h).
 * OT approval is keyed PER-WEEK (`reviewKey` = `${userId}:${isoWeek}`), so the
 * approved/pending split is taken from `otReviews` keyed by the week, NOT the day.
 * The daily OT1/OT2 split is retained on `PayrollRow` only for display continuity
 * (mini-KPI tiles); the authoritative reviewable OT figure is the weekly one.
 */
export function buildPayroll(days: DayRow[], otReviews: Record<string, ReviewState>, timeZone: string): PayrollRow[] {
  const byUser = new Map<string, DayRow[]>();
  for (const d of days) {
    const arr = byUser.get(d.userId) ?? [];
    arr.push(d);
    byUser.set(d.userId, arr);
  }

  const rows: PayrollRow[] = [];
  for (const [userId, list] of byUser) {
    const first = list[0];
    if (!first) continue;

    const totalMin = list.reduce((a, d) => a + d.workedMin, 0);
    const dailyOt1 = list.reduce((a, d) => a + d.ot1Min, 0);
    const dailyOt2 = list.reduce((a, d) => a + d.ot2Min, 0);

    // Weekly-over-40 OT, computed per ISO week.
    const weeks = buildWeeks(list, timeZone);
    const weeklyOtMin = weeks.reduce((a, w) => a + w.otMin, 0);

    // KPI tiles still show an OT1/OT2 split for legibility, but the authoritative
    // OT is weekly-over-40, so OT1 + OT2 is reconciled to equal `weeklyOtMin`.
    let ot1Min: number;
    let ot2Min: number;
    if (weeklyOtMin >= dailyOt1 + dailyOt2) {
      // Weekly surplus ≥ the daily split: keep the daily OT2 premium, the rest is OT1.
      ot2Min = dailyOt2;
      ot1Min = weeklyOtMin - dailyOt2;
    } else {
      // Daily rule over-counts vs weekly-40: fill OT2 first, then OT1, capped at weekly.
      ot2Min = Math.min(dailyOt2, weeklyOtMin);
      ot1Min = weeklyOtMin - ot2Min;
    }
    const regMin = totalMin - ot1Min - ot2Min;

    // Approved / pending split is keyed PER-WEEK off the weekly-over-40 OT, which
    // is what a manager approves. Rejected OT counts toward neither (unpaid).
    let otApprovedMin = 0;
    let otPendingMin = 0;
    let jobOtMin = 0;
    for (const w of weeks) {
      if (w.otMin === 0) continue;
      const review = otReviews[w.reviewKey] ?? 'pending';
      if (review === 'approved') otApprovedMin += w.otMin;
      else if (review !== 'rejected') otPendingMin += w.otMin;
      if (w.isJobOt) jobOtMin += w.otMin;
    }

    rows.push({
      userId,
      userName: first.userName,
      regMin,
      ot1Min,
      ot2Min,
      otApprovedMin,
      otPendingMin,
      jobOtMin,
      totalMin,
      days: list.length,
      lateCount: list.filter((d) => isLate(d.inTs)).length,
    });
  }
  return rows.sort((a, b) => b.totalMin - a.totalMin);
}

/**
 * One row per employee-per-ISO-week with WEEKLY-OVER-40 overtime — the v1 OT
 * model the backend OT-review endpoint keys on. `periodKey` is the ISO week
 * (e.g. `2026-W24`); `reviewKey` is `${userId}:${periodKey}` for the local
 * review map. OT approval is per-week, not per-day.
 */
export type WeekRow = {
  userId: string;
  userName: string;
  periodKey: string; // ISO week, e.g. 2026-W24
  reviewKey: string; // `${userId}:${periodKey}`
  workedMin: number;
  regMin: number;
  otMin: number; // weekly minutes over 40h
  isJobOt: boolean; // OT week with at least one job-attributed day
  days: DayRow[];
};

/** Aggregate days into per-employee, per-ISO-week rows with weekly-40 OT. Weeks are bucketed in `timeZone`. */
export function buildWeeks(days: DayRow[], timeZone: string): WeekRow[] {
  // Bucket by the day's first clock-in INSTANT (matches the backend, which keys the
  // ISO week off the shift START instant in the org timezone — `dateTs` is a
  // browser-local midnight and can drift a day across the tz boundary).
  const byWeek = new Map<string, DayRow[]>();
  for (const d of days) {
    const periodKey = isoWeekKey(timeZone, d.inTs);
    const key = `${d.userId}:${periodKey}`;
    const arr = byWeek.get(key) ?? [];
    arr.push(d);
    byWeek.set(key, arr);
  }

  const rows: WeekRow[] = [];
  for (const [reviewKey, list] of byWeek) {
    const first = list[0];
    if (!first) continue;
    const periodKey = isoWeekKey(timeZone, first.inTs);
    const workedMin = list.reduce((a, d) => a + d.workedMin, 0);
    const otMin = Math.max(0, workedMin - WEEKLY_REGULAR_MIN);
    const regMin = workedMin - otMin;
    const isJobOt = otMin > 0 && list.some((d) => d.sessions.some((s) => s.zoneKind === 'job'));
    rows.push({
      userId: first.userId,
      userName: first.userName,
      periodKey,
      reviewKey,
      workedMin,
      regMin,
      otMin,
      isJobOt,
      days: [...list].sort((a, b) => a.dateTs - b.dateTs),
    });
  }
  return rows.sort((a, b) => a.days[0]!.dateTs - b.days[0]!.dateTs);
}

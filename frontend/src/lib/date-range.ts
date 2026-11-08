// Date helpers shared by every list page's date filter.
// Controls deal in native 'YYYY-MM-DD' strings; the API wants ISO at day boundaries.
//
// #1634 (date-range half): the six *-Day functions below answer "what day is it",
// which used to mean only the BROWSER's day. A scheduling filter (e.g. Jobs'
// "Scheduled" facet) needs the ORG's day instead, so each gained an OPTIONAL
// `tz?: string` parameter. Omitted `tz` is byte-identical to the pre-existing
// browser-clock behaviour — every call site that does not pass `tz` keeps
// compiling and keeps behaving exactly as it did before this change. Only a
// call site that deliberately reads as a scheduling fact (not a "when was this
// row made" fact) should ever pass `tz`. See date-range.test.ts for the
// discriminating-instant tests that pin this contract.

import { getOrgDateFormat } from './org-format';
import { orgToday, addOrgDays } from './schedule-tz';

function toDayString(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 'YYYY-MM-DD' → ISO at local start of day (00:00:00). '' → undefined. */
export function dayStartISO(d: string): string | undefined {
  if (!d) return undefined;
  return new Date(`${d}T00:00:00`).toISOString();
}

/** 'YYYY-MM-DD' → ISO at local end of day (23:59:59.999). '' → undefined. */
export function dayEndISO(d: string): string | undefined {
  if (!d) return undefined;
  return new Date(`${d}T23:59:59.999`).toISOString();
}

/**
 * Start-of-week (Sunday), matching the backend new_this_week stat.
 * `tz` omitted -> browser-local (unchanged). `tz` given -> the ORG's week.
 */
export function startOfWeekDay(tz?: string): string {
  if (tz) {
    const today = orgToday(tz);
    // Pure calendar-number arithmetic: parse the org day as UTC midnight so the
    // weekday read is never reinterpreted through the runtime's own zone.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addOrgDays(today, -dow);
  }
  const now = new Date();
  const d = new Date(now);
  d.setDate(now.getDate() - now.getDay());
  return toDayString(d);
}

/** Start-of-month. `tz` omitted -> browser-local (unchanged); given -> the ORG's month. */
export function startOfMonthDay(tz?: string): string {
  if (tz) {
    const [y, m] = orgToday(tz).split('-');
    return `${y}-${m}-01`;
  }
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** Last day of the current month as 'YYYY-MM-DD'. `tz` omitted -> browser-local; given -> the ORG's month. */
export function endOfMonthDay(tz?: string): string {
  if (tz) {
    const [yStr, mStr] = orgToday(tz).split('-');
    const y = Number(yStr);
    const m = Number(mStr); // 1-indexed; Date.UTC(y, m, 0) is the last day of month m
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`;
  }
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

/** Today as 'YYYY-MM-DD'. `tz` omitted -> browser-local (unchanged); given -> the ORG's today. */
export function todayDay(tz?: string): string {
  if (tz) return orgToday(tz);
  return toDayString(new Date());
}

/**
 * N days before today as 'YYYY-MM-DD'. daysAgoDay(0) === today.
 * `tz` omitted -> browser-local (unchanged); given -> N days before the ORG's today.
 */
export function daysAgoDay(n: number, tz?: string): string {
  if (tz) return addOrgDays(orgToday(tz), -n);
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDayString(d);
}

/** Start-of-year (Jan 1). `tz` omitted -> browser-local (unchanged); given -> the ORG's year. */
export function startOfYearDay(tz?: string): string {
  if (tz) {
    const [y] = orgToday(tz).split('-');
    return `${y}-01-01`;
  }
  const now = new Date();
  return toDayString(new Date(now.getFullYear(), 0, 1));
}

/**
 * 'YYYY-MM-DD' → filter-chip label. Honors the org's numeric date_format
 * (e.g. 'MM/DD/YYYY' → '06/01/2026'); otherwise keeps the compact
 * 'Jun 1, 2026' short form for filter chips. (#126)
 */
export function formatDayLabel(d: string): string {
  const [y, m, day] = d.split('-');
  const pattern = getOrgDateFormat();
  if (y && m && day) {
    switch (pattern) {
      case 'MM/DD/YYYY':
        return `${m}/${day}/${y}`;
      case 'DD/MM/YYYY':
        return `${day}/${m}/${y}`;
      case 'YYYY-MM-DD':
        return `${y}-${m}-${day}`;
    }
  }
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/** Chip text for a date range, e.g. 'Created: ≥ Jun 1, 2026'. */
export function dateChipLabel(label: string, from: string, to: string): string {
  if (!from && !to) return label;
  if (from && to) return `${label}: ${formatDayLabel(from)} – ${formatDayLabel(to)}`;
  if (from) return `${label}: ≥ ${formatDayLabel(from)}`;
  return `${label}: ≤ ${formatDayLabel(to)}`;
}

/**
 * Inclusive [from, to] membership test for a Date; a null bound is open-ended.
 * Was duplicated byte-for-byte in reports/arAging.data.ts and
 * reports/expenses-logic.ts before consolidation.
 */
export function withinRange(d: Date, from: Date | null, to: Date | null): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// ─── The shared preset list ──────────────────────────────────────────────────
// Was FOUR byte-identical copies (DateRangeField.tsx, and the v2 _shared /
// estimates / jobs filterPopover.tsx files) before consolidation here (#1634).
// One definition now; every date-range picker imports it instead of pasting
// its own. `range()` takes the same optional `tz` as the six functions above -
// omitted, every preset resolves exactly as it always has (browser-local).

export interface Preset {
  key: string;
  label: string;
  range: (tz?: string) => { from: string; to: string };
}

export const PRESETS: Preset[] = [
  { key: 'any', label: 'Any time', range: () => ({ from: '', to: '' }) },
  { key: 'today', label: 'Today', range: (tz) => ({ from: todayDay(tz), to: todayDay(tz) }) },
  { key: 'week', label: 'This week', range: (tz) => ({ from: startOfWeekDay(tz), to: todayDay(tz) }) },
  { key: 'month', label: 'This month', range: (tz) => ({ from: startOfMonthDay(tz), to: endOfMonthDay(tz) }) },
  { key: 'last7', label: 'Last 7 days', range: (tz) => ({ from: daysAgoDay(6, tz), to: todayDay(tz) }) },
  { key: 'last30', label: 'Last 30 days', range: (tz) => ({ from: daysAgoDay(29, tz), to: todayDay(tz) }) },
  { key: 'last90', label: 'Last 90 days', range: (tz) => ({ from: daysAgoDay(89, tz), to: todayDay(tz) }) },
  { key: 'year', label: 'This year', range: (tz) => ({ from: startOfYearDay(tz), to: todayDay(tz) }) },
];

/**
 * Which preset (if any) {from,to} exactly matches, for the given `tz`
 * (omitted = browser clock, matching whichever zone produced `from`/`to` in
 * the first place); else 'custom' (some bound set) or 'any' (both empty).
 */
export function matchPreset(from: string, to: string, tz?: string): string {
  for (const p of PRESETS) {
    const r = p.range(tz);
    if (r.from === from && r.to === to) return p.key;
  }
  return from || to ? 'custom' : 'any';
}

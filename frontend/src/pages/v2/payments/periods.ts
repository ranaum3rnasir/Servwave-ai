import { addOrgDays, orgToday } from '@/lib/schedule-tz';

/**
 * The Payments page's period: a preset ("Last 30 days") or a custom range, always as org-zone calendar days
 * ('YYYY-MM-DD'). Presets are worked out in the ORG's timezone, never the browser's, so the owner in New York and
 * the dispatcher in Manila read the same totals for the same preset.
 */
export type PresetKey = '7' | '30' | '90' | 'month';
export type PeriodKey = PresetKey | 'custom';

export interface Period {
  key: PeriodKey;
  from: string;
  to: string;
}

/** The API's limit on one request (the summary and every list refuse a longer range). */
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_PRESET: PresetKey = '30';

export const PRESETS: ReadonlyArray<{ key: PresetKey; label: string }> = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'month', label: 'This month' },
];

const isPresetKey = (v: string | null): v is PresetKey => PRESETS.some((p) => p.key === v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePreset(key: PresetKey, tz: string, at: Date = new Date()): { from: string; to: string } {
  const today = orgToday(tz, at);
  if (key === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  // "Last N days" is N calendar days, today included.
  return { from: addOrgDays(today, -(Number(key) - 1)), to: today };
}

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export interface RangeProblem {
  field: 'from' | 'to';
  message: string;
}

/** The first thing wrong with a custom range, or null. `field` is the one to focus. */
export function validateRange(from: string, to: string): RangeProblem | null {
  if (!DAY.test(from)) return { field: 'from', message: 'Choose a start date' };
  if (!DAY.test(to)) return { field: 'to', message: 'Choose an end date' };
  if (to < from) return { field: 'to', message: 'End date can’t be before the start date' };
  if (dayCount(from, to) > MAX_RANGE_DAYS) return { field: 'to', message: `Choose a range of ${MAX_RANGE_DAYS} days or less` };
  return null;
}

/** Read `?period=7|30|90|month|custom&from=&to=`; anything unreadable falls back to Last 30 days. */
export function periodFromParams(params: URLSearchParams, tz: string, at: Date = new Date()): Period {
  const raw = params.get('period');
  if (raw === 'custom') {
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    if (!validateRange(from, to)) return { key: 'custom', from, to };
  } else if (isPresetKey(raw)) {
    return { key: raw, ...resolvePreset(raw, tz, at) };
  }
  return { key: DEFAULT_PRESET, ...resolvePreset(DEFAULT_PRESET, tz, at) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDay(day: string, withYear: boolean): string {
  const [y, m, d] = day.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}${withYear ? `, ${y}` : ''}`;
}

/**
 * What the picker shows: the preset's name, or a custom range's own dates ("Oct 1 - Oct 12"). The year is on the
 * start only when the two years differ, and on the end when they differ or the range is not in `currentYear`
 * (the org's today, 'YYYY'), so a range in another year never reads as this year's.
 */
export function periodLabel(period: Period, currentYear: string = orgToday('UTC').slice(0, 4)): string {
  const preset = PRESETS.find((p) => p.key === period.key);
  if (preset) return preset.label;
  const fromYear = period.from.slice(0, 4);
  const toYear = period.to.slice(0, 4);
  const yearsDiffer = fromYear !== toYear;
  return `${shortDay(period.from, yearsDiffer)} - ${shortDay(period.to, yearsDiffer || toYear !== currentYear)}`;
}

/** The query-string parts that describe a period (a preset needs only its key; the default is left out). */
export function periodToParams(period: Period): Record<string, string | null> {
  if (period.key === 'custom') return { period: 'custom', from: period.from, to: period.to };
  return { period: period.key === DEFAULT_PRESET ? null : period.key, from: null, to: null };
}

import { format, parse } from 'date-fns';
import { getOrgDateFormat } from './org-format';

/** Today's LOCAL calendar day as YYYY-MM-DD, for seeding a <input type="date">.
 *  Deliberately not `toISOString().slice(0, 10)`: that is the UTC day, which in
 *  every US timezone rolls over while it is still the previous evening locally,
 *  so an evening form opened on tomorrow's date. */
export function todayLocalDay(now: Date = new Date()): string {
  return format(now, 'yyyy-MM-dd');
}

/**
 * Turn a date-only picker value (YYYY-MM-DD) into the INSTANT it stands for.
 *
 * Columns like `payments.paid_at` hold true instants - almost every row is written
 * by a Stripe webhook or the server's own `new Date()`. A date-only string has to
 * acquire a time of day BEFORE it becomes one, because `new Date('2026-08-04')`
 * parses as UTC midnight, which is the previous evening across the US and renders
 * a day early on any local-time surface.
 *
 * Today keeps the real clock time, the honest answer when we have one. A back-dated
 * entry has no knowable time, so it takes local noon: far enough from both midnights
 * that no DST transition can carry it onto an adjacent day.
 */
export function instantFromLocalDay(day: string, now: Date = new Date()): string {
  if (day === todayLocalDay(now)) return now.toISOString();
  return parse(`${day} 12:00`, 'yyyy-MM-dd HH:mm', now).toISOString();
}

// Numeric date patterns we render exactly. Anything else (including the long-form
// 'MMMM D, YYYY' or an unset pref) falls back to the long-form default below so
// existing surfaces keep their "May 14, 2026" look until an org opts into a
// numeric format. (#126)
function numericDate(d: Date, pattern: string, utc: boolean): string | null {
  const yyyy = String(utc ? d.getUTCFullYear() : d.getFullYear());
  const mm = String((utc ? d.getUTCMonth() : d.getMonth()) + 1).padStart(2, '0');
  const dd = String(utc ? d.getUTCDate() : d.getDate()).padStart(2, '0');
  switch (pattern) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'DD/MM/YYYY':
      return `${dd}/${mm}/${yyyy}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    default:
      return null;
  }
}

/**
 * Shared body of the two exported renderers. `utc` is the entire difference
 * between them, and picking it is the caller declaring which kind of value it
 * holds - see the two exports below.
 *
 * An explicit `options` bag is rendered as given (pinned to UTC on the date-only
 * path) rather than deferring to the org pattern: a caller that asked for "Aug 4"
 * wants a compact label, not a full date in the org's numeric style.
 */
function renderDate(
  value: Date | string | null | undefined,
  utc: boolean,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';

  if (options) {
    const opts = utc ? { ...options, timeZone: 'UTC' } : options;
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }

  const pattern = getOrgDateFormat();
  if (pattern) {
    const numeric = numericDate(d, pattern, utc);
    if (numeric) return numeric;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(d);
}

/**
 * Render a DATE-ONLY value - a calendar day carrying no meaningful time of day
 * (`due_date`, `expectedDate`, `next_due`). These arrive as UTC midnight and so
 * must be read back in UTC; reading one in local time shows the previous day for
 * every US viewer.
 */
export function formatExactDay(
  value: Date | string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  return renderDate(value, true, options);
}

/**
 * Render an INSTANT - a real point in time from a timestamp column (`paid_at`,
 * `created_at`, `sent_at`, `scheduled_start`). These must be read in the viewer's
 * own zone; reading one in UTC rolls the calendar day forward across the whole US
 * evening, every day.
 *
 * This replaced `formatExactDate`, which was UTC-only while every one of its call
 * sites passed an instant. The old name said nothing about which of the two kinds
 * it took, which is how it came to be wrong at all of them.
 */
export function formatExactInstant(
  value: Date | string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  return renderDate(value, false, options);
}

/** YYYY-MM-DD from LOCAL calendar parts, for CSV exports of local-constructed
 *  dates. Its input is neither of the two kinds above: AR aging builds these
 *  dates from local day arithmetic, so they never came from the database.
 *  Deliberately not toISOString(), which shifts to UTC and can report the
 *  previous day. */
export function isoDateLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// frontend/src/lib/schedule-tz-intl.ts
//
// The part of the org-clock helpers that needs NOTHING but the browser's Intl: the default zone,
// rendering an instant on the org's clock, and counting calendar days. Split out of
// `schedule-tz.ts`, which imports the signed-in organization query and date-fns-tz, because a
// bundler tree-shakes per build, not per page: a module that both the staff app and a public page
// import carries everything EITHER of them uses. The public estimate and invoice pages import from
// here, so a customer's phone never downloads the data layer or date-fns-tz and the date-fns it
// drags in (mobile slice 47). Everything here is re-exported by `@/lib/schedule-tz`; staff code
// keeps importing from there.

/** ALPHA's first customers operate in US Eastern. Per-org override on Organization.timezone. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'America/New_York';

/** The house style for a scheduled date + time: "Aug 5, 9:00 PM". */
const DEFAULT_INSTANT_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * `toLocaleDateString()`'s default numeric shape ("7/10/2026"), pinned to the org zone.
 *
 * Exported because the invoices LIST and the invoices DETAIL page must render
 * byte-identical days for one invoice; two privately-declared copies of this object is
 * how they came to disagree in the first place.
 */
export const ORG_DAY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
};

/**
 * An ISO instant -> a human-readable string on the ORG's clock.
 *
 * `tz` is applied AFTER `opts` deliberately: a call site that carries over a stray
 * `timeZone` option cannot silently put the viewer's zone back. Empty input renders as ''
 * rather than 'Invalid Date'.
 */
export function formatInstant(
  instant: string | number | Date | null | undefined,
  tz: string,
  opts: Intl.DateTimeFormatOptions = DEFAULT_INSTANT_FORMAT,
  locale = 'en-US',
): string {
  // `!instant` is deliberately not the guard: epoch 0 is a number, and falsy. Only null,
  // undefined and '' mean "no value" - anything else is a real instant to render.
  if (instant === null || instant === undefined || instant === '') return '';
  return new Date(instant).toLocaleString(locale, { ...opts, timeZone: tz });
}

/** One cached formatter per zone: constructing an Intl.DateTimeFormat is far dearer than using one. */
const orgDayFormatters = new Map<string, Intl.DateTimeFormat>();

function intlOrgDay(instant: string | number | Date, tz: string): string {
  let f = orgDayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      // Pinned so a browser's regional default can never switch the digits or the calendar.
      numberingSystem: 'latn',
      calendar: 'gregory',
    });
    orgDayFormatters.set(tz, f);
  }
  const parts = f.formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * `orgDayDiff` for a full ISO instant (the API's timestamps), computed with Intl alone.
 *
 * It exists for the public invoice page. `orgDayDiff` goes through `isoToOrgDay`, which formats
 * with date-fns-tz, and that drags `date-fns` and its locale data into every bundle that reaches
 * it: about a tenth of the 200 KB first-download budget a customer's phone gets (mobile slice 47).
 * Same answer for an instant carrying its offset (`Z` or `+hh:mm`), parsed the way the page's own
 * `formatInstant` parses it; `schedule-tz.dayparity.test.ts` holds the two equal across zones and
 * both DST days. Staff screens keep using `orgDayDiff`.
 */
export function orgDayDiffIntl(iso: string, tz: string, nowIso?: string): number {
  const target = intlOrgDay(iso, tz);
  const today = intlOrgDay(nowIso ?? Date.now(), tz);
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}


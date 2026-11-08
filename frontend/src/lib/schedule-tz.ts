// frontend/src/lib/schedule-tz.ts
// The scheduler renders and writes react-big-calendar's raw local Date getters, which
// read the BROWSER's timezone. RBC has no timezone concept of its own, so the fix is a
// boundary translation, not a calendar change: convert once on the way in, once on the
// way out, and let everything in between keep operating on plain Date arithmetic.
//
// Instant  - a true point in time. What the API sends and what we persist.
// WallClock - a proxy Date whose LOCAL getters read the ORG-zone wall clock. Meaningless
//   as an instant on its own; exists only to be fed to react-big-calendar and to grid
//   layout math that reads local getters (getHours, setHours, startOfDay, etc. all keep
//   working correctly on a WallClock exactly as they would on a real local Date).
//
// The two are branded so a missed conversion is a type error instead of a silent bug
// that only shows up in someone else's timezone. Native Date methods (toISOString
// included) are still callable on either - the brand can't hide inherited members - so
// the actual write-path discipline is: go through wallClockToIso()/toInstant() at every
// serialisation site, never call .toISOString() on a WallClock by hand.
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { useOrganization } from '@/lib/api/organization';

declare const INSTANT: unique symbol;
declare const WALLCLOCK: unique symbol;

/** A true point in time. What the API sends and what we persist. */
export type Instant = Date & { readonly [INSTANT]: true };

/** A proxy Date whose LOCAL getters read the ORG wall clock. See file header. */
export type WallClock = Date & { readonly [WALLCLOCK]: true };

/** ALPHA's first customers operate in US Eastern. Per-org override on Organization.timezone. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'America/New_York';

/**
 * The org's configured scheduling timezone, with the one shared fallback.
 *
 * `org?.timezone || DEFAULT` answers TWO different questions with one value, and only one of
 * those answers is honest:
 *
 *   A. `org` is undefined - the query is still in flight, or it failed. We do not KNOW the zone
 *      here, and Eastern is a guess.
 *   B. `org.timezone` is null - the org has loaded and simply has no zone set. The column is
 *      nullable and this is the right answer; `__tests__/jobs-page.test.tsx` depends on it.
 *
 * The return type stays `string` deliberately. Widening it to `string | undefined` for case A
 * would break ~53 call sites, and any one of them missed would throw
 * `RangeError: Invalid time zone specified: undefined` out of date-fns-tz on the loading paint -
 * a cosmetic transient traded for a white screen. Case A is therefore handled where it actually
 * does damage: at the form seeds that PERSIST this value. A picker seeded on the guess and saved
 * back through the resolved zone is a silent, non-self-correcting shift, so those forms re-seed
 * when the zone changes - see `pages/v2/leads/components/walkthroughTab.tsx`,
 * `pages/v2/jobs/components/visitScheduleDialog.tsx` and `components/invoices/RecordPaymentDialog.tsx`.
 * Both cases are pinned in `schedule-tz.fallback.test.tsx`.
 */
export function useScheduleTimezone(): string {
  const { data: org } = useOrganization();
  return org?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
}

/** instant -> the WallClock proxy for `tz`. Feed this to react-big-calendar / grid layout math. */
export function toWallClock(instant: Date, tz: string): WallClock {
  return toZonedTime(instant, tz) as WallClock;
}

/** WallClock -> the real instant it represents in `tz`. Feed this to the API. */
export function toInstant(wallClock: Date, tz: string): Instant {
  return fromZonedTime(wallClock, tz) as Instant;
}

/** WallClock -> ISO string of the real instant it represents in `tz`. Write-path shorthand. */
export function wallClockToIso(wallClock: Date, tz: string): string {
  return toInstant(wallClock, tz).toISOString();
}

/** The current instant, as a WallClock in `tz` — current-time indicator, "today", default drops. */
export function nowWallClock(tz: string): WallClock {
  return toWallClock(new Date(), tz);
}

/** WallClock + milliseconds, staying in WallClock space — duration math, never a zone crossing. */
export function addMsToWallClock(wallClock: WallClock, ms: number): WallClock {
  return new Date(wallClock.getTime() + ms) as WallClock;
}

/**
 * Assert that a Date already known to be wall-clock space really is a WallClock. date-fns
 * helpers (startOfDay, startOfWeek, etc.) always return a plain Date even when given a
 * WallClock, so a value derived from a WallClock through one of them needs this to keep
 * carrying the brand. Only use this on values that were ALREADY WallClock before the
 * date-fns call - never on a fresh `new Date()`/`new Date(iso)`, which is exactly the bug
 * this file exists to catch.
 */
export function asWallClock(d: Date): WallClock {
  return d as WallClock;
}

// ─── The FORM-PICKER boundary ────────────────────────────────────────────────
// Everything above serves react-big-calendar, which works in Dates. Forms do not:
// DatePicker, TimeCombobox and DateTimePicker emit ZONELESS wall-clock strings
// ('YYYY-MM-DD', 'HH:MM', 'YYYY-MM-DDTHH:MM' - see __tests__/no-native-time-inputs.test.ts).
//
// A string carries no zone, so `new Date(str).toISOString()` resolves it against the
// BROWSER. That one line, repeated across ~20 call sites, is why a Manila dispatcher
// booking 9:00 AM stored 9:00 PM New York. Use these helpers at every form boundary.
//
// They deliberately take the STRING rather than a Date. date-fns-tz resolves a string
// against the TARGET zone directly, so the result is independent of the viewer's own
// timezone; the Date-based toWallClock/toInstant pair above has to reinterpret through
// the executing process's zone and is lossy on that process's own DST days. Verified
// identical under America/New_York, Asia/Manila and Europe/London.

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A picker's org-zone wall-clock string -> the ISO instant to persist.
 * Accepts 'YYYY-MM-DDTHH:MM' or a bare 'YYYY-MM-DD' (which uses `fallbackTime`).
 * Returns undefined for empty input, so callers can omit the field from a payload.
 */
export function pickerValueToIso(
  value: string | null | undefined,
  tz: string,
  fallbackTime = '00:00',
): string | undefined {
  if (!value) return undefined;
  const wallClock = DAY_ONLY.test(value) ? `${value}T${fallbackTime}` : value;
  return fromZonedTime(wallClock, tz).toISOString();
}

/**
 * Combine a DatePicker 'YYYY-MM-DD' and a TimeCombobox 'HH:MM' into the ISO instant to
 * persist. The two-field twin of pickerValueToIso; replaces the hand-rolled
 * `combineDatetime` helpers that were duplicated across the job and lead forms.
 */
export function dayAndTimeToIso(
  day: string | null | undefined,
  time: string | null | undefined,
  tz: string,
): string | undefined {
  if (!day) return undefined;
  return pickerValueToIso(day, tz, time || '00:00');
}

/** An ISO instant -> 'YYYY-MM-DDTHH:MM' in the ORG zone, to seed a DateTimePicker. */
export function isoToPickerValue(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  return formatInTimeZone(iso, tz, "yyyy-MM-dd'T'HH:mm");
}

/** An ISO instant -> 'YYYY-MM-DD' in the ORG zone, to seed a DatePicker. */
export function isoToOrgDay(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  return formatInTimeZone(iso, tz, 'yyyy-MM-dd');
}

/** An ISO instant -> 'HH:MM' in the ORG zone, to seed a TimeCombobox. */
export function isoToOrgTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  return formatInTimeZone(iso, tz, 'HH:mm');
}

// ─── The RENDER boundary ─────────────────────────────────────────────────────
// The helpers above serve form pickers. These serve anything a person reads.
//
// `new Date(iso).toLocaleString(...)` with no `timeZone` renders in the VIEWER's zone, so
// one stored instant becomes two different times on two screens - a New York owner reading
// 9:00 PM off the same job his Manila dispatcher reads as 9:00 AM. There is exactly one
// company clock, so every user-facing time goes through here.

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

/**
 * Whole CALENDAR days from `now` to `iso`, both measured in `tz`. Drives relative hints
 * ("Today", "Tomorrow", "in 3 days").
 *
 * Both ends are reduced to an org-zone 'YYYY-MM-DD' and re-anchored at UTC midnight before
 * subtracting, so this is pure calendar arithmetic. Diffing the raw instants instead would
 * be wrong twice over: it measures elapsed hours (11pm to 1am is "0 days" though the date
 * changed), and it is an hour out on the two DST days a year, where a calendar day is 23 or
 * 25 hours long.
 *
 * `nowIso` exists so tests can pin the reference point; production callers omit it.
 */
export function orgDayDiff(iso: string, tz: string, nowIso?: string): number {
  const target = isoToOrgDay(iso, tz);
  const today = isoToOrgDay(nowIso ?? new Date().toISOString(), tz);
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

// ─── The FILTER boundary ─────────────────────────────────────────────────────
// Rendering is not the only place a zone leaks in. A "Today" or "Last 7 days"
// filter is a pair of instants, and `new Date().setHours(0,0,0,0)` builds them on
// the VIEWER's clock - so the same preset selects a different set of rows for the
// New York owner than for the Manila dispatcher, and the counts they quote each
// other disagree. The boundaries below are the org's midnights.

/** Shift an org-zone 'YYYY-MM-DD' by whole calendar days. */
export function addOrgDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The org-zone calendar day containing `at` (default now), as 'YYYY-MM-DD'. */
export function orgToday(tz: string, at: Date = new Date()): string {
  return isoToOrgDay(at.toISOString(), tz);
}

/**
 * The instant an org-zone calendar day begins. Note this is NOT always midnight
 * local: on a spring-forward day in a zone that skips 00:00 (e.g. America/Santiago)
 * the day starts at 01:00, and date-fns-tz resolves that for us.
 */
export function orgDayStart(day: string, tz: string): Date {
  return new Date(pickerValueToIso(day, tz) as string);
}

/**
 * The last representable instant of an org-zone calendar day - the start of the NEXT
 * day, minus a millisecond. Derived rather than hardcoded to 23:59:59.999 because a
 * DST day is 23 or 25 hours long, so "start + 24h - 1ms" would over- or under-shoot.
 */
export function orgDayEnd(day: string, tz: string): Date {
  return new Date(orgDayStart(addOrgDays(day, 1), tz).getTime() - 1);
}

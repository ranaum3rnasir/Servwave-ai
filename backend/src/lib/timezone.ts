import { prisma } from './prisma';

/**
 * Default organization timezone. ALPHA's first customers operate in the US
 * Eastern timezone. Per-org overrides live on Organization.timezone.
 */
export const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Format a Date as a human-readable date + time string in an explicit IANA
 * timezone (e.g. "June 8, 2026 at 11:00 AM").
 *
 * Server-side renderers (emails, PDFs, SMS) MUST pass the org timezone, because
 * the backend process runs in UTC: `toLocaleString` without a `timeZone` emits
 * the server's UTC wall-clock, which is 4–5 hours ahead of Eastern and does not
 * match what users see in the browser-rendered CRM.
 */
/**
 * The far end of a window, for copy that has already named the near end in full.
 *
 * A time alone when both ends fall on the same ORG day ("October 15, 2026 at 9:00 AM -
 * 11:00 AM"), and the full date again when they do not - an overnight trip is exactly the
 * case where a bare end time would tell the customer the wrong day. The comparison is made
 * on the org's calendar day, not UTC's and not the server's, so a window that crosses
 * midnight in UTC but not in the org zone still reads as one day.
 */
export function formatEndOfWindowInZone(
  start: Date,
  end: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const day = (d: Date) => d.toLocaleDateString('en-US', { timeZone });
  if (day(start) !== day(end)) return formatDateTimeInZone(end, timeZone);
  return end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
}

export function formatDateTimeInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

/**
 * A short calendar date in an explicit IANA timezone ("Wed, Sep 30"), falling back to the default
 * zone when `timeZone` is not a zone the runtime knows. The form automation copy and in-app
 * notices use when they name a visit's day.
 */
export function formatShortDateInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone }).format(date);
  try {
    return fmt(timeZone);
  } catch {
    return fmt(DEFAULT_TIMEZONE);
  }
}

/**
 * Resolve an organization's configured timezone, falling back to the default
 * if the org is missing, has no timezone set, or the lookup fails. Safe to call
 * in fire-and-forget email paths — never throws.
 */
export async function getOrgTimezone(organizationId: string): Promise<string> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Resolve the org timezone for the CURRENT REQUEST, memoized on the request object.
 *
 * The list endpoints need the org clock in two independent places - the generic filter
 * engine's `dateRange` facets and the jobs controller's hand-rolled visit window - and both
 * run inside one request. Without the memo that is two `organization` lookups per list page.
 * The cache lives on the request because that is exactly its lifetime; a longer-lived cache
 * would keep serving a stale zone after an admin changes it in Settings.
 *
 * Callers should only reach for this when a BARE day string actually needs resolving - the
 * schedule board sends full instants and must not pay for a lookup it cannot use.
 */
const REQ_TZ = Symbol.for('alpha.orgTimezone');

export async function getRequestOrgTimezone(
  req: { user?: { organization_id?: string } },
): Promise<string> {
  const organizationId = req.user?.organization_id;
  // No authenticated org (the pure-engine unit tests, and any unauthenticated path) resolves
  // to the shared default WITHOUT touching the database.
  if (!organizationId) return DEFAULT_TIMEZONE;

  const cached = (req as Record<symbol, unknown>)[REQ_TZ];
  if (typeof cached === 'string') return cached;

  const timezone = await getOrgTimezone(organizationId);
  (req as Record<symbol, unknown>)[REQ_TZ] = timezone;
  return timezone;
}

/** Default currency. ALPHA's first customers bill in USD; per-org override on Organization.currency. */
export const DEFAULT_CURRENCY = 'USD';

/**
 * Resolve an organization's configured ISO-4217 currency code, falling back to
 * USD if the org is missing, has no currency set, or the lookup fails. Safe to
 * call in fire-and-forget email / PDF paths — never throws. (#126)
 */
export async function getOrgCurrency(organizationId: string): Promise<string> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true },
    });
    return org?.currency || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

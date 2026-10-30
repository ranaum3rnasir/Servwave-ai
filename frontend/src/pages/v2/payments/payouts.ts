/**
 * Small helpers the Payouts tab and the payout drawer share (payments go-live P8).
 */

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };

/**
 * A payout's arrival day ('YYYY-MM-DD') as "Oct 5, 2026". It is a calendar day, not an instant, so it is read as noon
 * UTC and printed in UTC: no time zone can move it to the day before. No day yet is a dash.
 */
export function formatPayoutDay(day: string | null): string {
  if (!day) return '—';
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', DAY).format(at);
}

/**
 * Communication plan usage — the real numbers behind the Phone header's
 * calling/texting meters.
 *
 * Every org's plan includes 100 calling minutes and 500 texts per calendar
 * month. This module answers "how much of that has been used this cycle?".
 *
 * Deliberately DERIVED, not metered. There is no balance table and no debit
 * hook: usage is aggregated on read from the CallSession and Message rows the
 * comm module already writes. That means the meter is retroactively correct
 * the moment it ships (existing history counts), a replayed CTM webhook cannot
 * double-count, and there is no counter that can drift away from the rows it
 * claims to summarise. Enforcement, when it lands, reads this same function.
 *
 * Both directions count. CTM bills the org for inbound tracking-number minutes
 * as well as outbound, so a meter that only watched outbound would under-report
 * the thing it exists to cap.
 */
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { prisma } from './prisma';
import { DEFAULT_TIMEZONE } from './timezone';

/** Calling minutes included in every plan, per calendar month. */
export const COMM_INCLUDED_MINUTES = 100;
/**
 * Texts included in every plan, per calendar month.
 *
 * 500, not 1,000. Measured against CTM on 2026-08-13, the busiest real org
 * (Northwind Services) sent 22 SMS segments in 30 days, so 500 is already ~20x live
 * usage. That 22 is suppressed though: SMS steps are still feature-locked in
 * the workflow builder, and once reminders and confirmations turn on, a
 * contractor running 20 jobs a day lands in the low hundreds per month. 500
 * covers that without doubling the ceiling for volume nobody is asking for
 * yet, and an allowance is far easier to raise later than to cut.
 */
export const COMM_INCLUDED_TEXTS = 500;

export interface CommUsage {
  /** UTC instant the current cycle began (local midnight on the 1st). */
  cycleStart: Date;
  /** Human label for the cycle, e.g. "Aug 1 – 31". */
  cycleLabel: string;
  /** Mirrors Organization.comm_usage_uncapped - true means both limits are null. */
  uncapped: boolean;
  /** `limit` is null for an uncapped org. Null rather than a very large number:
   *  a sentinel ceiling would let the meter render a meaningless percentage. */
  calling: { used: number; limit: number | null; unit: 'min' };
  texting: { used: number; limit: number | null; unit: 'texts' };
}

export interface CommUsageOptions {
  /** IANA zone the cycle boundary is resolved in. */
  timeZone?: string;
  /** Organization.comm_usage_uncapped - exempts the org from the allowance. */
  uncapped?: boolean;
  /** Injectable clock so the cycle boundary is testable without freezing time. */
  now?: Date;
}

/**
 * The UTC instant at which the org's current monthly cycle began — local
 * midnight on the 1st of the org's current month.
 *
 * The timezone is load-bearing, not decoration. `new Date().getUTCMonth()`
 * would roll the cycle over at 8pm on the last day of the month for a New York
 * org, zeroing every meter a day early. Resolving the wall-clock month in the
 * org's zone and converting that local midnight back to UTC is what keeps the
 * boundary where the user sees it, DST included.
 */
export function cycleStartFor(now: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  const local = toZonedTime(now, timeZone);
  const firstOfMonth = new Date(local.getFullYear(), local.getMonth(), 1, 0, 0, 0, 0);
  return fromZonedTime(firstOfMonth, timeZone);
}

/** Cycle label ("Aug 1 – 31"), resolved in the org's zone for the same reason. */
export function cycleLabelFor(now: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const local = toZonedTime(now, timeZone);
  const month = local.toLocaleString('en-US', { month: 'short' });
  // Day 0 of the following month is the last day of this one — the standard
  // trick, and correct for February in a leap year.
  const lastDay = new Date(local.getFullYear(), local.getMonth() + 1, 0).getDate();
  return `${month} 1 – ${lastDay}`;
}

/**
 * Billable minutes for a set of call durations.
 *
 * Rounds each call UP to the next whole minute, the way carriers bill. A call
 * with no recorded time at all contributes nothing.
 */
export function billableMinutes(durations: Array<number | null>): number {
  return durations.reduce<number>((total, sec) => {
    if (sec == null || sec <= 0) return total;
    return total + Math.ceil(sec / 60);
  }, 0);
}

/** The two clocks a CallSession can carry. */
export interface CallClocks {
  /** CTM `duration` - connected time: ring + queue + IVR + talk. What we pay for. */
  connected_sec?: number | null;
  /** CTM `talk_time` - conversation only. What the Calls list shows a human. */
  duration_sec?: number | null;
}

/**
 * Which clock the allowance runs on.
 *
 * The connected clock, because that is the one CTM invoices. Measured across
 * 160 real calls on 2026-08-14: `talk_time` was lower than `duration` on 130 of
 * them and higher on none - a 13.6% under-count in aggregate. Two shapes drive
 * it: a few seconds of connect overhead on every answered call, and calls that
 * rang unanswered, of which CTM billed 26 out of 26 while the conversation
 * clock read zero.
 *
 * `duration_sec` stays as a fallback rather than the primary source. Rows
 * ingested before connected_sec existed carry only the conversation clock, and
 * counting that history slightly low beats dropping it to zero. It is a
 * fallback for a MISSING value only - a connected_sec of 0 is a real
 * measurement (the call never connected at all) and wins over any talk time.
 */
export function billableSecondsOf(call: CallClocks): number {
  const connected = call.connected_sec;
  if (connected != null) return connected > 0 ? connected : 0;
  const talk = call.duration_sec;
  return talk != null && talk > 0 ? talk : 0;
}

/** Current-cycle usage for one org. */
export async function getCommUsage(
  organizationId: string,
  opts: CommUsageOptions = {},
): Promise<CommUsage> {
  const { timeZone = DEFAULT_TIMEZONE, uncapped = false, now = new Date() } = opts;
  const cycleStart = cycleStartFor(now, timeZone);

  // No `direction` filter on either query — inbound and outbound both count.
  const [calls, texts] = await Promise.all([
    prisma.callSession.findMany({
      where: { organization_id: organizationId, started_at: { gte: cycleStart } },
      select: { connected_sec: true, duration_sec: true },
    }),
    prisma.message.count({
      where: { organization_id: organizationId, ts: { gte: cycleStart } },
    }),
  ]);

  return {
    cycleStart,
    cycleLabel: cycleLabelFor(now, timeZone),
    uncapped,
    // `used` is reported honestly even past the limit: the meter clamps its bar
    // at 100%, but an org at 250/100 must not read the same as one at 100/100.
    // An uncapped org still gets real `used` figures - it is the limit that goes
    // away, not the measurement.
    calling: {
      used: billableMinutes(calls.map(billableSecondsOf)),
      limit: uncapped ? null : COMM_INCLUDED_MINUTES,
      unit: 'min',
    },
    texting: { used: texts, limit: uncapped ? null : COMM_INCLUDED_TEXTS, unit: 'texts' },
  };
}

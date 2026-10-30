import type { Request } from 'express';
import { moduleReachFor, reachWhere } from '../permissions/moduleReach';

/**
 * Does the caller's Events scope reach every calendar entry in the company (Events scope All)? Fails closed with no
 * person attached.
 */
export async function seesAllCalendarEntries(req: Request): Promise<boolean> {
  return (await moduleReachFor(req, 'CalendarEntry')).kind === 'all';
}

/**
 * Narrow a calendar-entry `where` to the entries the caller's Events scope reaches (P6): Attached lists the entries that
 * name the caller as a USER participant, Team the entries that name anyone in the caller's department, All every entry.
 * Being the entry's creator does not count (the creator is deliberately not a participant), and a customer participant
 * is not a person who can look. The clause joins `AND`, so it composes with a `participants` filter already on the
 * `where` (the customer page's schedule tab). The one rule the entries list, the entry detail, the customer page's
 * schedule tab and the Schedule's own search all ask.
 */
export async function withCalendarEntryRule(req: Request, where: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reach = await moduleReachFor(req, 'CalendarEntry');
  if (reach.kind === 'all') return where;
  const existing = Array.isArray(where.AND) ? (where.AND as Record<string, unknown>[]) : where.AND !== undefined ? [where.AND as Record<string, unknown>] : [];
  return { ...where, AND: [...existing, reachWhere('CalendarEntry', reach)] };
}

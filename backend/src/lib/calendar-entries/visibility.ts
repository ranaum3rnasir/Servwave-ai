import type { Request } from 'express';

/**
 * Does the caller see every calendar entry in the company (the "See all calendar entries" switch)? The one question
 * the entries list, the entry detail, the customer page's schedule tab and the Schedule's own search all ask, so a
 * custom role copied from Admin is held to its switch like any other role. Fails closed with no ability attached.
 */
export function seesAllCalendarEntries(req: Request): boolean {
  return req.ability?.can('see_all', 'CalendarEntry') ?? false;
}

/**
 * Narrow a calendar-entry `where` to the entries the caller may see: without See all calendar entries, only the
 * entries that list the caller as a USER participant. Being the entry's creator does not count (the creator is
 * deliberately not a participant), and a customer participant is not a person who can look. The clause joins `AND`,
 * so it composes with a `participants` filter already on the `where` (the customer page's schedule tab).
 */
export function withCalendarEntryRule(req: Request, where: Record<string, unknown>): Record<string, unknown> {
  if (seesAllCalendarEntries(req)) return where;
  const existing = Array.isArray(where.AND) ? (where.AND as Record<string, unknown>[]) : where.AND !== undefined ? [where.AND as Record<string, unknown>] : [];
  return { ...where, AND: [...existing, { participants: { some: { kind: 'USER', user_id: req.user!.id } } }] };
}

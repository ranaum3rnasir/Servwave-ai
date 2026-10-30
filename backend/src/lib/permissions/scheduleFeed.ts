import type { Request } from 'express';
import { isBareOrgDay } from '../orgDayRange';
import { resolveSwitches } from './switches/store';
import { SCOPE_SWITCH_KEY } from './switches/catalog';

/**
 * The Schedule's job feed (Roles & Permissions, PRD 4, S04.9).
 *
 * The board reads the jobs list asked for a window of full instants (`scheduled_after` / `scheduled_before`).
 * The Jobs list's own date filter asks for the same window in bare org days, so the two are told apart by the
 * shape of the bounds: the board's request is the feed, the list's is not.
 *
 * Under Jobs scope Attached the feed carries only the visits whose crew the person is on. Being a job's Sold By
 * or Dispatcher makes the job openable (its page shows every visit) but puts no other crew's visit on the
 * Schedule. Team, Location, All and Through own leads are unchanged. Read from the person's switches and the
 * visits' crews as they stand, so a person taken off a visit loses it on the very next request.
 */

/** Is this request the Schedule board's feed rather than the Jobs list (or an export of it)? */
function isScheduleFeedRequest(req: Request): boolean {
  const after = req.query.scheduled_after;
  const before = req.query.scheduled_before;
  if (!after && !before) return false;
  return !isBareOrgDay(after) && !isBareOrgDay(before);
}

/** The person whose own crew visits are the whole feed, or null when this request is not narrowed. */
export async function scheduleFeedCrewUserId(req: Request): Promise<string | null> {
  const user = req.user;
  if (!user || !isScheduleFeedRequest(req)) return null;
  const values = await resolveSwitches(user);
  return values[SCOPE_SWITCH_KEY.Job] === 'attached' ? user.id : null;
}

/** The visits of a job row (a list row selected with each visit's crew) that this person is on the crew of. */
export function ownCrewVisits<V extends { assignees: { user_id: string }[] }>(visits: V[], userId: string): V[] {
  return visits.filter((v) => v.assignees.some((a) => a.user_id === userId));
}

/**
 * The Schedule's walkthrough feed (Roles & Permissions, PRD 4, S04.10).
 *
 * The board reads the leads list asked for a walkthrough window (`walkthrough_after` / `walkthrough_before`), which
 * nothing else asks for, so that request is the feed. Under Leads scope Attached it carries the walkthroughs the
 * person is crewed on, plus every walkthrough of a lead they own or are assigned to when they hold Book
 * walkthroughs (whoever is crewed: whoever may move a walkthrough on the board can see it). Being only a lead's
 * Dispatcher adds none. Team, Location and All are unchanged, and the lead page still shows every walkthrough of a
 * lead to anyone who can open it. Read from the person's switches and the walkthroughs' crews as they stand, so a
 * person taken off a walkthrough loses it on the very next request.
 */
export type WalkthroughFeed = { userId: string; bookWalkthroughs: boolean };

/** Who the walkthrough feed is narrowed to, or null when this request is not narrowed. */
export async function scheduleWalkthroughFeed(req: Request): Promise<WalkthroughFeed | null> {
  const user = req.user;
  if (!user || !(req.query.walkthrough_after || req.query.walkthrough_before)) return null;
  const values = await resolveSwitches(user);
  if (values[SCOPE_SWITCH_KEY.Lead] !== 'attached') return null;
  return { userId: user.id, bookWalkthroughs: values.book_walkthroughs === true };
}

/** The walkthrough visits the feed carries, as a Prisma `where` on a visit. */
export function feedWalkthroughVisitWhere(feed: WalkthroughFeed): Record<string, unknown> {
  const crewed = { assignees: { some: { user_id: feed.userId } } };
  if (!feed.bookWalkthroughs) return crewed;
  return {
    OR: [
      crewed,
      { lead: { OR: [{ commission_owner_id: feed.userId }, { lead_assignees: { some: { user_id: feed.userId } } }] } },
    ],
  };
}

type FeedLead = {
  commission_owner?: { id: string } | null;
  lead_assignees?: { user_id: string }[];
  visits: { assignees: { user_id: string }[] }[];
};

/** A lead row of the feed keeps only the walkthroughs the feed carries for this person. */
export function feedWalkthroughs<L extends FeedLead>(leads: L[], feed: WalkthroughFeed | null): L[] {
  if (!feed) return leads;
  return leads.map((l) => {
    const theirs = l.commission_owner?.id === feed.userId || (l.lead_assignees ?? []).some((a) => a.user_id === feed.userId);
    if (feed.bookWalkthroughs && theirs) return l;
    return { ...l, visits: ownCrewVisits(l.visits, feed.userId) };
  });
}

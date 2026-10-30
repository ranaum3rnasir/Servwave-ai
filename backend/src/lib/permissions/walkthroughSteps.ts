import type { Request } from 'express';
import type { Subject } from './catalog';
import { findCurrentWalkthroughForLead, findScheduledWalkthrough } from '../../services/walkthrough.service';

/**
 * M3 - the access resolver's per-walkthrough answer (Roles & Permissions, PRD 4): which steps this person may take on
 * a lead's walkthrough. The lead page reads it (it offers no step the server would refuse) and the walkthrough routes
 * ask the very same functions, so the screen and the door cannot disagree.
 *
 * A step needs Perform walkthroughs AND either a place on THAT walkthrough's crew or Update any visit's status, the
 * rule job visits follow. Update any visit's status lifts the crew condition only, never Perform walkthroughs. The
 * routes are lead-level and carry no walkthrough id, so the check is made against the walkthrough the route is about to
 * change; being crewed on another walkthrough of the same lead (a finished one, an untimed one) does not count.
 * Booking, moving, unbooking, re-crewing and cancelling are not steps: they ride Book walkthroughs on their routes.
 */

/** The two steps, named for what the person does: write the walkthrough's notes, finish the walkthrough. */
export type WalkthroughStep = 'notes' | 'finish';

/** The walkthrough as the check reads it: who is on its crew. */
export type CrewedWalkthrough = { assignees?: { user_id: string }[] | null };

/** Lifecycle order, which is the order the answer lists them in. */
export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = ['notes', 'finish'];

/**
 * May this person step this walkthrough? No walkthrough means nothing to change and no crew to be on: only Update any
 * visit's status gets through, so the lead's notes door never answers one person differently from another.
 */
export function mayStepWalkthrough(req: Request, walkthrough: CrewedWalkthrough | null | undefined): boolean {
  if (!req.ability?.can('perform_walkthrough', 'Lead' as Subject)) return false;
  if (req.ability.can('update_any_visit_status', 'Job' as Subject)) return true;
  return (walkthrough?.assignees ?? []).some((a) => a.user_id === req.user!.id);
}

/**
 * The steps this person may take on a lead they can already open. Finish needs a scheduled walkthrough to finish; notes
 * ride the current one, so they stay with the crew of a finished walkthrough until a later one is booked.
 */
export async function walkthroughStepsFor(req: Request, leadId: string): Promise<WalkthroughStep[]> {
  if (!req.ability?.can('perform_walkthrough', 'Lead' as Subject)) return [];
  const [current, scheduled] = await Promise.all([findCurrentWalkthroughForLead(req, leadId), findScheduledWalkthrough(req, leadId)]);
  const target = { notes: current, finish: scheduled };
  return WALKTHROUGH_STEPS.filter((step) => target[step] !== null && mayStepWalkthrough(req, target[step]));
}

import type { Request } from 'express';
import { isCreatorStillAttached } from './creatorRule';
import { canActOnRow } from './enforce';
import { prisma } from '../prisma';
import { walkthroughStepsFor } from './walkthroughSteps';

/**
 * M3 - the access resolver's per-record answer for editing a lead (Roles & Permissions, PRD 4). The lead page reads it
 * (it offers no edit control the server would refuse) and the update route asks the very same functions, so the screen
 * and the door cannot disagree.
 *
 * Two people may edit a lead: one who holds Edit leads (for the leads in their scope), and the person who made the lead
 * while they are still on it (M3's "is creator and still attached"). The second has Edit leads off, and gets the plain
 * details only: the address, the source, the walkthrough times and the status stay with whoever holds Edit leads.
 */

/** What a person may do to a lead when they open it. */
export type LeadAction =
  | 'edit' | 'edit_address' | 'edit_source' | 'edit_schedule' | 'change_status'
  // Reopen lead on a Won or Lost lead (S05.19), from Reopen leads alone: it does not need Edit leads.
  | 'reopen'
  // The walkthrough steps (S04.19), from the same answer the walkthrough routes ask: noting the current walkthrough and
  // finishing the scheduled one. Independent of Edit leads, which a person doing only the walkthrough does not hold.
  | 'walkthrough_notes' | 'walkthrough_finish';

/** The fields a request names that the creator path may not change, each with the words the refusal says. */
const CREATOR_LOCKED: Array<{ fields: readonly string[]; message: string }> = [
  {
    fields: ['service_location_id', 'new_location', 'service_address_line1', 'service_address_line2', 'service_city', 'service_state', 'service_zip'],
    message: "You can't change this lead's address.",
  },
  { fields: ['ad_source'], message: "You can't change this lead's source." },
  { fields: ['scheduled_start', 'scheduled_end'], message: "You can't change this lead's walkthrough times." },
];

/** Does this person edit the lead as its creator rather than through Edit leads? True only when Edit leads is off. */
export function editsAsCreator(req: Request): boolean {
  return !req.ability?.can('update', 'Lead');
}

/** Is this person the lead's creator and still on it, right now? Read from the people on the lead as they stand. */
export function isLeadCreatorStillAttached(req: Request, leadId: string): Promise<boolean> {
  return isCreatorStillAttached(req.user!, 'Lead', leadId);
}

/**
 * The refusal for a creator-path edit: the message naming the first locked field the body carries, or null when the
 * body only touches what the creator may change. A status counts only when it differs from the stored one, since a
 * save that sends the status back changes nothing.
 */
export function creatorEditRefusal(body: Record<string, unknown>, storedStatus: string): string | null {
  for (const { fields, message } of CREATOR_LOCKED) {
    if (fields.some((field) => body[field] !== undefined)) return message;
  }
  if (body.status !== undefined && body.status !== storedStatus) return "You can't change this lead's status.";
  return null;
}

/** The actions this person may take on a lead they can already open. */
export async function leadActionsFor(req: Request, leadId: string): Promise<LeadAction[]> {
  const steps = (await walkthroughStepsFor(req, leadId)).map((step): LeadAction => `walkthrough_${step}`);
  // Reopen leads is its own switch: a person who cannot edit the lead may still bring a closed one back.
  const reopen: LeadAction[] =
    req.ability?.can('reopen', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'reopen')) ? ['reopen'] : [];
  if (editsAsCreator(req)) {
    return (await isLeadCreatorStillAttached(req, leadId)) ? ['edit', ...reopen, ...steps] : [...reopen, ...steps];
  }
  const actions: LeadAction[] = ['edit', 'edit_address', 'edit_source', 'edit_schedule'];
  if (req.ability?.can('change_status', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'change_status'))) {
    actions.push('change_status');
  }
  return [...actions, ...reopen, ...steps];
}

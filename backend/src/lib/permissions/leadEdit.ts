import type { Request } from 'express';
import { canActOnRow } from './enforce';
import { prisma } from '../prisma';
import { walkthroughStepsFor } from './walkthroughSteps';

/**
 * M3 - the access resolver's per-record answer for editing a lead (Roles & Permissions, PRD 4). The lead page reads it
 * (it offers no edit control the server would refuse) and the update route asks the very same functions, so the screen
 * and the door cannot disagree.
 *
 * Only a person who holds Edit leads edits a lead, for the leads in their scope (P7: a person who made the lead has no
 * way in that their switches do not give them; Create leads requires Edit leads, so a creator holds it).
 */

/** What a person may do to a lead when they open it. */
export type LeadAction =
  | 'edit' | 'edit_address' | 'edit_source' | 'edit_schedule' | 'change_status'
  // Reopen lead on a Won or Lost lead (S05.19), from Reopen leads alone: it does not need Edit leads.
  | 'reopen'
  // The walkthrough steps (S04.19), from the same answer the walkthrough routes ask: noting the current walkthrough and
  // finishing the scheduled one. Independent of Edit leads, which a person doing only the walkthrough does not hold.
  | 'walkthrough_notes' | 'walkthrough_finish';

/** The actions this person may take on a lead they can already open. */
export async function leadActionsFor(req: Request, leadId: string): Promise<LeadAction[]> {
  const steps = (await walkthroughStepsFor(req, leadId)).map((step): LeadAction => `walkthrough_${step}`);
  // Reopen leads is its own switch: a person who cannot edit the lead may still bring a closed one back.
  const reopen: LeadAction[] =
    req.ability?.can('reopen', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'reopen')) ? ['reopen'] : [];
  if (!req.ability?.can('update', 'Lead')) return [...reopen, ...steps];
  const actions: LeadAction[] = ['edit', 'edit_address', 'edit_source', 'edit_schedule'];
  if (req.ability?.can('change_status', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'change_status'))) {
    actions.push('change_status');
  }
  return [...actions, ...reopen, ...steps];
}

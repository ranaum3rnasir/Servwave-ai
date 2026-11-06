import type { Request } from 'express';
import { canAccessRow, canActOnRow, type RowDelegate } from './enforce';
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
  | 'walkthrough_notes' | 'walkthrough_finish'
  // A note on the lead itself: Add notes or Edit leads (a note is the lead's own data), for a lead in the person's reach.
  // The same two checks POST /api/leads/:id/notes makes, so the Notes tab offers "Add note" exactly where the route accepts one.
  | 'add_note';

/**
 * May this person add a note to this lead: Add notes or Edit leads, for a lead in their reach. The rule behind the
 * `add_note` action and POST /api/leads/:id/notes. `delegate` is the client to look the lead up with.
 */
export async function mayAddLeadNote(req: Request, leadId: string, delegate: RowDelegate = prisma.lead): Promise<boolean> {
  return holdsLeadNoteSwitch(req) && (await canAccessRow(req, 'Lead', delegate, leadId));
}

/**
 * Does this person hold Add notes or Edit leads at all, whatever their Leads scope reaches. The new-lead form's Notes box
 * asks only this (#3104, Ran's build ruling 3): a creator whose scope does not reach the lead they just made, or reaches
 * it only through the walkthrough booked with it, still gets the typed text saved as the general note.
 */
export function holdsLeadNoteSwitch(req: Request): boolean {
  return !!(req.ability?.can('add_note', 'Lead') || req.ability?.can('update', 'Lead'));
}

/** The actions this person may take on a lead they can already open. */
export async function leadActionsFor(req: Request, leadId: string): Promise<LeadAction[]> {
  const steps = (await walkthroughStepsFor(req, leadId)).map((step): LeadAction => `walkthrough_${step}`);
  // Reopen leads is its own switch: a person who cannot edit the lead may still bring a closed one back.
  const reopen: LeadAction[] =
    req.ability?.can('reopen', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'reopen')) ? ['reopen'] : [];
  const note: LeadAction[] = (await mayAddLeadNote(req, leadId)) ? ['add_note'] : [];
  if (!req.ability?.can('update', 'Lead')) return [...note, ...reopen, ...steps];
  const actions: LeadAction[] = ['edit', 'edit_address', 'edit_source', 'edit_schedule'];
  if (req.ability?.can('change_status', 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, leadId, 'change_status'))) {
    actions.push('change_status');
  }
  return [...actions, ...note, ...reopen, ...steps];
}

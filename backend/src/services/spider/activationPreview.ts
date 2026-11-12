/**
 * The numbers Spider's Activate review shows (#3431): what activating now would watch and send, counted by the sweep's
 * own rule (sweep.ts `watchedVisits`), the picker's own count of open and excluded leads (picker.ts `pickerOverview`) and
 * Spider's one recipient rule (recipients.ts), so the review never disagrees with what the sweep then does or the picker shows. Counts only, for the one company: no lead, customer or person details.
 */
import { prisma } from '../../lib/prisma';
import { readRecipients } from './config';
import { resolveSpiderRecipientsForLeads } from './recipients';
import { pickerOverview } from './picker';
import { watchedVisits } from './sweep';

export interface SpiderActivationPreview {
  /** Every open lead that is not excluded: the number the lead picker shows (Ran, 10 Nov). */
  watchedLeads: number;
  /** Excluded leads that are still open (#3434): a closed lead kept on the list is not counted, as in the picker. */
  excludedLeads: number;
  /** Of the watched leads, those already past their time limit: what the starting summary would report. */
  pastLimitLeads: number;
  /** The distinct people the starting summary would go to. */
  summaryRecipients: number;
}

export async function spiderActivationPreview(orgId: string, now: Date = new Date()): Promise<SpiderActivationPreview> {
  // The whole settings row (it is small), read as the sweep reads it.
  const settings = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
  // The picker header's numbers (Ran, 10 Nov), from the picker's own count (picker.ts pickerOverview): excluded =
  // excluded leads that are still open (a closed one stays on the list but is not counted), watched = the other open
  // leads. watched + excluded = open leads.
  const { watched: watchedLeads, excluded: excludedLeads } = await pickerOverview(orgId, settings?.excluded_lead_ids ?? []);
  if (!settings) return { watchedLeads, excludedLeads, pastLimitLeads: 0, summaryRecipients: 0 };
  // Activating starts a new active period now, so every stay past its limit is reported afresh (D5); the summary that
  // Activate would send ignores any earlier skip, since "Send" clears it.
  const { overdue } = await watchedVisits(orgId, { ...settings, backlog_skipped_stays: [] }, now, now);
  const byLead = overdue.length
    ? await resolveSpiderRecipientsForLeads(prisma, {
        orgId,
        leads: overdue.map((o) => ({ id: o.id, ownerId: o.owner_id })),
        recipients: readRecipients(settings.recipients),
      })
    : new Map();
  const people = new Set<string>();
  for (const list of byLead.values()) for (const p of list) people.add(p.id);
  return { watchedLeads, excludedLeads, pastLimitLeads: overdue.length, summaryRecipients: people.size };
}

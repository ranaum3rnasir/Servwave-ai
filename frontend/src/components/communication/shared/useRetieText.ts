/**
 * What a pick in "Attach to a lead or job" (#3024) does to a text, the same from the inbox and from a record tab: one request,
 * and the server keeps the text on one record (Ran, 2026-11-06), as it does for a call:
 *  - a job: the text goes on that job, and its lead becomes the job's own lead, or none;
 *  - a lead: the text goes on that lead, and comes off the job it was on;
 *  - "No lead or job": both ends come off.
 */
import { useReassignSmsJob, useReassignSmsLead, type ConversationLinkResult } from '@/lib/api/communication';
import type { AttachPick } from './CommJobMenu';

export function useRetieText() {
  const job = useReassignSmsJob();
  const lead = useReassignSmsLead();
  return (text: { id: string }, pick: AttachPick | null): Promise<ConversationLinkResult> =>
    pick?.kind === 'lead'
      ? lead.mutateAsync({ messageId: text.id, leadId: pick.id })
      : job.mutateAsync({ messageId: text.id, jobId: pick?.id ?? null });
}

/**
 * The tie of a record conversation (Roles & Permissions PRD 10, S10.5).
 *
 * A record conversation is the one a send to a customer opens about one record (an estimate, an invoice and its
 * deposit and payments, a job or lead notice, a calendar entry). It is tied to a job or a lead, and the tie is WORKED
 * OUT FROM THE RECORD EACH TIME IT IS READ, never stored: the record can move (an estimate gains a job, a lead becomes
 * a job) and a stored copy would go stale. This file is that rule and nothing else; it touches no database. The
 * resolver in `recordConversations.ts` loads the facts these functions take.
 *
 *   - an estimate: to its job when it has one, else its lead;
 *   - an invoice (a deposit invoice too): to its own job, else its estimate's job, else its estimate's lead;
 *   - a payment is read through its invoice, so it needs no case of its own;
 *   - a job or lead notice: to that job or lead; a calendar entry: to the job or lead it names (none does today);
 *   - a record with no job or lead (an invoice made for the customer alone): to the customer only.
 *
 * The tie FOLLOWS A LEAD INTO ITS JOB: a conversation tied to a lead shows on the job made from it too, and a
 * conversation tied to a job shows on the lead it came from (`showsOnJob`, `showsOnLead`). Reopening a Won lead
 * changes nothing here, because it changes no row the tie is worked out from.
 */

/** What a conversation is about, with the facts its tie is worked out from. */
export type TiedRecord =
  | { type: 'estimate'; jobId: string | null; leadId: string | null }
  | { type: 'invoice'; jobId: string | null; estimate: { jobId: string | null; leadId: string | null } | null }
  | { type: 'job'; id: string }
  | { type: 'lead'; id: string }
  | { type: 'calendar_entry'; jobId: string | null; leadId: string | null }
  | { type: 'customer' };

/** The job or lead a conversation is tied to. Both null means the customer only. Never both set. */
export interface RecordTie {
  jobId: string | null;
  leadId: string | null;
}

const JOB = (jobId: string): RecordTie => ({ jobId, leadId: null });
const LEAD = (leadId: string): RecordTie => ({ jobId: null, leadId });
const CUSTOMER_ONLY: RecordTie = { jobId: null, leadId: null };

/** A job when there is one, else a lead, else the customer only. */
function jobElseLead(jobId: string | null | undefined, leadId: string | null | undefined): RecordTie {
  if (jobId) return JOB(jobId);
  if (leadId) return LEAD(leadId);
  return CUSTOMER_ONLY;
}

export function tieOf(record: TiedRecord): RecordTie {
  switch (record.type) {
    case 'estimate':
      return jobElseLead(record.jobId, record.leadId);
    case 'invoice':
      return record.jobId ? JOB(record.jobId) : jobElseLead(record.estimate?.jobId, record.estimate?.leadId);
    case 'job':
      return JOB(record.id);
    case 'lead':
      return LEAD(record.id);
    case 'calendar_entry':
      return jobElseLead(record.jobId, record.leadId);
    case 'customer':
      return CUSTOMER_ONLY;
  }
}

/** Does a conversation with this tie show on this job's tab? A lead tie shows on every job made from that lead. */
export function showsOnJob(tie: RecordTie, job: { id: string; leadId: string | null }): boolean {
  if (tie.jobId !== null) return tie.jobId === job.id;
  return tie.leadId !== null && tie.leadId === job.leadId;
}

/** Does a conversation with this tie show on this lead's tab? A job tie shows on the lead the job was made from. */
export function showsOnLead(tie: RecordTie, lead: { id: string; jobIds: readonly string[] }): boolean {
  if (tie.leadId !== null) return tie.leadId === lead.id;
  return tie.jobId !== null && lead.jobIds.includes(tie.jobId);
}

/**
 * A conversation about an estimate or an invoice shows on a job's or lead's tab only to people who can also open that
 * estimate or invoice. Every other kind shows to anyone who can open the record.
 */
export const GUARDED_RECORD_TYPES = ['estimate', 'invoice'] as const;
export type GuardedRecordType = (typeof GUARDED_RECORD_TYPES)[number];

export function isGuardedRecordType(type: string | null | undefined): type is GuardedRecordType {
  return type === 'estimate' || type === 'invoice';
}

/**
 * The job or lead an email about an estimate is saved on when it is written: the estimate's tie, as the columns the
 * stored email carries (`Email.job_id`, `job_label`, `lead_id`). The job when the estimate has one, else its lead, never
 * both. Rows written before this rule carried the lead alone; the tab works the tie out from the record when it reads,
 * so they need no rewriting.
 */
export function estimateEmailTie(estimate: {
  job_id: string | null;
  lead_id: string | null;
  job_link?: { job_number: string } | null;
}): { jobId: string | null; jobLabel: string | null; leadId: string | null } {
  const tie = tieOf({ type: 'estimate', jobId: estimate.job_id, leadId: estimate.lead_id });
  return { jobId: tie.jobId, jobLabel: tie.jobId ? estimate.job_link?.job_number ?? null : null, leadId: tie.leadId };
}

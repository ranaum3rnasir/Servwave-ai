import { describe, it, expect } from 'vitest';
import { tieOf, showsOnJob, showsOnLead, isGuardedRecordType, estimateEmailTie, type TiedRecord, type RecordTie } from '../recordTie';

/**
 * The tie of a record conversation (Roles & Permissions PRD 10, S10.5): every conversation opened by a send to a
 * customer is tied to a job or a lead, worked out from the record as it is now. The rule is pure, so each row of the
 * table below is one fact about a record and the tie it must give.
 */

const JOB = 'job-1';
const LEAD = 'lead-1';
const OTHER_JOB = 'job-2';

describe('tieOf', () => {
  const rows: Array<[string, TiedRecord, RecordTie]> = [
    ['an estimate with a job goes to its job', { type: 'estimate', jobId: JOB, leadId: null }, { jobId: JOB, leadId: null }],
    ['an estimate with a job and a lead goes to its job only', { type: 'estimate', jobId: JOB, leadId: LEAD }, { jobId: JOB, leadId: null }],
    ['an estimate with only a lead goes to its lead', { type: 'estimate', jobId: null, leadId: LEAD }, { jobId: null, leadId: LEAD }],
    ['an estimate with neither goes to the customer only', { type: 'estimate', jobId: null, leadId: null }, { jobId: null, leadId: null }],
    [
      'an invoice with a job goes to its own job, whatever its estimate says',
      { type: 'invoice', jobId: JOB, estimate: { jobId: OTHER_JOB, leadId: LEAD } },
      { jobId: JOB, leadId: null },
    ],
    [
      'an invoice with no job goes to its estimate\'s job',
      { type: 'invoice', jobId: null, estimate: { jobId: JOB, leadId: LEAD } },
      { jobId: JOB, leadId: null },
    ],
    [
      'an invoice with no job (a deposit invoice) goes to its estimate\'s lead when the estimate has no job',
      { type: 'invoice', jobId: null, estimate: { jobId: null, leadId: LEAD } },
      { jobId: null, leadId: LEAD },
    ],
    [
      'an invoice with no job and an estimate with neither goes to the customer only',
      { type: 'invoice', jobId: null, estimate: { jobId: null, leadId: null } },
      { jobId: null, leadId: null },
    ],
    ['an invoice made for the customer alone goes to the customer only', { type: 'invoice', jobId: null, estimate: null }, { jobId: null, leadId: null }],
    ['a job notice goes to its job', { type: 'job', id: JOB }, { jobId: JOB, leadId: null }],
    ['a lead notice goes to its lead', { type: 'lead', id: LEAD }, { jobId: null, leadId: LEAD }],
    ['a calendar entry that names a job goes to the job', { type: 'calendar_entry', jobId: JOB, leadId: null }, { jobId: JOB, leadId: null }],
    ['a calendar entry that names a lead goes to the lead', { type: 'calendar_entry', jobId: null, leadId: LEAD }, { jobId: null, leadId: LEAD }],
    ['a calendar entry that names neither goes to the customer only', { type: 'calendar_entry', jobId: null, leadId: null }, { jobId: null, leadId: null }],
    ['a conversation about the customer goes to the customer only', { type: 'customer' }, { jobId: null, leadId: null }],
  ];
  it.each(rows)('%s', (_name, record, tie) => {
    expect(tieOf(record)).toEqual(tie);
  });
});

describe('where a tie shows', () => {
  const job = { id: JOB, leadId: LEAD };
  const jobWithoutLead = { id: JOB, leadId: null };
  const lead = { id: LEAD, jobIds: [JOB] };

  it('a job tie shows on that job and on no other', () => {
    expect(showsOnJob({ jobId: JOB, leadId: null }, job)).toBe(true);
    expect(showsOnJob({ jobId: OTHER_JOB, leadId: null }, job)).toBe(false);
  });

  it('a lead tie follows the lead into its job', () => {
    expect(showsOnJob({ jobId: null, leadId: LEAD }, job)).toBe(true);
    expect(showsOnJob({ jobId: null, leadId: 'lead-9' }, job)).toBe(false);
    expect(showsOnJob({ jobId: null, leadId: LEAD }, jobWithoutLead)).toBe(false);
  });

  it('a tie to the customer only shows on no job and no lead', () => {
    expect(showsOnJob({ jobId: null, leadId: null }, job)).toBe(false);
    expect(showsOnLead({ jobId: null, leadId: null }, lead)).toBe(false);
  });

  it('a lead tie shows on that lead, and a job tie shows on the lead the job came from', () => {
    expect(showsOnLead({ jobId: null, leadId: LEAD }, lead)).toBe(true);
    expect(showsOnLead({ jobId: JOB, leadId: null }, lead)).toBe(true);
    expect(showsOnLead({ jobId: OTHER_JOB, leadId: null }, lead)).toBe(false);
    expect(showsOnLead({ jobId: null, leadId: 'lead-9' }, lead)).toBe(false);
  });

  it('keeps every tie when a lead is reopened after it was won: the job stays tied, the lead keeps showing it', () => {
    // Reopening changes no row the tie is worked out from, so the same facts give the same answer.
    const afterReopen = { id: LEAD, jobIds: [JOB] };
    expect(showsOnLead(tieOf({ type: 'estimate', jobId: JOB, leadId: LEAD }), afterReopen)).toBe(true);
    expect(showsOnJob(tieOf({ type: 'estimate', jobId: JOB, leadId: LEAD }), job)).toBe(true);
    // New mail about the reopened lead, from an estimate with no job yet, ties to the lead and shows on the old job too.
    const later = tieOf({ type: 'estimate', jobId: null, leadId: LEAD });
    expect(showsOnLead(later, afterReopen)).toBe(true);
    expect(showsOnJob(later, job)).toBe(true);
  });
});

describe('isGuardedRecordType', () => {
  it('guards the conversations about an estimate or an invoice, and nothing else', () => {
    expect(isGuardedRecordType('estimate')).toBe(true);
    expect(isGuardedRecordType('invoice')).toBe(true);
    for (const open of ['job', 'lead', 'customer', 'calendar_entry', null, undefined]) expect(isGuardedRecordType(open)).toBe(false);
  });
});

describe('estimateEmailTie', () => {
  it('saves the email on the job, with its number, when the estimate has one, and on no lead', () => {
    expect(estimateEmailTie({ job_id: JOB, lead_id: LEAD, job_link: { job_number: 'J-7' } })).toEqual({ jobId: JOB, jobLabel: 'J-7', leadId: null });
  });
  it('saves it on the lead when the estimate has no job', () => {
    expect(estimateEmailTie({ job_id: null, lead_id: LEAD, job_link: null })).toEqual({ jobId: null, jobLabel: null, leadId: LEAD });
  });
  it('saves it on the customer alone when the estimate has neither', () => {
    expect(estimateEmailTie({ job_id: null, lead_id: null })).toEqual({ jobId: null, jobLabel: null, leadId: null });
  });
});

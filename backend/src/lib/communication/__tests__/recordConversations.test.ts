import { describe, it, expect, vi } from 'vitest';
import { tiedRecordConversations, type TieDb, type RecordOpeners } from '../recordConversations';
import { matchesWhere } from '../../../__tests__/whereMatcher';

/**
 * The resolver that works the tie out from the records, with the database stubbed so the number of reads can be
 * counted. The hosted database allows one connection, so a tab with fifty conversations must cost the same reads as one.
 */

const ORG = 'org-1';
const JOB = 'job-1';
const LEAD = 'lead-1';

function stub(rows: {
  job?: unknown; lead?: unknown;
  estimates?: Array<{ id: string; job_id: string | null; lead_id: string | null }>;
  invoices?: Array<{ id: string; job_id: string | null; estimate: { job_id: string | null; lead_id: string | null } | null }>;
}) {
  const db = {
    job: { findUnique: vi.fn().mockResolvedValue(rows.job ?? null) },
    lead: { findUnique: vi.fn().mockResolvedValue(rows.lead ?? null) },
    estimate: { findMany: vi.fn().mockResolvedValue(rows.estimates ?? []) },
    invoice: { findMany: vi.fn().mockResolvedValue(rows.invoices ?? []) },
  };
  return db;
}
const everyoneOpens = (): RecordOpeners => ({
  estimate: vi.fn(async (ids: readonly string[]) => new Set(ids)),
  invoice: vi.fn(async (ids: readonly string[]) => new Set(ids)),
});
const reads = (db: ReturnType<typeof stub>) =>
  db.job.findUnique.mock.calls.length + db.lead.findUnique.mock.calls.length + db.estimate.findMany.mock.calls.length + db.invoice.findMany.mock.calls.length;

const jobRow = { id: JOB, job_number: 'J-1', lead: { id: LEAD, lead_number: 'L-1' } };
const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));

describe('tiedRecordConversations', () => {
  it('reads the record, its estimates and its invoices once each, and asks each opener once, however many conversations there are', async () => {
    const counts: number[] = [];
    for (const n of [1, 50]) {
      const db = stub({
        job: jobRow,
        estimates: many(n, (i) => ({ id: `e${i}`, job_id: JOB, lead_id: null })),
        invoices: many(n, (i) => ({ id: `i${i}`, job_id: JOB, estimate: null })),
      });
      const openers = everyoneOpens();
      await tiedRecordConversations(db as unknown as TieDb, { organizationId: ORG, anchor: { kind: 'job', id: JOB }, openers });
      expect(openers.estimate).toHaveBeenCalledTimes(1);
      expect(openers.invoice).toHaveBeenCalledTimes(1);
      counts.push(reads(db));
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBe(3);
  });

  it('costs the same for a lead and its jobs', async () => {
    const db = stub({
      lead: { id: LEAD, lead_number: 'L-1', jobs: many(5, (i) => ({ id: `j${i}`, job_number: `J-${i}` })) },
      estimates: many(50, (i) => ({ id: `e${i}`, job_id: null, lead_id: LEAD })),
      invoices: many(50, (i) => ({ id: `i${i}`, job_id: `j${i % 5}`, estimate: null })),
    });
    await tiedRecordConversations(db as unknown as TieDb, { organizationId: ORG, anchor: { kind: 'lead', id: LEAD }, openers: everyoneOpens() });
    expect(reads(db)).toBe(3);
  });

  it('brings along the conversations of the estimates and invoices the person can open, the job, and its lead, and no others', async () => {
    const db = stub({
      job: jobRow,
      estimates: [
        { id: 'e-open', job_id: JOB, lead_id: null },
        { id: 'e-closed', job_id: JOB, lead_id: null },
        { id: 'e-lead-era', job_id: null, lead_id: LEAD },
        { id: 'e-sibling-job', job_id: 'job-2', lead_id: LEAD },
      ],
      invoices: [
        { id: 'i-open', job_id: JOB, estimate: null },
        { id: 'i-closed', job_id: null, estimate: { job_id: JOB, lead_id: LEAD } },
        { id: 'i-other-job', job_id: 'job-2', estimate: null },
      ],
    });
    const openers: RecordOpeners = {
      estimate: async (ids) => new Set(ids.filter((id) => id !== 'e-closed')),
      invoice: async (ids) => new Set(ids.filter((id) => id !== 'i-closed')),
    };
    const tied = await tiedRecordConversations(db as unknown as TieDb, { organizationId: ORG, anchor: { kind: 'job', id: JOB }, openers });

    const thread = (record_type: string, record_id: string) => ({ origin: 'record', record_type, record_id });
    const shows = (record_type: string, record_id: string) => matchesWhere({ thread: thread(record_type, record_id) }, tied.tiedEmailWhere!);
    expect(shows('estimate', 'e-open')).toBe(true);
    expect(shows('estimate', 'e-lead-era')).toBe(true);
    expect(shows('invoice', 'i-open')).toBe(true);
    expect(shows('job', JOB)).toBe(true);
    expect(shows('lead', LEAD)).toBe(true);
    expect(shows('estimate', 'e-closed')).toBe(false);
    expect(shows('estimate', 'e-sibling-job')).toBe(false);
    expect(shows('invoice', 'i-closed')).toBe(false);
    expect(shows('invoice', 'i-other-job')).toBe(false);
    expect(matchesWhere({ thread: { origin: 'started', record_type: 'estimate', record_id: 'e-open' } }, tied.tiedEmailWhere!)).toBe(false);
  });

  it('puts the tied job or lead on a reply that names neither, and leaves a row that already names one alone', async () => {
    const db = stub({ job: jobRow, estimates: [{ id: 'e1', job_id: null, lead_id: LEAD }, { id: 'e2', job_id: JOB, lead_id: null }] });
    const tied = await tiedRecordConversations(db as unknown as TieDb, { organizationId: ORG, anchor: { kind: 'job', id: JOB }, openers: everyoneOpens() });

    const leadEra = tied.withTie({ job_id: null, lead_id: null, thread: { record_type: 'estimate', record_id: 'e1' } });
    expect(leadEra).toMatchObject({ job_id: null, lead_id: LEAD, lead: { id: LEAD, lead_number: 'L-1' } });
    const onJob = tied.withTie({ job_id: null, lead_id: null, thread: { record_type: 'estimate', record_id: 'e2' } });
    expect(onJob).toMatchObject({ job_id: JOB, job_label: 'J-1', lead_id: null });
    const named = { job_id: null, lead_id: 'other-lead', thread: { record_type: 'estimate', record_id: 'e2' } };
    expect(tied.withTie(named)).toBe(named);
  });
});

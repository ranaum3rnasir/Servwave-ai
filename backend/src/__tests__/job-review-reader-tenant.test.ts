import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { readJobReview } from '../lib/job-review-reader';

/**
 * The review's file count is read inside the company like every other attachment query. The job is checked against
 * the company first, so nothing could leak; the filter keeps the read honest on its own.
 */
describe('readJobReview - the file count', () => {
  it('counts the job\'s attachments inside the company', async () => {
    const count = vi.fn().mockResolvedValue(3);
    const empty = vi.fn().mockResolvedValue([]);
    const db = {
      job: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'job-1', job_number: 'J1', job_type: null, created_at: new Date('2026-07-01T00:00:00Z'), tax_rate: 0,
          discount_amount: 0, scopes: null, job_line_items: [], visits: [], estimate: null, linked_estimates: [],
          customer: { first_name: 'Sample', last_name: 'Customer', company_name: null, tax_exempt: false },
          service_location: null,
        }),
      },
      jobReview: { findFirst: vi.fn().mockResolvedValue(null) },
      timelineEvent: { findMany: empty, findFirst: vi.fn().mockResolvedValue(null) },
      invoice: { findMany: empty },
      attachment: { count },
      note: { count: vi.fn().mockResolvedValue(0), findMany: empty },
      visitMilestoneLog: { findMany: empty },
    } as unknown as Prisma.TransactionClient;

    await readJobReview({ orgId: 'org-1', jobId: 'job-1', mayCosts: false, openInvoices: async () => new Set(), db });

    expect(count).toHaveBeenCalledWith({ where: { organization_id: 'org-1', entity_type: 'JOB', entity_id: 'job-1' } });
  });
});

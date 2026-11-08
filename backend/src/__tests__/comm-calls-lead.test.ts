/**
 * comm-calls-lead.test.ts — PATCH /api/communication/calls/:id/lead.
 *
 * Live QA 2026-07-21: lead_id is only ever stamped at ingest (stash/phone
 * match), and no manual path existed — a call that missed its lead
 * attribution could never be corrected, unlike jobs (calls/:id/job). This
 * mirrors reassignCallJob exactly: tenant-scoped lead resolve → atomic
 * updateMany → refetch; lead_id: null clears. Same-customer rule: a
 * customer-linked call only attaches to that customer's leads; unknown-caller
 * calls accept any org lead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as any;

const LEAD_ID = 'ab000000-0000-0000-0000-000000000088';
const LEAD_ROW = { id: LEAD_ID, lead_number: 'L00088', customer_id: CUSTOMER_FIXTURE.id };
const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';
const CALL_ID = 'cd000000-0000-0000-0000-000000000002';

const CALL_ROW = {
  id: CALL_ID,
  direction: 'in',
  from_number: '+15551234567',
  to_number: '+15550001111',
  tracking_source: null,
  status: 'completed',
  answered_by: { kind: 'none' },
  started_at: new Date('2026-06-09T10:00:00Z'),
  duration_sec: null,
  customer_id: CUSTOMER_FIXTURE.id,
  lead_id: null,
  vendor_id: null,
  job_id: null,
  job_label: null,
  organization_id: ALPHA_ORG_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) })
  );
}

describe('PATCH /api/communication/calls/:id/lead — manual attach', () => {
  it('sets lead_id from an org-scoped lead', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW]) // pre-read (same-customer constraint)
      .mockResolvedValueOnce([{ ...CALL_ROW, lead_id: LEAD_ID }]); // refetch
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.job.findFirst.mockResolvedValue(null); // lead has no job yet
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { lead_id: LEAD_ID, job_id: null, job_label: null },
    });
    expectOrgScoped(mockPrisma.lead.findUnique as Mock, ALPHA_ORG_ID);
    expectOrgScoped(mockPrisma.callSession.findMany as Mock, ALPHA_ORG_ID);
    expect(res.body.call.leadId).toBe(LEAD_ID);
  });

  it('clears lead_id on null without resolving a lead', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.callSession.findMany.mockResolvedValue([{ ...CALL_ROW, lead_id: null }]);

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
    // Symmetric with the job endpoint: one link, so detaching clears both ends.
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { lead_id: null, job_id: null, job_label: null },
    });
  });

  // Mirror of the job endpoint - the org-wide picker must be able to commit
  // anything it offers. See comm-calls-job.test.ts for the reasoning.
  it("accepts a lead belonging to a different customer and leaves customer_id alone", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW])
      .mockResolvedValueOnce([{ ...CALL_ROW, lead_id: LEAD_ID }]);
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_ROW, customer_id: OTHER_CUSTOMER_ID });
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    const data = mockPrisma.callSession.updateMany.mock.calls[0][0].data;
    expect(data.lead_id).toBe(LEAD_ID);
    expect(data).not.toHaveProperty('customer_id');
    expect(res.body.call.customerId).toBe(CUSTOMER_FIXTURE.id);
  });

  it('an unknown-caller call (customer_id null) accepts any org lead', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null }])
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null, lead_id: LEAD_ID }]);
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.call.leadId).toBe(LEAD_ID);
  });

  it('404s on an unknown call id', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(mockPrisma.callSession.updateMany).not.toHaveBeenCalled();
  });

  it('403s for a technician (no update Communication grant)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('technician'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.callSession.updateMany).not.toHaveBeenCalled();
  });
});

// ── One link, three columns (lead end) ──────────────────
//
// The mirror of the job endpoint's companion stamping: picking the lead is the
// same choice as picking its job, so it fills the same triple. A lead reaches
// its job back through the estimate (Job.estimate -> Estimate.lead_id), and a
// lead may have several estimates, so the most recent job wins.
const JOB_ID = 'ab000000-0000-0000-0000-000000000077';

describe('PATCH /api/communication/calls/:id/lead — companion job + customer', () => {
  it("stamps the lead's job alongside the lead", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW])
      .mockResolvedValueOnce([{ ...CALL_ROW, lead_id: LEAD_ID, job_id: JOB_ID, job_label: 'J00077' }]);
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID, job_number: 'J00077' });
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { lead_id: LEAD_ID, job_id: JOB_ID, job_label: 'J00077' },
    });
    // The job lookup must be org-scoped and reached via the estimate, not a
    // (non-existent) Job.lead_id column.
    expectOrgScoped(mockPrisma.job.findFirst as Mock, ALPHA_ORG_ID);
    expect(mockPrisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ estimate: { lead_id: LEAD_ID } }),
      })
    );
    expect(res.body.call.jobId).toBe(JOB_ID);
    expect(res.body.call.jobLabel).toBe('J00077');
  });

  // Mirror of the job endpoint: the anchor is lead/job only. See the comment on
  // the equivalent test in comm-calls-job.test.ts for why stamping the lead's
  // customer here is worse than leaving an unknown caller unknown.
  it('leaves an unknown caller unknown - an attach never writes customer_id', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null }])
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null, lead_id: LEAD_ID }]);
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { lead_id: LEAD_ID, job_id: null, job_label: null },
    });
    expect(res.body.call.customerId).toBeUndefined();
  });

  it('never overwrites a customer_id the phone match already resolved', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW])
      .mockResolvedValueOnce([{ ...CALL_ROW, lead_id: LEAD_ID }]);
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_ROW);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    await request(app)
      .patch(`/api/communication/calls/${CALL_ID}/lead`)
      .set(authHeader('dispatcher'))
      .send({ lead_id: LEAD_ID });

    const data = mockPrisma.callSession.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('customer_id');
  });
});

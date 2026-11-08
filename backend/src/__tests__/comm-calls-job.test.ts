import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as any;

// JOB_FIXTURE.id starts with 'j' (not hex) so it fails z.string().uuid() —
// these tests need a hex-valid job id that survives body validation.
const JOB_ID = 'ab000000-0000-0000-0000-000000000077';
// A job reaches its lead only through its estimate (Job.estimate -> Estimate.lead_id);
// there is no Job.lead_id column. A from-scratch job has estimate: null and so no lead.
const JOB_ROW = { id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_FIXTURE.id, estimate: null };
const LEAD_ID = 'ab000000-0000-0000-0000-000000000088';
const JOB_WITH_LEAD = { ...JOB_ROW, estimate: { lead_id: LEAD_ID } };
const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';
const CALL_ID = 'cd000000-0000-0000-0000-000000000001';

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

// ── Calls: attach-by-origin on create ───────────────────
describe('POST /api/communication/calls — job stamping', () => {
  it('stamps job_id + job_label when job_id is provided', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.callSession.create.mockImplementation((a: any) =>
      Promise.resolve({ id: CALL_ID, ...a.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher'))
      .send({ direction: 'in', from_number: '5551234567', to_number: '5550001111', status: 'completed', job_id: JOB_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.callSession.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.call.jobId).toBe(JOB_ID);
    expect(res.body.call.jobLabel).toBe('J00077');
  });

  it('404s on a cross-org/unknown job_id and creates nothing', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher'))
      .send({ direction: 'in', from_number: '5551234567', to_number: '5550001111', status: 'completed', job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
  });
});

// ── Calls: manual attach from the call log ──────────────
describe('PATCH /api/communication/calls/:id/job — manual attach', () => {
  it('sets job_id + job_label from an org-scoped job', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW]) // pre-read (same-customer constraint)
      .mockResolvedValueOnce([{ ...CALL_ROW, job_id: JOB_ID, job_label: 'J00077' }]); // refetch
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_ID, job_label: 'J00077', lead_id: null },
    });
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expectOrgScoped(mockPrisma.callSession.findMany as Mock, ALPHA_ORG_ID);
    expect(res.body.call.jobId).toBe(JOB_ID);
    expect(res.body.call.jobLabel).toBe('J00077');
  });

  it('clears job_id + job_label on null', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.callSession.findMany.mockResolvedValue([{ ...CALL_ROW, job_id: null, job_label: null }]);
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    // Job and lead are one link, so detaching drops both (the lead was only ever
    // stamped as the job's companion). customer_id is left alone — it is the
    // independent ingest phone match, not something this endpoint set.
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: null, job_label: null, lead_id: null },
    });
    expect(res.body.call).not.toHaveProperty('jobId');
    expect(res.body.call).not.toHaveProperty('jobLabel');
  });

  it('404s when the call is cross-org (attach path, org scoping)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.callSession.findMany.mockResolvedValue([]); // pre-read misses in Org B
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('orgB_admin'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Call not found');
    expectOrgScoped(mockPrisma.callSession.findMany as Mock, ORG_B_ID);
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.updateMany).not.toHaveBeenCalled();
  });

  it('404s when the call is cross-org (clear path, updateMany count 0)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('orgB_admin'))
      .send({ job_id: null });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Call not found');
    expectOrgScoped(mockPrisma.callSession.updateMany as Mock, ORG_B_ID);
  });

  it('404s on a cross-org job_id without touching the call', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValue([CALL_ROW]);
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.callSession.updateMany).not.toHaveBeenCalled();
  });

  // The picker searches every job and lead in the org, so it will surface
  // targets outside the call's customer - and they must be pickable, or the
  // search offers results that cannot be chosen. There is no phone matching
  // behind a job, so the anchor is not the phone match's to constrain: the call
  // keeps the customer ingest resolved, and job_id is whatever was picked.
  it("accepts another customer's job and leaves customer_id alone", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW]) // customer-linked call
      .mockResolvedValueOnce([{ ...CALL_ROW, job_id: JOB_ID, job_label: 'J00077' }]);
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, customer_id: OTHER_CUSTOMER_ID });
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(200);
    const data = mockPrisma.callSession.updateMany.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data).not.toHaveProperty('customer_id');
    expect(res.body.call.customerId).toBe(CUSTOMER_FIXTURE.id);
  });

  it('accepts any org job for an unknown-caller call (no customer_id)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null }])
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null, job_id: JOB_ID, job_label: 'J00077' }]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    expect(res.body.call.jobId).toBe(JOB_ID);
    expect(res.body.call.jobLabel).toBe('J00077');
  });

  it('403s for SALES (read-only Communication)', async () => {
    mockAuthAs('sales');
    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('sales'))
      .send({ job_id: null });
    expect(res.status).toBe(403);
    expect(mockPrisma.callSession.updateMany).not.toHaveBeenCalled();
  });
});

// ── One link, three columns ─────────────────────────────
//
// A call is "about" one thing. Picking the job or the lead is the same choice
// made from two ends, so one attach stamps the whole customer/job/lead triple
// rather than leaving the other columns stale. Job -> lead resolves through the
// job's estimate (Job.estimate -> Estimate.lead_id); there is no Job.lead_id.
describe('PATCH /api/communication/calls/:id/job — companion lead + customer', () => {
  it("stamps the job's lead alongside the job", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW])
      .mockResolvedValueOnce([{ ...CALL_ROW, job_id: JOB_ID, job_label: 'J00077', lead_id: LEAD_ID }]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_WITH_LEAD);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_ID, job_label: 'J00077', lead_id: LEAD_ID },
    });
    expect(res.body.call.leadId).toBe(LEAD_ID);
  });

  // customer_id belongs to the ingest phone match alone. A job carries a
  // customer, so stamping it here is tempting - but it is a guess derived from
  // one click, and writing it locks the call to that customer: the same-customer
  // guard above then 404s every other target, and detach does not clear it, so a
  // mis-attach becomes uncorrectable. The anchor is job/lead only.
  it('leaves an unknown caller unknown - an attach never writes customer_id', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null }])
      .mockResolvedValueOnce([{ ...CALL_ROW, customer_id: null, job_id: JOB_ID, job_label: 'J00077' }]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });

    expect(res.status).toBe(200);
    expect(mockPrisma.callSession.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_ID, job_label: 'J00077', lead_id: null },
    });
    expect(res.body.call.customerId).toBeUndefined();
  });

  it('never overwrites a customer_id the phone match already resolved', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany
      .mockResolvedValueOnce([CALL_ROW]) // customer-linked already
      .mockResolvedValueOnce([{ ...CALL_ROW, job_id: JOB_ID, job_label: 'J00077' }]);
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    await request(app).patch(`/api/communication/calls/${CALL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });

    const data = mockPrisma.callSession.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('customer_id');
  });
});

/**
 * ctm-call-attribution.test.ts — comm slice E1: PendingCallAttribution spine.
 *
 * Click-to-call (POST /calls, CTM branch) answers 202 and writes NO local row —
 * the 'starts'/'end' webhooks create the CallSession later — so any job/lead/
 * customer context picked in the dialer was silently dropped, and outbound
 * calls ingested with answered_by 'none' (nobody knew who placed them).
 *
 * This slice stashes the context server-side (pending_call_attributions) right
 * before the bridge and consumes it in ingestCall: newest unconsumed row for
 * the destination within a 30-min window, claimed atomically (updateMany
 * filtered on consumed_at: null) so a starts/end race can never double-apply,
 * with a requested_by → answered_by 'csr' fallback for agent-less payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { ingestCall } from '../lib/ctm/ingest';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const JOB_ID = 'ab000000-0000-0000-0000-000000000077';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000031';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000042';
const PENDING_ID = 'f0000000-0000-0000-0000-000000000001';

const OUT_BODY = {
  direction: 'out',
  from_number: '(551) 282-7064',
  to_number: '(555) 123-4567',
  status: 'ringing',
};

/** Org connected to CTM with one active tracking number to dial from. */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.placeCall.mockResolvedValue({ status: 'success' });
  p.auditLog.create.mockResolvedValue({});
  p.pendingCallAttribution.create.mockResolvedValue({ id: PENDING_ID });
  p.pendingCallAttribution.deleteMany.mockResolvedValue({ count: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts defaults: platform unconfigured, allowlist inert.
  client.isCtmConfigured.mockReturnValue(false);
  client.isOutboundAllowed.mockReturnValue(true);
});

// ─── POST /calls (CTM branch): stash the context before the bridge ──────────

describe('POST /api/communication/calls — pending attribution stash (CTM branch)', () => {
  it('job_id context: org-scoped resolve, pending row stashed (E.164 + job fields + requested_by) BEFORE placeCall, 202, NO CallSession row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_ID });

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, job_id: JOB_ID });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, outcome_since: expect.any(String) });

    expect(p.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: JOB_ID, organization_id: ALPHA_ORG_ID }),
      }),
    );
    expect(p.pendingCallAttribution.create).toHaveBeenCalledWith({
      data: {
        to_number: '+15551234567',
        job_id: JOB_ID,
        job_label: 'J00077',
        lead_id: null,
        customer_id: CUSTOMER_ID,
        requested_by: TEST_USERS.dispatcher.id,
        organization_id: ALPHA_ORG_ID,
      },
    });
    // The stash must be committed before CTM starts ringing anyone.
    expect(p.pendingCallAttribution.create.mock.invocationCallOrder[0]).toBeLessThan(
      client.placeCall.mock.invocationCallOrder[0],
    );
    expect(client.placeCall).toHaveBeenCalled();
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it('sweeps stale stash rows (>24h) opportunistically on the same request', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_ID });

    const before = Date.now();
    await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, job_id: JOB_ID });

    expect(p.pendingCallAttribution.deleteMany).toHaveBeenCalledWith({
      where: { organization_id: ALPHA_ORG_ID, created_at: { lt: expect.any(Date) } },
    });
    const lt: Date = p.pendingCallAttribution.deleteMany.mock.calls[0][0].where.created_at.lt;
    expect(lt.getTime()).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(lt.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('404s a cross-org/unknown job_id — no pending row, no bridge', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, job_id: JOB_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it('404s a cross-org/unknown lead_id — no pending row, no bridge', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Lead not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it('404s a cross-org/unknown customer_id — no pending row, no bridge', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, customer_id: CUSTOMER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it("lead_id context: pending carries lead_id + the lead's customer_id", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.lead.findFirst.mockResolvedValue({ id: LEAD_ID, customer_id: CUSTOMER_ID });

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, lead_id: LEAD_ID });

    expect(res.status).toBe(202);
    expect(p.pendingCallAttribution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lead_id: LEAD_ID,
        customer_id: CUSTOMER_ID,
        job_id: null,
        job_label: null,
      }),
    });
  });

  it('502 when CTM rejects the bridge — the freshly-stashed pending row is deleted', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_ID });
    client.placeCall.mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, job_id: JOB_ID });

    expect(res.status).toBe(502);
    expect(p.pendingCallAttribution.deleteMany).toHaveBeenCalledWith({
      where: { id: PENDING_ID },
    });
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it('allowlist 409 fires BEFORE any resolve or stash', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, job_id: JOB_ID });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(p.job.findUnique).not.toHaveBeenCalled();
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it('no context ids → byte-identical click-to-call: no resolves, no stash, no sweep', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, outcome_since: expect.any(String) });
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(p.pendingCallAttribution.deleteMany).not.toHaveBeenCalled();
    expect(p.job.findUnique).not.toHaveBeenCalled();
    expect(p.lead.findFirst).not.toHaveBeenCalled();
    expect(p.customer.findFirst).not.toHaveBeenCalled();
  });

  it('mock (non-CTM) path: explicit customer_id resolves org-scoped and stamps the row', async () => {
    mockAuthAs('dispatcher');
    // isCtmConfigured stays false → legacy local-row path.
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
    p.lead.findFirst.mockResolvedValue(null);
    p.vendor.findFirst.mockResolvedValue(null);
    p.vendorContact.findFirst.mockResolvedValue(null);
    p.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-1', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      // from_number that fails E.164 normalization → matchByPhone returns null,
      // so the stamped customer can only come from the explicit id.
      .send({ ...OUT_BODY, from_number: 'blocked', customer_id: CUSTOMER_ID });

    expect(res.status).toBe(201);
    expect(p.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CUSTOMER_ID, organization_id: ALPHA_ORG_ID }),
      }),
    );
    expect(p.callSession.create.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_ID);
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
  });

  it('mock (non-CTM) path: 404s a cross-org/unknown customer_id and creates nothing', async () => {
    mockAuthAs('dispatcher');
    p.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send({ ...OUT_BODY, customer_id: CUSTOMER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
    expect(p.callSession.create).not.toHaveBeenCalled();
  });
});

// ─── POST /calls/attribution: softphone stash (WebRTC places the call itself) ─

describe('POST /api/communication/calls/attribution — softphone stash (no bridge)', () => {
  it('job_id context: org-scoped resolve, stash written (E.164 + job fields + requested_by), 202, and NO call is bridged', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_ID });

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', job_id: JOB_ID });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });

    expect(p.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: JOB_ID, organization_id: ALPHA_ORG_ID }),
      }),
    );
    expect(p.pendingCallAttribution.create).toHaveBeenCalledWith({
      data: {
        to_number: '+15551234567',
        job_id: JOB_ID,
        job_label: 'J00077',
        lead_id: null,
        customer_id: CUSTOMER_ID,
        requested_by: TEST_USERS.dispatcher.id,
        organization_id: ALPHA_ORG_ID,
      },
    });
    // The WebRTC softphone dials CTM directly — the server must NEVER bridge here.
    expect(client.placeCall).not.toHaveBeenCalled();
    expect(p.callSession.create).not.toHaveBeenCalled();
  });

  it("lead_id context: stash carries lead_id + the lead's customer_id", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.lead.findFirst.mockResolvedValue({ id: LEAD_ID, customer_id: CUSTOMER_ID });

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', lead_id: LEAD_ID });

    expect(res.status).toBe(202);
    expect(p.pendingCallAttribution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lead_id: LEAD_ID,
        customer_id: CUSTOMER_ID,
        job_id: null,
        job_label: null,
      }),
    });
    expect(client.placeCall).not.toHaveBeenCalled();
  });

  it('404s a cross-org/unknown job_id — no stash written', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', job_id: JOB_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
  });

  it('404s a cross-org/unknown lead_id — no stash written', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', lead_id: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Lead not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
  });

  it('404s a cross-org/unknown customer_id — no stash written', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', customer_id: CUSTOMER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
  });

  it('sweeps stale stash rows (>24h) opportunistically', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.job.findUnique.mockResolvedValue({ id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_ID });

    const before = Date.now();
    await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567', job_id: JOB_ID });

    expect(p.pendingCallAttribution.deleteMany).toHaveBeenCalledWith({
      where: { organization_id: ALPHA_ORG_ID, created_at: { lt: expect.any(Date) } },
    });
    const lt: Date = p.pendingCallAttribution.deleteMany.mock.calls[0][0].where.created_at.lt;
    expect(lt.getTime()).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(lt.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('no context ids → nothing stashed, 202 queued:false', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();

    const res = await request(app)
      .post('/api/communication/calls/attribution')
      .set(authHeader('dispatcher'))
      .send({ to_number: '(555) 123-4567' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: false });
    expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
    expect(p.pendingCallAttribution.deleteMany).not.toHaveBeenCalled();
    expect(p.job.findUnique).not.toHaveBeenCalled();
  });
});

// ─── ingestCall: consume the stash on the webhook side ──────────────────────

const ORG_ID = 'org-1';

const OUT_STARTS = {
  sid: 'CA8001',
  account_id: 500001,
  direction: 'outbound',
  tracking_number: '+12395395911',
  called_number: '+15551234567',
  unix_time: 1_752_400_000,
};
const OUT_END = { ...OUT_STARTS, dial_status: 'answered', talk_time: 33 };

const PENDING_ROW = {
  id: PENDING_ID,
  to_number: '+15551234567',
  job_id: JOB_ID,
  job_label: 'J00077',
  lead_id: null,
  customer_id: CUSTOMER_ID,
  requested_by: TEST_USERS.dispatcher.id,
  created_at: new Date(),
  consumed_at: null,
  organization_id: ORG_ID,
};

// A stash keyed to the customer's ORIGINAL number, placed by the dispatcher.
// The webhook below reports a DIFFERENT (edited) dialed number, so only a
// placer match — not a number match — can reunite the call with its job.
const PLACER_ROW = {
  ...PENDING_ROW,
  to_number: '+19739516607',
};

// Outbound end whose agent leg resolves to the placing user (via agent.email),
// and whose dialed number is NOT the stash's number (the caller edited it to
// reach a cell). This is exactly the flow Ran demoed.
const OUT_END_EDITED = {
  sid: 'CA8009',
  account_id: 500001,
  direction: 'outbound',
  tracking_number: '+12395395911',
  called_number: '+15555550199',
  unix_time: 1_752_400_000,
  dial_status: 'answered',
  talk_time: 20,
  agent: { id: 'USR-PLACER', name: 'Placer User', email: 'placer@test.com' },
};

describe('ingestCall — pending attribution consume', () => {
  beforeEach(() => {
    p.customer.findFirst.mockResolvedValue(null);
    p.lead.findFirst.mockResolvedValue(null);
    p.vendor.findFirst.mockResolvedValue(null);
    p.vendorContact.findFirst.mockResolvedValue(null);
    p.user.findFirst.mockResolvedValue(null);
    p.callSession.findFirst.mockResolvedValue(null);
    p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
    p.pendingCallAttribution.findFirst.mockResolvedValue(null);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });
  });

  it("outbound 'starts' with a live pending row: windowed lookup, atomic claim, job/customer stamped into create", async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });

    await ingestCall(prisma, ORG_ID, OUT_STARTS, 'starts');

    const lookup = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(lookup.where).toEqual({
      organization_id: ORG_ID,
      to_number: '+15551234567',
      consumed_at: null,
      created_at: { gte: expect.any(Date) },
    });
    expect(lookup.orderBy).toEqual({ created_at: 'desc' });

    expect(p.pendingCallAttribution.updateMany).toHaveBeenCalledWith({
      where: { id: PENDING_ID, consumed_at: null },
      data: { consumed_at: expect.any(Date) },
    });

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.job_id).toBe(JOB_ID);
    expect(args.create.job_label).toBe('J00077');
    expect(args.create.customer_id).toBe(CUSTOMER_ID);
    expect(args.create.lead_id).toBeNull();
    // Out-of-order rule unchanged: a starts never updates an existing row.
    expect(args.update).toEqual({});
  });

  it("'end' creating the row (missed starts): same stamping on create AND update", async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.job_id).toBe(JOB_ID);
    expect(args.create.job_label).toBe('J00077');
    expect(args.create.customer_id).toBe(CUSTOMER_ID);
    expect(args.update.job_id).toBe(JOB_ID);
    expect(args.update.job_label).toBe('J00077');
    expect(args.update.customer_id).toBe(CUSTOMER_ID);
  });

  it("'end' updating a row that already HAS a job: pending never consulted, nothing clobbered", async () => {
    p.callSession.findFirst.mockResolvedValue({ organization_id: ORG_ID, job_id: 'already-linked' });

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    expect(p.pendingCallAttribution.findFirst).not.toHaveBeenCalled();
    expect(p.pendingCallAttribution.updateMany).not.toHaveBeenCalled();
    const args = p.callSession.upsert.mock.calls[0][0];
    expect('job_id' in args.update).toBe(false);
    expect('job_label' in args.update).toBe(false);
  });

  it("'end' updating a row whose job_id is null DOES consult the pending stash", async () => {
    p.callSession.findFirst.mockResolvedValue({ organization_id: ORG_ID, job_id: null });
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.update.job_id).toBe(JOB_ID);
    expect(args.update.job_label).toBe('J00077');
  });

  it('expired pendings are excluded by the 30-min gte bound (no claim, no stamp)', async () => {
    const before = Date.now();
    await ingestCall(prisma, ORG_ID, OUT_STARTS, 'starts');
    const after = Date.now();

    const gte: Date = p.pendingCallAttribution.findFirst.mock.calls[0][0].where.created_at.gte;
    expect(gte.getTime()).toBeGreaterThanOrEqual(before - 30 * 60_000);
    expect(gte.getTime()).toBeLessThanOrEqual(after - 30 * 60_000);
    expect(p.pendingCallAttribution.updateMany).not.toHaveBeenCalled();
    expect(p.callSession.upsert.mock.calls[0][0].create.job_id).toBeNull();
  });

  it('claim race (updateMany count 0): the pending data is NOT used', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });

    await ingestCall(prisma, ORG_ID, OUT_STARTS, 'starts');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.job_id).toBeNull();
    expect(args.create.job_label).toBeNull();
    expect(args.create.customer_id).toBeNull();
  });

  it('resolver-vs-pending precedence: matchByPhone customer WINS; pending still fills the job', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });
    p.customer.findFirst.mockResolvedValue({
      id: 'cust-match', first_name: 'Ada', last_name: 'Match', company_name: null,
    });

    await ingestCall(prisma, ORG_ID, OUT_STARTS, 'starts');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.customer_id).toBe('cust-match');
    expect(args.create.job_id).toBe(JOB_ID);
  });

  it("inbound 'starts' never consults the click-to-call stash - only the caller-keyed call-tracking half", async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      {
        sid: 'CA8002',
        direction: 'inbound',
        caller_number: '+15551234567',
        tracking_number: '+12395395911',
        unix_time: 1_752_400_000,
      },
      'starts',
    );

    // The external call-tracking join (lib/call-tracking) reads the stash by
    // CALLER and only rows a vendor wrote (provider set); the click-to-call
    // selectors (to_number / requested_by) are never used inbound.
    expect(p.pendingCallAttribution.findFirst).toHaveBeenCalledTimes(1);
    const where = p.pendingCallAttribution.findFirst.mock.calls[0][0].where;
    expect(where.from_number).toBe('+15551234567');
    expect(where.provider).toEqual({ not: null });
    expect(where.to_number).toBeUndefined();
    expect(where.requested_by).toBeUndefined();
  });

  it("requested_by fallback: agent-less outbound + claimed pending → answered_by 'csr' with the requester's name/email + agent_id", async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });
    p.user.findFirst.mockResolvedValue({
      id: TEST_USERS.dispatcher.id,
      first_name: 'Test',
      last_name: 'Dispatcher',
      email: 'dispatch@test.com',
    });

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    expect(p.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_USERS.dispatcher.id, organization_id: ORG_ID },
      }),
    );
    const expected = {
      kind: 'csr',
      ctm_agent_id: null,
      name: 'Test Dispatcher',
      email: 'dispatch@test.com',
    };
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.answered_by).toEqual(expected);
    expect(args.create.agent_id).toBe(TEST_USERS.dispatcher.id);
    expect(args.update.answered_by).toEqual(expected);
    expect(args.update.agent_id).toBe(TEST_USERS.dispatcher.id);
  });

  it('CTM agent payload still WINS over the requested_by fallback', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });
    p.user.findFirst.mockResolvedValue({ id: 'agent-user-1' });

    await ingestCall(
      prisma,
      ORG_ID,
      { ...OUT_END, agent: { id: 'USR9', name: 'Emanuel Dahan', email: 'e@x.com' } },
      'end',
    );

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.answered_by).toEqual({
      kind: 'csr',
      ctm_agent_id: 'USR9',
      name: 'Emanuel Dahan',
      email: 'e@x.com',
    });
    // Only the agent-email lookup ran — the requester fallback never fired.
    expect(p.user.findFirst).toHaveBeenCalledTimes(1);
    expect(p.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'e@x.com' }) }),
    );
  });

  it('requester not found in the org: answered_by stays none, no agent_id', async () => {
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW);
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });
    p.user.findFirst.mockResolvedValue(null);

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.answered_by.kind).toBe('none');
    expect(args.create.agent_id).toBeNull();
    // Context stamping is independent of the who-placed fallback.
    expect(args.create.job_id).toBe(JOB_ID);
  });

  // ── Placer match (Ran's model): attribute by WHO placed the call, not by the
  //    dialed number, so editing the number to reach a cell keeps the job ──────
  it('placer match: an edited number (stash keyed elsewhere) still attaches via the placer', async () => {
    // agent.email resolves to the placer; the stash is keyed to the customer's
    // original number, but the call went to an edited number → tier-1 (number)
    // misses, tier-2 (placer) attaches.
    p.user.findFirst.mockResolvedValue({ id: TEST_USERS.dispatcher.id });
    p.pendingCallAttribution.findFirst
      .mockResolvedValueOnce(null) // tier-1: nothing for the dialed number
      .mockResolvedValueOnce(PLACER_ROW); // tier-2: the placer's newest stash
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });

    await ingestCall(prisma, ORG_ID, OUT_END_EDITED, 'end');

    // tier-1 keyed off the dialed number…
    const tier1 = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(tier1.where).toEqual({
      organization_id: ORG_ID,
      to_number: '+15555550199',
      consumed_at: null,
      created_at: { gte: expect.any(Date) },
    });
    // …then, on a miss, tier-2 keyed off the resolved placer with NO number.
    expect(p.pendingCallAttribution.findFirst).toHaveBeenCalledTimes(2);
    const tier2 = p.pendingCallAttribution.findFirst.mock.calls[1][0];
    expect(tier2.where).toEqual({
      organization_id: ORG_ID,
      requested_by: TEST_USERS.dispatcher.id,
      consumed_at: null,
      created_at: { gte: expect.any(Date) },
    });
    expect(tier2.orderBy).toEqual({ created_at: 'desc' });

    expect(p.pendingCallAttribution.updateMany).toHaveBeenCalledWith({
      where: { id: PENDING_ID, consumed_at: null },
      data: { consumed_at: expect.any(Date) },
    });

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.job_id).toBe(JOB_ID);
    expect(args.create.job_label).toBe('J00077');
    expect(args.update.job_id).toBe(JOB_ID);
  });

  it('number match wins: a stash matching the dialed number is used, and the placer tier is never consulted', async () => {
    p.user.findFirst.mockResolvedValue({ id: TEST_USERS.dispatcher.id });
    p.pendingCallAttribution.findFirst.mockResolvedValue(PENDING_ROW); // tier-1 hits
    p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 1 });

    await ingestCall(
      prisma,
      ORG_ID,
      { ...OUT_END, agent: { id: 'USR-PLACER', name: 'Placer', email: 'placer@test.com' } },
      'end',
    );

    // Exactly one stash lookup — tier-1 by number. Tier-2 (placer) never ran.
    expect(p.pendingCallAttribution.findFirst).toHaveBeenCalledTimes(1);
    const only = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(only.where).toHaveProperty('to_number', '+15551234567');
    expect(only.where).not.toHaveProperty('requested_by');
    expect(p.callSession.upsert.mock.calls[0][0].create.job_id).toBe(JOB_ID);
  });

  it('no agent on the payload → the placer tier is skipped (number-only, unchanged)', async () => {
    // OUT_END carries no agent → no placer to key off → number lookup only.
    p.pendingCallAttribution.findFirst.mockResolvedValue(null);

    await ingestCall(prisma, ORG_ID, OUT_END, 'end');

    expect(p.pendingCallAttribution.findFirst).toHaveBeenCalledTimes(1);
    const only = p.pendingCallAttribution.findFirst.mock.calls[0][0];
    expect(only.where).not.toHaveProperty('requested_by');
    expect(p.callSession.upsert.mock.calls[0][0].create.job_id).toBeNull();
  });
});

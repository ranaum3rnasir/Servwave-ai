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
// attribution tests need a hex-valid job id that survives body validation.
const JOB_ID = 'ab000000-0000-0000-0000-000000000077';
const JOB_ROW = { id: JOB_ID, job_number: 'J00077', customer_id: CUSTOMER_FIXTURE.id };
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const CHAT_ID = 'b2c3d4e5-0000-0000-0000-000000000001';
const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';
const VENDOR_ID = 'd0000000-0000-0000-0000-000000000001';
const EMAIL_ID = 'e0000000-0000-0000-0000-000000000001';

// Minimal row shape mapEmail needs back from the post-update re-read.
const EMAIL_ROW = {
  id: EMAIL_ID, account: 'user', from: {}, to: 'x@y.com', subject: 'Job update',
  snippet: 'line one', body: ['line one'], at: '10:00 AM', ts: BigInt(1),
  unread: false, starred: false, folder: 'sent', customer_id: CUSTOMER_FIXTURE.id,
};

// The internal-lane guard as it must appear in Prisma where clauses. kind is
// nullable, so it has to be this OR shape — a bare { kind: { not: 'team' } }
// would silently exclude kind-NULL (customer) rows too.
const KIND_GUARD = { OR: [{ kind: null }, { kind: 'customer' }] };

const DAY_MS = 24 * 60 * 60 * 1000;

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

function mockCustomerThread(overrides: Record<string, unknown> = {}) {
  mockPrisma.messageThread.findFirst.mockResolvedValue({
    id: THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
    customer_id: CUSTOMER_FIXTURE.id, lead_id: null, vendor_id: null, kind: null,
    organization_id: ALPHA_ORG_ID, ...overrides,
  });
}

function mockMessageCreate() {
  mockPrisma.message.create.mockImplementation((a: any) =>
    Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }));
}

// ── SMS: attach-by-origin ───────────────────────────────
describe('POST /api/communication/sms — attach-by-origin', () => {
  it('stamps job_id + job_label when jobId is provided', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'On my way', jobId: JOB_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.message.jobId).toBe(JOB_ID);
    expect(res.body.message.jobLabel).toBe('J00077');
  });

  it('404s on a cross-org/unknown jobId and creates nothing', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hi', jobId: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it('400s an explicit jobId on a team thread (internal lanes are never job-tagged)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ kind: 'team', customer_id: null });
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'internal note', jobId: JOB_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Internal threads cannot be job-tagged');
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it('400s an explicit jobId on a group thread (group is an internal lane too)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ kind: 'group', customer_id: null });
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'group note', jobId: JOB_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Internal threads cannot be job-tagged');
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  // Same-customer constraint: on a customer-owned thread, another customer's job
  // is treated as nonexistent in this context → 404 (same as cross-org).
  it("404s a jobId belonging to another customer on a customer thread and creates nothing", async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, customer_id: OTHER_CUSTOMER_ID });
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hi', jobId: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it('stamps any org job on a thread without a customer (vendor threads keep org-scope-only validation)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ customer_id: null, vendor_id: VENDOR_ID });
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Order the parts', jobId: JOB_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
  });
});

// ── SMS: inbound auto-route (best-effort, recency-gated) ──
describe('POST /api/communication/sms — inbound auto-route', () => {
  it('routes an inbound reply to the recent live outbound job text', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.message.findMany.mockResolvedValue([
      { job_id: JOB_ID, job_label: 'J00077', ts: new Date(Date.now() - 2 * DAY_MS), job: { status: 'SCHEDULED' } },
    ]);
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Sounds good', direction: 'in' });
    expect(res.status).toBe(201);
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    expectOrgScoped(mockPrisma.message.findMany as Mock, ALPHA_ORG_ID);
    const call = mockPrisma.message.findMany.mock.calls[0][0];
    expect(call.where.thread_id).toBe(THREAD_ID);
    expect(call.where.direction).toBe('out');
    expect(call.where.job_id).toEqual({ not: null });
    expect(call.where.ts).toHaveProperty('gte');
    // Truncation guard: dedupe per job at the DB (distinct + ts-desc → first
    // row per job is its latest outbound) so a chatty job can't starve older
    // live jobs out of a take-N window.
    expect(call.orderBy).toEqual({ ts: 'desc' });
    expect(call.distinct).toEqual(['job_id']);
    expect(call.take).toBe(10);
  });

  it('routes a vendor-thread inbound reply from its outbound job text (story 28)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ customer_id: null, vendor_id: VENDOR_ID });
    mockPrisma.message.findMany.mockResolvedValue([
      { job_id: JOB_ID, job_label: 'J00077', ts: new Date(Date.now() - 2 * DAY_MS), job: { status: 'SCHEDULED' } },
    ]);
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Parts are in', direction: 'in' });
    expect(res.status).toBe(201);
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    // Candidate query stays scoped to this thread.
    expect(mockPrisma.message.findMany.mock.calls[0][0].where.thread_id).toBe(THREAD_ID);
  });

  it('creates with job_id null when all candidates are closed or stale (Unrouted tray)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.message.findMany.mockResolvedValue([
      // Closed but recent — never routed to.
      { job_id: 'ab000000-0000-0000-0000-000000000088', job_label: 'J00088', ts: new Date(Date.now() - DAY_MS), job: { status: 'COMPLETED' } },
      // Live but stale (outside the recency window) — never routed to.
      { job_id: 'ab000000-0000-0000-0000-000000000099', job_label: 'J00099', ts: new Date(Date.now() - 40 * DAY_MS), job: { status: 'SCHEDULED' } },
    ]);
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'Who is this?', direction: 'in' });
    expect(res.status).toBe(201);
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBeUndefined();
    expect(data.job_label).toBeUndefined();
    expect(res.body.message).not.toHaveProperty('jobId');
  });

  it('never auto-routes on a team thread', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ kind: 'team' });
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'internal note', direction: 'in' });
    expect(res.status).toBe(201);
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBeUndefined();
    expect(data.job_label).toBeUndefined();
  });

  it('never auto-routes on a group thread (internal lane, same as team)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ kind: 'group' });
    mockMessageCreate();
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'group note', direction: 'in' });
    expect(res.status).toBe(201);
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    const data = mockPrisma.message.create.mock.calls[0][0].data;
    expect(data.job_id).toBeUndefined();
    expect(data.job_label).toBeUndefined();
  });
});

// ── SMS: one-click reassign ─────────────────────────────
describe('PATCH /api/communication/sms/:id/job — one-click reassign', () => {
  it('sets job_id + job_label from an org-scoped job', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: MSG_ID, direction: 'in', body: 'Sounds good', ts: new Date(), status: 'received', automated: false, job_id: JOB_ID, job_label: 'J00077' },
    ]);
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    // Thread resolved by message membership, org-scoped.
    expect(mockPrisma.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ messages: { some: { id: MSG_ID } }, organization_id: ALPHA_ORG_ID }),
      })
    );
    // The internal-lane guard rides the atomic updateMany where too.
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: MSG_ID, organization_id: ALPHA_ORG_ID, thread: KIND_GUARD },
      data: { job_id: JOB_ID, job_label: 'J00077' },
    });
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.message.jobId).toBe(JOB_ID);
    expect(res.body.message.jobLabel).toBe('J00077');
  });

  it('clears job_id + job_label on null (back to the Unrouted tray)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: MSG_ID, direction: 'in', body: 'x', ts: new Date(), status: 'received', automated: false, job_id: null, job_label: null },
    ]);
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    // No job to validate → no thread pre-fetch; the updateMany guard alone
    // keeps internal-lane messages 404ing on the clear path too.
    expect(mockPrisma.messageThread.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: MSG_ID, organization_id: ALPHA_ORG_ID, thread: KIND_GUARD },
      data: { job_id: null, job_label: null },
    });
    expect(res.body.message).not.toHaveProperty('jobId');
    expect(res.body.message).not.toHaveProperty('jobLabel');
  });

  it('404s when the message is cross-org (org scoping)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.message.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('orgB_admin'))
      .send({ job_id: null });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
    expectOrgScoped(mockPrisma.message.updateMany as Mock, ORG_B_ID);
  });

  it('404s on a cross-org job_id without touching the message', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('404s a reassign of a group-thread message (internal lanes are never job-tagged)', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ kind: 'group', customer_id: null });
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  // Same-customer constraint mirrors sendMessage: a foreign customer's job is
  // indistinguishable from a nonexistent one → 404 'Job not found'.
  it("404s a reassign to another customer's job without touching the message", async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread();
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, customer_id: OTHER_CUSTOMER_ID });
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('reassigns any org job on a customer-less (vendor) thread — org-scope-only validation', async () => {
    mockAuthAs('dispatcher');
    mockCustomerThread({ customer_id: null, vendor_id: VENDOR_ID });
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([
      { id: MSG_ID, direction: 'in', body: 'Parts ready', ts: new Date(), status: 'received', automated: false, job_id: JOB_ID, job_label: 'J00077' },
    ]);
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    expect(res.body.message.jobId).toBe(JOB_ID);
    expect(res.body.message.jobLabel).toBe('J00077');
  });

  it('403s for SALES (read-only)', async () => {
    mockAuthAs('sales');
    const res = await request(app).patch(`/api/communication/sms/${MSG_ID}/job`).set(authHeader('sales'))
      .send({ job_id: null });
    expect(res.status).toBe(403);
  });
});

// ── Serializers expose attribution ──────────────────────
describe('GET /api/communication/threads — serializers expose attribution', () => {
  it('messages carry jobId/jobLabel and omit them when null', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.messageThread.findMany.mockResolvedValue([{
      id: THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: null, lead_id: null, vendor_id: null, customer: null, lead: null, vendor: null,
      messages: [
        { id: 'm1', direction: 'out', body: 'tagged', ts: new Date(), status: 'sent', automated: false, job_id: JOB_ID, job_label: 'J00077' },
        { id: 'm2', direction: 'in', body: 'untagged', ts: new Date(), status: 'received', automated: false, job_id: null, job_label: null },
      ],
    }]);
    const res = await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const [tagged, untagged] = res.body.threads[0].messages;
    expect(tagged.jobId).toBe(JOB_ID);
    expect(tagged.jobLabel).toBe('J00077');
    expect(untagged).not.toHaveProperty('jobId');
    expect(untagged).not.toHaveProperty('jobLabel');
  });
});

// ── Email: attach-by-origin ─────────────────────────────
describe('POST /api/communication/emails — attach-by-origin', () => {
  // The record-only email branch is DEMO-ORG-ONLY (a real org gets 501
  // EMAIL_SEND_NOT_CONFIGURED until the Resend send path lands). These stamping
  // tests exercise the record-only path, so the org resolves as demo.
  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
  });

  it('stamps job_id + job_label when job_id is provided', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.email.create.mockImplementation((a: any) => Promise.resolve({ id: 'em1', ...a.data }));
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', subject: 'Job update', body: ['line one'], job_id: JOB_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.email.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.email.jobId).toBe(JOB_ID);
    expect(res.body.email.jobLabel).toBe('J00077');
  });

  it('404s on a cross-org/unknown job_id and creates nothing', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', body: ['hi'], job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.email.create).not.toHaveBeenCalled();
  });

  it('stamps customer_id when customer_id is provided', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.email.create.mockImplementation((a: any) => Promise.resolve({ id: 'em1', ...a.data }));
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', body: ['hi'], customer_id: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(201);
    expect(mockPrisma.email.create.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expectOrgScoped(mockPrisma.customer.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.email.customerId).toBe(CUSTOMER_FIXTURE.id);
  });

  it('404s on a cross-org/unknown customer_id and creates nothing', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', body: ['hi'], customer_id: CUSTOMER_FIXTURE.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
    expect(mockPrisma.email.create).not.toHaveBeenCalled();
  });

  // Regression: the InboxPage composer path passes NO customer_id; after this
  // change it must still 201, never touch the customer guard, and persist no
  // customer_id — byte-identical to today. Green before AND after.
  it('still 201s and stamps no customer_id when customer_id is omitted', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.create.mockImplementation((a: any) => Promise.resolve({ id: 'em1', ...a.data }));
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', body: ['hi'] });
    expect(res.status).toBe(201);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.email.create.mock.calls[0][0].data.customer_id).toBeUndefined();
  });
});

// ── Email: one-click reassign (mirror of PATCH /sms/:id/job) ──
// Emails have no MessageThread, so there is no internal-lane (kind) guard here.
// The email ROW itself carries customer_id, which plays the part the thread's
// customer_id plays for SMS: a customer-anchored email only accepts that
// customer's jobs; a customer-less one keeps org-scope-only validation.
describe('PATCH /api/communication/emails/:id/job - one-click reassign', () => {
  it('sets job_id + job_label from an org-scoped job', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.findFirst
      .mockResolvedValueOnce({ id: EMAIL_ID, customer_id: CUSTOMER_FIXTURE.id })
      .mockResolvedValueOnce({ ...EMAIL_ROW, job_id: JOB_ID, job_label: 'J00077' });
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    // The email is resolved org-scoped before the job is even looked at.
    expect(mockPrisma.email.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: EMAIL_ID, organization_id: ALPHA_ORG_ID }),
      })
    );
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    // Atomic id+org update - no TOCTOU window, same shape as the SMS mirror.
    expect(mockPrisma.email.updateMany).toHaveBeenCalledWith({
      where: { id: EMAIL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: JOB_ID, job_label: 'J00077' },
    });
    expect(res.body.email.jobId).toBe(JOB_ID);
    expect(res.body.email.jobLabel).toBe('J00077');
  });

  it('clears job_id + job_label on null', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.email.findFirst.mockResolvedValue({ ...EMAIL_ROW, job_id: null, job_label: null });
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.email.updateMany).toHaveBeenCalledWith({
      where: { id: EMAIL_ID, organization_id: ALPHA_ORG_ID },
      data: { job_id: null, job_label: null },
    });
    expect(res.body.email).not.toHaveProperty('jobId');
    expect(res.body.email).not.toHaveProperty('jobLabel');
  });

  it('404s when the email is cross-org (org scoping)', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.email.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('orgB_admin'))
      .send({ job_id: null });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email not found');
    expectOrgScoped(mockPrisma.email.updateMany as Mock, ORG_B_ID);
  });

  it('404s on a cross-org email id on the assign path too, without looking up the job', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.email.findFirst.mockResolvedValue(null);
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('orgB_admin'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email not found');
    expect(mockPrisma.job.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  it('404s on a cross-org job_id without touching the email', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.findFirst.mockResolvedValue({ id: EMAIL_ID, customer_id: null });
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  // Same-customer constraint mirrors the SMS reassign: another customer's job
  // is indistinguishable from a nonexistent one → 404 'Job not found'.
  it("404s a reassign to another customer's job without touching the email", async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.findFirst.mockResolvedValue({ id: EMAIL_ID, customer_id: CUSTOMER_FIXTURE.id });
    mockPrisma.job.findUnique.mockResolvedValue({ ...JOB_ROW, customer_id: OTHER_CUSTOMER_ID });
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  it('reassigns any org job on a customer-less (vendor) email - org-scope-only validation', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.findFirst
      .mockResolvedValueOnce({ id: EMAIL_ID, customer_id: null })
      .mockResolvedValueOnce({ ...EMAIL_ROW, customer_id: null, vendor_id: VENDOR_ID, job_id: JOB_ID, job_label: 'J00077' });
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: JOB_ID });
    expect(res.status).toBe(200);
    expect(res.body.email.jobId).toBe(JOB_ID);
    expect(res.body.email.jobLabel).toBe('J00077');
  });

  it('403s for SALES (read-only)', async () => {
    mockAuthAs('sales');
    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('sales'))
      .send({ job_id: null });
    expect(res.status).toBe(403);
  });
});

// ── WhatsApp: attach-by-origin ──────────────────────────
describe('POST /api/communication/whatsapp — attach-by-origin', () => {
  beforeEach(() => {
    mockPrisma.whatsAppChat.findFirst.mockResolvedValue({ id: CHAT_ID, organization_id: ALPHA_ORG_ID });
    mockPrisma.whatsAppChat.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.whatsAppMessage.create.mockImplementation((a: any) =>
      Promise.resolve({ id: 'wm1', at: '10:00 AM', ...a.data }));
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
  });

  it('stamps job_id + job_label when job_id is provided', async () => {
    // WhatsApp is demo-locked at the route (requireDemoOrg), so every case in
    // this block has to authenticate as a demo org to reach the controller.
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.job.findUnique.mockResolvedValue(JOB_ROW);
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: CHAT_ID, text: 'hi', job_id: JOB_ID });
    expect(res.status).toBe(201);
    const data = mockPrisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(JOB_ID);
    expect(data.job_label).toBe('J00077');
    expectOrgScoped(mockPrisma.job.findUnique as Mock, ALPHA_ORG_ID);
    expect(res.body.message.jobId).toBe(JOB_ID);
    expect(res.body.message.jobLabel).toBe('J00077');
  });

  it('404s on a cross-org/unknown job_id and creates nothing', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.job.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: CHAT_ID, text: 'hi', job_id: JOB_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
    expect(mockPrisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});

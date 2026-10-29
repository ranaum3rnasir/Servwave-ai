/**
 * #2046 — the Communication SECTION gate (`access_inbox Communication`), one route per newly
 * gated FILE (spec §2, amended by the reviewer's R1/R2/R3): 403 for a caller holding
 * `read`+`create Communication` and NOT `access_inbox` (SALES today), 200 for the same shape of
 * caller once it holds the grant (DISPATCHER, which holds `access_inbox` from DEFAULT_GRANTS by
 * construction — see permissions-communication-section-backfill.test.ts).
 *
 * The GREEN CONTROL block below is the pair that stops a symptom-suppressing "gate the whole
 * router" fix: for the SAME no-`access_inbox` caller, every route the spec keeps UNGATED (R1's
 * by-id thread, R2's four record-surface routes, R3's email job-reassign, the record-tab
 * endpoints and the SMS compose path) must keep answering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader,
  ALPHA_ORG_ID, LEAD_FIXTURE, JOB_FIXTURE, CUSTOMER_FIXTURE, TEST_USERS,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

// A caller holding DISPATCHER's full Communication CRUD (including `update`) but hand-stripped
// of `access_inbox` - the shape R3's control needs. `mockAuthAs('dispatcher')` alone cannot prove
// PATCH /emails/:id/job is un-gated, because DISPATCHER holds access_inbox by construction; SALES
// cannot either, because it never holds `update Communication` regardless of this fix.
function mockDispatcherWithoutAccessInbox() {
  const rows = DEFAULT_GRANTS.filter(
    (g) => g.role === 'DISPATCHER' && !(g.action === 'access_inbox' && g.subject === 'Communication'),
  );
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

// #2046 R1: SALES-shaped grant, hand-injected past today's DEFAULT_GRANTS (which only give SALES
// `read Communication`) — the shape the finding proved reachable in prod (`create Communication`
// with no `access_inbox`, 3/8 prod orgs). Mirrors mockDispatcherWithAccessInbox in repro-2046.
function mockSalesWithCreateCommunication() {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => g.role === 'SALES'),
    { role: 'SALES', action: 'create', subject: 'Communication' },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

const LEAD_ID = LEAD_FIXTURE.id;
const JOB_ID = JOB_FIXTURE.id;
const CUSTOMER_ID = CUSTOMER_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();

  // Same generous defaults as repro-2046.test.ts's beforeEach, so the GATED-route 200 cases
  // (the DISPATCHER-with-the-grant half of each pair) reach their handler without a 500 from an
  // un-mocked delegate. The RED (403) cases never reach a handler at all — canDo blocks first.
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.message.findMany.mockResolvedValue([]);
  // `message.count` is not in setup.ts's base mock (comm-usage.test.ts's own beforeEach adds it
  // the same way) - the usage endpoint (GET /communication/usage) is the only gated route here
  // that calls it.
  mockPrisma.message.count = vi.fn().mockResolvedValue(0);
  mockPrisma.whatsAppChat.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.email.count.mockResolvedValue(0);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.phoneAgent.findMany.mockResolvedValue([]);
  mockPrisma.phoneNumber.findMany.mockResolvedValue([]);
  mockPrisma.callFlow.findMany.mockResolvedValue([]);
  mockPrisma.textTemplate.findMany.mockResolvedValue([]);
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York', comm_usage_uncapped: false });
});

// ─── One route per newly-gated FILE — RED without access_inbox, GREEN with it ───────────────

const GATED_ROUTES: { file: string; method: 'get'; path: string; demoOrgOnly?: boolean }[] = [
  { file: 'comm-threads.routes.ts',  method: 'get', path: '/api/communication/threads' },
  { file: 'comm-calls.routes.ts',    method: 'get', path: '/api/communication/calls' },
  { file: 'comm-email.routes.ts',    method: 'get', path: '/api/communication/emails' },
  { file: 'comm-whatsapp.routes.ts', method: 'get', path: '/api/communication/whatsapp', demoOrgOnly: true },
  { file: 'comm-shared.routes.ts',   method: 'get', path: '/api/communication/unread-counts' },
  { file: 'comm-config.routes.ts',   method: 'get', path: '/api/communication/call-flows' },
  { file: 'comm-agents.routes.ts',   method: 'get', path: '/api/communication/agents' },
  { file: 'comm-numbers.routes.ts',  method: 'get', path: '/api/communication/numbers' },
  { file: 'comm-usage.routes.ts',    method: 'get', path: '/api/communication/usage' },
];

describe('#2046 the section gate — 403 without access_inbox, 200 with it (one route per file)', () => {
  for (const route of GATED_ROUTES) {
    it(`${route.file}: 403 for SALES (holds read+create Communication, not access_inbox)`, async () => {
      mockAuthAs('sales', route.demoOrgOnly ? { is_demo: true } : {});
      const res = await request(app)[route.method](route.path).set(authHeader('sales'));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Insufficient permissions' });
    });

    it(`${route.file}: 200 for DISPATCHER (holds access_inbox from DEFAULT_GRANTS)`, async () => {
      mockAuthAs('dispatcher', route.demoOrgOnly ? { is_demo: true } : {});
      const res = await request(app)[route.method](route.path).set(authHeader('dispatcher'));
      expect(res.status).toBe(200);
    });
  }
});

// ─── GREEN CONTROL — routes the spec keeps UNGATED stay reachable for the same SALES caller ──

describe('#2046 GREEN control — ungated routes stay reachable for read+create-only SALES', () => {
  const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
  const CALL_ID = 'ca000000-0000-0000-0000-000000000001';
  const EMAIL_ID = 'e0000000-0000-0000-0000-000000000099';

  it('POST /api/communication/sms succeeds', async () => {
    mockAuthAs('sales');
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: CUSTOMER_ID, lead_id: null, vendor_id: null, kind: null,
      organization_id: ALPHA_ORG_ID,
    });
    mockPrisma.message.create.mockImplementation((a: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'msg-1', ts: new Date(), ...a.data }));

    const res = await request(app).post('/api/communication/sms').set(authHeader('sales'))
      .send({ threadId: THREAD_ID, body: 'On my way' });
    expect(res.status).toBe(201);
  });

  it('GET /api/communication/calls/:id — 200 (R1\'s sibling, unchanged)', async () => {
    mockAuthAs('sales');
    mockPrisma.callSession.findFirst.mockResolvedValue({
      id: CALL_ID, direction: 'in', status: 'completed', started_at: new Date(),
      answered_by: null, customer_id: null, job_id: null, job_label: null,
    });

    const res = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('GET /api/communication/threads/:id — 200 (R1)', async () => {
    mockAuthAs('sales');
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, customer_id: null, channel: 'sms', campaign_type: null, unread: 0, messages: [],
    });

    const res = await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('POST /api/communication/emails — 201 (R2)', async () => {
    mockAuthAs('sales');
    mockPrisma.email.create.mockResolvedValue({
      id: EMAIL_ID, account: 'user', from: { name: null, email: 'no-reply@mail.test.com' },
      to: 'angel@example.com', subject: 'About your enquiry', snippet: '', body: ['hi'],
      at: '3:42 PM', ts: BigInt(1789000005000), unread: false, starred: false, folder: 'sent',
    });

    const res = await request(app).post('/api/communication/emails').set(authHeader('sales'))
      .field('to', 'angel@example.com')
      .field('subject', 'About your enquiry')
      .field('body', JSON.stringify(['hi']));
    expect(res.status).toBe(201);
  });

  it('GET /api/communication/sending-identity — 200 (R2)', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/sending-identity').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('GET /api/communication/emails/attach-source — 200 (R2)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_ID });
    mockPrisma.attachment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/communication/emails/attach-source?customer_id=${CUSTOMER_ID}`)
      .set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('GET /api/communication/templates — 200 (R2)', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/templates').set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('PATCH /api/communication/emails/:id/job — succeeds without access_inbox (R3)', async () => {
    // `update Communication` is what this route requires; SALES never holds it (with or without
    // this fix), so the caller here is a hand-shaped DISPATCHER-without-access_inbox instead -
    // the shape that actually isolates "un-gated on access_inbox" from "lacks the write verb".
    mockAuthAs('dispatcher');
    mockDispatcherWithoutAccessInbox();
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.email.findFirst.mockResolvedValue({
      id: EMAIL_ID, account: 'user', from: {}, to: 'x@y.com', subject: 's', snippet: '', body: [],
      at: '', ts: BigInt(1), unread: false, starred: false, folder: 'sent', job_id: null, job_label: null,
    });

    const res = await request(app).patch(`/api/communication/emails/${EMAIL_ID}/job`).set(authHeader('dispatcher'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
  });

  it('the three record-tab endpoints still answer for SALES', async () => {
    mockAuthAs('sales');
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID, lead_assignees: [{ user_id: TEST_USERS.sales.id }] });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    // #2041: the customer roll-up now row-scopes via `canReadCustomerById` — give the fixture an
    // OWN_CUSTOMER proof (created_by_id) so this stays a #2046 section-gate check, not a #2041
    // row-scope one (that's customers-row-scope.test.ts's job).
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_ID, created_by_id: TEST_USERS.sales.id });

    const leadRes = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('sales'));
    expect(leadRes.status).toBe(200);

    const jobRes = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('sales'));
    expect(jobRes.status).toBe(200);

    const custRes = await request(app).get(`/api/customers/${CUSTOMER_ID}/communications`).set(authHeader('sales'));
    expect(custRes.status).toBe(200);
  });
});

// ─── #2046 security round 1 (L1) — originating an UNANCHORED conversation by number ──────────
//
// POST /api/communication/sms's `toNumber` branch creates a brand-new, org-wide MessageThread
// (no lead/job anchor) under `create Communication` alone — the section list (GET /threads) and
// POST /threads both require `access_inbox`, but this door to the same org-wide inbox did not.
// The gate applies ONLY when the resolution would CREATE a new thread with no lead/job anchor
// (no lead_id/job_id on the request): an existing thread (by threadId, or a toNumber match that
// already has a thread) and a lead/job-anchored compose are unaffected — those are governed by
// the visibility the caller already has, not by section access.

const NEW_NUMBER = '(201) 555-0199';
const EXISTING_SMS_THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000002';

describe('#2046 R1 — originating a new unanchored conversation by number requires access_inbox', () => {
  it('SALES (create Communication, no access_inbox) toNumber to a NEW number — 403, nothing created or sent', async () => {
    mockAuthAs('sales');
    mockSalesWithCreateCommunication();
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null); // no existing thread for this number
    mockPrisma.messageThread.create.mockResolvedValue({
      id: 'thr-should-not-exist', channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: null, lead_id: null, vendor_id: null, kind: null, title: '+12015550199',
    });
    mockPrisma.message.create.mockImplementation((a: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'msg-should-not-exist', ts: new Date(), ...a.data }));

    const res = await request(app).post('/api/communication/sms').set(authHeader('sales'))
      .send({ toNumber: NEW_NUMBER, body: 'hi there' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Starting a new conversation from the inbox requires access to the Communication section.',
    });
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it('SALES compose with lead_id on its OWN lead — 201, unaffected by the gate', async () => {
    mockAuthAs('sales');
    mockSalesWithCreateCommunication();
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID, customer_id: CUSTOMER_ID });
    mockPrisma.messageThread.create.mockResolvedValue({
      id: 'thr-new-anchored', channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: null, lead_id: null, vendor_id: null, kind: null, title: '+12015550199',
    });
    mockPrisma.message.create.mockImplementation((a: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'msg-anchored', ts: new Date(), ...a.data }));

    const res = await request(app).post('/api/communication/sms').set(authHeader('sales'))
      .send({ toNumber: NEW_NUMBER, leadId: LEAD_ID, body: 'hi there' });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create).toHaveBeenCalled();
  });

  it('SALES reply to an EXISTING visible thread by threadId — 201, unchanged', async () => {
    mockAuthAs('sales');
    mockSalesWithCreateCommunication();
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: EXISTING_SMS_THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: CUSTOMER_ID, lead_id: null, vendor_id: null, kind: null,
      organization_id: ALPHA_ORG_ID,
    });
    mockPrisma.message.create.mockImplementation((a: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'msg-reply', ts: new Date(), ...a.data }));

    const res = await request(app).post('/api/communication/sms').set(authHeader('sales'))
      .send({ threadId: EXISTING_SMS_THREAD_ID, body: 'On my way' });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
  });

  it('DISPATCHER (holds access_inbox) toNumber to a NEW number — 201, unaffected by the gate', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.create.mockResolvedValue({
      id: 'thr-new-dispatch', channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: null, lead_id: null, vendor_id: null, kind: null, title: '+12015550199',
    });
    mockPrisma.message.create.mockImplementation((a: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'msg-dispatch', ts: new Date(), ...a.data }));

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ toNumber: NEW_NUMBER, body: 'hi there' });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create).toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID, mockAuthAs, authHeader, CUSTOMER_FIXTURE, LEAD_FIXTURE, TEST_USERS,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as any;
// clearTokenCache is not optional: authenticate caches the resolved user per
// bearer token for 60s, so without it the org a test passes to mockAuthAs (the
// demo flag the WhatsApp cases below depend on) is silently ignored in favour of
// whatever the first test in the file resolved.
beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); clearTokenCache(); });

describe('POST /api/communication/calls', () => {
  const base = { direction: 'in', from_number: '(555) 123-4567', to_number: '+15550000000', status: 'completed' };

  it('links to the Customer on phone match (DEC6)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-1', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    const data = mockPrisma.callSession.create.mock.calls[0][0].data;
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(data.lead_id).toBeNull();
    expect(data.vendor_id).toBeNull();
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
    // matchByPhone covers all three phone storage places (scalar, legacy
    // secondary_phone, phones[] relation) — see comms-identity.test.ts.
    const phoneIn = { in: ['+15551234567', '5551234567', '(555) 123-4567'] };
    expect(mockPrisma.customer.findFirst).toHaveBeenCalledWith({
      where: {
        organization_id: ALPHA_ORG_ID,
        OR: [
          { phone: phoneIn },
          { secondary_phone: phoneIn },
          { phones: { some: { phone: phoneIn } } },
        ],
      },
      select: { id: true, first_name: true, last_name: true, company_name: true },
    });
  });

  it('links to a Vendor when the caller is a vendor, not a customer/lead (DEC6)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'ven-1', name: 'Acme Supply' });
    mockPrisma.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-v', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    const data = mockPrisma.callSession.create.mock.calls[0][0].data;
    expect(data.vendor_id).toBe('ven-1');
    expect(data.customer_id).toBeNull();
    expect(data.lead_id).toBeNull();
  });

  it('stays unmatched when nothing matches (DEC6 — never auto-creates a Lead)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-2', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    const data = mockPrisma.callSession.create.mock.calls[0][0].data;
    expect(data.customer_id).toBeNull();
    expect(data.lead_id).toBeNull();
    expect(data.vendor_id).toBeNull();
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();
  });

  it('attaches an org-validated lead_id when provided (overrides the resolver lead)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-3', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher'))
      .send({ ...base, lead_id: LEAD_FIXTURE.id });
    expect(res.status).toBe(201);
    expect(mockPrisma.callSession.create.mock.calls[0][0].data.lead_id).toBe(LEAD_FIXTURE.id);
    expect(mockPrisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: LEAD_FIXTURE.id, organization_id: ALPHA_ORG_ID },
    });
  });

  it('404s when lead_id is not in the org (P1)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher'))
      .send({ ...base, lead_id: 'e0000000-0000-0000-0000-0000000000ff' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Lead not found');
    expect(mockPrisma.callSession.create).not.toHaveBeenCalled();
  });

  it('400s on a bad body', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post('/api/communication/calls').set(authHeader('dispatcher'))
      .send({ direction: 'in' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('201s for SALES now that `create Communication` is a role-agnostic baseline (Task A0, ServWave phone master plan)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.callSession.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'call-2', started_at: new Date(), answered_by: { kind: 'none' }, ...args.data }));
    const res = await request(app).post('/api/communication/calls').set(authHeader('sales')).send(base);
    expect(res.status).toBe(201);
  });
});

describe('POST /api/communication/threads', () => {
  const base = { from_number: '555-123-4567', campaign_type: 'customer_care' };

  it('links to the Customer on match', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.messageThread.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'thr-1', channel: 'sms', campaign_type: 'customer_care', unread: 0, messages: [], ...args.data }));
    const res = await request(app).post('/api/communication/threads').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    const data = mockPrisma.messageThread.create.mock.calls[0][0].data;
    expect(data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(data.lead_id).toBeNull();
    expect(data.vendor_id).toBeNull();
  });

  it('stays unmatched when nothing matches', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'thr-2', channel: 'sms', campaign_type: 'customer_care', unread: 0, messages: [], ...args.data }));
    const res = await request(app).post('/api/communication/threads').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    const data = mockPrisma.messageThread.create.mock.calls[0][0].data;
    expect(data.customer_id).toBeNull();
    expect(data.vendor_id).toBeNull();
  });

  it('attaches an org-validated lead_id', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.messageThread.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'thr-3', channel: 'sms', campaign_type: 'customer_care', unread: 0, messages: [], ...args.data }));
    const res = await request(app).post('/api/communication/threads').set(authHeader('dispatcher'))
      .send({ ...base, lead_id: LEAD_FIXTURE.id });
    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create.mock.calls[0][0].data.lead_id).toBe(LEAD_FIXTURE.id);
  });

  it('404s on a lead_id not in the org', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/threads').set(authHeader('dispatcher'))
      .send({ ...base, lead_id: 'e0000000-0000-0000-0000-0000000000ff' });
    expect(res.status).toBe(404);
  });

  // #2046: starting a brand-new conversation from the org-wide inbox is a section action - it now
  // also requires access_inbox, which SALES does not hold. This is the POST /threads door; the
  // record tab's composer (POST /sms) stays on `create Communication` for a reply into an
  // EXISTING thread or a lead/job-anchored compose - only its OWN unanchored-origination path
  // (toNumber to a number with no thread yet) picked up the same access_inbox gate, in security
  // round 1 (comm-section-gate.test.ts).
  it('403s for SALES — creating a new thread now requires access_inbox (#2046)', async () => {
    mockAuthAs('sales');
    const res = await request(app).post('/api/communication/threads').set(authHeader('sales')).send(base);
    expect(res.status).toBe(403);
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/communication/whatsapp-chats', () => {
  const base = { name: 'Jane', org: 'Acme', phone: '(555) 123-4567' };

  // WhatsApp is demo-locked at the route (requireDemoOrg), so every case here
  // authenticates as a demo org to reach the controller at all.
  it('links to the Customer on phone match', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.whatsAppChat.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'wac-1', unread: 0, messages: [], ...args.data }));
    const res = await request(app).post('/api/communication/whatsapp-chats').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    expect(mockPrisma.whatsAppChat.create.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
  });

  it('stays unmatched when nothing matches', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockPrisma.vendor.findFirst.mockResolvedValue(null);
    mockPrisma.vendorContact.findFirst.mockResolvedValue(null);
    mockPrisma.whatsAppChat.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 'wac-2', unread: 0, messages: [], ...args.data }));
    const res = await request(app).post('/api/communication/whatsapp-chats').set(authHeader('dispatcher')).send(base);
    expect(res.status).toBe(201);
    expect(mockPrisma.whatsAppChat.create.mock.calls[0][0].data.customer_id).toBeNull();
  });

  it('400s when phone is missing', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp-chats').set(authHeader('dispatcher'))
      .send({ name: 'Jane', org: 'Acme' });
    expect(res.status).toBe(400);
  });

  // #2046: WhatsApp has no record-tab consumer at all - the whole surface, including starting a
  // new chat, is section-only and now requires access_inbox.
  it('403s for SALES — WhatsApp is section-only, requires access_inbox (#2046)', async () => {
    mockAuthAs('sales', { is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp-chats').set(authHeader('sales')).send(base);
    expect(res.status).toBe(403);
    expect(mockPrisma.whatsAppChat.create).not.toHaveBeenCalled();
  });
});

describe('GET comms surface linked records (V4)', () => {
  it('includes the linked Customer + Lead + agent on calls', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.callSession.findMany.mockResolvedValue([{
      id: 'call-1', direction: 'in', from_number: '+15551234567', to_number: 'x', status: 'completed',
      answered_by: { kind: 'agent' }, started_at: new Date(),
      customer_id: CUSTOMER_FIXTURE.id, lead_id: LEAD_FIXTURE.id, vendor_id: null,
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
      lead: { id: LEAD_FIXTURE.id, lead_number: 'L00001' },
      vendor: null,
      agent: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    }]);
    const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const incl = mockPrisma.callSession.findMany.mock.calls[0][0].include;
    expect(incl.customer).toBeTruthy();
    expect(incl.lead).toBeTruthy();
    expect(incl.vendor).toBeTruthy();
    expect(incl.agent).toBeTruthy();
    expect(res.body.calls[0].linkedCustomer).toEqual({ id: CUSTOMER_FIXTURE.id, name: 'Doe HVAC' });
    expect(res.body.calls[0].linkedLead).toEqual({ id: LEAD_FIXTURE.id, leadNumber: 'L00001' });
    expect(res.body.calls[0].leadId).toBe(LEAD_FIXTURE.id);
    expect(res.body.calls[0].linkedAgent).toEqual({ id: TEST_USERS.admin.id, name: 'Test Admin' });
  });

  it('includes the linked Vendor on threads', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.messageThread.findMany.mockResolvedValue([{
      id: 'thr-1', channel: 'sms', campaign_type: 'customer_care', unread: 0, messages: [],
      customer_id: null, lead_id: null, vendor_id: 'ven-1',
      customer: null, lead: null, vendor: { id: 'ven-1', name: 'Acme Supply' },
    }]);
    const res = await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(mockPrisma.messageThread.findMany.mock.calls[0][0].include.vendor).toBeTruthy();
    expect(res.body.threads[0].linkedVendor).toEqual({ id: 'ven-1', name: 'Acme Supply' });
    expect(res.body.threads[0].vendorId).toBe('ven-1');
  });

  it('includes the linked Customer on WhatsApp chats', async () => {
    mockAuthAs('dispatcher', { is_demo: true }); // WhatsApp routes are demo-locked

    mockPrisma.whatsAppChat.findMany.mockResolvedValue([{
      id: 'wac-1', name: 'Jane', org: 'Acme', phone: '+15551234567', unread: 0, last_at: '10:00 AM', messages: [],
      customer_id: CUSTOMER_FIXTURE.id, lead_id: null, vendor_id: null,
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
      lead: null, vendor: null,
    }]);
    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(mockPrisma.whatsAppChat.findMany.mock.calls[0][0].include.customer).toBeTruthy();
    expect(res.body.chats[0].linkedCustomer).toEqual({ id: CUSTOMER_FIXTURE.id, name: 'Doe HVAC' });
  });

  it('includes the linked Customer on emails', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.findMany.mockResolvedValue([{
      id: 'em-1', account: 'gmail', from: { name: 'John', email: 'john@doe.com' }, to: 'me@org.com',
      subject: 'Hi', snippet: 's', body: ['s'], at: '10:00 AM', ts: 1, unread: false, starred: false, folder: 'inbox',
      customer_id: CUSTOMER_FIXTURE.id, lead_id: null, vendor_id: null,
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
      lead: null, vendor: null,
    }]);
    const res = await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(mockPrisma.email.findMany.mock.calls[0][0].include.customer).toBeTruthy();
    expect(res.body.emails[0].linkedCustomer).toEqual({ id: CUSTOMER_FIXTURE.id, name: 'Doe HVAC' });
  });

  it('joins PhoneAgent to its User', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.phoneAgent.findMany.mockResolvedValue([{
      id: 'pa-1', user_id: TEST_USERS.admin.id, kind: 'human', name: 'X', role: 'agent',
      calls: 0, answer_rate_pct: 0, booking_rate_pct: 0, aht_sec: 0, sentiment_pct: 0,
      revenue: 0, script_adherence_pct: 0, containment_pct: null,
      user: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin', email: 'admin@test.com' },
    }]);
    const res = await request(app).get('/api/communication/agents').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(mockPrisma.phoneAgent.findMany.mock.calls[0][0].include.user).toBeTruthy();
    expect(res.body.agents[0].userId).toBe(TEST_USERS.admin.id);
    expect(res.body.agents[0].linkedUser).toEqual({ id: TEST_USERS.admin.id, name: 'Test Admin', email: 'admin@test.com' });
  });
});

describe('POST /api/communication/sms', () => {
  it('appends to an existing thread by threadId', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.messageThread.findFirst.mockResolvedValue({ id: 'a1b2c3d4-0000-0000-0000-000000000001', organization_id: ALPHA_ORG_ID });
    mockPrisma.message.create.mockImplementation((a: any) => Promise.resolve({ id: 'm1', ts: new Date(), ...a.data }));
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: 'a1b2c3d4-0000-0000-0000-000000000001', body: 'hi' });
    expect(res.status).toBe(201);
    expect(mockPrisma.message.create).toHaveBeenCalled();
  });

  it('resolves-or-creates a thread when only customerId is given', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.create.mockResolvedValue({ id: 'a1b2c3d4-0000-0000-0000-000000000009', organization_id: ALPHA_ORG_ID });
    mockPrisma.message.create.mockImplementation((a: any) => Promise.resolve({ id: 'm2', ts: new Date(), ...a.data }));
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_FIXTURE.id, body: 'hi' });
    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create.mock.calls[0][0].data.customer_id).toBe(CUSTOMER_FIXTURE.id);
    expect(mockPrisma.message.create.mock.calls[0][0].data.thread_id).toBe('a1b2c3d4-0000-0000-0000-000000000009');
  });

  it('400s when neither threadId nor customerId is given', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher')).send({ body: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('404s when customerId is not in the org', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: 'c0000000-0000-0000-0000-0000000000ff', body: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
  });
});

describe('POST /api/communication/whatsapp', () => {
  beforeEach(() => {
    mockPrisma.whatsAppChat.findFirst.mockResolvedValue({ id: 'b2c3d4e5-0000-0000-0000-000000000001', organization_id: ALPHA_ORG_ID });
    mockPrisma.whatsAppMessage.create.mockImplementation((a: any) => Promise.resolve({ id: 'wm1', at: '10:00 AM', ...a.data }));
    mockPrisma.whatsAppChat.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
  });
  it('201s with the chat_id contract', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(res.status).toBe(201);
  });
  it('400s with the old chatId key', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chatId: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(res.status).toBe(400);
  });
  // #2046: WhatsApp has no record-tab consumer at all - the whole surface, including sending into
  // an existing chat, is section-only and now requires access_inbox.
  it('403s for SALES — WhatsApp is section-only, requires access_inbox (#2046)', async () => {
    mockAuthAs('sales', { is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('sales'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(res.status).toBe(403);
  });
  // The route-level demo lock (requireDemoOrg) is what a real org actually hits
  // now - it 404s before the controller runs (proved in
  // comm-email-entitlement.test.ts). This case keeps the controller's own
  // WHATSAPP_NOT_CONNECTED backstop covered: the two checks read different
  // sources (req.user.org_is_demo from the auth JWT vs a live organization row),
  // so the 409 branch still has to hold when a stale token disagrees with the DB.
  it('409s WHATSAPP_NOT_CONNECTED when the live org row says non-demo, and writes nothing', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: false });
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WHATSAPP_NOT_CONNECTED');
    expect(mockPrisma.whatsAppMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppChat.updateMany).not.toHaveBeenCalled();
  });
  it('201s and persists for a demo org so the ServWave Test showcase is unchanged', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
    const res = await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(res.status).toBe(201);
    expect(mockPrisma.whatsAppMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.whatsAppMessage.create.mock.calls[0][0].data.organization_id).toBe(ALPHA_ORG_ID);
    expect(mockPrisma.whatsAppMessage.create.mock.calls[0][0].data.status).toBe('sent');
  });
  it('keeps the WhatsApp queries org-scoped and reads is_demo off the caller\'s own org', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
    await request(app).post('/api/communication/whatsapp').set(authHeader('dispatcher'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });
    expect(mockPrisma.whatsAppChat.findFirst.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
    expect(mockPrisma.whatsAppChat.updateMany.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
    expect(mockPrisma.organization.findUnique.mock.calls[0][0]).toEqual({
      where: { id: ALPHA_ORG_ID },
      select: { is_demo: true },
    });
  });
});

describe('POST /api/communication/emails', () => {
  // The record-only email branch is DEMO-ORG-ONLY (a real org gets 501
  // EMAIL_SEND_NOT_CONFIGURED until the Resend send path lands).
  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({ is_demo: true });
  });

  it('201s with body[] + thread_id and sets snippet from body[0]', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.email.create.mockImplementation((a: any) => Promise.resolve({ id: 'em1', ts: 1, at: '10:00 AM', ...a.data }));
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', subject: 'Hi', body: ['line one', 'line two'], thread_id: null });
    expect(res.status).toBe(201);
    expect(mockPrisma.email.create.mock.calls[0][0].data.snippet).toBe('line one');
  });
  it('400s with a string body (old shape)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post('/api/communication/emails').set(authHeader('dispatcher'))
      .send({ to: 'x@y.com', subject: 'Hi', body: 'a string' });
    expect(res.status).toBe(400);
  });
  it('201s for SALES now that `create Communication` is a role-agnostic baseline (Task A0, ServWave phone master plan)', async () => {
    mockAuthAs('sales');
    mockPrisma.email.create.mockImplementation((a: any) => Promise.resolve({ id: 'em2', ts: 1, at: '10:00 AM', ...a.data }));
    const res = await request(app).post('/api/communication/emails').set(authHeader('sales'))
      .send({ to: 'x@y.com', body: ['hi'] });
    expect(res.status).toBe(201);
  });
});

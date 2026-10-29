// Email slice 1 - `email` is its own entitlement, split out from `phone`.
//
// Before this slice one router carried unread-counts + WhatsApp + email behind a
// single `requireFeature('phone')`, so an org that only pays for email could not
// reach a single email endpoint. Now:
//   - comm-email.routes.ts     -> requireFeature('email')  (minPlan STARTER)
//   - comm-whatsapp.routes.ts  -> requireFeature('phone') + requireDemoOrg
//   - comm-shared.routes.ts    -> NO feature gate (unread-counts and team-members
//                                 both span features)
//
// These are full-stack route tests on purpose: every comm-* router shares the
// /api/communication mount, and a router-level `router.use(gate)` runs for EVERY
// request that enters that router - including paths it has no route for. So the
// gates only behave correctly given the right mount order AND path-scoped
// router.use()s in app.ts. Testing the middleware in isolation would prove none
// of that.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const EMAIL_ID = 'ee000000-0000-0000-0000-000000000001';

const EMAIL_ROW = {
  id: EMAIL_ID,
  account: 'user',
  from: { name: 'John', email: 'john@doe.com' },
  to: 'me@org.com',
  subject: 'Hi',
  snippet: 's',
  body: ['s'],
  at: '10:00 AM',
  ts: 1,
  unread: false,
  starred: false,
  folder: 'inbox',
  customer: null,
  lead: null,
  vendor: null,
};

/** STARTER: `email` is included (minPlan STARTER, built) but `phone` is not. */
const EMAIL_ONLY_ORG = { plan: 'STARTER', feature_overrides: {} };
/** PRO with email explicitly switched off: `phone` yes, `email` no. */
const PHONE_ONLY_ORG = { plan: 'PRO', feature_overrides: { email: false } };

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('email endpoints for an org with `email` but WITHOUT `phone`', () => {
  it('GET /emails - 200, not 402', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.findMany.mockResolvedValue([EMAIL_ROW]);

    const res = await request(app).get('/api/communication/emails').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.emails).toHaveLength(1);
  });

  it('GET /email-groups - 200, not 402', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.emailGroup.findMany.mockResolvedValue([{ id: 'eg-1', name: 'Ops', member_ids: [] }]);

    const res = await request(app).get('/api/communication/email-groups').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
  });

  it('GET /emails/:id - 200, not 402', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.findFirst.mockResolvedValue(EMAIL_ROW);

    const res = await request(app).get(`/api/communication/emails/${EMAIL_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.email.id).toBe(EMAIL_ID);
  });

  it('PATCH /emails/thread-read - 200, not 402', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: 'b0000000-0000-4000-8000-000000000004' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  it('POST /emails - reaches the controller and sends for real (never 402)', async () => {
    // Email slice 7: every org gets the real Resend send path now - there is no
    // more demo-only record branch / 501 for a real org. sendComposedEmail is
    // globally mocked to a 'sent' result (setup.ts), so this proves the request
    // clears the feature gate and reaches the controller, not that Resend itself
    // was exercised (that is comm-email-send.test.ts's job).
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.create.mockResolvedValue({ ...EMAIL_ROW, id: 'sent-1' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', subject: 'x', body: ['hi'] });

    expect(res.status).toBe(201);
    expect(p.email.create).toHaveBeenCalledTimes(1);
    expect(p.organization.findUnique).not.toHaveBeenCalled();
  });

  it('GET /whatsapp - 402 FEATURE_NOT_IN_PLAN(phone), nothing queried', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);

    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('admin'));

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'phone' });
    expect(p.whatsAppChat.findMany).not.toHaveBeenCalled();
  });

  it('POST /whatsapp - 402 FEATURE_NOT_IN_PLAN(phone), nothing written', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);

    const res = await request(app)
      .post('/api/communication/whatsapp')
      .set(authHeader('admin'))
      .send({ chat_id: 'b2c3d4e5-0000-0000-0000-000000000001', text: 'hi' });

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('phone');
    expect(p.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});

describe('email endpoints for an org WITH `phone` but with `email` overridden off', () => {
  it('GET /emails - 402 FEATURE_NOT_IN_PLAN(email), nothing queried', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);

    const res = await request(app).get('/api/communication/emails').set(authHeader('admin'));

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'email', required_plan: 'STARTER' });
    expect(p.email.findMany).not.toHaveBeenCalled();
  });

  it('GET /email-groups - 402', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);

    const res = await request(app).get('/api/communication/email-groups').set(authHeader('admin'));

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('email');
    expect(p.emailGroup.findMany).not.toHaveBeenCalled();
  });

  it('POST /emails - 402, nothing written', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', body: ['hi'] });

    expect(res.status).toBe(402);
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('still reaches a phone-gated router - the email gate must not swallow /threads', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);
    p.messageThread.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/threads').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });
});

describe('WhatsApp is demo-locked on top of `phone`', () => {
  it('a demo org with `phone` reaches GET /whatsapp', async () => {
    mockAuthAs('admin', { is_demo: true });
    p.whatsAppChat.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(p.whatsAppChat.findMany).toHaveBeenCalled();
  });

  it('a real (non-demo) org WITH `phone` gets 404 FEATURE_DISABLED and never queries', async () => {
    mockAuthAs('admin', { is_demo: false });

    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'whatsapp' });
    expect(p.whatsAppChat.findMany).not.toHaveBeenCalled();
  });

  it('the lock covers POST /whatsapp-chats too - no chat row is created', async () => {
    mockAuthAs('admin', { is_demo: false });

    const res = await request(app)
      .post('/api/communication/whatsapp-chats')
      .set(authHeader('admin'))
      .send({ name: 'Jane', org: 'Acme', phone: '(555) 123-4567' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('FEATURE_DISABLED');
    expect(p.whatsAppChat.create).not.toHaveBeenCalled();
  });

  it('the demo lock does not leak onto the email routes of a real org', async () => {
    mockAuthAs('admin', { is_demo: false });
    p.email.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/emails').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });
});

// #2049: sms's half of GET /unread-counts moved off the shared
// `messageThread.aggregate({_sum:{unread}})` column onto a per-user COUNT OF
// UNREAD THREADS (messageThread.findMany + attachCallerUnread) - a thread
// with at least one not-yet-read inbound message counts once, regardless of
// how many messages it holds. This fixture builds such a thread.
function unreadSmsThread(id: string) {
  return { id, messages: [{ direction: 'in', ts: new Date() }] };
}

// #2049 slice 2: the WhatsApp mirror - moved off
// `whatsAppChat.aggregate({_sum:{unread}})` onto a per-user COUNT OF UNREAD
// CHATS (whatsAppChat.findMany + attachCallerUnreadWhatsApp). `from: 'them'`
// is the inbound shape (R10: `from <> 'us'`), not `direction`.
function unreadWhatsAppChat(id: string) {
  return { id, messages: [{ from: 'them', created_at: new Date() }] };
}

describe('GET /unread-counts is entitlement-aware and ungated', () => {
  it('an email-only org gets its email count, zeros elsewhere, and pays for no other query', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.count.mockResolvedValue(7);

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sms: 0, whatsapp: 0, email: 7 });
    expect(p.email.count).toHaveBeenCalledTimes(1);
    expect(p.messageThread.findMany).not.toHaveBeenCalled();
    expect(p.whatsAppChat.findMany).not.toHaveBeenCalled();
  });

  it('a phone-only (non-demo) org gets its sms count, zeros elsewhere, and skips the email + whatsapp queries', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);
    p.messageThread.findMany.mockResolvedValue([
      unreadSmsThread('t1'), unreadSmsThread('t2'), unreadSmsThread('t3'), unreadSmsThread('t4'),
    ]);

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sms: 4, whatsapp: 0, email: 0 });
    expect(p.messageThread.findMany).toHaveBeenCalledTimes(1);
    expect(p.email.count).not.toHaveBeenCalled();
    expect(p.whatsAppChat.findMany).not.toHaveBeenCalled();
  });

  it('a demo org with `phone` does count WhatsApp - the payload mirrors the route lock', async () => {
    mockAuthAs('admin', { is_demo: true });
    p.messageThread.findMany.mockResolvedValue([unreadSmsThread('t1')]);
    p.whatsAppChat.findMany.mockResolvedValue([unreadWhatsAppChat('c1'), unreadWhatsAppChat('c2')]);
    p.email.count.mockResolvedValue(3);

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sms: 1, whatsapp: 2, email: 3 });
  });

  it('every query it does run is org-scoped', async () => {
    mockAuthAs('admin', { is_demo: true });
    p.messageThread.findMany.mockResolvedValue([]);
    p.whatsAppChat.findMany.mockResolvedValue([]);
    p.email.count.mockResolvedValue(0);

    await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    expect(p.messageThread.findMany.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
    expect(p.whatsAppChat.findMany.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
    expect(p.email.count.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
  });

  it('no unread sms threads / no unread whatsapp chats reports 0, not null or undefined', async () => {
    mockAuthAs('admin', { is_demo: true });
    p.messageThread.findMany.mockResolvedValue([]);
    p.whatsAppChat.findMany.mockResolvedValue([]);
    p.email.count.mockResolvedValue(0);

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    expect(res.body).toEqual({ sms: 0, whatsapp: 0, email: 0 });
  });
});

describe('route order inside the email router', () => {
  it('PATCH /emails/thread-read resolves to markThreadRead - GET /emails/:id must not swallow it', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 3 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: 'b0000000-0000-4000-8000-000000000005' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    // markThreadRead finds visible rows by thread_id; getEmail would have read
    // a single row by id instead.
    expect(p.email.findMany.mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      thread_id: 'b0000000-0000-4000-8000-000000000005',
    });
    expect(p.email.findFirst).not.toHaveBeenCalled();
  });

  it('GET /emails/:id still works for a literal-looking id', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.email.findFirst.mockResolvedValue({ ...EMAIL_ROW, id: 'thread-read' });

    const res = await request(app).get('/api/communication/emails/thread-read').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(p.email.findFirst).toHaveBeenCalled();
  });
});

// An unmatched path under a prefix this router owns must NOT keep walking the
// /api/communication mount chain until some phone-gated router answers 402. An
// email-only org would then see a Pro upsell for a telephony module it never
// touched, on a page it owns.
describe('each router terminates its own prefixes', () => {
  it('an unmatched path under /emails is 404, never a phone 402', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);

    const res = await request(app)
      .post('/api/communication/emails/draft')
      .set(authHeader('admin'))
      .send({ to: 'a@b.c' });

    expect(res.status).toBe(404);
    expect(res.body.feature).toBeUndefined();
  });

  it('a deep unmatched /emails path is 404 too', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);

    const res = await request(app).get('/api/communication/emails/aa/bb').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.feature).toBeUndefined();
  });

  it('an unmatched path under /whatsapp is 404 for a demo org, not somebody else 402', async () => {
    mockAuthAs('admin', { plan: 'PRO', feature_overrides: {}, is_demo: true });

    const res = await request(app).get('/api/communication/whatsapp/aa/bb').set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.feature).toBeUndefined();
  });
});

// /forward-rules reads the email forward-rules table and /team-members is the
// org user directory that BOTH the composer and the phone call-groups screen
// read. Leaving them behind PRO `phone` left an email-only org with a
// permanently empty directory and no forward rules, silently (handle402 keeps
// reads quiet).
describe('cross-feature Communication endpoints', () => {
  it('an email-only org can read /forward-rules', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.emailForwardRule.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/forward-rules').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('an email-only org can read /team-members', async () => {
    mockAuthAs('admin', EMAIL_ONLY_ORG);
    p.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/team-members').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('a phone org with `email` overridden off keeps /team-members - call groups still need it', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);
    p.user.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/team-members').set(authHeader('admin'));

    expect(res.status).toBe(200);
  });

  it('/forward-rules follows `email`, so the phone-only org is 402d on it', async () => {
    mockAuthAs('admin', PHONE_ONLY_ORG);

    const res = await request(app).get('/api/communication/forward-rules').set(authHeader('admin'));

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('email');
    expect(p.emailForwardRule.findMany).not.toHaveBeenCalled();
  });
});

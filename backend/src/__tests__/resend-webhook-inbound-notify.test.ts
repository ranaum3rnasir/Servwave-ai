// A captured reply has to REACH someone. Slice 6 stored it correctly and told
// nobody, so the only way to discover a customer had written back was to open
// the Inbox and refresh - the app's one channel with no live signal at all.
//
// This wires inbound email into the customer-reply alert (services/notifications/emailReplyAlerts.ts,
// PRD 10 S10.10), which finds the people through M6's chain and writes the bell, plus a second
// `emails.changed` broadcast to the same people so the open Inbox list refreshes without a full
// notification refetch. WHO is rung is decided there, by the real-database suite
// permission-email-reply-bells-db.test.ts; this suite is about the webhook's wiring: what it hands
// the alert, when, and that nothing in it chooses a recipient (no role, no user list).
//
// TWO ORDERING PROPERTIES, both correctness rather than taste:
//
//  1. The alert runs AFTER the transaction commits. Notifying about a row that a
//     later rollback erases would leave a bell entry pointing at nothing - the
//     same reason the domain-verified email in this controller is deliberately
//     deferred past its own transaction.
//  2. A failure to notify must NEVER fail the webhook. Resend retries a non-2xx,
//     and a retry re-runs the fetch; the idempotency claim already committed, so
//     the replay is deduped and the message is simply lost. The customer's mail
//     matters more than the bell.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { resendVerify, receivingGet } = vi.hoisted(() => ({
  resendVerify: vi.fn(),
  receivingGet: vi.fn(),
}));

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test' as string,
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
    RESEND_API_KEY: 're_test_key' as string | undefined,
    RESEND_WEBHOOK_SECRET: 'whsec_test_secret' as string | undefined,
    FRONTEND_URL: 'http://localhost:5173',
  },
}));
vi.mock('../config/env', () => mockEnv);

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(), receiving: { get: receivingGet } };
    webhooks = { verify: resendVerify };
  },
}));

vi.mock('../services/notifications/emailReplyAlerts', () => ({
  alertEmailReply: vi.fn().mockResolvedValue(['assignee-1']),
}));
vi.mock('../services/notifications/realtimePublish', () => ({
  publishNotificationsChanged: vi.fn().mockResolvedValue(undefined),
  publishEmailsChanged: vi.fn().mockResolvedValue(undefined),
}));

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { alertEmailReply } from '../services/notifications/emailReplyAlerts';
import { publishEmailsChanged } from '../services/notifications/realtimePublish';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

// The router looks the event's reply tokens up in one read, before the message body is fetched.
const tokenResolvesTo = (row: unknown) => p.replyToken.findMany.mockResolvedValue(row ? [row] : []);

const app = express();
app.use('/api/webhooks', webhookRoutes);

const ORG = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '33333333-3333-3333-3333-333333333333';
const ASSIGNEE = '44444444-4444-4444-4444-444444444444';
const TOKEN = 'v1jSzARGWhcIuV_cVcbJEw';
const RECEIVED_ID = 'rec_abc123';

function post(payload: unknown, svixId = 'evt_notify_1') {
  return request(app)
    .post('/api/webhooks/resend')
    .set('Content-Type', 'application/json')
    .set('svix-id', svixId)
    .set('svix-timestamp', '1754390400')
    .set('svix-signature', 'v1,test-sig')
    .send(JSON.stringify(payload));
}

function receivedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'email.received',
    created_at: '2026-08-05T17:43:00.395Z',
    data: {
      email_id: RECEIVED_ID,
      created_at: '2026-08-05T17:43:00.395Z',
      from: 'Angel <angel@example.com>',
      to: [`${TOKEN}@reply.test.com`],
      cc: [],
      bcc: [],
      received_for: [`${TOKEN}@reply.test.com`],
      message_id: '<abc@mail.gmail.com>',
      subject: 'Re: Quote',
      attachments: [],
      ...overrides,
    },
  };
}

function receivedEmail(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      object: 'email',
      id: RECEIVED_ID,
      from: 'Angel <angel@example.com>',
      to: [`${TOKEN}@reply.test.com`],
      cc: null,
      bcc: null,
      reply_to: null,
      received_for: [`${TOKEN}@reply.test.com`],
      created_at: '2026-08-05T17:43:00.395Z',
      subject: 'Re: Quote',
      text: 'Sounds good.',
      html: '<div>Sounds good.</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
      message_id: '<abc@mail.gmail.com>',
      attachments: [],
      ...overrides,
    },
    error: null,
  };
}

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    organization_id: ORG,
    thread_id: THREAD,
    entity_type: null,
    entity_id: null,
    customer_id: CUSTOMER,
    expected_from: 'angel@example.com',
    created_by_user_id: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (alertEmailReply as any).mockResolvedValue([ASSIGNEE]);
  resendVerify.mockImplementation((...args: any[]) => {
    const payload = args[0]?.payload ?? args[0];
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  });
  receivingGet.mockResolvedValue(receivedEmail());
  p.resendEvent.findUnique.mockResolvedValue(null);
  p.resendEvent.create.mockResolvedValue({});
  tokenResolvesTo(tokenRow());
  p.email.create.mockResolvedValue({ id: 'inbound-row-1' });
  p.email.findUnique.mockResolvedValue(null);
  p.emailThread.create.mockResolvedValue({ id: 'new-thread-1' });
  p.emailThread.findUnique.mockResolvedValue({ id: THREAD, assigned_to_user_id: ASSIGNEE });
  p.customer.findUnique.mockResolvedValue({ id: CUSTOMER, first_name: 'Angel', last_name: 'Reyes', company_name: null });
  // The company has the Email plan feature (every plan includes it; only an override removes it).
  p.organization.findUnique.mockResolvedValue({ plan: 'STARTER', trial_ends_at: null, feature_overrides: {} });
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg));
});

describe('email.received - notifying', () => {
  it('hands the stored reply to the customer-reply alert, once, with no actor and no recipients of its own', async () => {
    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(alertEmailReply).toHaveBeenCalledTimes(1);
    expect(alertEmailReply).toHaveBeenCalledWith({
      organizationId: ORG,
      threadId: THREAD,
      // The id the alert dedupes on, so a webhook replay cannot double-notify.
      providerMessageId: RECEIVED_ID,
      // The stored reply itself: the bell goes only to people who open it (M1).
      emailId: 'inbound-row-1',
      senderLabel: 'Angel <angel@example.com>',
      subject: 'Re: Quote',
    });
  });

  it('names no recipient: the webhook reads no user and no thread owner, the alert finds the people', async () => {
    await post(receivedEvent());

    expect(p.user.findMany).not.toHaveBeenCalled();
    const args = (alertEmailReply as any).mock.calls[0][0];
    // The stored reply's id names a message, not a person: who may open it is the alert's question (M1).
    expect(Object.keys(args).sort()).toEqual(['emailId', 'organizationId', 'providerMessageId', 'senderLabel', 'subject', 'threadId']);
  });

  it('anchors the alert on the conversation the reply landed in, which is what the inbox opens', async () => {
    // A reply whose token lost its conversation lands in a fresh one: the alert is about that one.
    tokenResolvesTo(tokenRow({ thread_id: null, entity_type: 'estimate', entity_id: '55555555-5555-5555-5555-555555555555' }));

    await post(receivedEvent());

    expect((alertEmailReply as any).mock.calls[0][0]).toMatchObject({ threadId: 'new-thread-1' });
  });

  it('pushes emails.changed to the same people, so an open Inbox refreshes', async () => {
    await post(receivedEvent());

    expect(publishEmailsChanged).toHaveBeenCalledTimes(1);
    expect(publishEmailsChanged).toHaveBeenCalledWith([ASSIGNEE], ORG);
  });

  it('does not push emails.changed when nobody was notified', async () => {
    // No recipients means no open client to refresh, and an empty publish is a
    // pointless round trip per inbound message.
    (alertEmailReply as any).mockResolvedValue([]);

    await post(receivedEvent());

    expect(publishEmailsChanged).not.toHaveBeenCalled();
  });
});

describe('email.received - while the company\'s Email plan feature is off', () => {
  it('stores the reply and rings nobody: no alert, no live-update push', async () => {
    p.organization.findUnique.mockResolvedValue({ plan: 'STARTER', trial_ends_at: null, feature_overrides: { email: false } });

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(p.email.create).toHaveBeenCalledTimes(1);
    expect(alertEmailReply).not.toHaveBeenCalled();
    expect(publishEmailsChanged).not.toHaveBeenCalled();
  });

  it('asks the plan of the company the reply belongs to, on the transaction\'s own client', async () => {
    await post(receivedEvent());

    expect(p.organization.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORG } }));
  });
});

describe('email.received - notifying never costs us the message', () => {
  it('still 200s when the alert throws', async () => {
    // The alert swallows its own errors, but this guards the wiring around it.
    // A non-2xx here makes Resend retry, the retry is deduped by the claim that
    // already committed, and the customer's reply is gone.
    (alertEmailReply as any).mockRejectedValue(new Error('notification service down'));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(p.email.create).toHaveBeenCalledTimes(1);
  });

  it('acknowledges the delivery before the alert is worked out, so its reads never delay the 200', async () => {
    // The alert reads people, switches and the conversation on the hosted one-connection pool;
    // Resend waits for the 200, so the acknowledgement goes first and the alert follows it.
    let releaseEmit: (ids: string[]) => void = () => {};
    (alertEmailReply as any).mockImplementation(() => new Promise<string[]>((resolve) => { releaseEmit = resolve; }));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(alertEmailReply).toHaveBeenCalledTimes(1);
    expect(publishEmailsChanged).not.toHaveBeenCalled();
    releaseEmit([ASSIGNEE]);
    await vi.waitFor(() => expect(publishEmailsChanged).toHaveBeenCalledTimes(1));
  });

  it('still 200s when the emails.changed broadcast throws', async () => {
    (publishEmailsChanged as any).mockRejectedValue(new Error('realtime down'));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
  });

  it('alerts only after the row is committed, never from inside the transaction', async () => {
    // A rollback after the alert would leave a bell entry pointing at a message
    // that does not exist.
    let committed = false;
    p.$transaction.mockImplementation(async (arg: any) => {
      const out = typeof arg === 'function' ? await arg(p) : await Promise.all(arg);
      committed = true;
      return out;
    });
    (alertEmailReply as any).mockImplementation(async () => {
      expect(committed).toBe(true);
      return [ASSIGNEE];
    });

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(alertEmailReply).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a message that could not be attributed to an org', async () => {
    // No token match - nothing was stored, so there is nothing to announce.
    tokenResolvesTo(null);

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(alertEmailReply).not.toHaveBeenCalled();
    expect(publishEmailsChanged).not.toHaveBeenCalled();
  });
});

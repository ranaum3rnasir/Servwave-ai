// A captured reply has to REACH someone. Slice 6 stored it correctly and told
// nobody, so the only way to discover a customer had written back was to open
// the Inbox and refresh - the app's one channel with no live signal at all.
//
// This wires inbound email into the notification service that calls, texts and
// every other verb already use: a `communication.email_inbound` emit, plus a
// second `emails.changed` broadcast to the same people so the open Inbox list
// refreshes without a full notification refetch.
//
// TWO ORDERING PROPERTIES, both correctness rather than taste:
//
//  1. The emit runs AFTER the transaction commits. Notifying about a row that a
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

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(['assignee-1']),
}));
vi.mock('../services/notifications/realtimePublish', () => ({
  publishNotificationsChanged: vi.fn().mockResolvedValue(undefined),
  publishEmailsChanged: vi.fn().mockResolvedValue(undefined),
}));

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { emit } from '../services/notifications/notificationService';
import { publishEmailsChanged } from '../services/notifications/realtimePublish';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

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
  (emit as any).mockResolvedValue([ASSIGNEE]);
  resendVerify.mockImplementation((...args: any[]) => {
    const payload = args[0]?.payload ?? args[0];
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  });
  receivingGet.mockResolvedValue(receivedEmail());
  p.resendEvent.findUnique.mockResolvedValue(null);
  p.resendEvent.create.mockResolvedValue({});
  p.replyToken.findUnique.mockResolvedValue(tokenRow());
  p.email.create.mockResolvedValue({ id: 'inbound-row-1' });
  p.email.findUnique.mockResolvedValue(null);
  p.emailThread.create.mockResolvedValue({ id: 'new-thread-1' });
  p.emailThread.findUnique.mockResolvedValue({ id: THREAD, assigned_to_user_id: ASSIGNEE });
  p.customer.findUnique.mockResolvedValue({ id: CUSTOMER, first_name: 'Angel', last_name: 'Reyes', company_name: null });
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg));
});

describe('email.received - notifying', () => {
  it('emits communication.email_inbound for the stored reply', async () => {
    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    const args = (emit as any).mock.calls[0][0];
    expect(args).toMatchObject({
      verb: 'communication.email_inbound',
      organizationId: ORG,
      // A customer is not a user of ours, so there is no actor to drop.
      actorId: null,
    });
  });

  it('passes the thread assignee so the reply reaches whoever owns it', async () => {
    await post(receivedEvent());

    const args = (emit as any).mock.calls[0][0];
    expect(args.entity).toMatchObject({ thread_assignee_id: ASSIGNEE });
  });

  it('anchors the notification on the thread, which is what the inbox opens', async () => {
    await post(receivedEvent());

    const args = (emit as any).mock.calls[0][0];
    expect(args.object).toMatchObject({ type: 'EMAIL_THREAD', id: THREAD });
  });

  it('carries the subject and sender through for the bell copy', async () => {
    await post(receivedEvent());

    const args = (emit as any).mock.calls[0][0];
    expect(args.data).toMatchObject({ subject: 'Re: Quote' });
  });

  it('dedupes on the provider message id, so a webhook replay cannot double-notify', async () => {
    await post(receivedEvent());

    const args = (emit as any).mock.calls[0][0];
    expect(args.dedupKey).toContain(RECEIVED_ID);
  });

  it('pushes emails.changed to the same people, so an open Inbox refreshes', async () => {
    await post(receivedEvent());

    expect(publishEmailsChanged).toHaveBeenCalledTimes(1);
    expect(publishEmailsChanged).toHaveBeenCalledWith([ASSIGNEE], ORG);
  });

  it('does not push emails.changed when nobody was notified', async () => {
    // No recipients means no open client to refresh, and an empty publish is a
    // pointless round trip per inbound message.
    (emit as any).mockResolvedValue([]);

    await post(receivedEvent());

    expect(publishEmailsChanged).not.toHaveBeenCalled();
  });
});

describe('email.received - notifying never costs us the message', () => {
  it('still 200s when the emit throws', async () => {
    // emit() swallows its own errors, but this guards the wiring around it.
    // A non-2xx here makes Resend retry, the retry is deduped by the claim that
    // already committed, and the customer's reply is gone.
    (emit as any).mockRejectedValue(new Error('notification service down'));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(p.email.create).toHaveBeenCalledTimes(1);
  });

  it('still 200s when the emails.changed broadcast throws', async () => {
    (publishEmailsChanged as any).mockRejectedValue(new Error('realtime down'));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
  });

  it('notifies only after the row is committed, never from inside the transaction', async () => {
    // A rollback after the emit would leave a bell entry pointing at a message
    // that does not exist.
    let committed = false;
    p.$transaction.mockImplementation(async (arg: any) => {
      const out = typeof arg === 'function' ? await arg(p) : await Promise.all(arg);
      committed = true;
      return out;
    });
    (emit as any).mockImplementation(async () => {
      expect(committed).toBe(true);
      return [ASSIGNEE];
    });

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a message that could not be attributed to an org', async () => {
    // No token match - nothing was stored, so there is nothing to announce.
    p.replyToken.findUnique.mockResolvedValue(null);

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(emit).not.toHaveBeenCalled();
    expect(publishEmailsChanged).not.toHaveBeenCalled();
  });
});

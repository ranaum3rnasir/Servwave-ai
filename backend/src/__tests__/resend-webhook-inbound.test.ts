// Email slice 6 (inbound reply capture) - the email.received webhook branch.
//
// THE ORDERING HERE IS A CORRECTNESS PROPERTY, not a style choice.
//
// The webhook payload is metadata only (email_id, from, to, subject, ...) with
// no body and no headers, so the full message has to be fetched from the
// Received Emails API. That fetch is a NETWORK call, and where it sits relative
// to the idempotency claim decides whether a transient API failure loses the
// customer's message:
//
//   fetch -> claim -> persist   (correct: a failed fetch 500s having claimed
//                                nothing, so Resend's retry re-runs it)
//   claim -> fetch -> persist   (wrong: the claim survives the failure, the
//                                retry is deduped, the message is gone)
//
// It also must not sit INSIDE the transaction, which would hold a DB
// transaction open across a network round-trip.
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

import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const app = express();
app.use('/api/webhooks', webhookRoutes);

const ORG = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'v1jSzARGWhcIuV_cVcbJEw';
const RECEIVED_ID = 'rec_abc123';

function post(payload: unknown, svixId = 'evt_inbound_1') {
  return request(app)
    .post('/api/webhooks/resend')
    .set('Content-Type', 'application/json')
    .set('svix-id', svixId)
    .set('svix-timestamp', '1754390400')
    .set('svix-signature', 'v1,test-sig')
    .send(JSON.stringify(payload));
}

/** What Resend actually posts: metadata only, no body, no headers. */
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

/** What the Received Emails API returns: the same plus body, headers and raw. */
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
      text: 'Sounds good.\n\nSee you Tuesday.',
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
  p.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(p) : Promise.all(arg));
});

describe('email.received - fetching the full message', () => {
  it('calls the Received Emails API, because the webhook payload has no body', async () => {
    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(receivingGet).toHaveBeenCalledWith(RECEIVED_ID);
  });

  it('does not correlate the received id as one of our provider_message_ids', async () => {
    // email.received carries `email_id` just like the delivery events do, but it
    // is the RECEIVED message's id in a different namespace. Falling through to
    // the delivery-correlation path would look up a sent message that cannot
    // exist and log a spurious unknown-id warning.
    await post(receivedEvent());

    expect(p.email.findUnique).not.toHaveBeenCalled();
  });
});

describe('email.received - persisting the message', () => {
  it('stores an inbound row attributed to the token org and thread', async () => {
    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(p.email.create).toHaveBeenCalledTimes(1);
    expect(p.email.create.mock.calls[0][0].data).toMatchObject({
      organization_id: ORG,
      thread_id: THREAD,
      customer_id: CUSTOMER,
      direction: 'in',
      folder: 'inbox',
      subject: 'Re: Quote',
      reply_token: TOKEN,
      inbound_match: 'MATCHED',
      inbound_auth: 'PASS',
      provider_message_id: RECEIVED_ID,
    });
  });

  it('splits the plain-text body into paragraphs, matching how the app renders', async () => {
    await post(receivedEvent());

    const data = p.email.create.mock.calls[0][0].data;
    expect(data.body).toEqual(['Sounds good.', 'See you Tuesday.']);
    expect(data.snippet).toBe('Sounds good.');
  });

  it('lands unread, since nobody has seen it', async () => {
    await post(receivedEvent());
    expect(p.email.create.mock.calls[0][0].data.unread).toBe(true);
  });

  it('records the sender from the message, not from the webhook payload', async () => {
    // The payload and the API agree here, but only one of them is fetched with
    // the headers that back the DMARC verdict - keep a single source.
    await post(receivedEvent({ from: 'Spoofed <attacker@evil.com>' }));

    expect(p.email.create.mock.calls[0][0].data.from).toMatchObject({
      email: 'angel@example.com',
    });
  });
});

describe('email.received - a sender that does not check out', () => {
  it('stores the message but withholds the thread', async () => {
    receivingGet.mockResolvedValue(receivedEmail({ from: 'stranger@elsewhere.com' }));

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.inbound_match).toBe('UNMATCHED_SENDER');
    expect(data.thread_id).toBeNull();
    // Retained precisely because this is the case an operator may want to link
    // by hand - the token is what makes that one click.
    expect(data.reply_token).toBe(TOKEN);
  });

  it('routes a DMARC failure to the unmatched queue even when the address matches', async () => {
    receivingGet.mockResolvedValue(receivedEmail({
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' },
    }));

    await post(receivedEvent());

    expect(p.email.create.mock.calls[0][0].data).toMatchObject({
      inbound_match: 'UNMATCHED_SENDER',
      inbound_auth: 'FAIL',
    });
  });
});

describe('email.received - mail we cannot attribute', () => {
  it('acknowledges without storing when the token does not resolve', async () => {
    // No org to file it under, and guessing one would be a cross-tenant write.
    // A 200 rather than a 500: retrying will not make the token resolve, and a
    // retry loop on junk mail is its own problem.
    p.replyToken.findUnique.mockResolvedValue(null);

    const res = await post(receivedEvent());

    expect(res.status).toBe(200);
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('still records the event so a redelivery is deduped', async () => {
    p.replyToken.findUnique.mockResolvedValue(null);
    await post(receivedEvent());
    expect(p.resendEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe('email.received - a failed fetch must not lose the message', () => {
  it('500s and claims NOTHING when the Received Emails API errors', async () => {
    receivingGet.mockResolvedValue({ data: null, error: { message: 'boom', name: 'application_error' } });

    const res = await post(receivedEvent());

    expect(res.status).toBe(500);
    // The claim is what makes Resend's retry a no-op. Never write it before the
    // fetch that can fail.
    expect(p.resendEvent.create).not.toHaveBeenCalled();
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('500s and claims nothing when the API call throws outright', async () => {
    receivingGet.mockRejectedValue(new Error('network down'));

    const res = await post(receivedEvent());

    expect(res.status).toBe(500);
    expect(p.resendEvent.create).not.toHaveBeenCalled();
  });
});

describe('email.received - a token whose thread was deleted', () => {
  it('mints a thread rather than storing a message with nowhere to appear', async () => {
    // reply_tokens.thread_id is ON DELETE SET NULL, so a deleted thread leaves a
    // live token pointing at nothing. The message is still this org's, and a
    // row with no thread would be invisible in a thread-keyed inbox.
    p.replyToken.findUnique.mockResolvedValue(tokenRow({ thread_id: null }));

    await post(receivedEvent());

    expect(p.emailThread.create).toHaveBeenCalledTimes(1);
    expect(p.emailThread.create.mock.calls[0][0].data).toMatchObject({ organization_id: ORG });
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe('new-thread-1');
  });

  it('does not mint a thread for an unmatched sender', async () => {
    receivingGet.mockResolvedValue(receivedEmail({ from: 'stranger@elsewhere.com' }));

    await post(receivedEvent());

    expect(p.emailThread.create).not.toHaveBeenCalled();
  });
});

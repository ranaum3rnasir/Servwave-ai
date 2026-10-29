// Email slice 6 (inbound reply capture) - deciding what an inbound message is.
//
// Two properties carry all the weight here:
//
//  1. THE TOKEN AUTHENTICATES THE THREAD, NOT THE PERSON. Anyone who can read
//     the email can reply, and mail is trivially forwarded, so a valid token is
//     necessary but not sufficient. The sender check is what turns it into an
//     attribution decision, and it must fail toward the unmatched queue rather
//     than toward a wrong thread.
//  2. NEVER LOSE THE MESSAGE, NEVER GUESS. An unattributable message is dropped
//     with a log rather than filed under a guessed org - there is no org-less
//     place to put it, and picking one would be a cross-tenant write.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({ env: { EMAIL_REPLY_DOMAIN: 'reply.test.com' } }));
vi.mock('../config/env', () => mockEnv);

import { resolveInboundMessage, InboundMessage } from '../lib/inbound-email';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ORG = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'v1jSzARGWhcIuV_cVcbJEw';

const p = {
  replyToken: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
} as any;

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

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    providerId: 'rec_1',
    from: 'Angel <angel@example.com>',
    receivedFor: [`${TOKEN}@reply.test.com`],
    to: [`${TOKEN}@reply.test.com`],
    subject: 'Re: Quote',
    messageId: '<abc@mail.gmail.com>',
    receivedAt: new Date('2026-08-05T17:43:00.395Z'),
    text: 'sounds good',
    html: null,
    headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  p.replyToken.findUnique.mockResolvedValue(tokenRow());
});

describe('resolveInboundMessage - the happy path', () => {
  it('attaches a verified reply to the token thread', async () => {
    const result = await resolveInboundMessage(p, message());

    expect(result).toMatchObject({
      organization_id: ORG,
      thread_id: THREAD,
      reply_token: TOKEN,
      customer_id: CUSTOMER,
      inbound_match: 'MATCHED',
      inbound_auth: 'PASS',
    });
  });

  it('reads the token from received_for, not the To header', async () => {
    // received_for is the envelope recipient (SMTP RCPT TO). The To header is
    // author-supplied and need not contain our address at all - Bcc, forwarding
    // and list mail all break it.
    await resolveInboundMessage(p, message({
      receivedFor: [`${TOKEN}@reply.test.com`],
      to: ['someone-else@elsewhere.com'],
    }));

    expect(p.replyToken.findUnique).toHaveBeenCalledWith({ where: { token: TOKEN } });
  });

  it('falls back to the To header when received_for is empty', async () => {
    const result = await resolveInboundMessage(p, message({ receivedFor: [] }));
    expect(result?.inbound_match).toBe('MATCHED');
  });

  it('matches the sender case-insensitively', async () => {
    // A client that capitalises the user's own address must not demote them.
    const result = await resolveInboundMessage(p, message({ from: 'Angel <ANGEL@Example.COM>' }));
    expect(result?.inbound_match).toBe('MATCHED');
  });

  it('accepts a bare address with no display name', async () => {
    const result = await resolveInboundMessage(p, message({ from: 'angel@example.com' }));
    expect(result?.inbound_match).toBe('MATCHED');
  });
});

describe('resolveInboundMessage - unattributable mail is dropped, not guessed', () => {
  it('returns null when the recipient carries no token of ours', async () => {
    const result = await resolveInboundMessage(p, message({
      receivedFor: ['hello@someone-elses-domain.com'],
      to: ['hello@someone-elses-domain.com'],
    }));

    expect(result).toBeNull();
    expect(p.replyToken.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the token does not resolve', async () => {
    // Unknown, revoked or expired. There is no org to file this under, and
    // guessing one would be a cross-tenant write.
    p.replyToken.findUnique.mockResolvedValue(null);
    expect(await resolveInboundMessage(p, message())).toBeNull();
  });
});

describe('resolveInboundMessage - the sender check', () => {
  it('routes a mismatched sender to UNMATCHED_SENDER and withholds the thread', async () => {
    const result = await resolveInboundMessage(p, message({ from: 'stranger@elsewhere.com' }));

    expect(result).toMatchObject({
      organization_id: ORG,
      inbound_match: 'UNMATCHED_SENDER',
      thread_id: null,
    });
  });

  it('keeps the reply token on an UNMATCHED_SENDER row', async () => {
    // This is exactly the case where the token DID resolve a thread and we
    // refused to trust it, so retaining the token is what makes manual linking
    // one click rather than a search.
    const result = await resolveInboundMessage(p, message({ from: 'stranger@elsewhere.com' }));
    expect(result?.reply_token).toBe(TOKEN);
  });

  it('rejects a DMARC failure even when the address matches exactly', async () => {
    // A forged From that happens to name the right person is precisely what
    // DMARC catches and a string compare cannot.
    const result = await resolveInboundMessage(p, message({
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' },
    }));

    expect(result).toMatchObject({ inbound_match: 'UNMATCHED_SENDER', inbound_auth: 'FAIL' });
  });

  it('still matches on address when no DMARC verdict is available', async () => {
    // Degraded, not blocked: the sender's domain may simply publish no DMARC.
    // The verdict is recorded so the UI can decline to call this "verified".
    const result = await resolveInboundMessage(p, message({ headers: null }));

    expect(result).toMatchObject({ inbound_match: 'MATCHED', inbound_auth: 'UNAVAILABLE' });
  });

  it('records NO_POLICY without downgrading the match', async () => {
    const result = await resolveInboundMessage(p, message({
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=none' },
    }));

    expect(result).toMatchObject({ inbound_match: 'MATCHED', inbound_auth: 'NO_POLICY' });
  });

  it('treats an unparseable From as a sender mismatch', async () => {
    const result = await resolveInboundMessage(p, message({ from: 'not-an-address' }));
    expect(result?.inbound_match).toBe('UNMATCHED_SENDER');
  });
});

describe('resolveInboundMessage - a token whose thread is gone', () => {
  it('keeps the org and reports no thread rather than dropping the message', async () => {
    // reply_tokens.thread_id is ON DELETE SET NULL, so a deleted thread leaves a
    // live token pointing at nothing. The message is still genuinely this org's.
    p.replyToken.findUnique.mockResolvedValue(tokenRow({ thread_id: null }));

    const result = await resolveInboundMessage(p, message());

    expect(result).toMatchObject({
      organization_id: ORG,
      thread_id: null,
      inbound_match: 'MATCHED',
    });
  });
});

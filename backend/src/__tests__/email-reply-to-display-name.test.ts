import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// The Reply-To address a customer sees carries an OPAQUE 128-bit routing token
// as its whole local part (`M01mp2fH_5-kHn83pCugSQ@reply.servwave.com`, see
// lib/reply-token.ts). That is the right design - it is how an inbound reply
// finds its thread without trusting a spoofable header - and it is what GitHub,
// Zendesk and Front all do.
//
// What they also do, and what this covers, is attach a DISPLAY NAME. Sent bare,
// a mail client has nothing else to render and falls back to showing the raw
// token, so the customer's reply header reads like a machine id. With a name,
// the token is still there and still resolves; it is simply not what the human
// reads.
//
// Naming happens HERE rather than at the call site because dispatchEmail
// already owns the From header and already has the org row - so the two
// identities cannot drift, and every caller that passes a replyTo gets it.

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

import { prisma } from '../lib/prisma';

let dispatchEmail: typeof import('../lib/email')['__dispatchEmailForTest'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  dispatchEmail = real.__dispatchEmailForTest;
});

const TOKEN_ADDRESS = 'M01mp2fH_5-kHn83pCugSQ@reply.servwave.com';
const ORG_ID = 'org-1';

const payload = (extra: Record<string, unknown> = {}) =>
  ({ to: 'customer@example.com', subject: 's', text: 't', ...extra }) as never;

/** The `replyTo` actually handed to the provider on the first send. */
const sentReplyTo = () => resendSend.mock.calls[0]![0].replyTo;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: true,
    name: 'Acme Plumbing',
  });
  resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
});

describe('dispatchEmail - Reply-To display name', () => {
  it('names the org so the routing token is not what the customer reads', async () => {
    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).toBe(`"Acme Plumbing" <${TOKEN_ADDRESS}>`);
  });

  it('keeps the token itself byte-for-byte - the name is cosmetic, the address routes', async () => {
    // Guards the whole point of the change: if naming ever mangled the local
    // part, every reply would land in the unmatched queue instead of its thread.
    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).toContain(`<${TOKEN_ADDRESS}>`);
    expect(sentReplyTo()).toMatch(/<M01mp2fH_5-kHn83pCugSQ@reply\.servwave\.com>$/);
  });

  it('sends no Reply-To at all when the caller minted no token', async () => {
    // Unchanged behaviour, restated so naming cannot start inventing a header.
    // An advertised reply address that resolves to nothing is worse than none.
    await dispatchEmail(ORG_ID, payload());

    expect(sentReplyTo()).toBeUndefined();
  });

  it('falls back to the bare address when the org name sanitizes to nothing', async () => {
    // `"" <addr>` is worse than no name; formatSenderIdentity already returns
    // the bare address in that case and Reply-To inherits the same rule.
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: '   ',
    });

    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).toBe(TOKEN_ADDRESS);
  });

  it('quotes a name containing a double quote rather than breaking the header', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Bob "The Pipe" Plumbing',
    });

    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).toBe(`"Bob \\"The Pipe\\" Plumbing" <${TOKEN_ADDRESS}>`);
  });

  it('strips a CRLF in the org name - Reply-To is as injectable as From', async () => {
    // The org name is user-controlled. A raw CRLF here would let an org inject
    // a Bcc into every message it sends, so the same guard has to hold on both
    // headers, not just the one that happened to be written first.
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Acme\r\nBcc: attacker@example.com',
    });

    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).not.toContain('\r');
    expect(sentReplyTo()).not.toContain('\n');
    expect(sentReplyTo()).toContain(`<${TOKEN_ADDRESS}>`);
  });

  it('encodes a non-ASCII org name as an RFC 2047 word', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      email_sending_enabled: true,
      name: 'Grüne Löwen',
    });

    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }));

    expect(sentReplyTo()).toMatch(/^=\?UTF-8\?B\?.+\?= <M01mp2fH_5-kHn83pCugSQ@reply\.servwave\.com>$/);
  });

  it('names each address when Reply-To carries several', async () => {
    // Resend's own CreateEmailOptions types replyTo as `string | string[]`.
    // Treating the array as one string collapses it into a single pair of
    // angle brackets (`"Acme" <a@x.com,b@x.com>`), which is not a valid
    // address list - so the header has to be built per address.
    const second = 'ops@acme.com';

    await dispatchEmail(ORG_ID, payload({ replyTo: [TOKEN_ADDRESS, second] }));

    expect(sentReplyTo()).toEqual([
      `"Acme Plumbing" <${TOKEN_ADDRESS}>`,
      `"Acme Plumbing" <${second}>`,
    ]);
  });

  it('leaves an empty Reply-To array alone rather than inventing a header', async () => {
    await dispatchEmail(ORG_ID, payload({ replyTo: [] }));

    expect(sentReplyTo()).toEqual([]);
  });

  it('leaves Reply-To unnamed on a platform-voice send, matching its From', async () => {
    // Platform voice deliberately speaks as the platform, not the org - naming
    // the reply address after the org would contradict the From beside it.
    await dispatchEmail(ORG_ID, payload({ replyTo: TOKEN_ADDRESS }), {
      senderIdentity: 'platform',
    });

    expect(sentReplyTo()).toBe(TOKEN_ADDRESS);
  });
});

// Email slice 6 (inbound reply capture) - the reply-token library.
//
// These tests lock the properties the ADDRESS design depends on, because every
// one of them is a security or correctness property rather than a style choice:
//
//  - 22 base64url chars: RFC 5321 4.5.3.1.1 caps a local part at 64 octets, and
//    the whole reason this is an opaque lookup key rather than a signed,
//    self-describing token is that a signed payload does not fit in that budget.
//    A regression that lengthens the token silently reintroduces that failure.
//  - Unguessable: 128 bits from a CSPRNG. Anyone who learns an org's reply
//    address can post into that org's inbox, so a predictable generator is a
//    cross-tenant write primitive.
//  - No PII: the address is logged by every intermediate MTA, echoed in DSNs and
//    bounce bodies, and stored in the recipient's mail client.
//  - Revoked/expired resolves to null, and the CALLER routes that to the
//    unmatched queue. It must never hard-bounce at the customer.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test' as string,
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
  },
}));
vi.mock('../config/env', () => mockEnv);

import {
  generateReplyToken,
  replyAddressFor,
  parseReplyAddress,
  mintReplyToken,
  prepareReplyToken,
  persistReplyToken,
  resolveReplyToken,
} from '../lib/reply-token';
import { prisma } from '../lib/prisma';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const ENTITY = '44444444-4444-4444-4444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateReplyToken', () => {
  it('is 22 base64url characters - the RFC 5321 64-octet local-part budget', () => {
    const token = generateReplyToken();
    expect(token).toHaveLength(22);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('never repeats across a large batch (CSPRNG, not a counter or a clock)', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateReplyToken()));
    expect(tokens.size).toBe(2000);
  });

  it('carries no padding character, which would be mangled in a local part', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateReplyToken()).not.toContain('=');
    }
  });
});

describe('replyAddressFor', () => {
  it('puts the token in the WHOLE local part, not as a plus-suffix', () => {
    // Plus-addressing (RFC 5233 sub-addressing) is real and works at the major
    // providers, but `+` is mangled or rejected by enough MTAs and hand-rolled
    // address parsers to be a needless failure mode.
    expect(replyAddressFor('abc123')).toBe('abc123@reply.test.com');
    expect(replyAddressFor('abc123')).not.toContain('+');
  });

  it('stays inside the 64-octet local-part cap for a real generated token', () => {
    const address = replyAddressFor(generateReplyToken());
    const localPart = address.split('@')[0];
    expect(Buffer.byteLength(localPart, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('parseReplyAddress', () => {
  it('extracts the token from a bare address', () => {
    expect(parseReplyAddress('sometoken@reply.test.com')).toBe('sometoken');
  });

  it('extracts the token from a display-name form with angle brackets', () => {
    expect(parseReplyAddress('ServWave <sometoken@reply.test.com>')).toBe('sometoken');
  });

  it('is case-insensitive on the DOMAIN but preserves local-part case', () => {
    // base64url is case-SIGNIFICANT - lowercasing the local part would collapse
    // distinct tokens onto each other and destroy ~21 bits of the keyspace.
    expect(parseReplyAddress('AbC@REPLY.TEST.COM')).toBe('AbC');
  });

  it('returns null for an address on any other domain', () => {
    expect(parseReplyAddress('someone@gmail.com')).toBeNull();
    expect(parseReplyAddress('someone@notreply.test.com')).toBeNull();
    // A domain that merely ENDS WITH ours must not match - `evilreply.test.com`
    // is a different domain an attacker can own.
    expect(parseReplyAddress('someone@evilreply.test.com')).toBeNull();
  });

  it('returns null for junk rather than throwing', () => {
    expect(parseReplyAddress('')).toBeNull();
    expect(parseReplyAddress('not-an-address')).toBeNull();
    expect(parseReplyAddress('@reply.test.com')).toBeNull();
  });
});

describe('mintReplyToken', () => {
  it('reuses a live token for the same (thread, recipient) instead of minting a second', () => {
    // One stable reply address per (thread, recipient) is what makes threading
    // work at all - a new address per message would scatter one conversation
    // across as many threads as it has messages.
    p.replyToken.findFirst.mockResolvedValue({ token: 'existingtoken', revoked_at: null, expires_at: null });

    return mintReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'Customer@Example.com',
    }).then((token) => {
      expect(token).toBe('existingtoken');
      expect(p.replyToken.create).not.toHaveBeenCalled();
    });
  });

  it('normalizes expected_from to lowercase so the From comparison is case-insensitive', async () => {
    p.replyToken.findFirst.mockResolvedValue(null);
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    await mintReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: '  Customer@Example.COM  ',
      created_by_user_id: USER,
    });

    expect(p.replyToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expected_from: 'customer@example.com' }),
      }),
    );
  });

  it('never sets expires_at - tokens do not expire (settled 2026-08-05)', async () => {
    p.replyToken.findFirst.mockResolvedValue(null);
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    await mintReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
    });

    const { data } = p.replyToken.create.mock.calls[0][0];
    expect(data.expires_at ?? null).toBeNull();
  });

  it('carries the sender through so a reply inherits assignment attribution', async () => {
    p.replyToken.findFirst.mockResolvedValue(null);
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    await mintReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
      created_by_user_id: USER,
    });

    expect(p.replyToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ created_by_user_id: USER }),
      }),
    );
  });

  it('scopes the reuse lookup to the organization', async () => {
    // A token is a cross-tenant write primitive if it can be reused across
    // orgs - the reuse query must never match another org's row.
    p.replyToken.findFirst.mockResolvedValue(null);
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    await mintReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
    });

    expect(p.replyToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG }),
      }),
    );
  });
});

describe('prepareReplyToken / persistReplyToken (two-phase, for the compose path)', () => {
  // The compose path creates its EmailThread only AFTER a successful dispatch,
  // so that a send which never left leaves no orphan thread behind. But the
  // reply token has to be in the Reply-To header OF that dispatch. Minting it
  // up front would persist a row for a send that may never happen, breaking the
  // controller's own stated invariant ("a dispatch that never left persists
  // NOTHING"). Hence: resolve-or-generate first (read-only), persist after.

  it('generates without writing anything when no live token exists', async () => {
    p.replyToken.findFirst.mockResolvedValue(null);

    const { token, persist } = await prepareReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(persist).toBe(true);
    expect(p.replyToken.create).not.toHaveBeenCalled();
  });

  it('does not even look for reuse when there is no anchor', async () => {
    // A fresh compose has no thread yet (it is created after the dispatch) and
    // no entity. An unanchored lookup would reduce to `org + recipient`, which
    // matches a token bound to some OTHER thread and would silently route this
    // conversation's replies into an older one.
    const { persist } = await prepareReplyToken(p, {
      organization_id: ORG,
      expected_from: 'customer@example.com',
    });

    expect(persist).toBe(true);
    expect(p.replyToken.findFirst).not.toHaveBeenCalled();
  });

  it('gives two unanchored sends two different tokens', async () => {
    // Two fresh composes to the same person are two conversations.
    const a = await prepareReplyToken(p, { organization_id: ORG, expected_from: 'c@example.com' });
    const b = await prepareReplyToken(p, { organization_id: ORG, expected_from: 'c@example.com' });

    expect(a.token).not.toBe(b.token);
  });

  it('anchors on the entity when there is no thread', async () => {
    p.replyToken.findFirst.mockResolvedValue(null);

    await prepareReplyToken(p, {
      organization_id: ORG,
      entity_type: 'estimate',
      entity_id: ENTITY,
      expected_from: 'customer@example.com',
    });

    expect(p.replyToken.findFirst.mock.calls[0][0].where).toMatchObject({
      organization_id: ORG,
      entity_type: 'estimate',
      entity_id: ENTITY,
      revoked_at: null,
    });
  });

  it('treats a half-specified entity as no anchor at all', async () => {
    // entity_type without entity_id would otherwise match every token of that
    // type in the org, across unrelated records.
    const { persist } = await prepareReplyToken(p, {
      organization_id: ORG,
      entity_type: 'estimate',
      expected_from: 'customer@example.com',
    });

    expect(persist).toBe(true);
    expect(p.replyToken.findFirst).not.toHaveBeenCalled();
  });

  it('returns the existing token with persist=false when one is already live', async () => {
    p.replyToken.findFirst.mockResolvedValue({ token: 'existingtoken', revoked_at: null, expires_at: null });

    const { token, persist } = await prepareReplyToken(p, {
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
    });

    expect(token).toBe('existingtoken');
    expect(persist).toBe(false);
    expect(p.replyToken.create).not.toHaveBeenCalled();
  });

  it('persistReplyToken writes the prepared token verbatim', async () => {
    // The token in the row MUST be byte-identical to the one that went out in
    // the Reply-To header - regenerating here would hand the customer an
    // address that resolves to nothing.
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    await persistReplyToken(p, {
      token: 'preparedtoken1234567AB',
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'Customer@Example.com',
      created_by_user_id: USER,
    });

    expect(p.replyToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          token: 'preparedtoken1234567AB',
          thread_id: THREAD,
          expected_from: 'customer@example.com',
          created_by_user_id: USER,
        }),
      }),
    );
  });

  it('lets the thread be attached at persist time, after the thread exists', async () => {
    // A fresh compose has no thread when the header is built; the thread id is
    // only known once the dispatch succeeded and the thread row was created.
    p.replyToken.findFirst.mockResolvedValue(null);
    p.replyToken.create.mockImplementation(({ data }: any) => Promise.resolve(data));

    const { token } = await prepareReplyToken(p, {
      organization_id: ORG,
      expected_from: 'customer@example.com',
    });
    await persistReplyToken(p, {
      token,
      organization_id: ORG,
      thread_id: THREAD,
      expected_from: 'customer@example.com',
    });

    const { data } = p.replyToken.create.mock.calls[0][0];
    expect(data.token).toBe(token);
    expect(data.thread_id).toBe(THREAD);
  });
});

describe('resolveReplyToken', () => {
  it('returns the row for a live token', async () => {
    const row = { token: 't', organization_id: ORG, revoked_at: null, expires_at: null };
    p.replyToken.findUnique.mockResolvedValue(row);
    await expect(resolveReplyToken(p, 't')).resolves.toEqual(row);
  });

  it('returns null for a revoked token', async () => {
    p.replyToken.findUnique.mockResolvedValue({
      token: 't', organization_id: ORG, revoked_at: new Date('2026-01-01'), expires_at: null,
    });
    await expect(resolveReplyToken(p, 't')).resolves.toBeNull();
  });

  it('returns null for a token whose expires_at has passed', async () => {
    // Nothing sets expires_at today, but the column exists so a per-token
    // expiry can be imposed later - the read path must honour it from day one
    // rather than being retrofitted when the first one is set.
    p.replyToken.findUnique.mockResolvedValue({
      token: 't', organization_id: ORG, revoked_at: null, expires_at: new Date('2020-01-01'),
    });
    await expect(resolveReplyToken(p, 't')).resolves.toBeNull();
  });

  it('returns the row when expires_at is in the future', async () => {
    const future = new Date(Date.now() + 86_400_000);
    const row = { token: 't', organization_id: ORG, revoked_at: null, expires_at: future };
    p.replyToken.findUnique.mockResolvedValue(row);
    await expect(resolveReplyToken(p, 't')).resolves.toEqual(row);
  });

  it('returns null for an unknown token without throwing', async () => {
    p.replyToken.findUnique.mockResolvedValue(null);
    await expect(resolveReplyToken(p, 'nope')).resolves.toBeNull();
  });
});

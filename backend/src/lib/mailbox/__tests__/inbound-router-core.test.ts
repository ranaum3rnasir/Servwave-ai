import { describe, it, expect, vi } from 'vitest';
import {
  planInbound,
  recipientCandidates,
  MAX_MAILBOX_CANDIDATES,
  type RouterLookups,
  type RegisteredMailbox,
} from '../inbound-router-core';

/**
 * PRD 10, S10.14: the inbound router's decision, taken from the recipients alone and before any message body is fetched. The
 * core is pure apart from the two lookups it is handed, so every branch is driven here with fakes; the real tables are
 * covered by permission-email-inbound-router-db.test.ts through the delivery webhook.
 */

const DOMAINS = { replyDomain: 'reply.test.com', mailboxDomain: 'mail.test.com' };
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const box = (localPart: string, organizationId: string, mailboxId: string): RegisteredMailbox => ({ localPart, organizationId, mailboxId });

function lookups(opts: { tokens?: string[]; dead?: string[]; boxes?: RegisteredMailbox[] } = {}) {
  const liveTokens = vi.fn(async (tokens: string[]) => tokens.filter((t) => (opts.tokens ?? []).includes(t)).map((token) => ({ token })));
  // Every token the table holds, live or not: the router asks only once no live token took the message.
  const knownTokens = vi.fn(async (tokens: string[]) => tokens.filter((t) => [...(opts.tokens ?? []), ...(opts.dead ?? [])].includes(t)).map((token) => ({ token })));
  const issuedAddresses = vi.fn(async (parts: string[]) => (opts.boxes ?? []).filter((b) => parts.includes(b.localPart)));
  const l: RouterLookups<{ token: string }> = { liveTokens, knownTokens, issuedAddresses };
  return { l, liveTokens, knownTokens, issuedAddresses };
}

describe('recipientCandidates', () => {
  it('reads the bare and the display-name forms, keeps a token\'s case, lowercases a mailbox address and drops the rest', () => {
    const found = recipientCandidates(
      ['Angel <AbC_dEf-123@Reply.Test.com>', 'Jane.Doe.Acme@MAIL.test.com', 'someone@elsewhere.com', 'no-at-sign', ''],
      DOMAINS,
    );
    expect(found.tokens).toEqual(['AbC_dEf-123']);
    expect(found.mailboxes).toEqual([{ localPart: 'jane.doe.acme', address: 'jane.doe.acme@mail.test.com' }]);
  });

  it('never takes a look-alike of either domain', () => {
    const found = recipientCandidates(['tok@evilreply.test.com', 'tok@reply.test.com.evil.io', 'a.b.c@evilmail.test.com', 'a.b.c@staging.mail.test.com'], DOMAINS);
    expect(found).toEqual({ tokens: [], mailboxes: [] });
  });

  it('never offers a reserved local part, whatever its case, to the register', () => {
    const found = recipientCandidates(['no-reply@mail.test.com', 'NoReply@mail.test.com', 'postmaster@mail.test.com', 'abuse@mail.test.com', 'bounces@mail.test.com'], DOMAINS);
    expect(found.mailboxes).toEqual([]);
  });

  it('lists each address once, in the order it came, and caps how many the register is asked about', () => {
    const found = recipientCandidates(['a.b.c@mail.test.com', 'A.B.C@mail.test.com', 'x.y.c@mail.test.com'], DOMAINS);
    expect(found.mailboxes.map((m) => m.localPart)).toEqual(['a.b.c', 'x.y.c']);
    const many = Array.from({ length: MAX_MAILBOX_CANDIDATES + 20 }, (_, i) => `u${i}.x.c@mail.test.com`);
    expect(recipientCandidates(many, DOMAINS).mailboxes).toHaveLength(MAX_MAILBOX_CANDIDATES);
    const tokens = Array.from({ length: MAX_MAILBOX_CANDIDATES + 20 }, (_, i) => `tok${i}@reply.test.com`);
    expect(recipientCandidates(tokens, DOMAINS).tokens).toHaveLength(MAX_MAILBOX_CANDIDATES);
  });

  it('answers nothing for a mailbox domain this environment does not have', () => {
    expect(recipientCandidates(['a.b.c@mail.test.com'], { replyDomain: 'reply.test.com', mailboxDomain: '' }).mailboxes).toEqual([]);
  });
});

describe('planInbound', () => {
  it('drops mail with no candidate at all without asking either lookup anything', async () => {
    const { l, liveTokens, issuedAddresses } = lookups();
    expect(await planInbound(['stranger@elsewhere.com', 'no-reply@mail.test.com'], DOMAINS, l)).toEqual({ state: 'dropped' });
    expect(liveTokens).not.toHaveBeenCalled();
    expect(issuedAddresses).not.toHaveBeenCalled();
  });

  it('routes a live reply token to its row, first among the tokens in the order they came', async () => {
    const { l } = lookups({ tokens: ['one', 'two'] });
    const plan = await planInbound(['x@elsewhere.com', 'two@reply.test.com', 'one@reply.test.com'], DOMAINS, l);
    expect(plan).toEqual({ state: 'token', token: { token: 'two' } });
  });

  it('asks the token lookup once for all the tokens, not once per recipient', async () => {
    const { l, liveTokens } = lookups({ tokens: ['b'] });
    await planInbound(['a@reply.test.com', 'b@reply.test.com', 'c@reply.test.com'], DOMAINS, l);
    expect(liveTokens).toHaveBeenCalledTimes(1);
    expect(liveTokens).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('puts a token ahead of a mailbox address in the same message, and does not ask the register', async () => {
    const { l, issuedAddresses } = lookups({ tokens: ['tok'], boxes: [box('a.b.c', ORG_A, 'm1')] });
    const plan = await planInbound(['a.b.c@mail.test.com', 'tok@reply.test.com'], DOMAINS, l);
    expect(plan.state).toBe('token');
    expect(issuedAddresses).not.toHaveBeenCalled();
  });

  it('falls through to a mailbox address when the token no longer resolves', async () => {
    const { l } = lookups({ tokens: [], boxes: [box('a.b.c', ORG_A, 'm1')] });
    const plan = await planInbound(['dead@reply.test.com', 'a.b.c@mail.test.com'], DOMAINS, l);
    expect(plan).toEqual({ state: 'mailboxes', organizationId: ORG_A, deliveries: [{ mailboxId: 'm1', address: 'a.b.c@mail.test.com' }] });
  });

  it('drops a token the table has never held when nothing else can take the message: there is no company to file it under', async () => {
    const { l } = lookups({ tokens: [] });
    expect(await planInbound(['guess@reply.test.com'], DOMAINS, l)).toEqual({ state: 'dropped' });
  });

  it('holds a token that no longer resolves (revoked or expired) when nothing else can take the message (PRD 10, S10.18)', async () => {
    const { l } = lookups({ dead: ['dead'] });
    expect(await planInbound(['dead@reply.test.com'], DOMAINS, l)).toEqual({ state: 'unresolved_token', token: { token: 'dead' } });
  });

  it('asks which tokens the table holds only when no live token and no mailbox address took the message', async () => {
    const live = lookups({ tokens: ['live'], dead: ['dead'] });
    await planInbound(['dead@reply.test.com', 'live@reply.test.com'], DOMAINS, live.l);
    expect(live.knownTokens).not.toHaveBeenCalled();
    const mailbox = lookups({ dead: ['dead'], boxes: [box('a.b.c', ORG_A, 'm1')] });
    await planInbound(['dead@reply.test.com', 'a.b.c@mail.test.com'], DOMAINS, mailbox.l);
    expect(mailbox.knownTokens).not.toHaveBeenCalled();
  });

  it('drops an address the register does not hold as issued', async () => {
    const { l, issuedAddresses } = lookups({ boxes: [] });
    expect(await planInbound(['never.issued.c@mail.test.com'], DOMAINS, l)).toEqual({ state: 'dropped' });
    expect(issuedAddresses).toHaveBeenCalledTimes(1);
  });

  it('drops an address on another environment\'s mailbox domain without asking the register', async () => {
    const { l, issuedAddresses } = lookups({ boxes: [box('a.b.c', ORG_A, 'm1')] });
    expect(await planInbound(['a.b.c@mail.servwave.com'], DOMAINS, l)).toEqual({ state: 'dropped' });
    expect(issuedAddresses).not.toHaveBeenCalled();
  });

  it('delivers one message to two of the company\'s mailboxes once each, in mailbox id order', async () => {
    const { l, issuedAddresses } = lookups({ boxes: [box('u.two.c', ORG_A, 'm9'), box('u.one.c', ORG_A, 'm2')] });
    const plan = await planInbound(['u.two.c@mail.test.com', 'u.one.c@mail.test.com'], DOMAINS, l);
    expect(plan).toEqual({
      state: 'mailboxes',
      organizationId: ORG_A,
      deliveries: [{ mailboxId: 'm2', address: 'u.one.c@mail.test.com' }, { mailboxId: 'm9', address: 'u.two.c@mail.test.com' }],
    });
    expect(issuedAddresses).toHaveBeenCalledTimes(1);
  });

  it('delivers once to a mailbox reached by two of its addresses', async () => {
    const { l } = lookups({ boxes: [box('new.name.c', ORG_A, 'm1'), box('old.name.c', ORG_A, 'm1')] });
    const plan = await planInbound(['old.name.c@mail.test.com', 'new.name.c@mail.test.com'], DOMAINS, l);
    expect(plan).toEqual({ state: 'mailboxes', organizationId: ORG_A, deliveries: [{ mailboxId: 'm1', address: 'old.name.c@mail.test.com' }] });
  });

  it('never stores one message under two companies: the first recipient\'s company takes it and the other is left out', async () => {
    const { l } = lookups({ boxes: [box('a.x.one', ORG_A, 'm1'), box('b.y.two', ORG_B, 'm2')] });
    const plan = await planInbound(['b.y.two@mail.test.com', 'a.x.one@mail.test.com'], DOMAINS, l);
    expect(plan).toEqual({ state: 'mailboxes', organizationId: ORG_B, deliveries: [{ mailboxId: 'm2', address: 'b.y.two@mail.test.com' }] });
  });

  it('keeps a mailbox address that is registered while its sibling is not', async () => {
    const { l } = lookups({ boxes: [box('a.b.c', ORG_A, 'm1')] });
    const plan = await planInbound(['ghost.b.c@mail.test.com', 'a.b.c@mail.test.com'], DOMAINS, l);
    expect(plan.state).toBe('mailboxes');
  });
});

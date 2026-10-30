/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.11 - the dispatch choke point gains one input, the mailbox to send from,
   and resolves the address from the register: a hand-written email goes out from the sender's own address with
   "<sender's name> at <company name>" as the display name.

   The real dispatcher against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Only
   the provider's client is faked, so the headers that "went out" can be read back.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    MAILBOX_DOMAIN: 'staging.mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

const suite = realClient ? describe : describe.skip;

const tag = () =>
  randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10);

suite('a hand-written email goes out from the sender\'s own mailbox (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const users: string[] = [];

  async function newCompany(name: string, extra: Record<string, unknown> = {}) {
    const { createCompanyWithMainMailbox } = await import('../lib/mailbox/register.js');
    const id = randomUUID();
    const org = await createCompanyWithMainMailbox(db, {
      id, name, email: `${id.slice(0, 8)}@example.test`, address_line1: '1 Test Way', city: 'Testville',
      state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      email_sending_enabled: true, ...extra,
    });
    orgs.push(org.id);
    return org;
  }

  async function newPerson(orgId: string, first: string, last: string) {
    const { issueUserMailbox } = await import('../lib/mailbox/register.js');
    const id = randomUUID();
    await db.user.create({ data: { id, organization_id: orgId, email: `${id}@example.test`, first_name: first, last_name: last, role: 'DISPATCHER' } });
    users.push(id);
    const issued = await db.$transaction((tx) => issueUserMailbox(tx, { id, organization_id: orgId, first_name: first, last_name: last }));
    return { id, mailboxId: issued.mailboxId, status: issued.status };
  }

  const mainOf = async (orgId: string) => (await db.mailbox.findFirstOrThrow({ where: { organization_id: orgId, kind: 'main' } })).id;

  const MESSAGE = { to: 'customer@example.com', subject: 's', text: 't' };

  async function send(orgId: string, sender: { mailboxId: string; userId: string }, extra: { replyTo?: string; to?: string } = {}) {
    const { sendComposedEmail } = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    return sendComposedEmail({ organizationId: orgId, ...MESSAGE, ...extra, handSender: sender });
  }

  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('sends from the sender\'s own primary address with "<name> at <company>" as the display name, and reports exactly what went out', async () => {
    const t = tag();
    const org = await newCompany(`Acme ${t}`);
    const jane = await newPerson(org.id, 'Jane', `Smith${t}`);

    const result = await send(org.id, { mailboxId: jane.mailboxId, userId: jane.id });

    const address = `jane.smith${t}.acme${t}@staging.mail.test.com`;
    const header = resendSend.mock.calls[0]![0].from as string;
    expect(header).toBe(`"Jane Smith${t} at Acme ${t}" <${address}>`);
    expect(result).toMatchObject({ status: 'sent', fromAddress: address, fromName: `Jane Smith${t} at Acme ${t}` });
  });

  it('names the hidden reply address the same way, so the two identities on one message agree', async () => {
    const t = tag();
    const org = await newCompany(`Reply ${t}`);
    const jane = await newPerson(org.id, 'Jane', `Smith${t}`);

    await send(org.id, { mailboxId: jane.mailboxId, userId: jane.id }, { replyTo: 'abc123@reply.test.com' });

    expect(resendSend.mock.calls[0]![0].replyTo).toBe(`"Jane Smith${t} at Reply ${t}" <abc123@reply.test.com>`);
  });

  it('sends from the NEW primary address after the address was changed', async () => {
    const { setUserNamePart } = await import('../lib/mailbox/register.js');
    const t = tag();
    const org = await newCompany(`Moved ${t}`);
    const jane = await newPerson(org.id, 'Jane', `Smith${t}`);
    const changed = await setUserNamePart(db, { organizationId: org.id, userId: jane.id, namePart: `janet${t}` });
    expect(changed.ok).toBe(true);

    const result = await send(org.id, { mailboxId: jane.mailboxId, userId: jane.id });

    expect(result).toMatchObject({ status: 'sent', fromAddress: `janet${t}.moved${t}@staging.mail.test.com` });
  });

  it('keeps a hostile name from splitting the header', async () => {
    const t = tag();
    const org = await newCompany(`Hostile ${t}`);
    const evil = await newPerson(org.id, `Eve\r\nBcc: spy@example.com "<x>,`, `Hacker${t}`);

    await send(org.id, { mailboxId: evil.mailboxId, userId: evil.id });

    const header = resendSend.mock.calls[0]![0].from as string;
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toMatch(/^"[^"<>,\\]*" <[^<>\s,"]+>$/);
  });

  it('refuses a person with no address ("address needed") and sends nothing', async () => {
    const t = tag();
    const org = await newCompany(`Needed ${t}`);
    const jane = await newPerson(org.id, 'Jane', `Smith${t}`);
    await db.mailboxAddress.deleteMany({ where: { mailbox_id: jane.mailboxId } });
    await db.mailbox.update({ where: { id: jane.mailboxId }, data: { status: 'address_needed' } });

    const result = await send(org.id, { mailboxId: jane.mailboxId, userId: jane.id });

    expect(result).toEqual({ status: 'skipped', reason: 'address_needed' });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('refuses the main mailbox, a colleague\'s mailbox and another company\'s mailbox as the one to send from', async () => {
    const t = tag();
    const org = await newCompany(`Own ${t}`);
    const other = await newCompany(`Other ${t}`);
    const jane = await newPerson(org.id, 'Jane', `Smith${t}`);
    const colleague = await newPerson(org.id, 'Colin', `Jones${t}`);
    const stranger = await newPerson(other.id, 'Sam', `Rivers${t}`);

    for (const mailboxId of [await mainOf(org.id), colleague.mailboxId, stranger.mailboxId]) {
      expect(await send(org.id, { mailboxId, userId: jane.id })).toEqual({ status: 'skipped', reason: 'foreign_mailbox' });
    }
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('refuses a sender who is not in the company the send is for', async () => {
    const t = tag();
    const org = await newCompany(`Mine ${t}`);
    const other = await newCompany(`Theirs ${t}`);
    const stranger = await newPerson(other.id, 'Sam', `Rivers${t}`);

    const result = await send(org.id, { mailboxId: stranger.mailboxId, userId: stranger.id });

    expect(result.status).toBe('skipped');
    expect(resendSend).not.toHaveBeenCalled();
  });

  it('still honours the company switch and the suppression list', async () => {
    const t = tag();
    const off = await newCompany(`Off ${t}`, { email_sending_enabled: false });
    const offJane = await newPerson(off.id, 'Jane', `Smith${t}`);
    expect(await send(off.id, { mailboxId: offJane.mailboxId, userId: offJane.id })).toEqual({ status: 'skipped', reason: 'org_disabled' });

    const on = await newCompany(`On ${t}`);
    const onJane = await newPerson(on.id, 'Jane', `Smith${t}`);
    const bounced = `bounced-${t}@example.com`;
    await db.emailSuppression.create({ data: { address: bounced, category: 'TRANSACTIONAL', kind: 'HARD_BOUNCE' } });
    expect(await send(on.id, { mailboxId: onJane.mailboxId, userId: onJane.id }, { to: bounced })).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(resendSend).not.toHaveBeenCalled();
    await db.emailSuppression.deleteMany({ where: { address: bounced } });
  });
});

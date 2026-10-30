/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - automated mail still goes out from the company address,
   now resolved from the register, and a company rename no longer moves it.

   The real dispatcher against a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Only the provider's client is faked, so the From header that "went out" can be read back.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
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

suite('automated mail From, from the register (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const PAYLOAD = { to: 'customer@example.com', subject: 's', text: 't' } as never;

  async function newCompany(name: string) {
    const { createCompanyWithMainMailbox } = await import('../lib/mailbox/register.js');
    const id = randomUUID();
    const org = await createCompanyWithMainMailbox(db, {
      id, name, email: `${id.slice(0, 8)}@example.test`, address_line1: '1 Test Way', city: 'Testville',
      state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      email_sending_enabled: true,
    });
    orgs.push(org.id);
    return org;
  }

  async function send(orgId: string) {
    const { __dispatchEmailForTest } = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
    resendSend.mockClear();
    const result = await __dispatchEmailForTest(orgId, PAYLOAD);
    return { result: result as { status: string; fromAddress: string }, header: resendSend.mock.calls[0]![0].from as string };
  }

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('sends from the main address the register issued, and the recorded From equals the header that went out', async () => {
    const t = tag();
    const org = await newCompany(`Acme ${t}`);

    const { result, header } = await send(org.id);

    expect(result.fromAddress).toBe(`acme${t}@staging.mail.test.com`);
    expect(header).toBe(`"Acme ${t}" <acme${t}@staging.mail.test.com>`);
  });

  it('keeps the same From after the company is renamed, with the new name as the display name', async () => {
    const t = tag();
    const org = await newCompany(`Before ${t}`);
    await db.organization.update({ where: { id: org.id }, data: { name: `After ${t}` } });

    const { result, header } = await send(org.id);

    expect(result.fromAddress).toBe(`before${t}@staging.mail.test.com`);
    expect(header).toBe(`"After ${t}" <before${t}@staging.mail.test.com>`);
  });

  it('follows a deliberate change of the company part', async () => {
    const { changeCompanyPart } = await import('../lib/mailbox/register.js');
    const t = tag();
    const org = await newCompany(`Change ${t}`);
    await changeCompanyPart(db, org.id, `service${t}`);

    const { result } = await send(org.id);

    expect(result.fromAddress).toBe(`service${t}@staging.mail.test.com`);
  });

  it('after a change that also moves every person\'s address, automated sends and the sender-address resolver use the new main address', async () => {
    const { changeCompanyPart, issueUserMailbox } = await import('../lib/mailbox/register.js');
    const { orgSendingIdentity } = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    const t = tag();
    const org = await newCompany(`Moves ${t}`);
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, organization_id: org.id, email: `${userId}@example.test`, first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER' } });
    await db.$transaction((tx) => issueUserMailbox(tx, { id: userId, organization_id: org.id, first_name: 'Jane', last_name: 'Smith' }));
    await changeCompanyPart(db, org.id, `newer${t}`);

    const { result, header } = await send(org.id);

    expect(result.fromAddress).toBe(`newer${t}@staging.mail.test.com`);
    expect(header).toBe(`"Moves ${t}" <newer${t}@staging.mail.test.com>`);
    expect(await orgSendingIdentity(org.id)).toMatchObject({ address: `newer${t}@staging.mail.test.com`, localPart: `newer${t}` });
    await db.user.deleteMany({ where: { id: userId } });
  });
});

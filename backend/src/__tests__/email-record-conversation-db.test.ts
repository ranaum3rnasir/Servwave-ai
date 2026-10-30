/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.4 - a send that names its record opens (or reuses) that
   record's conversation in the company's main mailbox with origin "record", and the person who sent a
   document by hand is recorded on the stored email and on the reply token. An automated send records
   nobody. A send that names no record stays loose: no conversation, so no mailbox.

   The real senders against a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Only the provider's client is faked.
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
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
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

suite('a send that names its record opens its conversation in a mailbox (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];

  async function newCompany() {
    const { createCompanyWithMainMailbox } = await import('../lib/mailbox/register.js');
    const id = randomUUID();
    const org = await createCompanyWithMainMailbox(db, {
      id, name: `Co ${id.slice(0, 8)}`, email: `${id.slice(0, 8)}@example.test`, address_line1: '1 Test Way', city: 'Testville',
      state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      email_sending_enabled: true,
    });
    orgs.push(org.id);
    const main = await db.mailbox.findFirstOrThrow({ where: { organization_id: org.id, kind: 'main' } });
    return { orgId: org.id, mainMailboxId: main.id };
  }

  async function newUser(orgId: string) {
    const id = randomUUID();
    await db.user.create({
      data: { id, email: `u${id.slice(0, 8)}@example.test`, first_name: 'Sam', last_name: 'Sender', role: 'ADMIN', is_admin: true, organization_id: orgId },
    });
    return id;
  }

  /** A payment notice about an invoice: the sender with no PDF, so it runs on real tables alone. */
  async function sendInvoiceNotice(orgId: string, invoiceId: string, extra: Record<string, unknown> = {}, to = 'jane@example.test') {
    const email = await vi.importActual<typeof import('../lib/email')>('../lib/email');
    await email.sendPaymentReceivedEmail({
      organizationId: orgId, to, customerName: 'Jane', invoiceNumber: 'INV-1', amount: 10, method: 'CASH', newBalance: 0,
      record: { organizationId: orgId, entityType: 'invoice', entityId: invoiceId, ...extra },
    });
  }

  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  afterAll(async () => {
    await db.emailThread.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.replyToken.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.email.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.user.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('opens the record conversation in the main mailbox with origin "record" and the record it belongs to', async () => {
    const { orgId, mainMailboxId } = await newCompany();
    const invoiceId = randomUUID();

    await sendInvoiceNotice(orgId, invoiceId);

    const threads = await db.emailThread.findMany({ where: { organization_id: orgId } });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      mailbox_id: mainMailboxId, origin: 'record', record_type: 'invoice', record_id: invoiceId, assigned_to_user_id: null,
    });
    const sent = await db.email.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(sent.thread_id).toBe(threads[0]!.id);
  });

  it('reuses the record conversation for a later send about the same record to the same person', async () => {
    const { orgId } = await newCompany();
    const invoiceId = randomUUID();

    await sendInvoiceNotice(orgId, invoiceId);
    await sendInvoiceNotice(orgId, invoiceId);

    expect(await db.emailThread.count({ where: { organization_id: orgId } })).toBe(1);
    expect(await db.email.count({ where: { organization_id: orgId } })).toBe(2);
  });

  it('records the person who pressed Send on the stored email and on the reply token', async () => {
    const { orgId } = await newCompany();
    const sender = await newUser(orgId);

    await sendInvoiceNotice(orgId, randomUUID(), { sentByUserId: sender });

    const sent = await db.email.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(sent.sent_by_user_id).toBe(sender);
    expect(sent.automated).toBe(true);
    const token = await db.replyToken.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(token.created_by_user_id).toBe(sender);
  });

  it('records nobody for an automated send', async () => {
    const { orgId } = await newCompany();

    await sendInvoiceNotice(orgId, randomUUID());

    const sent = await db.email.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(sent.sent_by_user_id).toBeNull();
    const token = await db.replyToken.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(token.created_by_user_id).toBeNull();
  });

  it('leaves a send that names no record loose: no conversation, so no mailbox', async () => {
    const { orgId } = await newCompany();
    const email = await vi.importActual<typeof import('../lib/email')>('../lib/email');

    await email.sendPaymentReceivedEmail({
      organizationId: orgId, to: 'jane@example.test', customerName: 'Jane', invoiceNumber: 'INV-2', amount: 10, method: 'CASH', newBalance: 0,
      record: { organizationId: orgId },
    });

    expect(await db.emailThread.count({ where: { organization_id: orgId } })).toBe(0);
    const sent = await db.email.findFirstOrThrow({ where: { organization_id: orgId } });
    expect(sent.thread_id).toBeNull();
  });
});

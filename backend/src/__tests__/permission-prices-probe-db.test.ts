/* =============================================================================
   Roles & Permissions security fixes, H6 (ticket 34): the regression guard for Ran's ruling (2026-10-28).

   "The only prices are prices in the platform itself: if an entity has a price as a variable or field, hide it. If it's
   just in text, as part of a string, don't. For notes, messages, any communication: we do not scan those." The customer's
   link inside a message is left as it is, and the PDF on an email ServWave sent opens for anyone who can read the
   message.

   So, for a person without See prices:
     - the invoice email ServWave sent, a text an automation sent, the customer's reply and a logged note come back
       EXACTLY as stored, amounts, link and token included, and the email's PDF opens;
     - on the same records the price FIELDS are still left out: an invoice's total and line prices, an estimate's deposit,
       and the record's `public_token` field.
   With See prices, everything is there.

   Everything goes through the public routes, as a person on a custom role made from blank with exactly the switches the
   routes need. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { persistTransactionalEmail } from '../lib/comm-persist';
import { recordOutboundSms } from '../services/automations/smsRecord';

const suite = realClient ? describe : describe.skip;
const SEE_PRICES = 'see_prices';
const hasKey = (o: unknown, k: string) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

suite('H6 ruling: messages are left as written, price fields are hidden (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['email_attachments', 'emails', 'messages', 'message_threads', 'manual_communication_logs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let org: string;
  let customer: string;
  let roleKey: string;
  let me: Person;
  const ids: Record<string, string> = {};
  const invoiceToken = randomUUID();
  const estimateToken = randomUUID();
  const stored: Record<string, string> = {};

  const setSeePrices = (on: boolean) =>
    setRoleSwitchValues({ organizationId: org, roleKey, actorId: null, reason: 'manual', values: { [SEE_PRICES]: on } });
  const api = (): Promise<Api> => fx.signedInAs(me);

  beforeAll(async () => {
    const world = await fx.newOrg();
    org = world.org;
    customer = world.customer;
    orgs.push(org);

    roleKey = 'h6-ruling';
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({
      organizationId: org, roleKey, actorId: null, reason: 'manual',
      values: {
        ...allOff, jobs_scope: 'all', leads_scope: 'all', communication_scope: 'all', [SEE_PRICES]: true,
        view_jobs: true, view_customers: true, view_invoices: true, view_estimates: true,
        view_communication: true, access_communication: true, show_email: true, show_text: true, log_past_communications: true,
      },
    });
    me = await fx.addUser(org, 'h6ruling', 'TECHNICIAN', { customRoleId: role.id });

    const job = await fx.addJob(org, customer);
    ids.job = job.id;
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    ids.invoice = inv.id;
    await db.invoice.update({ where: { id: inv.id }, data: { status: 'SENT', public_token: invoiceToken, amount_due: 60, sent_at: new Date() } });
    const est = await fx.addEstimate(org, customer, world.admin.id, { jobId: job.id });
    ids.estimate = est.id;
    await db.estimate.update({
      where: { id: est.id }, data: { status: 'SENT', public_token: estimateToken, sent_at: new Date(), deposit_type: 'FIXED', deposit_value: 25 },
    });
    const link = `https://app.example.test/p/invoices/${inv.id}?token=${invoiceToken}`;

    // The invoice email ServWave sent, with its PDF.
    stored.notice = `Hi Pat, invoice INV-1 for $60.00 is due on Nov 30, 2026. Pay here: ${link}`;
    await persistTransactionalEmail({
      organizationId: org, customerId: customer, jobId: job.id, entityType: 'invoice', entityId: inv.id,
      to: 'pat@example.test', subject: 'Invoice INV-1 from Test Co', text: stored.notice, fromName: 'Test Co', fromAddress: 'billing@example.test',
      attachments: [{ filename: 'invoice-INV-1.pdf', content: Buffer.from('%PDF-1.4 ruling'), contentType: 'application/pdf' }],
    });
    ids.notice = (await db.email.findFirstOrThrow({ where: { organization_id: org, account: 'system' } })).id;

    // The customer's reply, quoting it with the link rewritten by a mail provider's link wrapper.
    stored.reply = `Thanks, paid $60.00!\n\n> Pay here: https://eur01.safelinks.example/?url=${encodeURIComponent(link)}&data=05`;
    ids.reply = (await db.email.create({
      data: {
        organization_id: org, account: 'inbox', direction: 'in', folder: 'inbox', customer_id: customer, job_id: job.id,
        from: { name: 'Pat Payer', email: 'pat@example.test' }, to: 'billing@example.test', subject: 'Re: Invoice INV-1 ($60.00)',
        snippet: stored.reply.slice(0, 200), body: [stored.reply], at: '9:00 AM', ts: BigInt(Date.now()), unread: true, starred: false,
      },
    })).id;

    // A text an automation sent.
    stored.text = `Hi Pat, your invoice for $60.00 is ready: ${link}`;
    const sms = await recordOutboundSms({ organizationId: org, to: { type: 'customer', customerId: customer, job: { id: job.id, label: null } }, body: stored.text });
    ids.textThread = sms.threadId;
    ids.text = sms.messageId;

    // A logged note.
    stored.note = 'Told them the repair is $60 and they agreed.';
    ids.note = (await db.manualCommunicationLog.create({
      data: {
        organization_id: org, channel: 'CALL', direction: 'OUT', occurred_at: new Date('2026-10-20T15:00:00Z'),
        performed_by: me.id, logged_by: me.id, notes: stored.note, job_id: job.id,
      },
    })).id;
  }, 180_000);

  /** The stored messages, read back on their own routes, must equal what was stored. */
  async function messagesComeBackAsStored() {
    const notice = await (await api()).get(`/api/communication/emails/${ids.notice}`);
    expect(notice.status).toBe(200);
    expect(notice.body.email.body).toEqual([stored.notice]);
    expect(notice.body.email.snippet).toBe(stored.notice.slice(0, 200));
    expect(notice.body.email.attachments?.[0]?.name).toBe('invoice-INV-1.pdf');

    const reply = await (await api()).get(`/api/communication/emails/${ids.reply}`);
    expect(reply.status).toBe(200);
    expect(reply.body.email.body).toEqual([stored.reply]);
    expect(reply.body.email.subject).toBe('Re: Invoice INV-1 ($60.00)');

    const thread = await (await api()).get(`/api/communication/threads/${ids.textThread}`);
    expect(thread.status).toBe(200);
    expect(thread.body.thread.messages.find((m: { id: string }) => m.id === ids.text).body).toBe(stored.text);

    const note = await (await api()).get(`/api/communication/manual-log/${ids.note}`);
    expect(note.status).toBe(200);
    expect(note.body.entry.notes).toBe(stored.note);

    const tab = await (await api()).get(`/api/jobs/${ids.job}/communications`);
    expect(tab.status).toBe(200);
    const items = tab.body.items as Array<{ id: string; preview: string }>;
    expect(items.find((i) => i.id === ids.text)!.preview).toContain('$60.00');
    expect(items.find((i) => i.id === ids.notice)!.preview).toContain('$60.00');

    // The PDF on the email ServWave sent opens for anyone who can read the message.
    const pdf = await (await api()).get(`/api/communication/emails/${ids.notice}/attachments/0`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.url).toMatch(/^https:/);
  }

  it('without See prices, every message comes back exactly as stored, link and amounts included, and the PDF opens', async () => {
    await setSeePrices(false);
    await messagesComeBackAsStored();
  });

  it('without See prices, the price fields of the same records are still left out', async () => {
    await setSeePrices(false);
    const inv = await (await api()).get(`/api/invoices/${ids.invoice}`);
    expect(inv.status).toBe(200);
    for (const k of ['total_amount', 'amount_due', 'public_token']) expect(hasKey(inv.body.invoice, k), `invoice.${k}`).toBe(false);
    expect(hasKey(inv.body.invoice.line_items[0], 'unit_price')).toBe(false);
    expect(hasKey(inv.body.invoice, 'invoice_number')).toBe(true);

    const est = await (await api()).get(`/api/estimates/${ids.estimate}`);
    expect(est.status).toBe(200);
    for (const k of ['total_amount', 'deposit_value', 'public_token']) expect(hasKey(est.body.estimate, k), `estimate.${k}`).toBe(false);
    expect(hasKey(est.body.estimate, 'estimate_number')).toBe(true);
  });

  it('with See prices, the messages are as stored and the price fields are there', async () => {
    await setSeePrices(true);
    await messagesComeBackAsStored();
    const inv = await (await api()).get(`/api/invoices/${ids.invoice}`);
    expect(inv.body.invoice.public_token).toBe(invoiceToken);
    expect(hasKey(inv.body.invoice, 'total_amount')).toBe(true);
    expect(hasKey(inv.body.invoice.line_items[0], 'unit_price')).toBe(true);
    const est = await (await api()).get(`/api/estimates/${ids.estimate}`);
    expect(est.body.estimate.public_token).toBe(estimateToken);
    expect(Number(est.body.estimate.deposit_value)).toBe(25);
  });
});

/* =============================================================================
   Roles & Permissions security, pre-PR review fixes (re-audit 2026-10-29, fix builder D). One case per finding, each through the
   HTTP API on a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.

   Every person is on a custom role holding exactly the switches the case is about. Each case also proves its control: the
   person who should see or do the thing still does, so a case cannot pass because nobody gets anything.

     H3   the customer Jobs tab lists an invoice's id and status only to a person who can open invoices;
     N17  the estimate's deposit invoice follows View invoices, and its amounts follow See prices;
     N5   the payments drawer's invoice total, balance and "can take now" follow See prices;
     N10  an estimate version's struck-through full price follows See prices;
     N11  a payout's difference figure follows See prices;
     N6   a record's history names a colleague, never their login address, to a non-Admin;
     N8   a mailbox that came from an Admin is the Owner's to hand on;
     N9   an email is filed on a customer only when the sender can open that customer;
     N16  archiving, snoozing or assigning a conversation takes the conversation, not one message of it;
     N18  only an Admin is told who the Owner is;
     N21  a deactivated person gets no invite;
     N23  a custom role is made, renamed and archived in the same step as its record;
     N19  a repeated refusal is recorded once a minute.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The mail edge: an invitation and a hand-written email are captured, never sent.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
  sendComposedEmail: vi.fn(),
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { sendComposedEmail } from '../lib/email';
import { supabaseAdmin } from '../lib/supabase';
import { forgetRefusalsForTests } from '../lib/audit';
import { ONLY_THE_OWNER_CHANGES_ADMINS } from '../lib/users/owner';
import { INACTIVE_INVITE_REFUSAL } from '../controllers/user.controller';

const suite = realClient ? describe : describe.skip;

suite('pre-PR review fixes, builder D (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as never;
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fixd_refuse_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: the audit write fails'; END $$`);
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['unapplied_captures', 'payouts', 'email_read_states', 'emails', 'reply_tokens', 'email_threads', 'purchase_orders']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_version_snapshots WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    vi.mocked(sendComposedEmail).mockImplementation(async () => ({
      status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'someone@mail.test.com', fromName: null,
    }) as never);
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Someone = Person & { api: () => Promise<Api> };
  let sequence = 0;

  async function company() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return { ...made, owner: Object.assign(made.admin, { api: () => fx.signedInAs(made.admin) }) as Someone };
  }

  /** These switches off, and every switch that needs one of them off too, so the set is one the product stores. */
  const withDependantsOff = (off: string[]): Record<string, SwitchValue> => {
    const out: Record<string, SwitchValue> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew;) {
      grew = false;
      for (const sw of SWITCH_CATALOG) {
        if (!(sw.key in out) && sw.requires.some((r) => out[r] === false)) { out[sw.key] = false; grew = true; }
      }
    }
    return out;
  };

  /** A person on a fresh custom role with exactly these values on top of the base's preset (`off` and what needs it go off). */
  async function personWith(org: string, on: Record<string, SwitchValue>, off: string[] = [], base: Role = 'DISPATCHER'): Promise<Someone> {
    const key = `fixd-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...withDependantsOff(off), ...on }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `fixd${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  // ─── H3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('H3: the customer Jobs tab', () => {
    it('lists the job but none of its invoices to a person with View invoices off; the invoice reader sees them', async () => {
      const c = await company();
      const job = await fx.addJob(c.org, c.customer);
      const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT' } });
      const common = { view_customers: true, view_jobs: true, jobs_scope: 'all' };
      const blind = await personWith(c.org, common, ['view_invoices']);
      const reader = await personWith(c.org, { ...common, view_invoices: true });

      const tab = async (p: Someone) => {
        const res = await (await p.api()).get(`/api/customers/${c.customer}/jobs`);
        expect(res.status).toBe(200);
        const row = (res.body.jobs as Array<{ id: string; invoices?: Array<{ id: string; status: string }> }>).find((j) => j.id === job.id);
        expect(row, 'the job is listed').toBeDefined();
        return row!.invoices ?? [];
      };
      expect(await tab(blind)).toEqual([]);
      expect(await tab(reader)).toEqual([{ id: invoice.id, status: 'SENT' }]);
      expect(await tab(c.owner)).toEqual([{ id: invoice.id, status: 'SENT' }]);
    });
  });

  // ─── N17 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N17: the estimate\'s deposit invoice', () => {
    async function depositScene() {
      const c = await company();
      const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id);
      const deposit = await fx.addInvoice(c.org, c.customer, { estimateId: estimate.id });
      await db.invoice.update({
        where: { id: deposit.id },
        data: { kind: 'DEPOSIT', status: 'PARTIAL', total_amount: 417.29, subtotal: 417.29, amount_due: 300.17 },
      });
      await db.payment.create({ data: { invoice_id: deposit.id, amount: 117.12, method: 'CASH', paid_at: new Date() } });
      const common = { view_customers: true, view_estimates: true, leads_scope: 'all', jobs_scope: 'all', view_leads: true, view_jobs: true };
      return { c, estimate, deposit, common };
    }
    const invoicesOf = async (p: Someone, estimateId: string) => {
      const res = await (await p.api()).get(`/api/estimates/${estimateId}`);
      expect(res.status).toBe(200);
      return res.body.estimate.invoices as Array<Record<string, unknown>>;
    };

    it('carries no deposit invoice to a person with View invoices off', async () => {
      const s = await depositScene();
      const blind = await personWith(s.c.org, { ...s.common, see_prices: true }, ['view_invoices']);
      expect(await invoicesOf(blind, s.estimate.id)).toEqual([]);
      const owner = await invoicesOf(s.c.owner, s.estimate.id);
      expect(owner.map((i) => i.id)).toEqual([s.deposit.id]);
      expect(Number(owner[0]!.total_amount)).toBe(417.29);
    });

    it('carries it, without its amounts, to an invoice reader without See prices; with its amounts to one with See prices', async () => {
      const s = await depositScene();
      const priceBlind = await personWith(s.c.org, { ...s.common, view_invoices: true }, ['see_prices']);
      const [row] = await invoicesOf(priceBlind, s.estimate.id);
      expect(row).toMatchObject({ id: s.deposit.id, status: 'PARTIAL', kind: 'DEPOSIT' });
      for (const key of ['total_amount', 'amount_due', 'total_refunded']) expect(row).not.toHaveProperty(key);
      for (const payment of row!.payments as Array<Record<string, unknown>>) expect(payment).not.toHaveProperty('amount');
      const body = JSON.stringify(row);
      for (const figure of ['417.29', '300.17', '117.12']) expect(body).not.toContain(figure);

      const pricey = await personWith(s.c.org, { ...s.common, view_invoices: true, see_prices: true });
      const [full] = await invoicesOf(pricey, s.estimate.id);
      expect(Number(full!.total_amount)).toBe(417.29);
    });
  });

  // ─── N5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N5: the payments drawer', () => {
    it('shows the meant-for invoice and the invoices it could go on with no figure to a person without See prices', async () => {
      const c = await company();
      const meant = await fx.addInvoice(c.org, c.customer);
      await db.invoice.update({ where: { id: meant.id }, data: { status: 'SENT', total_amount: 4321.09, subtotal: 4321.09, amount_due: 3210.98 } });
      const other = await fx.addInvoice(c.org, c.customer);
      await db.invoice.update({ where: { id: other.id }, data: { status: 'SENT', total_amount: 77.77, subtotal: 77.77, amount_due: 77.77 } });
      const capture = await db.unappliedCapture.create({
        data: {
          organization_id: c.org, invoice_id: meant.id, reason: 'AMOUNT_MISMATCH', amount: 77.77,
          stripe_payment_intent_id: null, stripe_account_id: null, source_key: `session:fixd-${randomUUID()}`, status: 'OPEN',
        },
      });
      const common = { view_payments: true, view_invoices: true, jobs_scope: 'all', view_jobs: true, view_customers: true };
      const blind = await personWith(c.org, common, ['see_prices']);
      const seeing = await personWith(c.org, { ...common, see_prices: true });

      const doors = [
        `/api/payments-needing-attention/${capture.id}`,
        `/api/payments-needing-attention/${capture.id}/invoices`,
        `/api/payments-page/attention/unmatched_payment:${capture.id}`,
      ];
      for (const door of doors) {
        const hidden = await (await blind.api()).get(door);
        expect(hidden.status, door).toBe(200);
        const text = JSON.stringify(hidden.body);
        for (const figure of ['4321.09', '4,321.09', '3210.98', '3,210.98', '77.77']) expect(text, `${door} ${figure}`).not.toContain(figure);
        for (const key of ['"balance"', '"payable_now"']) expect(text, `${door} ${key}`).not.toContain(key);
        const shown = await (await seeing.api()).get(door);
        expect(shown.status, door).toBe(200);
        expect(JSON.stringify(shown.body), door).toContain('77.77');
      }
      const detail = (await (await blind.api()).get(doors[0]!)).body;
      expect(detail.meant_for.invoice).toMatchObject({ id: meant.id });
      expect(detail.meant_for.invoice).not.toHaveProperty('total');
      const full = (await (await seeing.api()).get(doors[0]!)).body;
      expect(full.meant_for.invoice.total).toBe(4321.09);
    });
  });

  // ─── N10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N10: an estimate version', () => {
    it('leaves out a discounted line\'s full price without See prices', async () => {
      const c = await company();
      const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id);
      await db.estimateVersionSnapshot.create({
        data: {
          estimate_id: estimate.id, version: 1, total_amount: 100, line_items: [], sent_at: new Date(), trigger: 'SEND',
          document: {
            view: { rows: [{ kind: 'line_item', key: 'l1', title: 'Service', photos: [], grossAmount: 8642.13, gross_amount: 8642.13, netAmount: 100, discounted: true }] },
          },
        },
      });
      const common = { view_customers: true, view_estimates: true, view_leads: true, leads_scope: 'all', view_jobs: true, jobs_scope: 'all' };
      const blind = await personWith(c.org, common, ['see_prices']);
      const res = await (await blind.api()).get(`/api/estimates/${estimate.id}/versions/1`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('8642.13');
      const [row] = res.body.version.document.view.rows;
      expect(row).toMatchObject({ title: 'Service', discounted: true });
      const shown = await (await c.owner.api()).get(`/api/estimates/${estimate.id}/versions/1`);
      expect(shown.body.version.document.view.rows[0].grossAmount).toBe(8642.13);
    });
  });

  // ─── N11 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N11: a payout', () => {
    it('leaves out the difference figure without See prices', async () => {
      const c = await company();
      const payout = await db.payout.create({
        data: { organization_id: c.org, stripe_payout_id: `po_fixd_${randomUUID()}`, status: 'PAID', amount: 5432.17, arrival_date: new Date() },
      });
      const blind = await personWith(c.org, { view_payments: true }, ['see_prices']);
      const res = await (await blind.api()).get(`/api/payments-page/payouts/${payout.id}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('net_difference');
      expect(JSON.stringify(res.body)).not.toContain('5432.17');
      const shown = await (await c.owner.api()).get(`/api/payments-page/payouts/${payout.id}`);
      expect(shown.body.net_difference).toBe(-5432.17);
    });
  });

  // ─── N6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N6: a record\'s history names people, not their login addresses', () => {
    const auditRow = (org: string, actor: Person, resourceType: string, resourceId: string, action: string) => db.auditLog.create({
      data: {
        org_id: org, actor_id: actor.id, actor_email: actor.email, action, resource_type: resourceType, resource_id: resourceId,
        metadata: {}, ip_address: '203.0.113.7', user_agent: 'FixD-Browser/1.0',
      },
    });

    it('Estimate History: a non-Admin gets the name only; an Admin gets the stored row', async () => {
      const c = await company();
      const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id);
      await auditRow(c.org, c.admin, 'Estimate', estimate.id, 'estimate.sent');
      const viewer = await personWith(c.org, { view_customers: true, view_estimates: true, view_leads: true, leads_scope: 'all', view_jobs: true, jobs_scope: 'all' });

      const res = await (await viewer.api()).get(`/api/estimates/${estimate.id}/history`);
      expect(res.status).toBe(200);
      const [event] = res.body.events;
      expect(event).toMatchObject({ action: 'estimate.sent', actor_name: 'Test Admin' });
      const text = JSON.stringify(res.body);
      for (const leak of [c.admin.email, '203.0.113.7', 'FixD-Browser', c.admin.id, c.org]) expect(text).not.toContain(leak);

      const asAdmin = await (await c.owner.api()).get(`/api/estimates/${estimate.id}/history`);
      expect(asAdmin.body.events[0]).toMatchObject({ actor_email: c.admin.email, actor_name: 'Test Admin' });
    });

    it('PO Activity: a non-Admin gets the name only; an Admin gets the login address', async () => {
      const c = await company();
      const po = await db.purchaseOrder.create({ data: { organization_id: c.org, po_number: `PO-${randomUUID().slice(0, 8)}`, vendor: 'Acme', status: 'draft' } });
      await auditRow(c.org, c.admin, 'PurchaseOrder', po.id, 'inventory.po_created');
      const viewer = await personWith(c.org, { view_purchase_orders: true, view_jobs: true, jobs_scope: 'all' });

      const res = await (await viewer.api()).get(`/api/inventory/purchase-orders/${po.id}/activity`);
      expect(res.status).toBe(200);
      expect(res.body.activity[0]).toMatchObject({ kind: 'created', actor: 'Test Admin' });
      expect(JSON.stringify(res.body)).not.toContain(c.admin.email);

      const asAdmin = await (await c.owner.api()).get(`/api/inventory/purchase-orders/${po.id}/activity`);
      expect(asAdmin.body.activity[0]).toMatchObject({ actor: c.admin.email });
    });
  });

  // ─── N8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N8: a mailbox that came from an Admin', () => {
    async function heldScene() {
      const c = await company();
      const otherAdmin = Object.assign(await fx.addUser(c.org, 'admin2', 'ADMIN'), {}) as Someone;
      otherAdmin.api = () => fx.signedInAs(otherAdmin);
      // A deactivated Admin whose mailbox the Owner handed to an ordinary person earlier.
      const leftAdmin = await fx.addUser(c.org, 'leftadmin', 'ADMIN');
      await db.user.update({ where: { id: leftAdmin.id }, data: { is_active: false } });
      const keeper = await fx.addUser(c.org, 'keeper', 'DISPATCHER');
      const box = randomUUID();
      await db.mailbox.create({ data: { id: box, organization_id: c.org, kind: 'user', user_id: leftAdmin.id, holder_user_id: keeper.id, status: 'handed' } });
      const main = randomUUID();
      await db.mailbox.create({ data: { id: main, organization_id: c.org, kind: 'main', status: 'active' } });
      return { c, otherAdmin, leftAdmin, keeper, box };
    }

    it('is not handed on by a non-Owner Admin deactivating the person who holds it, through either door', async () => {
      const s = await heldScene();
      const deactivate = await (await s.otherAdmin.api()).delete(`/api/users/${s.keeper.id}`, { handover_to: s.otherAdmin.id });
      expect({ status: deactivate.status, error: deactivate.body.error }).toEqual({ status: 403, error: ONLY_THE_OWNER_CHANGES_ADMINS });
      const patched = await (await s.otherAdmin.api()).patch(`/api/users/${s.keeper.id}`, { is_active: false, handover_to: s.otherAdmin.id });
      expect({ status: patched.status, error: patched.body.error }).toEqual({ status: 403, error: ONLY_THE_OWNER_CHANGES_ADMINS });
      const toMain = await (await s.otherAdmin.api()).delete(`/api/users/${s.keeper.id}`, { handover_to: 'main' });
      expect(toMain.status).toBe(403);

      expect(await db.user.findUniqueOrThrow({ where: { id: s.keeper.id }, select: { is_active: true } })).toEqual({ is_active: true });
      expect(await db.mailbox.findUniqueOrThrow({ where: { id: s.box }, select: { holder_user_id: true, status: true } }))
        .toEqual({ holder_user_id: s.keeper.id, status: 'handed' });
    });

    it('is handed on when the Owner does it', async () => {
      const s = await heldScene();
      const res = await (await s.c.owner.api()).delete(`/api/users/${s.keeper.id}`, { handover_to: s.otherAdmin.id });
      expect(res.status).toBe(200);
      expect(await db.mailbox.findUniqueOrThrow({ where: { id: s.box }, select: { holder_user_id: true } })).toEqual({ holder_user_id: s.otherAdmin.id });
    });

    it('still lets a non-Owner Admin deactivate a person who holds no Admin\'s mailbox', async () => {
      const s = await heldScene();
      const plain = await fx.addUser(s.c.org, 'plain', 'DISPATCHER');
      const res = await (await s.otherAdmin.api()).delete(`/api/users/${plain.id}`, { handover_to: s.otherAdmin.id });
      expect(res.status).toBe(200);
    });
  });

  // ─── N9 / N16: email ─────────────────────────────────────────────────────────────────────────────────────────────────
  const EMAIL_ON = {
    access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached', contact_customers: true,
    view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
  };
  async function userMailbox(org: string, owner: Person): Promise<string> {
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', user_id: owner.id, holder_user_id: owner.id, status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `fixd-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
    return id;
  }
  async function customerWithEmail(org: string, email: string) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Mail', last_name: 'Customer', email },
    });
    return id;
  }

  describe('N9: filing an email on its customer', () => {
    it('files a hand-written email on the recipient\'s customer only when the sender can open that customer', async () => {
      const c = await company();
      const address = `n9-${randomUUID().slice(0, 8)}@example.com`;
      const customer = await customerWithEmail(c.org, address);
      const blind = await personWith(c.org, EMAIL_ON, ['view_customers']);
      await userMailbox(c.org, blind);
      // The control can open the customer: it is on a job of theirs (customer reach comes with the record).
      const seeing = await personWith(c.org, { ...EMAIL_ON, view_customers: true });
      await userMailbox(c.org, seeing);
      await fx.addJob(c.org, customer, { crew: [seeing.id] });
      expect((await (await seeing.api()).get(`/api/customers/${customer}`)).status).toBe(200);
      expect((await (await blind.api()).get(`/api/customers/${customer}`)).status).not.toBe(200);

      const sent = await (await blind.api()).post('/api/communication/emails', { to: address, subject: 'Hello', body: ['Hi there.'] });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(JSON.stringify(sent.body)).not.toContain(customer);
      expect(await db.email.findUniqueOrThrow({ where: { id: sent.body.email.id }, select: { customer_id: true } })).toEqual({ customer_id: null });

      const control = await (await seeing.api()).post('/api/communication/emails', { to: address, subject: 'Hello', body: ['Hi there.'] });
      expect(control.status).toBe(201);
      expect(await db.email.findUniqueOrThrow({ where: { id: control.body.email.id }, select: { customer_id: true } })).toEqual({ customer_id: customer });
    });

    it('files a reply on its conversation\'s customer only when the sender can open that customer', async () => {
      const c = await company();
      const customer = await customerWithEmail(c.org, `n9r-${randomUUID().slice(0, 8)}@example.com`);
      const blind = await personWith(c.org, EMAIL_ON, ['view_customers']);
      const mailbox = await userMailbox(c.org, blind);
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: c.org, mailbox_id: mailbox, origin: 'started' } });
      await db.email.create({
        data: {
          organization_id: c.org, thread_id: thread, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'someone.else@example.org' }, to: 'office@example.com', subject: 'Question', snippet: 's', body: ['b'],
          at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });
      const reply = await (await blind.api()).post('/api/communication/emails', {
        to: 'unknown.person@example.org', subject: 'Re: Question', body: ['Answer.'], thread_id: thread,
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(JSON.stringify(reply.body)).not.toContain(customer);
      expect(await db.email.findUniqueOrThrow({ where: { id: reply.body.email.id }, select: { customer_id: true } })).toEqual({ customer_id: null });
    });
  });

  describe('N16: changing a conversation as a whole', () => {
    it('takes the conversation being the person\'s, not one readable message of it', async () => {
      const c = await company();
      const reader = await personWith(c.org, { ...EMAIL_ON, edit_communication_records: true });
      await userMailbox(c.org, reader);
      const holder = await personWith(c.org, { ...EMAIL_ON, edit_communication_records: true });
      const theirs = await userMailbox(c.org, holder);
      const myJob = await fx.addJob(c.org, c.customer, { crew: [reader.id] });
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: c.org, mailbox_id: theirs, origin: 'started' } });
      const message = await db.email.create({
        data: {
          organization_id: c.org, thread_id: thread, customer_id: c.customer, job_id: myJob.id, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'n16', snippet: 's', body: ['b'],
          at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      // The reader can read the one message, through the job they are on.
      expect((await (await reader.api()).get(`/api/communication/emails/${message.id}`)).status).toBe(200);

      const missing = await (await reader.api()).patch(`/api/communication/emails/threads/${randomUUID()}/archive`, { archived: true });
      for (const [verb, body] of [['archive', { archived: true }], ['snooze', { snoozed_until: new Date(Date.now() + 86_400_000).toISOString() }], ['assign', { user_id: reader.id }]] as const) {
        const res = await (await reader.api()).patch(`/api/communication/emails/threads/${thread}/${verb}`, body);
        expect({ verb, status: res.status, body: res.body }).toEqual({ verb, status: missing.status, body: missing.body });
      }
      expect(missing.status).toBe(404);
      expect(await db.emailThread.findUniqueOrThrow({ where: { id: thread }, select: { archived: true, snoozed_until: true, assigned_to_user_id: true } }))
        .toEqual({ archived: false, snoozed_until: null, assigned_to_user_id: null });

      const own = await (await holder.api()).patch(`/api/communication/emails/threads/${thread}/archive`, { archived: true });
      expect(own.status).toBe(200);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).archived).toBe(true);
    });
  });

  // ─── N18 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N18: who the Owner is', () => {
    const auth = supabaseAdmin.auth as unknown as { signInWithPassword: ReturnType<typeof vi.fn> };
    const signIn = async (p: Person) => {
      auth.signInWithPassword.mockResolvedValue({
        data: {
          user: { id: randomUUID(), email: p.email, email_confirmed_at: new Date().toISOString() },
          session: { access_token: `at-${randomUUID()}`, refresh_token: `rt-${randomUUID()}`, expires_at: 9_999_999_999 },
        },
        error: null,
      });
      return request(app).post('/api/auth/login').send({ email: p.email, password: 'correct-horse-9' });
    };

    it('is told to an Admin, on /me and on sign-in, and to nobody else', async () => {
      const c = await company();
      const member = await personWith(c.org, { view_customers: true });
      await db.user.update({ where: { id: member.id }, data: { has_login: true } });
      await db.user.update({ where: { id: c.admin.id }, data: { has_login: true } });

      const me = await (await member.api()).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user).not.toHaveProperty('org_owner_user_id');
      expect(JSON.stringify(me.body)).not.toContain(c.admin.id);
      expect((await (await c.owner.api()).get('/api/auth/me')).body.user.org_owner_user_id).toBe(c.admin.id);

      const memberLogin = await signIn(member);
      expect(memberLogin.status, JSON.stringify(memberLogin.body)).toBe(200);
      expect(memberLogin.body.user).not.toHaveProperty('org_owner_user_id');
      const ownerLogin = await signIn(c.admin);
      expect(ownerLogin.status).toBe(200);
      expect(ownerLogin.body.user.org_owner_user_id).toBe(c.admin.id);
    });
  });

  // ─── N21 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N21: an invite for a deactivated person', () => {
    it('is refused and arms nothing; an active person still gets one', async () => {
      const c = await company();
      const gone = await fx.addUser(c.org, 'gone', 'DISPATCHER');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false, has_login: false } });
      const res = await (await c.owner.api()).post(`/api/users/${gone.id}/invite`);
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: INACTIVE_INVITE_REFUSAL });
      expect(res.body).not.toHaveProperty('invite_url');
      expect(await db.user.findUniqueOrThrow({ where: { id: gone.id }, select: { has_login: true, is_active: true } }))
        .toEqual({ has_login: false, is_active: false });

      const active = await fx.addUser(c.org, 'active', 'DISPATCHER');
      const ok = await (await c.owner.api()).post(`/api/users/${active.id}/invite`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
  });

  // ─── N23 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N23: a custom role and its record are one step', () => {
    async function whileAuditWritesFail<T>(org: string, run: () => Promise<T>): Promise<T> {
      const name = `test_fixd_refuse_${org.replace(/-/g, '')}`;
      await db.$executeRawUnsafe(
        `CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.org_id = '${org}'::uuid) EXECUTE FUNCTION test_fixd_refuse_audit_row()`,
      );
      try {
        return await run();
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON audit_logs`);
      }
    }

    it('makes, renames and archives nothing when the record cannot be written; with it, each is recorded', async () => {
      const c = await company();
      const label = `Fixd Role ${randomUUID().slice(0, 6)}`;
      const refusedCreate = await whileAuditWritesFail(c.org, async () => (await c.owner.api()).post('/api/roles', { label, base_role: 'DISPATCHER' }));
      expect(refusedCreate.status).toBe(500);
      expect(await db.customRole.count({ where: { organization_id: c.org, label } })).toBe(0);

      const created = await (await c.owner.api()).post('/api/roles', { label, base_role: 'DISPATCHER' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const key = created.body.role as string;
      expect(await db.auditLog.count({ where: { org_id: c.org, action: 'role.created', resource_id: created.body.id } })).toBe(1);

      const renamed = `${label} B`;
      const refusedRename = await whileAuditWritesFail(c.org, async () => (await c.owner.api()).patch(`/api/roles/${key}`, { label: renamed }));
      expect(refusedRename.status).toBe(500);
      expect((await db.customRole.findUniqueOrThrow({ where: { id: created.body.id } })).label).toBe(label);
      expect((await (await c.owner.api()).patch(`/api/roles/${key}`, { label: renamed })).status).toBe(200);
      const renameRow = await db.auditLog.findFirstOrThrow({ where: { org_id: c.org, action: 'role.updated', resource_id: created.body.id } });
      expect(renameRow.metadata).toMatchObject({ label: { from: label, to: renamed } });

      const refusedArchive = await whileAuditWritesFail(c.org, async () => (await c.owner.api()).post(`/api/roles/${key}/archive`));
      expect(refusedArchive.status).toBe(500);
      expect((await db.customRole.findUniqueOrThrow({ where: { id: created.body.id } })).archived_at).toBeNull();
      expect((await (await c.owner.api()).post(`/api/roles/${key}/archive`)).status).toBe(200);
      expect(await db.auditLog.count({ where: { org_id: c.org, action: 'role.archived', resource_id: created.body.id } })).toBe(1);
    });
  });

  // ─── N19 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('N19: a repeated refusal', () => {
    const refusalRows = (org: string, actor: string) => db.auditLog.findMany({
      where: { org_id: org, actor_id: actor, action: 'access.denied' }, select: { metadata: true },
    });
    const settle = async (org: string, actor: string, want: number) => {
      for (let i = 0; i < 60; i++) {
        if ((await refusalRows(org, actor)).length >= want) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 150));
      return refusalRows(org, actor);
    };

    it('is recorded once a minute for the same person, address and reason; another address is its own', async () => {
      forgetRefusalsForTests();
      const c = await company();
      const nobody = await personWith(c.org, {}, ['view_customers', 'view_invoices', 'export_invoices']);
      for (let i = 0; i < 4; i++) expect((await (await nobody.api()).get('/api/customers/stats')).status).toBe(403);
      const rows = await settle(c.org, nobody.id, 1);
      expect(rows.map((r) => (r.metadata as { path: string }).path)).toEqual(['/api/customers/stats']);

      expect((await (await nobody.api()).get('/api/invoices/export')).status).toBe(403);
      const after = await settle(c.org, nobody.id, 2);
      expect(after.map((r) => (r.metadata as { path: string }).path).sort()).toEqual(['/api/customers/stats', '/api/invoices/export']);
    });

    it('is recorded once a minute however the record id in the address changes, on a route and behind a router-wide check (P2-6)', async () => {
      forgetRefusalsForTests();
      const c = await company();
      const nobody = await personWith(c.org, {}, ['view_customers']);
      // A route's own check: GET /api/customers/:id, a new random id each time.
      for (let i = 0; i < 25; i++) expect((await (await nobody.api()).get(`/api/customers/${randomUUID()}`)).status).toBe(403);
      // A check the whole router makes before any route matches (the Roles routes are Admin-only), a new random id each time.
      for (let i = 0; i < 25; i++) expect((await (await nobody.api()).get(`/api/roles/${randomUUID()}/permissions`)).status).toBe(403);
      const rows = await settle(c.org, nobody.id, 2);
      const paths = rows.map((r) => (r.metadata as { path: string }).path);
      expect(paths).toHaveLength(2);
      expect(paths.filter((p) => p.startsWith('/api/customers/'))).toHaveLength(1);
      expect(paths.filter((p) => p.startsWith('/api/roles/'))).toHaveLength(1);
    });

    it('is recorded once a minute however the address is cased (pass 3, N-p3-1)', async () => {
      forgetRefusalsForTests();
      const c = await company();
      const nobody = await personWith(c.org, {}, ['view_customers']);
      const id = randomUUID();
      const casings = [
        '/api/customers', '/API/customers', '/api/Customers', '/API/Customers', '/API/CUSTOMERS', '/Api/Customers',
        '/aPi/cUsToMeRs', '/ApI/CuStOmErS', '/api/CUSTOMERS', '/API/cUSTOMERS', '/Api/customers', '/api/customerS',
      ];
      for (const prefix of casings) expect((await (await nobody.api()).get(`${prefix}/${id}`)).status, prefix).toBe(403);
      // A check the whole router makes before any route matches, in the same casings.
      for (const prefix of ['/api/roles', '/API/Roles', '/api/ROLES', '/Api/rOlEs']) {
        expect((await (await nobody.api()).get(`${prefix}/${randomUUID()}/permissions`)).status, prefix).toBe(403);
      }
      const rows = await settle(c.org, nobody.id, 2);
      const paths = rows.map((r) => (r.metadata as { path: string }).path.toLowerCase());
      expect(paths).toHaveLength(2);
      expect(paths.filter((p) => p.startsWith('/api/customers/'))).toHaveLength(1);
      expect(paths.filter((p) => p.startsWith('/api/roles/'))).toHaveLength(1);
    });
  });
});

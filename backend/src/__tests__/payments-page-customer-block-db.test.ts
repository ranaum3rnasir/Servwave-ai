/* =============================================================================
   V7-05a - the customer block (services/payments-page/customerBlock.ts) and where it is returned: the payment detail
   and the dispute evidence state. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Called as people on custom roles (never a built-in role name). Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { customerBlockFor } from '../services/payments-page/customerBlock';

const suite = realClient ? describe : describe.skip;

suite('customer block (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    for (const org of orgs) {
      const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
      await q(`DELETE FROM disputes WHERE organization_id = '${org}'`);
    }
    await fx.cleanup();
  });

  let sequence = 0;
  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    return o;
  }
  async function personWith(org: string, values: Record<string, boolean | string | string[]>, name = 'viewer') {
    const key = `cb-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `${name}${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }
  const SEES_ALL = { view_payments: true, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' } as const;

  /** A request as the middleware leaves it for this user; `viewPayments` stands in for the ability check the route already did. */
  async function reqFor(userId: string, viewPayments = true): Promise<Request> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    return { user, ability: { can: (action: string) => action !== 'view_payments' || viewPayments } } as unknown as Request;
  }

  async function addLocation(customer: string, o: { primary?: boolean; active?: boolean; line2?: string | null; street?: string } = {}) {
    await db.serviceLocation.create({
      data: {
        id: randomUUID(), customer_id: customer, address_line1: o.street ?? '12 Oak St', address_line2: o.line2 ?? null, city: 'Boston', state: 'MA', zip: '02108',
        is_primary: o.primary ?? true, is_active: o.active ?? true,
      },
    });
  }
  async function addPhone(customer: string, phone: string, o: { primary?: boolean; at?: Date } = {}) {
    await db.customerPhone.create({ data: { customer_id: customer, phone, is_primary: o.primary ?? false, ...(o.at ? { created_at: o.at } : {}) } });
  }
  const invoiceIn = async (org: string, customer: string, opts: Parameters<typeof fx.addInvoice>[2] = {}) => (await fx.addInvoice(org, customer, opts)).id;

  describe('the helper', () => {
    it('returns the customer, the one-line address, phone, email, job, lead and invoice for a caller who can open the invoice', async () => {
      const { org, customer, admin, tag } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { company_name: 'Pat Payer Plumbing', email: 'pat@example.test', phone: '555-000-0000' } });
      await addLocation(customer);
      await addLocation(customer, { primary: false, street: '99 Other Rd' });
      await addPhone(customer, '555-111-2222', { primary: true });
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      await db.job.update({ where: { id: job.id }, data: { job_type: 'Install' } });
      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: await invoiceIn(org, customer, { jobId: job.id }) } });
      const block = await customerBlockFor({ invoiceId: invoice.id }, await reqFor(admin.id));
      const jobRow = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      const leadRow = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(block).toEqual({
        restricted: false, id: customer, customer_number: `C-${tag}`, name: 'Pat Payer', company: 'Pat Payer Plumbing', address: '12 Oak St, Boston, MA 02108',
        phone: '555-111-2222', email: 'pat@example.test',
        job: { id: job.id, number: jobRow.job_number, type: 'Install' }, lead: { id: lead.id, number: leadRow.lead_number },
        invoice: { id: invoice.id, number: invoice.invoice_number },
      });
    });

    it('has no job and no lead on a deposit or orphan invoice, and nothing but the invoice link', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const block = await customerBlockFor({ invoiceId: invoice }, await reqFor(admin.id));
      expect(block).toMatchObject({ restricted: false, job: null, lead: null, invoice: { id: invoice }, address: null, phone: null, email: null, company: null });
    });

    it('has a job but no lead when the job did not come from one', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await invoiceIn(org, customer, { jobId: job.id });
      const block = await customerBlockFor({ invoiceId: invoice }, await reqFor(admin.id));
      expect(block).toMatchObject({ job: { id: job.id, type: null }, lead: null });
    });

    it('picks the primary phone, else the first added, else the legacy phone', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const phoneOf = async () => ((await customerBlockFor({ invoiceId: invoice }, await reqFor(admin.id))) as { phone: string | null }).phone;
      expect(await phoneOf()).toBeNull();
      await db.customer.update({ where: { id: customer }, data: { phone: '555-000-0000' } });
      expect(await phoneOf()).toBe('555-000-0000');
      await addPhone(customer, '555-222-0002', { at: new Date('2026-01-02T00:00:00Z') });
      await addPhone(customer, '555-222-0001', { at: new Date('2026-01-01T00:00:00Z') });
      expect(await phoneOf()).toBe('555-222-0001');
      await addPhone(customer, '555-333-0003', { primary: true, at: new Date('2026-01-03T00:00:00Z') });
      expect(await phoneOf()).toBe('555-333-0003');
    });

    it('skips an inactive location and one that is not primary, and puts line 2 in when set', async () => {
      const { org, customer, admin } = await newOrg();
      const invoice = await invoiceIn(org, customer);
      const addressOf = async () => ((await customerBlockFor({ invoiceId: invoice }, await reqFor(admin.id))) as { address: string | null }).address;
      await addLocation(customer, { primary: true, active: false, street: '1 Closed Ln' });
      await addLocation(customer, { primary: false, street: '2 Side St' });
      expect(await addressOf()).toBeNull();
      await addLocation(customer, { primary: true, line2: 'Suite 4' });
      expect(await addressOf()).toBe('12 Oak St, Suite 4, Boston, MA 02108');
    });

    it('returns customer null and restricted for a caller who cannot open the invoice, with nothing about the person', async () => {
      const { org, customer } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { company_name: 'Hidden Holdings', email: 'hidden@example.test', phone: '555-999-9999' } });
      const me = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached' });
      const invoice = await invoiceIn(org, customer);
      const block = await customerBlockFor({ invoiceId: invoice }, await reqFor(me.id));
      expect(block).toEqual({ customer: null, restricted: true });
      expect(JSON.stringify(block)).not.toMatch(/Hidden|555-999|hidden@|Pat/);
    });

    it('gives phone and email only to a caller who holds View payments', async () => {
      const { org, customer, admin } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'pat@example.test', phone: '555-000-0000' } });
      const invoice = await invoiceIn(org, customer);
      const block = await customerBlockFor({ invoiceId: invoice }, await reqFor(admin.id, false));
      expect(block).toMatchObject({ restricted: false, name: 'Pat Payer', phone: null, email: null });
    });

    it('refuses another company\'s invoice, and an invoice that does not exist', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const theirs = await invoiceIn(b.org, b.customer);
      expect(await customerBlockFor({ invoiceId: theirs }, await reqFor(a.admin.id))).toEqual({ customer: null, restricted: true });
      expect(await customerBlockFor({ invoiceId: randomUUID() }, await reqFor(a.admin.id))).toEqual({ customer: null, restricted: true });
    });
  });

  describe('where it is returned', () => {
    async function paidInvoice(org: string, customer: string, jobId?: string) {
      const invoice = await invoiceIn(org, customer, jobId ? { jobId } : {});
      const paymentId = randomUUID();
      await db.payment.create({
        data: {
          id: paymentId, invoice_id: invoice, amount: 100, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
          stripe_payment_intent_id: `pi_test_${paymentId.slice(0, 12)}`, card_brand: 'visa', card_last4: '4242', stripe_account_id: 'acct_test_one',
        },
      });
      return { invoice, paymentId };
    }

    it('rides on the payment detail as customer_block', async () => {
      const { org, customer } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'pat@example.test' } });
      const job = await fx.addJob(org, customer);
      const { invoice, paymentId } = await paidInvoice(org, customer, job.id);
      const person = await personWith(org, { ...SEES_ALL });
      const res = await (await person.api()).get(`/api/payments-page/payments/${paymentId}`);
      expect(res.status).toBe(200);
      expect(res.body.customer_block).toMatchObject({
        restricted: false, name: 'Pat Payer', email: 'pat@example.test', job: { id: job.id }, invoice: { id: invoice },
      });
      expect(JSON.stringify(res.body.customer_block)).not.toMatch(/stripe|acct_|pi_/i);
    });

    it('still answers 404 for a payment on an invoice the caller cannot open (no block, no PII)', async () => {
      const { org, customer } = await newOrg();
      const { paymentId } = await paidInvoice(org, customer);
      const narrowed = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached' });
      const res = await (await narrowed.api()).get(`/api/payments-page/payments/${paymentId}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/Pat|Payer/);
    });

    it('rides on the dispute evidence state with the dispute code, and a caller who cannot open the invoice still gets 404', async () => {
      const { org, customer } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: 'pat@example.test' } });
      const { invoice, paymentId } = await paidInvoice(org, customer);
      const d = await db.dispute.create({
        data: {
          organization_id: org, invoice_id: invoice, payment_id: paymentId, stripe_dispute_id: `dp_test_${randomUUID().slice(0, 12)}`,
          status: 'NEEDS_RESPONSE', reason: 'fraudulent', amount: 100, evidence_due_by: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      const person = await personWith(org, { ...SEES_ALL });
      const res = await (await person.api()).get(`/api/payments-page/disputes/${d.id}/evidence`);
      expect(res.status).toBe(200);
      expect(res.body.dispute.reference).toBe(`DSP-${d.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`);
      expect(res.body.customer_block).toMatchObject({ restricted: false, name: 'Pat Payer', email: 'pat@example.test', invoice: { id: invoice } });
      expect(JSON.stringify(res.body)).not.toContain(d.stripe_dispute_id);
      const narrowed = await personWith(org, { ...SEES_ALL, jobs_scope: 'attached', leads_scope: 'attached' });
      expect((await (await narrowed.api()).get(`/api/payments-page/disputes/${d.id}/evidence`)).status).toBe(404);
    });
  });
});

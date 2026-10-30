/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.10 - payments received as entries on the record tab.

   A payment received on one of the record's invoices or deposits shows on the job's or lead's Communication tab as an
   entry that says whether it was paid online or recorded by the office, read from the payment itself. It shows only to
   people who can open that invoice (the creator rule included), its amount is that invoice's price, and it never lists
   in a section or an unread count.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PaymentMethod, PaymentState, PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('the payments received on the record Communication tab (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of SWITCH_CATALOG) {
        if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
      }
    }
    return out;
  };
  const INVOICES_VIEW_OFF = withDependantsOff(['view_invoices']);

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `payment-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
        access_communication: true, view_communication: true, communication_scope: 'linked_to_me', ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  type Entry = {
    id: string; channel: string; direction: string; who: string; title: string; preview: string; at: string;
    jobId?: string; leadId?: string; entry?: string; amount?: number; paidVia?: string;
  };
  const entriesOf = (body: { items: Entry[] }) => body.items.filter((i) => i.entry === 'payment_received');
  const idsOf = (body: { items: Entry[] }) => entriesOf(body).map((e) => e.id).sort();

  /** A payment written straight into the ledger, in any state; the customer paid it themselves when `online`. */
  async function addPayment(
    invoiceId: string,
    opts: {
      amount?: number; online?: boolean; state?: PaymentState; method?: PaymentMethod; at?: Date; voided?: boolean;
      reference?: string; refunded?: { amount: number | null }; legacyOnline?: boolean;
    } = {},
  ) {
    const row = await db.payment.create({
      data: {
        invoice_id: invoiceId, amount: opts.amount ?? 40, method: opts.method ?? (opts.online ? 'CARD' : 'CASH'),
        paid_at: opts.at ?? new Date(), state: opts.state ?? 'SUCCEEDED',
        created_by_source: opts.online ? 'CLIENT' : opts.legacyOnline ? 'UNKNOWN' : 'USER',
        ...(opts.online || opts.legacyOnline ? { stripe_charge_id: `ch_${randomUUID()}`, stripe_payment_intent_id: `pi_${randomUUID()}` } : {}),
        ...(opts.voided ? { voided_at: new Date() } : {}),
        ...(opts.reference ? { reference_number: opts.reference } : {}),
        ...(opts.refunded ? { refunded_at: new Date(), refunded_amount: opts.refunded.amount } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  describe('the job tab', () => {
    it('shows a payment made online and one recorded by the office, each saying which, with its amount', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const online = await addPayment(invoice.id, { online: true, amount: 40 });
      const office = await addPayment(invoice.id, { amount: 25.5 });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      expect(idsOf(tab.body)).toEqual([online, office].sort());
      const paidOnline = entriesOf(tab.body).find((e) => e.id === online)!;
      expect(paidOnline).toMatchObject({ channel: 'portal', paidVia: 'online', preview: 'Paid online', amount: 40, jobId: job.id });
      const recorded = entriesOf(tab.body).find((e) => e.id === office)!;
      expect(recorded).toMatchObject({ paidVia: 'office', preview: 'Recorded by the office', amount: 25.5 });
    });

    it('never words an entry with the payment processor\'s name, or hands out its ids', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await addPayment(invoice.id, { online: true, method: 'ACH' });
      await addPayment(invoice.id, { online: true, method: 'CARD' });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      const entries = entriesOf(tab.body);
      expect(entries).toHaveLength(2);
      expect(JSON.stringify(entries)).not.toMatch(/stripe|processor|\bch_|\bpi_/i);
    });

    it('says a card payment from before creators were tracked was paid online, by the processor\'s id on the row', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const legacy = await addPayment(invoice.id, { legacyOnline: true, method: 'CARD', at: new Date('2026-07-25T15:00:00Z') });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      const entry = entriesOf(tab.body).find((e) => e.id === legacy)!;
      expect(entry).toMatchObject({ paidVia: 'online', preview: 'Paid online' });
    });

    it('shows a payment from before the release', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const longAgo = new Date('2025-02-01T15:00:00Z');
      const old = await addPayment(invoice.id, { at: longAgo });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(idsOf(tab.body)).toEqual([old]);
      expect(new Date(entriesOf(tab.body)[0].at).toISOString()).toBe(longAgo.toISOString());
    });

    it('lists only money that was received: not one still clearing, failed, voided, given back whole or the deposit credit; one partly refunded stays', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const { DEPOSIT_CREDIT_REFERENCE } = await import('../lib/deposit-credit.js');
      const received = await addPayment(invoice.id, { amount: 60 });
      const partlyRefunded = await addPayment(invoice.id, { amount: 80, refunded: { amount: 20 } });
      await addPayment(invoice.id, { state: 'PROCESSING', online: true, method: 'ACH' });
      await addPayment(invoice.id, { state: 'FAILED', online: true, method: 'ACH' });
      await addPayment(invoice.id, { voided: true });
      await addPayment(invoice.id, { amount: 50, refunded: { amount: 50 } });
      await addPayment(invoice.id, { amount: 70, refunded: { amount: null } });
      await addPayment(invoice.id, { amount: 30, method: 'CARD', reference: DEPOSIT_CREDIT_REFERENCE });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(idsOf(tab.body)).toEqual([received, partlyRefunded].sort());
      expect(entriesOf(tab.body).find((e) => e.id === partlyRefunded)!.amount).toBe(80);
    });
  });

  describe('who gets an entry', () => {
    it('leaves it out for a person on the job with View invoices off who did not make the invoice, and gives it to the invoice\'s creator', async () => {
      const { org, admin, customer } = await newOrg();
      const creator = await personWith(org, { ...INVOICES_VIEW_OFF });
      const colleague = await personWith(org, { ...INVOICES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { crew: [creator.id, colleague.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      const theOffices = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const onMine = await addPayment(mine.id);
      await addPayment(theOffices.id);

      const asCreator = await (await creator.api()).get(`/api/jobs/${job.id}/communications`);
      expect(asCreator.status).toBe(200);
      expect(idsOf(asCreator.body)).toEqual([onMine]);

      const asColleague = await (await colleague.api()).get(`/api/jobs/${job.id}/communications`);
      expect(asColleague.status).toBe(200);
      expect(entriesOf(asColleague.body)).toEqual([]);
    });

    it('takes the entry away from the creator once they are off the job', async () => {
      const { org, customer } = await newOrg();
      const creator = await personWith(org, { ...INVOICES_VIEW_OFF });
      const other = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [creator.id, other.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: creator.id });
      await addPayment(invoice.id);
      expect(entriesOf((await (await creator.api()).get(`/api/jobs/${job.id}/communications`)).body)).toHaveLength(1);

      await fx.removeCrew(job.visitId!, creator.id);
      // The tab is the job's: a person taken off it no longer opens it, so the payment goes with it.
      const after = await (await creator.api()).get(`/api/jobs/${job.id}/communications`);
      expect(after.status).toBe(403);
      expect(after.body.items).toBeUndefined();
    });

    it('gives it to a person whose invoices data scope is All, on a job they are not on', async () => {
      const { org, admin, customer } = await newOrg();
      const wide = await personWith(org, { jobs_scope: 'all', invoices_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const paid = await addPayment(invoice.id);

      const tab = await (await wide.api()).get(`/api/jobs/${job.id}/communications`);
      expect(idsOf(tab.body)).toEqual([paid]);
    });

    it('shows the amount to a person without See financial data or See company figures: it is the invoice\'s price, not a cost or a company figure', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { see_financial_data: false, see_company_figures: false });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await addPayment(invoice.id, { amount: 123.45 });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(entriesOf(tab.body)[0].amount).toBe(123.45);
    });

    it('carries no amount to anyone who cannot open the invoice, because there is no entry at all', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { ...INVOICES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      await addPayment(invoice.id, { amount: 987.65 });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(JSON.stringify(tab.body)).not.toContain('987.65');
      expect(entriesOf(tab.body)).toEqual([]);
    });
  });

  describe('the lead tab', () => {
    it('shows a lead-stage deposit on the lead, and after conversion on the lead and on the job', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      // The deposit invoice has no job yet: it hangs off the estimate on the lead.
      const deposit = await fx.addInvoice(org, customer, { estimateId: estimate.id });
      await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT' } });
      const paid = await addPayment(deposit.id, { online: true, amount: 50 });
      const api = await person.api();

      const leadTab = await api.get(`/api/leads/${lead.id}/communications`);
      expect(leadTab.status).toBe(200);
      expect(idsOf(leadTab.body)).toEqual([paid]);
      expect(entriesOf(leadTab.body)[0].title).toMatch(/deposit/);

      // The lead converts: the job is made from the estimate and the estimate points at it.
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: job.id } });

      const after = await api.get(`/api/leads/${lead.id}/communications`);
      expect(idsOf(after.body)).toEqual([paid]);
      const jobTab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(idsOf(jobTab.body)).toEqual([paid]);
    });

    it('does not show a job invoice\'s payment on a lead that has no deposit of its own', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id] });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await addPayment(invoice.id);

      const tab = await (await person.api()).get(`/api/leads/${lead.id}/communications`);
      expect(tab.status).toBe(200);
      expect(entriesOf(tab.body)).toEqual([]);
    });
  });

  describe('the customer tab', () => {
    it('leaves a job invoice\'s payment out for a person who can open the customer but not the job, and keeps a customer-only invoice\'s', async () => {
      const { org, admin, customer } = await newOrg();
      // Opens the customer through a lead they are on, never the job.
      const person = await personWith(org, { invoices_scope: 'all' });
      await fx.addLead(org, customer, { assignees: [person.id] });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const jobInvoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const customerInvoice = await fx.addInvoice(org, customer, {});
      await addPayment(jobInvoice.id);
      const customerOnly = await addPayment(customerInvoice.id);

      const tab = await (await person.api()).get(`/api/customers/${customer}/communications`);
      expect(tab.status).toBe(200);
      expect(idsOf(tab.body)).toEqual([customerOnly]);
    });

    it('lists every entry for a person who can open the customer\'s job', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { invoices_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const jobInvoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const customerInvoice = await fx.addInvoice(org, customer, {});
      const a = await addPayment(jobInvoice.id);
      const b = await addPayment(customerInvoice.id);

      const tab = await (await person.api()).get(`/api/customers/${customer}/communications`);
      expect(idsOf(tab.body)).toEqual([a, b].sort());
    });
  });

  describe('what the entries are not', () => {
    it('never appear in a section list or an unread count, and send no alert', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { communication_scope: 'all', jobs_scope: 'all', invoices_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const api = await person.api();

      const before = {
        counts: (await api.get('/api/communication/unread-counts')).body,
        calls: (await api.get('/api/communication/calls')).body.calls,
        threads: (await api.get('/api/communication/threads')).body.threads,
      };
      const alertsBefore = await db.notification.count({ where: { organization_id: org } });
      const paid = await addPayment(invoice.id);
      expect(idsOf((await api.get(`/api/jobs/${job.id}/communications`)).body)).toEqual([paid]);

      expect((await api.get('/api/communication/unread-counts')).body).toEqual(before.counts);
      expect((await api.get('/api/communication/calls')).body.calls).toEqual(before.calls);
      expect((await api.get('/api/communication/threads')).body.threads).toEqual(before.threads);
      expect(await db.notification.count({ where: { organization_id: org } })).toBe(alertsBefore);
    });
  });
});

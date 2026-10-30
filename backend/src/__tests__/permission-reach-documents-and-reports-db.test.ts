/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec stories 48-50, build items 7 and 8).

   - An estimate or invoice is reached the way the lead or job it hangs off is, and that needs View leads or View jobs:
     a document is never reachable when its lead or job isn't (story 50).
   - The inventory-usage report follows reach: it names no invoice the person can't reach (story 48).
   - The activity report is filtered in the database, so a person who reaches more records than one statement can list
     still gets their answer (story 49).

   Everything goes through the API as people on custom roles holding exactly the switch values under test, over
   everything else off. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch at its narrowest: off, the first choice, no members. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

suite('documents and reports follow reach (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  // The stock movements this suite writes go first: the fixture's cleanup removes jobs, which they point at.
  const movementOrgs: string[] = [];
  afterAll(async () => {
    await db.stockMovement.deleteMany({ where: { organization_id: { in: movementOrgs } } }).catch(() => undefined);
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `t33-role-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, key, { ...ALL_OFF, ...values });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    const person = await fx.addUser(org, `t33p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  describe('an estimate or invoice needs View on the lead or job it hangs off (story 50)', () => {
    const DOCS = { view_estimates: true, view_invoices: true, leads_scope: 'all', jobs_scope: 'all' };

    /** A lead with an estimate and its deposit invoice, a job with an estimate and an invoice, and a converted lead's estimate. */
    async function documents() {
      const { org, customer, admin } = await fx.newOrg();
      const lead = await fx.addLead(org, customer, {});
      const leadEstimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const depositInvoice = await fx.addInvoice(org, customer, { estimateId: leadEstimate.id });
      const job = await fx.addJob(org, customer, {});
      const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const jobInvoice = await fx.addInvoice(org, customer, { jobId: job.id });
      return { org, leadEstimate: leadEstimate.id, depositInvoice: depositInvoice.id, jobEstimate: jobEstimate.id, jobInvoice: jobInvoice.id };
    }

    async function reached(api: () => Promise<Api>) {
      const estimates = await (await api()).get('/api/estimates');
      const invoices = await (await api()).get('/api/invoices');
      expect(estimates.status).toBe(200);
      expect(invoices.status).toBe(200);
      return { estimates: ids(estimates.body.estimates), invoices: ids(invoices.body.invoices) };
    }

    it('with View leads and View jobs, scope All reaches every document (the control)', async () => {
      const d = await documents();
      const me = await personWith(d.org, { ...DOCS, view_leads: true, view_jobs: true });
      expect(await reached(me.api)).toEqual({
        estimates: [d.leadEstimate, d.jobEstimate].sort(),
        invoices: [d.depositInvoice, d.jobInvoice].sort(),
      });
    });

    it('without View leads, the estimate and deposit invoice on a lead are out of reach, the job\'s documents are not', async () => {
      const d = await documents();
      const me = await personWith(d.org, { ...DOCS, view_leads: false, view_jobs: true });
      expect(await reached(me.api)).toEqual({ estimates: [d.jobEstimate], invoices: [d.jobInvoice] });
      const missing = await (await me.api()).get(`/api/estimates/${randomUUID()}`);
      const hidden = await (await me.api()).get(`/api/estimates/${d.leadEstimate}`);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(missing.body);
      expect((await (await me.api()).get(`/api/invoices/${d.depositInvoice}`)).status).toBe(404);
    });

    it('without View jobs, the job\'s estimate and invoice are out of reach, the lead\'s documents are not', async () => {
      const d = await documents();
      const me = await personWith(d.org, { ...DOCS, view_leads: true, view_jobs: false });
      expect(await reached(me.api)).toEqual({ estimates: [d.leadEstimate], invoices: [d.depositInvoice] });
      expect((await (await me.api()).get(`/api/invoices/${d.jobInvoice}`)).status).toBe(404);
      expect((await (await me.api()).get(`/api/estimates/${d.jobEstimate}`)).status).toBe(404);
    });

    it('on Their own, being on the lead does not reach its estimate without View leads', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { view_estimates: true, view_invoices: true, view_leads: false, view_jobs: true, leads_scope: 'attached', jobs_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      expect((await reached(me.api)).estimates).toEqual([jobEstimate.id]);
      expect((await (await me.api()).get(`/api/estimates/${estimate.id}`)).status).toBe(404);
    });
  });

  describe('the inventory-usage report names no invoice out of reach (story 48)', () => {
    /** A consumption on a job the person is on, billed on an invoice line. */
    async function usage(org: string, jobId: string, invoiceLineId: string) {
      movementOrgs.push(org);
      await db.stockMovement.create({
        data: {
          organization_id: org, occurred_at: new Date(), item_sku: 'HINGE-1', item_name: 'Hinge', type: 'consume', qty: 2,
          reference: 'used on the job', actor: 'tech', job_id: jobId, invoice_line_item_id: invoiceLineId, unit_cost: 5,
        },
      });
    }
    const REPORTS = { access_reports: true, view_jobs: true, jobs_scope: 'attached', leads_scope: 'attached' };
    const invoicesIn = (body: { items: { invoices: { id: string; invoiceNumber: string }[] }[] }) => body.items.flatMap((i) => i.invoices);

    it('with View invoices, the invoice the usage was billed on is named (the control)', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...REPORTS, view_invoices: true });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await usage(org, job.id, invoice.lineId);
      const res = await (await me.api()).get('/api/reports/inventory-usage');
      expect(res.status).toBe(200);
      expect(invoicesIn(res.body).map((i) => i.id)).toEqual([invoice.id]);
    });

    it('without View invoices, the usage is counted but no invoice id or number comes back', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...REPORTS, view_invoices: false });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await usage(org, job.id, invoice.lineId);
      const res = await (await me.api()).get('/api/reports/inventory-usage');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(invoicesIn(res.body)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(invoice.id);
      expect(JSON.stringify(res.body)).not.toContain(`INV-${invoice.id.slice(0, 8)}`);
    });

    it('a usage on a reachable job billed on an invoice of a job out of reach does not name that invoice', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...REPORTS, view_invoices: true });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, {});
      const invoice = await fx.addInvoice(org, customer, { jobId: theirs.id });
      await usage(org, mine.id, invoice.lineId);
      const res = await (await me.api()).get('/api/reports/inventory-usage');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(invoice.id);
    });
  });

  describe('the activity report is filtered in the database (story 49)', () => {
    // More records than one statement can list one by one (Postgres takes at most 32,767 values in a statement).
    const MANY = 33_000;

    it('asks the database one statement that joins events to their records, sending no list of ids', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { access_reports: true, view_leads: true, leads_scope: 'attached', view_jobs: true, jobs_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { owner: me.id });
      await db.timelineEvent.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, event_type: 'LEAD_CREATED', description: 'x', created_by: me.id } });
      const raw = vi.spyOn(db, '$queryRaw');
      const idReads = (['job', 'lead', 'estimate', 'invoice'] as const).map((d) => vi.spyOn(db[d] as unknown as { findMany: (a: unknown) => unknown }, 'findMany'));
      try {
        const res = await (await me.api()).get('/api/reports/activity');
        expect(res.status).toBe(200);
        expect(res.body.users.map((u: { id: string }) => u.id)).toEqual([me.id]);
        const statements = raw.mock.calls.map((c) => c[0] as unknown as { sql?: string; values?: unknown[] }).filter((q) => q.sql?.includes('timeline_events'));
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/EXISTS \(\s*SELECT 1 FROM "(jobs|leads|estimates|invoices)" rec/);
        // No parameter is a list: the reachable records are never fetched and sent back as ids.
        expect(statements[0]!.values!.filter((v) => Array.isArray(v))).toEqual([]);
        expect(idReads.flatMap((spy) => spy.mock.calls)).toEqual([]);
      } finally {
        raw.mockRestore();
        idReads.forEach((spy) => spy.mockRestore());
      }
    });

    it('never counts another company\'s events, even for the kinds of record the person reaches in full', async () => {
      const { org, customer } = await fx.newOrg();
      // Jobs scope All with Leads scope Their own: the job events are taken whole, the lead events through the join.
      const me = await personWith(org, { access_reports: true, view_leads: true, leads_scope: 'attached', view_jobs: true, jobs_scope: 'all', view_estimates: true, view_invoices: true });
      const job = await fx.addJob(org, customer, {});
      await db.timelineEvent.create({ data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CREATED', description: 'x', created_by: me.id } });

      const other = await fx.newOrg();
      const stranger = await fx.addUser(other.org, 'stranger', 'TECHNICIAN');
      const theirLead = await fx.addLead(other.org, other.customer, { owner: stranger.id });
      const theirJob = await fx.addJob(other.org, other.customer, { crew: [stranger.id] });
      const theirEstimate = await fx.addEstimate(other.org, other.customer, stranger.id, { leadId: theirLead.id });
      const theirInvoice = await fx.addInvoice(other.org, other.customer, { jobId: theirJob.id });
      for (const [type, id] of [['JOB', theirJob.id], ['LEAD', theirLead.id], ['ESTIMATE', theirEstimate.id], ['INVOICE', theirInvoice.id]] as const) {
        await db.timelineEvent.create({ data: { organization_id: other.org, entity_type: type, entity_id: id, event_type: `${type}_CREATED`, description: 'x', created_by: stranger.id } });
      }

      const res = await (await me.api()).get('/api/reports/activity');
      expect(res.status).toBe(200);
      expect(res.body.users.map((u: { id: string }) => u.id)).toEqual([me.id]);
    });

    it(`answers a person who reaches ${MANY.toLocaleString('en-US')} leads with the same events as a small company`, async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { access_reports: true, view_leads: true, leads_scope: 'attached', view_jobs: true, jobs_scope: 'attached' });
      const other = await fx.addUser(org, 'other', 'TECHNICIAN');
      // The person owns every one of these leads, so every one is within their reach.
      const leadIds = Array.from({ length: MANY }, () => randomUUID());
      for (let i = 0; i < leadIds.length; i += 5_000) {
        await db.lead.createMany({
          data: leadIds.slice(i, i + 5_000).map((id, k) => ({
            id, organization_id: org, customer_id: customer, lead_number: `BULK-${i + k}`, service_request: 'Door', commission_owner_id: me.id,
          })),
        });
      }
      const outside = await fx.addLead(org, customer, {});
      const event = (entity: string, by: string, type: string) =>
        db.timelineEvent.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: entity, event_type: type, description: 'x', created_by: by } });
      await event(leadIds[0]!, me.id, 'LEAD_CREATED');
      await event(leadIds[MANY - 1]!, other.id, 'LEAD_UPDATED');
      await event(outside.id, other.id, 'LEAD_CREATED'); // out of reach: not counted

      const res = await (await me.api()).get('/api/reports/activity');
      expect(res.status).toBe(200);
      const counts = Object.fromEntries((res.body.users as { id: string; actions: number }[]).map((u) => [u.id, u.actions]));
      expect(counts).toEqual({ [me.id]: 1, [other.id]: 1 });
    }, 300_000);
  });
});

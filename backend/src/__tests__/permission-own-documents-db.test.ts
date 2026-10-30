/* =============================================================================
   Roles & Permissions, P5 and P7 - Their own on estimates and invoices, with no creator rule.

   Their own is attached: through the anchor (crew of any visit, Sold by, Dispatcher), plus the documents the person
   made for a customer alone. Who made a record opens nothing by itself: View is the single gate, so a person with
   View estimates or View invoices off is refused their own document, and every verb stands on its own switch.
   A document outside the person's reach answers not-found, like one that does not exist.

   Everything goes through the public interface: the estimate and invoice routes, called as people on custom roles
   (never a built-in role name) whose switch values are the cases under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { readersWithEntityAccess as ReadersWithEntityAccess } from '../lib/tasks/entityAccessCohort';

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
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// These modules read the app's client when they load, which is undefined without a database, so they
// load inside the tests: the file then skips cleanly instead of failing to import.
const readersWithEntityAccess: typeof ReadersWithEntityAccess =
  async (...args) => (await import('../lib/tasks/entityAccessCohort.js')).readersWithEntityAccess(...args);

const suite = realClient ? describe : describe.skip;

suite('Their own on estimates and invoices (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** Every switch that needs one of these (the row rule) goes off with it, so the set stays storable. */
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
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);
  // Create requires Edit (AL-04): a holder with no Edit holds no Create (nor Standalone) either, so those go off with it.
  const EDIT_INVOICES_OFF = withDependantsOff(['edit_invoices']);
  const EDIT_ESTIMATES_OFF = withDependantsOff(['edit_estimates']);

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: {
      base?: 'DISPATCHER' | 'SALES' | 'TECHNICIAN'; departmentId?: string; locationId?: string; name?: string;
      /** Grants the switch catalog does not own yet come from the role's stored grants; these are taken off the role. */
      withoutStoredGrants?: { action: string; subject: string }[];
    } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `cr-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    for (const g of opts.withoutStoredGrants ?? []) {
    }
    clearPermissionCache(org);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `c${sequence}`, base, {
      customRoleId: role.id, departmentId: opts.departmentId, locationId: opts.locationId,
    });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleKey: key });
  }

  const listed = async (api: Api, path: string, key: 'estimates' | 'invoices') => {
    const res = await api.get(path);
    expect(res.status).toBe(200);
    return (res.body[key] as { id: string }[]).map((r) => r.id);
  };
  const listedEstimates = (api: Api) => listed(api, '/api/estimates', 'estimates');
  const listedInvoices = (api: Api) => listed(api, '/api/invoices', 'invoices');
  const aCrewMember = () => `crew${++sequence}`;

  describe('View is the single gate', () => {
    it('refuses a person their own invoice and lists none with View invoices off, even one they made on a job they are on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...INVOICES_VIEW_OFF, jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const alone = await fx.addInvoice(org, customer, { createdBy: me.id });

      expect((await api.get(`/api/invoices/${mine.id}`)).status).toBe(403);
      expect((await api.get(`/api/invoices/${alone.id}`)).status).toBe(403);
      expect(await listedInvoices(api)).toEqual([]);
    });

    it('refuses a person their own estimate and lists none with View estimates off, even one they made for a customer alone', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...ESTIMATES_VIEW_OFF, jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const onMyLead = await fx.addEstimate(org, customer, me.id, { leadId: lead.id });
      const alone = await fx.addEstimate(org, customer, me.id);

      expect((await api.get(`/api/estimates/${onMyLead.id}`)).status).toBe(403);
      expect((await api.get(`/api/estimates/${alone.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).toEqual([]);
    });
  });

  describe('what Their own lists', () => {
    it('lists the invoices on their job and the ones they made for a customer alone, and nothing else', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const attached = await fx.addInvoice(org, customer, { jobId: job.id });
      const customerOnly = await fx.addInvoice(org, customer, { createdBy: me.id });
      const decoy = await fx.addInvoice(org, customer);
      const strangerJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      const unattachedMine = await fx.addInvoice(org, customer, { jobId: strangerJob.id, createdBy: me.id });

      const ids = await listedInvoices(api);
      expect(ids.sort()).toEqual([attached.id, customerOnly.id].sort());
      expect(ids).not.toContain(decoy.id);
      expect(ids).not.toContain(unattachedMine.id);
    });

    it('lists the estimates on their lead and the ones they made for a customer alone, and nothing else', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const attached = await fx.addEstimate(org, customer, me.id, { leadId: lead.id });
      const customerOnly = await fx.addEstimate(org, customer, me.id);
      const decoy = await fx.addEstimate(org, customer, (await fx.addUser(org, aCrewMember(), 'SALES')).id);

      const ids = await listedEstimates(api);
      expect(ids.sort()).toEqual([attached.id, customerOnly.id].sort());
      expect(ids).not.toContain(decoy.id);
    });

    it('keeps a customer-only estimate for good, and follows attachment once it is linked to a job', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const estimate = await fx.addEstimate(org, customer, me.id);

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toEqual([estimate.id]);

      // Linked to a job the creator is not on: not found, and gone from the list.
      const theirJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: theirJob.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(404);
      expect(await listedEstimates(api)).toEqual([]);

      // Linked to a job the creator is on: open again.
      const myJob = await fx.addJob(org, customer, { crew: [me.id] });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: myJob.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toEqual([estimate.id]);
    });

    it('loses an estimate on a lead once taken off the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const estimate = await fx.addEstimate(org, customer, me.id, { leadId: lead.id });

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      await db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(404);
      expect(await listedEstimates(api)).toEqual([]);
    });

    it('loses an invoice on a job once taken off the job', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });

      expect((await api.get(`/api/invoices/${mine.id}`)).status).toBe(200);
      await fx.removeCrew(job.visitId!, me.id);
      expect((await api.get(`/api/invoices/${mine.id}`)).status).toBe(404);
      expect(await listedInvoices(api)).toEqual([]);
    });
  });

  describe('a record outside the reach', () => {
    it('answers not-found for an unattached estimate and invoice, the same as for an id that does not exist', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await me.api();
      const strangerJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: strangerJob.id });
      const invoice = await fx.addInvoice(org, customer, { jobId: strangerJob.id });
      const nobody = '00000000-0000-0000-0000-000000000000';

      const estimateAnswer = await api.get(`/api/estimates/${estimate.id}`);
      const missingEstimate = await api.get(`/api/estimates/${nobody}`);
      expect(estimateAnswer.status).toBe(404);
      expect(estimateAnswer.body).toEqual(missingEstimate.body);

      const invoiceAnswer = await api.get(`/api/invoices/${invoice.id}`);
      const missingInvoice = await api.get(`/api/invoices/${nobody}`);
      expect(invoiceAnswer.status).toBe(404);
      expect(invoiceAnswer.body).toEqual(missingInvoice.body);
    });

    it.each([
      ['attached', {}],
      ['team', {}],
    ])('follows attachment for their own lead-less estimate on a job whatever scope they hold (%s)', async (scope, opts) => {
      const { org, customer } = await fx.newOrg();
      const dept = await fx.addDepartment(org, 'mine');
      const me = await personWith(org, { jobs_scope: scope, leads_scope: scope }, { ...opts, departmentId: dept });
      const api = await me.api();
      const strangerJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      const estimate = await fx.addEstimate(org, customer, me.id, { jobId: strangerJob.id });

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(404);
      expect(await listedEstimates(api)).not.toContain(estimate.id);

      // Putting the creator on the job's crew attaches them, and the estimate opens again.
      await db.visitAssignee.create({ data: { visit_id: strangerJob.visitId!, user_id: me.id, organization_id: org } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toContain(estimate.id);
    });

    it('keeps a person with Team scope and no department their own customer-only documents', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'team', leads_scope: 'team' });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);

      expect(await listedEstimates(api)).toEqual([mine.id]);
    });
  });

  describe('every verb stands on its own switch', () => {
    it('edits their own invoice only with Edit invoices, and never a colleague\'s outside their reach', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const withoutEdit = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', ...EDIT_INVOICES_OFF });
      const withEdit = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });
      const mine = await fx.addInvoice(org, customer, { createdBy: withoutEdit.id });
      const theirs = await fx.addInvoice(org, customer, { createdBy: admin.id });

      const refused = await (await withoutEdit.api()).patch(`/api/invoices/${mine.id}`, { allow_partial_payment: true });
      expect(refused.status).toBe(403);
      const allowed = await (await withEdit.api()).patch(`/api/invoices/${theirs.id}`, { allow_partial_payment: true });
      expect(allowed.status).toBe(200);
    });

    it('is refused send, delete and the money verbs on their own invoice without the matching switch', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, {
        jobs_scope: 'attached', leads_scope: 'attached', ...EDIT_INVOICES_OFF, delete_invoices: false, void_invoices: false, apply_credits: false,
        void_payments: false, apply_discounts: false, edit_invoice_line_items: false, record_payments: false,
        refund_payments: false, send_payment_links: false,
      });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const base = `/api/invoices/${mine.id}`;

      expect((await api.get(base)).status).toBe(200);
      const attempts: [string, { status: number }][] = [
        ['edit', await api.patch(base, { allow_partial_payment: true })],
        ['send', await api.post(`${base}/send`, {})],
        ['delete', await api.delete(base)],
        ['void', await api.post(`${base}/void`, { reason: 'mistake' })],
        ['refund', await api.post(`${base}/refund`, { amount: 1, method: 'CASH' })],
        ['credit', await api.post(`${base}/credit`, { amount: 1, reason: 'goodwill' })],
        ['discount', await api.patch(`${base}/billing`, { discount_amount: 10 })],
        ['record payment', await api.post(`${base}/payments`, { amount: 1, method: 'CASH' })],
        ['payment link', await api.post(`${base}/payment-link`, {})],
        ['add line', await api.post(`${base}/line-items`, { description: 'Extra', quantity: 1, unit_price: 5 })],
      ];
      for (const [name, res] of attempts) expect(res.status, name).toBe(403);
      expect(await db.invoice.findUniqueOrThrow({ where: { id: mine.id }, select: { status: true } })).toEqual({ status: 'DRAFT' });
    });

    it('is refused edit, send, delete, approve, decline and a waived deposit on their own estimate without the matching switch', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, {
        jobs_scope: 'all', leads_scope: 'all', ...EDIT_ESTIMATES_OFF, delete_estimates: false, approve_estimates: false,
        decline_estimates: false, waive_deposits: false,
      });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);
      const base = `/api/estimates/${mine.id}`;

      expect((await api.get(base)).status).toBe(200);
      const attempts: [string, { status: number }][] = [
        ['edit', await api.patch(base, { name: 'Front door' })],
        ['send', await api.post(`${base}/send`, {})],
        ['mark sent', await api.post(`${base}/mark-sent`, {})],
        ['delete', await api.delete(base)],
        ['approve', await api.post(`${base}/approve-internal`, {})],
        ['decline', await api.post(`${base}/decline-internal`, { lost_reason: 'x' })],
        ['waive deposit', await api.post(`${base}/waive-deposit`, {})],
      ];
      for (const [name, res] of attempts) expect(res.status, name).toBe(403);
      expect(await db.estimate.count({ where: { id: mine.id } })).toBe(1);
    });

    it('edits, sends and deletes their own draft estimate with the switches on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', delete_estimates: true });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);

      expect((await api.patch(`/api/estimates/${mine.id}`, { name: 'Front door' })).status).toBe(200);
      expect((await api.post(`/api/estimates/${mine.id}/mark-sent`, {})).status).not.toBe(403);
      const second = await fx.addEstimate(org, customer, me.id);
      expect((await api.delete(`/api/estimates/${second.id}`)).status).toBe(200);
      expect(await db.estimate.count({ where: { id: second.id } })).toBe(0);
    });
  });

  describe('who can open an estimate, for the task assignee check', () => {
    it('counts its creator while they are attached or when it is for a customer alone, in a fixed number of probes', async () => {
      const { org, customer } = await fx.newOrg();
      const asReader = async (p: Person) => {
        const row = await db.user.findUniqueOrThrow({
          where: { id: p.id },
          select: { id: true, role: true, is_admin: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
        });
        return row;
      };
      const views = { jobs_scope: 'attached', leads_scope: 'attached' };
      const maker = await personWith(org, views);
      const other = await personWith(org, views);
      const bystander = await personWith(org, views);
      const readers = [await asReader(maker), await asReader(other), await asReader(bystander)];

      const alone = await fx.addEstimate(org, customer, maker.id);
      const customerOnly = await readersWithEntityAccess(readers, { type: 'ESTIMATE', id: alone.id });
      expect([...customerOnly.withAccess]).toEqual([maker.id]);
      expect(customerOnly.fallbacks).toBe(0);

      const job = await fx.addJob(org, customer, { crew: [other.id] });
      const onSomeonesJob = await fx.addEstimate(org, customer, maker.id, { jobId: job.id });
      const notAttached = await readersWithEntityAccess(readers, { type: 'ESTIMATE', id: onSomeonesJob.id });
      expect([...notAttached.withAccess]).toEqual([other.id]);

      await db.visitAssignee.create({ data: { visit_id: job.visitId!, user_id: maker.id, organization_id: org } });
      const attached = await readersWithEntityAccess(readers, { type: 'ESTIMATE', id: onSomeonesJob.id });
      expect([...attached.withAccess].sort()).toEqual([maker.id, other.id].sort());
      expect(attached.fallbacks).toBe(0);
      expect(attached.probes).toBe(notAttached.probes);
    });
  });
});

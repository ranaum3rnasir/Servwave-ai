/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.4 - the creator rule for estimates and invoices.

   For every role, the creator of an estimate or invoice may open, edit, send and resend it, and delete
   it while it is a draft, as long as they can see it: on a job or lead only while attached to it; for a
   customer alone, for good; once linked to a job or lead, attachment applies. The rule opens the record
   even with the module's View off, and never grants void, refund, credit, void payment, Apply
   discounts, Record payments or Send payment links.

   Everything goes through the public interface: the estimate and invoice routes, called as people on
   custom roles (never a built-in role name) whose switch values are the cases under test, and the
   resolver's exported question. Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { readersWithEntityAccess as ReadersWithEntityAccess } from '../lib/tasks/entityAccessCohort';
import type { isCreatorStillAttached as IsCreatorStillAttached } from '../lib/permissions/creatorRule';

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
const isCreatorStillAttached: typeof IsCreatorStillAttached =
  async (...args) => (await import('../lib/permissions/creatorRule.js')).isCreatorStillAttached(...args);

const suite = realClient ? describe : describe.skip;

suite('the creator rule for estimates and invoices (real database)', () => {
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
      await db.rolePermission.deleteMany({ where: { organization_id: org, role: key, action: g.action, subject: g.subject } });
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

  describe('an invoice\'s creator', () => {
    it('opens and lists an invoice they created on a job they are attached to with Invoices View off, and loses it on the next request once taken off the job', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...INVOICES_VIEW_OFF, invoices_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const colleagues = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: (await fx.addUser(org, aCrewMember(), 'SALES')).id });

      expect((await api.get(`/api/invoices/${mine.id}`)).status).toBe(200);
      expect(await listedInvoices(api)).toEqual([mine.id]);
      // The job's crew still cannot open a colleague's invoice with View off.
      expect((await api.get(`/api/invoices/${colleagues.id}`)).status).toBe(403);

      await fx.removeCrew(job.visitId!, me.id);

      expect((await api.get(`/api/invoices/${mine.id}`)).status).toBe(403);
      expect(await listedInvoices(api)).toEqual([]);
    });

    it('lists the union of the rows their Invoices scope reaches and the invoices they created for a customer alone', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { invoices_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const attached = await fx.addInvoice(org, customer, { jobId: job.id });
      const customerOnly = await fx.addInvoice(org, customer, { createdBy: me.id });
      const decoy = await fx.addInvoice(org, customer);

      const ids = await listedInvoices(api);
      expect(ids.sort()).toEqual([attached.id, customerOnly.id].sort());
      expect(ids).not.toContain(decoy.id);
    });

    it('deletes their own draft invoice with Delete invoices off, is refused once it is sent, and is refused on a colleague\'s draft in scope', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...INVOICES_VIEW_OFF, invoices_scope: 'attached' });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const draft = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const sent = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      await db.invoice.update({ where: { id: sent.id }, data: { status: 'SENT' } });

      expect((await api.delete(`/api/invoices/${draft.id}`)).status).toBe(204);
      expect(await db.invoice.count({ where: { id: draft.id } })).toBe(0);
      const refused = await api.delete(`/api/invoices/${sent.id}`);
      expect(refused.status).toBe(400);
      expect(await db.invoice.count({ where: { id: sent.id } })).toBe(1);

      const reader = await personWith(org, { invoices_scope: 'all', delete_invoices: false });
      const colleaguesDraft = await fx.addInvoice(org, customer, { createdBy: me.id });
      expect((await (await reader.api()).delete(`/api/invoices/${colleaguesDraft.id}`)).status).toBe(403);
      expect(await db.invoice.count({ where: { id: colleaguesDraft.id } })).toBe(1);
    });

    it('edits and sends their own invoice with Edit invoices off, and is refused on a colleague\'s invoice in scope', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { invoices_scope: 'all', edit_invoices: false });
      const api = await me.api();
      const mine = await fx.addInvoice(org, customer, { createdBy: me.id });
      const colleagues = await fx.addInvoice(org, customer, { createdBy: admin.id });

      const edited = await api.patch(`/api/invoices/${mine.id}`, { allow_partial_payment: true });
      expect(edited.status).toBe(200);
      expect((await api.patch(`/api/invoices/${colleagues.id}`, { allow_partial_payment: true })).status).toBe(403);
      // Send and resend ride the same switch: allowed on one's own (anything but a refusal), refused on a colleague's.
      for (const verb of ['send', 'resend']) {
        const own = await api.post(`/api/invoices/${mine.id}/${verb}`, {});
        expect(own.status, `${verb} own`).not.toBe(403);
        expect((await api.post(`/api/invoices/${colleagues.id}/${verb}`, {})).status, `${verb} colleague`).toBe(403);
      }
      expect((await api.patch(`/api/invoices/${colleagues.id}/billing`, { tip: 1 })).status).toBe(403);
      expect((await api.patch(`/api/invoices/${mine.id}/billing`, { tip: 1 })).status).toBe(200);
    });

    it('is refused void, refund, credit, void payment, a discount change, a payment, a payment link and a new line on their own invoice without the matching switch', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, {
        invoices_scope: 'attached', edit_invoices: false, void_invoices: false, apply_credits: false, void_payments: false,
        apply_discounts: false, edit_invoice_line_items: false, record_payments: false, refund_payments: false,
        send_payment_links: false,
      });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const base = `/api/invoices/${mine.id}`;

      expect((await api.get(base)).status).toBe(200);
      const attempts: [string, { status: number }][] = [
        ['void', await api.post(`${base}/void`, { reason: 'mistake' })],
        ['refund', await api.post(`${base}/refund`, { amount: 1, method: 'CASH' })],
        ['credit', await api.post(`${base}/credit`, { amount: 1, reason: 'goodwill' })],
        ['void payment', await api.post(`${base}/void-payment`, { payment_id: '00000000-0000-0000-0000-000000000000', reason: 'x' })],
        ['discount', await api.patch(`${base}/billing`, { discount_amount: 10 })],
        ['record payment', await api.post(`${base}/payments`, { amount: 1, method: 'CASH' })],
        ['payment link', await api.post(`${base}/payment-link`, {})],
        ['add line', await api.post(`${base}/line-items`, { description: 'Extra', quantity: 1, unit_price: 5 })],
        ['delete line', await api.delete(`${base}/line-items/${mine.lineId}`)],
      ];
      for (const [name, res] of attempts) expect(res.status, name).toBe(403);
      expect(await db.invoice.findUniqueOrThrow({ where: { id: mine.id }, select: { status: true } })).toEqual({ status: 'DRAFT' });
    });
  });

  describe('an estimate\'s creator', () => {
    it('keeps a customer-only estimate for good, even with Estimates View off, and follows attachment once it is linked to a job', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...ESTIMATES_VIEW_OFF, estimates_scope: 'attached' });
      const api = await me.api();
      const estimate = await fx.addEstimate(org, customer, me.id);

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toEqual([estimate.id]);

      // Linked to a job the creator is not on: refused, and gone from the list.
      const theirJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: theirJob.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).toEqual([]);

      // Linked to a job the creator is on: open again.
      const myJob = await fx.addJob(org, customer, { crew: [me.id] });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: myJob.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toEqual([estimate.id]);
    });

    it('loses an estimate on a lead once taken off the lead', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...ESTIMATES_VIEW_OFF, estimates_scope: 'attached' });
      const api = await me.api();
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const estimate = await fx.addEstimate(org, customer, me.id, { leadId: lead.id });

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      await db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).toEqual([]);
    });

    it('edits and sends their own estimate with Edit estimates off, and is refused on a colleague\'s estimate in scope', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'all', edit_estimates: false });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);
      const colleagues = await fx.addEstimate(org, customer, admin.id);

      expect((await api.patch(`/api/estimates/${mine.id}`, { name: 'Front door' })).status).toBe(200);
      expect((await api.patch(`/api/estimates/${colleagues.id}`, { name: 'Front door' })).status).toBe(403);
      expect((await api.post(`/api/estimates/${mine.id}/mark-sent`, {})).status).not.toBe(403);
      expect((await api.post(`/api/estimates/${colleagues.id}/mark-sent`, {})).status).toBe(403);
      expect((await api.post(`/api/estimates/${mine.id}/send`, {})).status).not.toBe(403);
      expect((await api.post(`/api/estimates/${colleagues.id}/send`, {})).status).toBe(403);
      expect((await api.post(`/api/estimates/${mine.id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 12 })).status).not.toBe(403);
      expect((await api.post(`/api/estimates/${colleagues.id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 12 })).status).toBe(403);
    });

    it('deletes their own draft estimate with Delete estimates off, and is refused on a colleague\'s draft in scope', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'all', delete_estimates: false });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);
      const colleagues = await fx.addEstimate(org, customer, admin.id);

      expect((await api.delete(`/api/estimates/${colleagues.id}`)).status).toBe(403);
      expect(await db.estimate.count({ where: { id: colleagues.id } })).toBe(1);
      expect((await api.delete(`/api/estimates/${mine.id}`)).status).toBe(200);
      expect(await db.estimate.count({ where: { id: mine.id } })).toBe(0);
    });

    it('never gets approve, decline or a waived deposit on their own estimate from the creator rule', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, {
        estimates_scope: 'all', approve_estimates: false, decline_estimates: false, waive_deposits: false, edit_estimates: false,
      });
      const api = await me.api();
      const mine = await fx.addEstimate(org, customer, me.id);
      const base = `/api/estimates/${mine.id}`;

      // The rule does open the estimate and let them edit it; it stops there.
      expect((await api.get(base)).status).toBe(200);
      expect((await api.patch(base, { name: 'Front door' })).status).toBe(200);
      expect((await api.post(`${base}/approve-internal`, {})).status).toBe(403);
      expect((await api.post(`${base}/decline-internal`, { lost_reason: 'x' })).status).toBe(403);
      expect((await api.post(`${base}/waive-deposit`, {})).status).toBe(403);
    });

    it.each([
      ['attached', {}],
      ['team', {}],
      ['location', {}],
      ['through_own_leads', { base: 'SALES' as const }],
    ])('follows attachment for their own lead-less estimate on a job whatever scope they hold (%s)', async (scope, opts) => {
      const { org, customer } = await fx.newOrg();
      const [dept, place] = [await fx.addDepartment(org, 'mine'), await fx.addLocation(org, 'here')];
      const me = await personWith(org, scope === 'through_own_leads' ? {} : { estimates_scope: scope }, {
        ...opts, departmentId: dept, locationId: place,
      });
      const api = await me.api();
      const strangerJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, aCrewMember(), 'TECHNICIAN')).id] });
      const estimate = await fx.addEstimate(org, customer, me.id, { jobId: strangerJob.id });

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).not.toContain(estimate.id);

      // Putting the creator on the job's crew attaches them, and the estimate opens again.
      await db.visitAssignee.create({ data: { visit_id: strangerJob.visitId!, user_id: me.id, organization_id: org } });
      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toContain(estimate.id);
    });
  });

  describe('who can open an estimate, for the task assignee check', () => {
    it('counts its creator while they are attached or when it is for a customer alone, in a fixed number of probes', async () => {
      const { org, customer } = await fx.newOrg();
      const asReader = async (p: Person) => {
        const row = await db.user.findUniqueOrThrow({
          where: { id: p.id },
          select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } }, department_id: true, location_id: true },
        });
        return row;
      };
      const views = { ...ESTIMATES_VIEW_OFF, estimates_scope: 'attached' };
      const maker = await personWith(org, views);
      const other = await personWith(org, { estimates_scope: 'attached' });
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

  describe('the resolver\'s "is creator and still attached"', () => {
    it('is true for the creator while attached, and false once they are taken off, for someone else\'s record, and for no such record', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, {});
      const user = await db.user.findUniqueOrThrow({ where: { id: me.id } });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
      const theirs = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
      const myEstimate = await fx.addEstimate(org, customer, me.id, { jobId: job.id });

      expect(await isCreatorStillAttached(user, 'Invoice', mine.id)).toBe(true);
      expect(await isCreatorStillAttached(user, 'Estimate', myEstimate.id)).toBe(true);
      expect(await isCreatorStillAttached(user, 'Invoice', theirs.id)).toBe(false);
      expect(await isCreatorStillAttached(user, 'Invoice', '00000000-0000-0000-0000-000000000000')).toBe(false);

      await fx.removeCrew(job.visitId!, me.id);
      expect(await isCreatorStillAttached(user, 'Invoice', mine.id)).toBe(false);
      expect(await isCreatorStillAttached(user, 'Estimate', myEstimate.id)).toBe(false);
    });

    it('answers for a lead and a job too, which PRD 4 reads for the creator-still-attached lead edit', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, {});
      const user = await db.user.findUniqueOrThrow({ where: { id: me.id } });
      const lead = await fx.addLead(org, customer, { assignees: [me.id], createdBy: me.id });
      const job = await fx.addJob(org, customer, { crew: [me.id], createdBy: me.id });
      const elsewhere = await fx.addLead(org, customer, { createdBy: me.id });

      expect(await isCreatorStillAttached(user, 'Lead', lead.id)).toBe(true);
      expect(await isCreatorStillAttached(user, 'Job', job.id)).toBe(true);
      expect(await isCreatorStillAttached(user, 'Lead', elsewhere.id)).toBe(false);
    });
  });
});

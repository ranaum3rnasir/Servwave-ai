/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.5 - customers reached through jobs and leads; customer data
   comes with the record.

   Everything goes through the public interface: the role store and the customer, job, lead and service
   plan routes, called as people on custom roles (never a built-in role name) whose switch values are the
   ones under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

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
// ...and so is the numbering allocator (the setup's stub hands every customer the same number, so a
// second customer create in one organization collides on it).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, findSwitch, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const suite = realClient ? describe : describe.skip;

suite('customers are reached through jobs and leads (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: 'ADMIN' | 'DISPATCHER' | 'SALES' | 'TECHNICIAN'; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `cr-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    // The role copies the legacy grants of its base the way creating a role does; the catalog, not
    // those stored grants, decides what the person reaches among customers.
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleKey: key });
  }

  /** A customer with a primary service location; `createdBy` is the person who made it. */
  async function addCustomer(org: string, opts: { createdBy?: string; phone?: string; email?: string; name?: string } = {}) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: opts.name ?? 'Reach', last_name: `Tester-${tag}`, phone: opts.phone ?? null, email: opts.email ?? null,
        created_by_id: opts.createdBy ?? null,
        service_locations: { create: { address_line1: '9 Reach Road', city: 'Testville', state: 'MA', zip: '02108', is_primary: true } },
      },
    });
    return id;
  }

  const listedCustomers = async (api: Api) => {
    const res = await api.get('/api/customers?limit=100');
    expect(res.status).toBe(200);
    return (res.body.customers as { id: string }[]).map((c) => c.id);
  };
  const opens = async (api: Api, customer: string) => (await api.get(`/api/customers/${customer}`)).status === 200;

  const allScopes = { leads_scope: 'all', jobs_scope: 'all' };

  describe('who reaches which customer', () => {
    it('opens every customer when Leads scope and Jobs scope are both All', async () => {
      const { org, customer } = await fx.newOrg();
      const bare = await addCustomer(org);
      const me = await personWith(org, allScopes);
      const api = await me.api();

      expect(await listedCustomers(api)).toEqual(expect.arrayContaining([customer, bare]));
      expect(await opens(api, bare)).toBe(true);
    });

    it('opens, on Attached scopes, only customers of leads and jobs the person is attached to, plus customers they created', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
      const [ofAssignedLead, ofOwnedLead, ofWalkthroughLead, ofDispatchedLead, ofCrewedJob, ofSoldJob, ofDispatchedJob, madeByMe, unrelated] =
        await Promise.all(Array.from({ length: 9 }, () => addCustomer(org)));
      const madeByMeToo = await addCustomer(org, { createdBy: me.id });
      await fx.addLead(org, ofAssignedLead!, { assignees: [me.id] });
      await fx.addLead(org, ofOwnedLead!, { owner: me.id });
      await fx.addLead(org, ofWalkthroughLead!, { walkthroughCrew: [me.id] });
      await fx.addLead(org, ofDispatchedLead!, { dispatcher: me.id });
      await fx.addJob(org, ofCrewedJob!, { crew: [me.id] });
      await fx.addJob(org, ofSoldJob!, { soldBy: me.id });
      await fx.addJob(org, ofDispatchedJob!, { dispatcher: me.id });
      // A lead or job someone else is on, and a record the person merely created, reach nobody.
      await fx.addLead(org, unrelated!, {});
      await fx.addJob(org, unrelated!, { crew: [] });
      await fx.addJob(org, madeByMe!, { createdBy: me.id });
      const api = await me.api();

      const reached = [ofAssignedLead, ofOwnedLead, ofWalkthroughLead, ofDispatchedLead, ofCrewedJob, ofSoldJob, ofDispatchedJob, madeByMeToo];
      const listed = await listedCustomers(api);
      for (const c of reached) expect(listed, `customer ${c}`).toContain(c);
      for (const c of [unrelated, madeByMe]) expect(listed, `customer ${c}`).not.toContain(c);
      for (const c of reached) expect(await opens(api, c!), `customer ${c}`).toBe(true);
      expect(await opens(api, unrelated!)).toBe(false);
    });

    it('reaches the customers of every lead on Leads scope All while Jobs scope is Attached', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'all', jobs_scope: 'attached' });
      const [ofAnyLead, ofOthersJob, ofMyJob] = await Promise.all([addCustomer(org), addCustomer(org), addCustomer(org)]);
      await fx.addLead(org, ofAnyLead, {});
      await fx.addJob(org, ofOthersJob, {});
      await fx.addJob(org, ofMyJob, { crew: [me.id] });
      const api = await me.api();

      const listed = await listedCustomers(api);
      expect(listed).toContain(ofAnyLead);
      expect(listed).toContain(ofMyJob);
      expect(listed).not.toContain(ofOthersJob);
    });

    it('reaches a customer through a job the Through own leads value reaches', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'through_own_leads' }, { base: 'SALES' });
      const [ofMyLeadsJob, ofOthersJob] = await Promise.all([addCustomer(org), addCustomer(org)]);
      const lead = await fx.addLead(org, ofMyLeadsJob, { assignees: [me.id] });
      await fx.addJob(org, ofMyLeadsJob, { fromLead: lead.id });
      await fx.addJob(org, ofOthersJob, {});
      const api = await me.api();

      const listed = await listedCustomers(api);
      expect(listed).toContain(ofMyLeadsJob);
      expect(listed).not.toContain(ofOthersJob);
    });

    it('keeps the attached and created reach for a person with no department when Team scope reaches nobody', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'team', jobs_scope: 'team' });
      const [attached, mine, teammates] = await Promise.all([addCustomer(org), addCustomer(org, { createdBy: undefined }), addCustomer(org)]);
      const made = await addCustomer(org, { createdBy: me.id });
      await fx.addJob(org, attached, { crew: [me.id] });
      const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: await fx.addDepartment(org, 'other') });
      await fx.addJob(org, teammates, { crew: [mate.id] });
      const api = await me.api();

      const listed = await listedCustomers(api);
      expect(listed).toEqual(expect.arrayContaining([attached, made]));
      expect(listed).not.toContain(teammates);
      expect(listed).not.toContain(mine);
    });

    it('refuses Edit customers on a customer outside reach, and lets it through on one inside', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached', edit_customers: true });
      const [inside, outside] = await Promise.all([addCustomer(org), addCustomer(org)]);
      await fx.addJob(org, inside, { crew: [me.id] });
      const api = await me.api();

      const refused = await api.patch(`/api/customers/${outside}`, { first_name: 'Changed' });
      expect([403, 404]).toContain(refused.status);
      expect((await db.customer.findUniqueOrThrow({ where: { id: outside } })).first_name).toBe('Reach');

      const allowed = await api.patch(`/api/customers/${inside}`, { first_name: 'Changed' });
      expect(allowed.status).toBe(200);
      expect((await db.customer.findUniqueOrThrow({ where: { id: inside } })).first_name).toBe('Changed');
    });

    it('lets the person take a customer away when Delete customers is on, within reach only', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached', delete_customers: true });
      const [inside, outside] = await Promise.all([addCustomer(org, { createdBy: me.id }), addCustomer(org)]);
      const api = await me.api();

      expect([403, 404]).toContain((await api.delete(`/api/customers/${outside}`)).status);
      expect(await db.customer.count({ where: { id: outside } })).toBe(1);
      expect((await api.delete(`/api/customers/${inside}`)).status).toBe(200);
      expect(await db.customer.count({ where: { id: inside } })).toBe(0);
    });
  });

  describe('Customers View off', () => {
    const technicianLike = { view_customers: false, create_customers: false, edit_customers: false, delete_customers: false, export_customers: false, archive_customers: false, edit_customer_record_ids: false,
      change_customer_created_date: false };

    it('refuses a customer detail read, while the name, phone and address arrive on a job the person can open', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...technicianLike, leads_scope: 'attached', jobs_scope: 'attached' }, { base: 'TECHNICIAN' });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await me.api();

      const detail = await api.get(`/api/customers/${customer}`);
      expect([403, 404]).toContain(detail.status);
      expect((await api.get('/api/customers')).status).toBe(403);

      const res = await api.get(`/api/jobs/${job.id}`);
      expect(res.status).toBe(200);
      const body = res.body.job ?? res.body;
      expect(body.customer).toMatchObject({ first_name: 'Dana', phone: '+16175550142' });
      expect(body.service_location).toMatchObject({ address_line1: '1 Test Way' });
    });

    it('keeps the customer\'s phone and address on an invoice and an estimate that sit on a job or lead the person can open', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await personWith(org, {
        ...technicianLike, view_invoices: true, view_estimates: true,
        leads_scope: 'attached', jobs_scope: 'attached',
      }, { base: 'TECHNICIAN' });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const api = await me.api();

      const invoiceRes = await api.get(`/api/invoices/${invoice.id}`);
      expect(invoiceRes.status).toBe(200);
      expect(invoiceRes.body.invoice.customer).toMatchObject({ first_name: 'Dana', phone: '+16175550142' });
      const estimateRes = await api.get(`/api/estimates/${estimate.id}`);
      expect(estimateRes.status).toBe(200);
      expect((estimateRes.body.estimate.customer ?? estimateRes.body.estimate.lead.customer)).toMatchObject({ phone: '+16175550142' });
    });

    it('still withholds the contact of a customer from an invoice that has no job or lead, when the person cannot read the customer', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...technicianLike, view_invoices: true, jobs_scope: 'all', leads_scope: 'all' }, { base: 'TECHNICIAN' });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const invoice = await fx.addInvoice(org, customer);
      const api = await me.api();

      const res = await api.get(`/api/invoices/${invoice.id}`);
      expect(res.status).toBe(200);
      expect(res.body.invoice.customer.first_name).toBe('Dana');
      expect(res.body.invoice.customer).not.toHaveProperty('phone');
    });

    it('does not reach an invoice on a job the person cannot open: an invoice follows the Jobs scope (P6)', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, {
        ...technicianLike, view_invoices: true, leads_scope: 'attached', jobs_scope: 'attached',
      }, { base: 'TECHNICIAN' });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const job = await fx.addJob(org, customer, {});
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const api = await me.api();

      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(404);
      expect((await api.get(`/api/invoices/${invoice.id}`)).status).toBe(404);
    });

    it('keeps the contact on an estimate reached through its job: the job\'s customer is theirs to open whatever lead the estimate also sits on', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await personWith(org, {
        ...technicianLike, view_estimates: true, leads_scope: 'attached', jobs_scope: 'all',
      }, { base: 'TECHNICIAN' });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const lead = await fx.addLead(org, customer, {});
      const job = await fx.addJob(org, customer, {});
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id, jobId: job.id });
      const api = await me.api();

      const res = await api.get(`/api/estimates/${estimate.id}`);
      expect(res.status).toBe(200);
      expect(res.body.estimate.customer ?? res.body.estimate.lead.customer).toMatchObject({ phone: '+16175550142' });
    });

    it('keeps the contact on an invoice whose job the person reaches as its Sold By, or through their team', async () => {
      const { org } = await fx.newOrg();
      const soldByMe = await personWith(org, { ...technicianLike, view_invoices: true, jobs_scope: 'attached' }, { base: 'TECHNICIAN' });
      const department = await fx.addDepartment(org, 'crew');
      const teamMate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: department });
      const onTeam = await personWith(org, { ...technicianLike, view_invoices: true, jobs_scope: 'team' }, { base: 'TECHNICIAN' });
      await db.user.update({ where: { id: onTeam.id }, data: { department_id: department } });
      const customer = await addCustomer(org, { phone: '+16175550142', name: 'Dana' });
      const soldJob = await fx.addJob(org, customer, { soldBy: soldByMe.id });
      const teamJob = await fx.addJob(org, customer, { crew: [teamMate.id] });
      const soldInvoice = await fx.addInvoice(org, customer, { jobId: soldJob.id });
      const teamInvoice = await fx.addInvoice(org, customer, { jobId: teamJob.id });

      const sold = await (await soldByMe.api()).get(`/api/invoices/${soldInvoice.id}`);
      expect(sold.status).toBe(200);
      expect(sold.body.invoice.customer).toMatchObject({ phone: '+16175550142' });
      const team = await (await onTeam.api()).get(`/api/invoices/${teamInvoice.id}`);
      expect(team.status).toBe(200);
      expect(team.body.invoice.customer).toMatchObject({ phone: '+16175550142' });
    });

    it('answers the customer picker and the duplicate check in the new lead form for a person who can create leads', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...technicianLike, edit_leads: true, create_leads: true, leads_scope: 'attached', jobs_scope: 'attached' }, { base: 'TECHNICIAN' });
      const existing = await addCustomer(org, { name: 'Pickme', phone: '+16175550177', email: 'pickme@example.test' });
      const api = await me.api();

      const picked = await api.get('/api/customers/picker?search=Pickme');
      expect(picked.status).toBe(200);
      expect((picked.body.customers as { id: string }[]).map((c) => c.id)).toContain(existing);
      expect((await api.get(`/api/customers/picker/${existing}`)).status).toBe(200);

      const duplicate = await api.post('/api/leads', { new_customer: { first_name: 'Pickme', email: 'pickme@example.test' }, service_request: 'Fix the door' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toBe('duplicate');
      expect(duplicate.body.existing.id).toBe(existing);
    });

    it('shows the duplicate-check match in full to the Dispatcher of one of its leads, and redacted to a person on none', async () => {
      const { org } = await fx.newOrg();
      const values = { view_customers: true, edit_leads: true, create_leads: true, leads_scope: 'attached', jobs_scope: 'attached' };
      const dispatcher = await personWith(org, values, { base: 'TECHNICIAN' });
      const stranger = await personWith(org, values, { base: 'TECHNICIAN' });
      const existing = await addCustomer(org, { name: 'Dispatched', phone: '+16175550188', email: 'dispatched@example.test' });
      await fx.addLead(org, existing, { dispatcher: dispatcher.id });
      const body = { new_customer: { first_name: 'Dispatched', email: 'dispatched@example.test' }, service_request: 'Fix the door' };

      const seen = await (await dispatcher.api()).post('/api/leads', body);
      expect(seen.status).toBe(409);
      expect(seen.body.existing.redacted).not.toBe(true);
      const hidden = await (await stranger.api()).post('/api/leads', body);
      expect(hidden.status).toBe(409);
      expect(hidden.body.existing.redacted).toBe(true);
    });

    it('refuses the picker to a person who can create neither a lead, a job, an estimate nor an invoice', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...technicianLike, create_leads: false, create_jobs: false, create_estimates: false }, { base: 'TECHNICIAN' });
      const api = await me.api();
      expect((await api.get('/api/customers/picker?search=Reach')).status).toBe(403);
    });
  });

  describe('the service plan builder\'s quick customer create', () => {
    const body = { first_name: 'Quick', last_name: 'Planner', email: 'quick.planner@example.test', phone: '+16175550131' };

    it('is accepted on Create service plans and refused on the standalone customer create, with Create customers off', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...allScopes, create_customers: false, edit_service_plans: true, create_service_plans: true }, { base: 'ADMIN' });
      const api = await me.api();

      const refused = await api.post('/api/customers', body);
      expect(refused.status).toBe(403);
      expect(await db.customer.count({ where: { organization_id: org, email: body.email } })).toBe(0);

      const accepted = await api.post('/api/service-plans/customers', body);
      expect(accepted.status).toBe(201);
      expect(await db.customer.count({ where: { organization_id: org, email: body.email } })).toBe(1);
    });

    it('is refused without Create service plans, even with Create customers on', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, { ...allScopes, edit_customers: true, create_customers: true, create_service_plans: false, edit_service_plans: false, delete_service_plans: false }, { base: 'ADMIN' });
      const api = await me.api();

      expect((await api.post('/api/service-plans/customers', body)).status).toBe(403);
      expect(await db.customer.count({ where: { organization_id: org, email: body.email } })).toBe(0);
    });
  });

  describe('Change customer created date', () => {
    const backdated = '2020-03-04';

    it('is refused for a custom role copied from Admin with the switch off, and kept for one with it on', async () => {
      const { org } = await fx.newOrg();
      const without = await personWith(org, { change_customer_created_date: false }, { base: 'ADMIN', name: 'without' });
      const withIt = await personWith(org, { change_customer_created_date: true }, { base: 'ADMIN', name: 'with' });
      const customer = await addCustomer(org);
      const before = (await db.customer.findUniqueOrThrow({ where: { id: customer } })).created_at;

      const refused = await (await without.api()).patch(`/api/customers/${customer}`, { created_at: backdated });
      // The rest of the edit goes through; only the date is left alone.
      expect(refused.status).toBe(200);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).created_at.toISOString()).toBe(before.toISOString());

      const allowed = await (await withIt.api()).patch(`/api/customers/${customer}`, { created_at: backdated });
      expect(allowed.status).toBe(200);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).created_at.toISOString().slice(0, 10)).toBe(backdated);
    });
  });

  describe('the built-in presets, as the catalog states them', () => {
    it('lets Sales open the customers of their own leads and jobs, and Technician open no customer page', async () => {
      const { org } = await fx.newOrg();
      const seller = await fx.addUser(org, 'sam', 'SALES');
      const technician = await fx.addUser(org, 'tom', 'TECHNICIAN');
      const [sellersCustomer, others, techsCustomer] = await Promise.all([addCustomer(org), addCustomer(org), addCustomer(org)]);
      await fx.addLead(org, sellersCustomer, { assignees: [seller.id] });
      await fx.addLead(org, others, {});
      await fx.addJob(org, techsCustomer, { crew: [technician.id] });

      const asSales = await fx.signedInAs(seller);
      const listed = await listedCustomers(asSales);
      expect(listed).toContain(sellersCustomer);
      expect(listed).not.toContain(others);
      expect(await opens(asSales, others)).toBe(false);

      const asTechnician = await fx.signedInAs(technician);
      expect((await asTechnician.get(`/api/customers/${techsCustomer}`)).status).toBe(403);
    });

    it('lets Dispatcher open and edit every customer (Create customers needs Edit), but not export the list', async () => {
      const { org, customer } = await fx.newOrg();
      const dispatcher = await fx.addUser(org, 'dee', 'DISPATCHER');
      const api = await fx.signedInAs(dispatcher);

      expect(await opens(api, customer)).toBe(true);
      expect((await api.patch(`/api/customers/${customer}`, { first_name: 'Changed' })).status).toBe(200);
      expect((await api.get('/api/customers/export')).status).toBe(403);
    });
  });

  describe('the catalog read', () => {
    it('serves the Customers and Service Plans rows with their presets, and every built-in preset passes validation', async () => {
      const { org } = await fx.newOrg();
      const technician = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await (await fx.signedInAs(technician)).get('/api/permission-switches/catalog');

      expect(res.status).toBe(200);
      const byKey = Object.fromEntries((res.body.switches as { key: string }[]).map((s) => [s.key, s])) as Record<string, Record<string, unknown>>;
      for (const s of SWITCH_CATALOG.filter((x) => ['Customers', 'Service Plans'].includes(x.module))) {
        expect(byKey[s.key], s.key).toMatchObject({ label: s.label, presets: s.presets });
      }
      for (const role of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const) {
        expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
      }
    });
  });

  describe('the route-level enforcement table', () => {
    // One request per server check. With the switch on the request is let in (anything but a refusal); with
    // it off it is refused (a customer detail or list answers with no row, the others with a 403).
    type Probe = {
      switchKey: string; check: string; isList?: boolean;
      run: (api: Api, org: string, me: Person) => Promise<{ status: number; body?: unknown }>;
      /** A check that leaves the rest of the edit alone and drops only its own field answers 200 with `applied` false. */
      leavesFieldAlone?: boolean;
    };
    const aCustomer = (org: string, me: Person) => addCustomer(org, { createdBy: me.id });
    const probes: Probe[] = [
      { switchKey: 'view_customers', check: 'customer-list', isList: true, run: (api) => api.get('/api/customers') },
      { switchKey: 'view_customers', check: 'customer-detail', run: async (api, org, me) => api.get(`/api/customers/${await aCustomer(org, me)}`) },
      { switchKey: 'create_customers', check: 'customer-create', run: (api) => api.post('/api/customers', { first_name: 'Row', email: `row-${randomUUID().slice(0, 6)}@example.test` }) },
      { switchKey: 'edit_customers', check: 'customer-update', run: async (api, org, me) => api.patch(`/api/customers/${await aCustomer(org, me)}`, { first_name: 'Row' }) },
      { switchKey: 'delete_customers', check: 'customer-delete', run: async (api, org, me) => api.delete(`/api/customers/${await aCustomer(org, me)}`) },
      { switchKey: 'export_customers', check: 'customer-export', run: (api) => api.get('/api/customers/export') },
      { switchKey: 'archive_customers', check: 'customer-archive', run: async (api, org, me) => api.post(`/api/customers/${await aCustomer(org, me)}/archive`, {}) },
      { switchKey: 'change_customer_created_date', check: 'customer-created-date', leavesFieldAlone: true, run: async (api, org, me) => {
          const id = await aCustomer(org, me);
          const res = await api.patch(`/api/customers/${id}`, { created_at: '2019-02-03' });
          const row = await db.customer.findUniqueOrThrow({ where: { id } });
          return { status: res.status, body: { applied: row.created_at.toISOString().slice(0, 10) === '2019-02-03' } };
        } },
      { switchKey: 'edit_customer_record_ids', check: 'customer-renumber', run: async (api, org, me) => api.post(`/api/customers/${await aCustomer(org, me)}/number/preview`, { customer_number: 'C-9999' }) },
      { switchKey: 'view_service_plans', check: 'service-plan-read', isList: true, run: (api) => api.get('/api/service-plans') },
      { switchKey: 'create_service_plans', check: 'service-plan-create', run: (api) => api.post('/api/service-plans', {}) },
      { switchKey: 'create_service_plans', check: 'service-plan-customer-create', run: (api) => api.post('/api/service-plans/customers', { first_name: 'Row', email: `plan-${randomUUID().slice(0, 6)}@example.test` }) },
      { switchKey: 'edit_service_plans', check: 'service-plan-update', run: (api) => api.post(`/api/service-plans/${randomUUID()}/activate`, {}) },
      { switchKey: 'delete_service_plans', check: 'service-plan-delete', run: (api) => api.delete(`/api/service-plans/${randomUUID()}`) },
    ];
    // The Service Plans rows are checked by the plan routes; Customers rows by the customer routes.
    const mine = (s: { module: string }) => ['Customers', 'Service Plans'].includes(s.module);

    it('has a row for every server check the catalog lists for a Customers or Service Plans switch, and no switch is left unaccounted for', () => {
      const listed = SWITCH_CATALOG.filter(mine).flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual([...listed].sort());
      for (const s of SWITCH_CATALOG.filter(mine)) expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
      const pending = SWITCH_CATALOG.filter((s) => mine(s) && s.serverChecks.length === 0);
      expect(pending.map((s) => s.key).sort()).toEqual(['copy_customer_email', 'copy_customer_phone']);
      for (const s of pending) expect(s.pending, s.key).toMatch(/PRD \d+|Display only/);
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org } = await fx.newOrg();
      const me = await personWith(org, allScopes, { base: 'ADMIN', name: 'table' });
      const api = await me.api();
      const roleSwitches = async (values: Record<string, boolean>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(findSwitch(probe.switchKey)!.serverChecks, probe.check).toContain(probe.check);
        // Everything that needs the switch, directly or through another switch that does.
        const dependants: string[] = [];
        for (let grew = true; grew;) {
          const before = dependants.length;
          for (const s of SWITCH_CATALOG) {
            if (!dependants.includes(s.key) && s.requires.some((r) => r === probe.switchKey || dependants.includes(r))) dependants.push(s.key);
          }
          grew = dependants.length > before;
        }

        await roleSwitches({ [probe.switchKey]: true });
        if (probe.check === 'customer-list') await aCustomer(org, me);
        const letIn = await probe.run(api, org, me);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);
        expect(letIn.status, `${probe.check} with the switch on`).toBeLessThan(500);
        if (probe.leavesFieldAlone) expect((letIn.body as { applied: boolean }).applied, `${probe.check} with the switch on`).toBe(true);

        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, false])), [probe.switchKey]: false });
        const refused = await probe.run(api, org, me);
        if (probe.leavesFieldAlone) {
          expect(refused.status, `${probe.check} with the switch off`).toBe(200);
          expect((refused.body as { applied: boolean }).applied, `${probe.check} with the switch off`).toBe(false);
        } else if (probe.check === 'customer-detail') expect([403, 404], probe.check).toContain(refused.status);
        else expect(refused.status, `${probe.check} with the switch off`).toBe(403);

        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, true])), [probe.switchKey]: true });
      }
    });
  });
});

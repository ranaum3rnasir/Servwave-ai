/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.6 - top search returns exactly what the person can open.

   Top search asks the resolver in every module: the rows the module's View scope reaches plus the rows
   the creator rule reaches, and nothing the person cannot open. Customers are left out when View
   customers is off.

   Everything goes through the public interface: GET /api/search, called as people on custom roles (never
   a built-in role name) whose switch values are the cases under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('top search returns exactly what the person can open (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

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
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);
  const CUSTOMERS_VIEW_OFF = withDependantsOff(['view_customers']);

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `search-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `s${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A customer every search below finds by the one word in `lastName`. */
  async function addCustomer(org: string, lastName: string, opts: { createdBy?: string } = {}) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Search', last_name: lastName, created_by_id: opts.createdBy ?? null,
        service_locations: { create: { address_line1: '9 Search Road', city: 'Testville', state: 'MA', zip: '02108', is_primary: true } },
      },
    });
    return id;
  }

  const word = () => `Zebrafish${++sequence}x${randomUUID().slice(0, 6)}`;

  /** What top search returns for the word, as ids per module. */
  async function found(api: Api, q: string) {
    const res = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    const ids = (key: string) => (res.body.results[key] as { id: string }[]).map((r) => r.id).sort();
    return {
      jobs: ids('jobs'), leads: ids('leads'), estimates: ids('estimates'), invoices: ids('invoices'), customers: ids('customers'),
    };
  }

  it('with Invoices View off, returns an invoice the person created on a job they are still on, and drops it once they are taken off the job', async () => {
    const { org } = await fx.newOrg();
    const q = word();
    const customer = await addCustomer(org, q);
    const me = await personWith(org, { ...INVOICES_VIEW_OFF, invoices_scope: 'attached', jobs_scope: 'attached' });
    const api = await me.api();
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const mine = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id });
    const colleagues = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: (await fx.addUser(org, `peer${++sequence}`, 'SALES')).id });

    const before = await found(api, q);
    expect(before.invoices).toEqual([mine.id]);
    expect(before.invoices).not.toContain(colleagues.id);
    expect(before.jobs).toEqual([job.id]);

    await fx.removeCrew(job.visitId!, me.id);

    const after = await found(api, q);
    expect(after.invoices).toEqual([]);
    expect(after.jobs).toEqual([]);
  });

  it('with View off, finds by the customer\'s name an estimate and an invoice the person created for a customer alone, and not a colleague\'s', async () => {
    const { org } = await fx.newOrg();
    const q = word();
    const customer = await addCustomer(org, q);
    const me = await personWith(org, { ...INVOICES_VIEW_OFF, ...ESTIMATES_VIEW_OFF });
    const api = await me.api();
    const colleague = await fx.addUser(org, `peer${++sequence}`, 'SALES');
    const mineInvoice = await fx.addInvoice(org, customer, { createdBy: me.id });
    const mineEstimate = await fx.addEstimate(org, customer, me.id);
    await fx.addInvoice(org, customer, { createdBy: colleague.id });
    await fx.addEstimate(org, customer, colleague.id);

    const result = await found(api, q);
    expect(result.invoices).toEqual([mineInvoice.id]);
    expect(result.estimates).toEqual([mineEstimate.id]);
    // A two-word search ("first last") finds them the same way.
    const twoWords = await found(api, `Search ${q}`);
    expect(twoWords.invoices).toEqual([mineInvoice.id]);
    expect(twoWords.estimates).toEqual([mineEstimate.id]);
  });

  it('with Customers View off, returns no customers while the jobs and leads the person can open still appear', async () => {
    const { org } = await fx.newOrg();
    const q = word();
    const customer = await addCustomer(org, q);
    const me = await personWith(org, { ...CUSTOMERS_VIEW_OFF, jobs_scope: 'all', leads_scope: 'all' });
    const api = await me.api();
    const job = await fx.addJob(org, customer, { crew: [] });
    const lead = await fx.addLead(org, customer, {});

    const result = await found(api, q);
    expect(result.customers).toEqual([]);
    expect(result.jobs).toEqual([job.id]);
    expect(result.leads).toEqual([lead.id]);
  });

  it('with Customers View on, returns the customers the person reaches', async () => {
    const { org } = await fx.newOrg();
    const q = word();
    const customer = await addCustomer(org, q);
    const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });

    expect((await found(await me.api(), q)).customers).toEqual([customer]);
  });

  it('never returns a job, lead, estimate or invoice the person cannot open', async () => {
    const { org, admin } = await fx.newOrg();
    const q = word();
    const customer = await addCustomer(org, q);
    const me = await personWith(org, {
      leads_scope: 'attached', jobs_scope: 'attached', estimates_scope: 'attached', invoices_scope: 'attached',
    });
    const api = await me.api();

    const myLead = await fx.addLead(org, customer, { assignees: [me.id] });
    const myJob = await fx.addJob(org, customer, { crew: [me.id] });
    const myEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: myJob.id });
    const myInvoice = await fx.addInvoice(org, customer, { jobId: myJob.id });

    const othersLead = await fx.addLead(org, customer, {});
    const othersJob = await fx.addJob(org, customer, { crew: [] });
    const othersEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: othersJob.id });
    const othersInvoice = await fx.addInvoice(org, customer, { jobId: othersJob.id });

    const result = await found(api, q);
    expect(result.leads).toEqual([myLead.id]);
    expect(result.jobs).toEqual([myJob.id]);
    expect(result.estimates).toEqual([myEstimate.id]);
    expect(result.invoices).toEqual([myInvoice.id]);
    for (const hidden of [othersLead.id, othersJob.id, othersEstimate.id, othersInvoice.id]) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });
});

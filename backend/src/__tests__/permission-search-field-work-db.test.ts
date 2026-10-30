/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.7 - top search answers from the access resolver, for field work.

   The server rule itself is S01.6's (permission-search-db.test.ts). This suite is the field worker's proof of
   it: a person holding the Technician preset's switch values finds the work they are attached to by name,
   number or address; an invoice they created on a job they are still on; no customer; no service plan and no
   calendar entry; and loses the job and the invoice the moment they are taken off the job. A person with
   company-wide scope is unchanged.

   Everything goes through the public interface: GET /api/search, called as people on custom roles built from
   the catalog's preset column. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed again.
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
import { presetSwitchSet } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('top search for field work (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const planIds: string[] = [];
  const entryIds: string[] = [];
  afterAll(async () => {
    // Service plans restrict their customer's removal, so they go before the orgs do.
    await db.calendarEntry.deleteMany({ where: { id: { in: entryIds } } }).catch(() => undefined);
    await db.servicePlan.deleteMany({ where: { id: { in: planIds } } }).catch(() => undefined);
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role copied from a built-in preset, with these switches changed. */
  async function personFrom(
    org: string,
    preset: 'TECHNICIAN' | 'DISPATCHER',
    overrides: Record<string, boolean | string> = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `field-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, preset);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...presetSwitchSet(preset), ...overrides }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `f${sequence}`, preset, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** Create invoices turned on for the person's role, the way the Roles screen grants it. */
  async function allowCreatingInvoices(org: string, person: Person) {
    const user = await db.user.findUniqueOrThrow({ where: { id: person.id }, select: { custom_role: { select: { key: true } } } });
    const role = user.custom_role!.key;
    const has = await db.rolePermission.findFirst({ where: { organization_id: org, role, action: 'create', subject: 'Invoice' } });
    if (!has) await db.rolePermission.create({ data: { organization_id: org, role, action: 'create', subject: 'Invoice' } });
  }

  const word = () => `Quokka${++sequence}x${randomUUID().slice(0, 6)}`;

  async function addCustomer(org: string, lastName: string) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Field', last_name: lastName,
        service_locations: { create: { address_line1: '9 Search Road', city: 'Testville', state: 'MA', zip: '02108', is_primary: true } },
      },
    });
    return id;
  }

  /** Give a job's service location a street nobody else has. */
  async function moveJobTo(jobId: string, street: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { service_location_id: true } });
    await db.serviceLocation.update({ where: { id: job.service_location_id! }, data: { address_line1: street } });
  }

  /** What top search returns for the query, as ids per group. */
  async function found(api: Api, q: string) {
    const res = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    const ids = (key: string) => (res.body.results[key] as { id: string }[]).map((r) => r.id).sort();
    return {
      jobs: ids('jobs'), leads: ids('leads'), estimates: ids('estimates'), invoices: ids('invoices'),
      customers: ids('customers'), servicePlans: ids('servicePlans'), calendarEntries: ids('calendarEntries'),
    };
  }

  /** An org with the Technician preset's person attached to a lead and a job (and an estimate on each), and a stranger's of each. */
  async function fieldWork() {
    const { org, admin } = await fx.newOrg();
    const name = word();
    const customer = await addCustomer(org, name);
    const me = await personFrom(org, 'TECHNICIAN');
    const mine = {
      lead: (await fx.addLead(org, customer, { assignees: [me.id] })).id,
      job: (await fx.addJob(org, customer, { crew: [me.id] })).id,
    };
    const mineEstimateOnJob = (await fx.addEstimate(org, customer, admin.id, { jobId: mine.job })).id;
    const mineEstimateOnLead = (await fx.addEstimate(org, customer, admin.id, { leadId: mine.lead })).id;
    const others = {
      lead: (await fx.addLead(org, customer, {})).id,
      job: (await fx.addJob(org, customer, { crew: [(await fx.addUser(org, `mate${++sequence}`, 'TECHNICIAN')).id] })).id,
    };
    const othersEstimateOnJob = (await fx.addEstimate(org, customer, admin.id, { jobId: others.job })).id;
    const othersEstimateOnLead = (await fx.addEstimate(org, customer, admin.id, { leadId: others.lead })).id;
    return {
      org, admin, name, customer, me, mine, others,
      mineEstimateOnJob, mineEstimateOnLead,
      mineEstimates: [mineEstimateOnJob, mineEstimateOnLead].sort(),
      othersEstimates: [othersEstimateOnJob, othersEstimateOnLead],
    };
  }

  it('finds the leads, jobs and estimates the Technician preset is attached to by the customer\'s name, and none of the others', async () => {
    const w = await fieldWork();
    const result = await found(await w.me.api(), w.name);

    expect(result.jobs).toEqual([w.mine.job]);
    expect(result.leads).toEqual([w.mine.lead]);
    expect(result.estimates).toEqual(w.mineEstimates);
    for (const hidden of [w.others.job, w.others.lead, ...w.othersEstimates]) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it('finds them by number', async () => {
    const w = await fieldWork();
    const api = await w.me.api();
    const numberOf = async () => ({
      job: (await db.job.findUniqueOrThrow({ where: { id: w.mine.job }, select: { job_number: true } })).job_number,
      lead: (await db.lead.findUniqueOrThrow({ where: { id: w.mine.lead }, select: { lead_number: true } })).lead_number,
      estimate: (await db.estimate.findUniqueOrThrow({ where: { id: w.mineEstimates[0]! }, select: { estimate_number: true } })).estimate_number,
    });
    const n = await numberOf();

    expect((await found(api, n.job)).jobs).toEqual([w.mine.job]);
    expect((await found(api, n.lead)).leads).toEqual([w.mine.lead]);
    expect((await found(api, n.estimate)).estimates).toEqual([w.mineEstimates[0]]);
    // A number that belongs to someone else's record finds nothing.
    const otherJob = await db.job.findUniqueOrThrow({ where: { id: w.others.job }, select: { job_number: true } });
    expect((await found(api, otherJob.job_number)).jobs).toEqual([]);
  });

  it('finds the job and the lead by their address, and not the same street on someone else\'s', async () => {
    const w = await fieldWork();
    const street = `${word()} Meadow Lane`;
    await moveJobTo(w.mine.job, street);
    await moveJobTo(w.others.job, street);
    await db.lead.update({ where: { id: w.mine.lead }, data: { service_address_line1: street, service_city: 'Testville' } });
    await db.lead.update({ where: { id: w.others.lead }, data: { service_address_line1: street, service_city: 'Testville' } });

    const result = await found(await w.me.api(), street);
    expect(result.jobs).toEqual([w.mine.job]);
    expect(result.leads).toEqual([w.mine.lead]);
  });

  it('finds an invoice they created on their job once Create invoices is on, and not another person\'s invoice on the same job', async () => {
    const w = await fieldWork();
    await allowCreatingInvoices(w.org, w.me);
    const mine = await fx.addInvoice(w.org, w.customer, { jobId: w.mine.job, createdBy: w.me.id });
    const colleagues = await fx.addInvoice(w.org, w.customer, { jobId: w.mine.job, createdBy: w.admin.id });
    const onOthersJob = await fx.addInvoice(w.org, w.customer, { jobId: w.others.job, createdBy: w.me.id });

    const result = await found(await w.me.api(), w.name);
    expect(result.invoices).toEqual([mine.id]);
    expect(JSON.stringify(result)).not.toContain(colleagues.id);
    // Made by them, but on a job they are not on: the creator rule needs the attachment.
    expect(JSON.stringify(result)).not.toContain(onOthersJob.id);
  });

  it('returns no customer group with View customers off', async () => {
    const w = await fieldWork();
    const result = await found(await w.me.api(), w.name);

    expect(result.customers).toEqual([]);
    // The same word does find the customer for a person who may view customers.
    const office = await personFrom(w.org, 'DISPATCHER');
    expect((await found(await office.api(), w.name)).customers).toEqual([w.customer]);
  });

  it('never returns a service plan or a calendar entry, even to someone who may read both', async () => {
    const w = await fieldWork();
    const location = (await db.serviceLocation.findFirstOrThrow({ where: { customer_id: w.customer } })).id;
    const plan = await db.servicePlan.create({
      data: {
        organization_id: w.org, customer_id: w.customer, service_location_id: location, service_plan_number: `SP-${randomUUID().slice(0, 8)}`,
        name: `${w.name} yearly care`, status: 'ACTIVE', visit_cadence: 'MONTHLY', start_date: new Date(Date.now() - 86_400_000), contract_price: 100,
      },
    });
    planIds.push(plan.id);
    const entry = await db.calendarEntry.create({
      data: {
        organization_id: w.org, title: `${w.name} supplier meeting`, start: new Date(Date.now() + 86_400_000),
        end: new Date(Date.now() + 90_000_000), created_by: w.admin.id,
      },
    });
    entryIds.push(entry.id);
    // The technician is a participant, so the Schedule's search would find it for them; top search still does not.
    await db.calendarEntryParticipant.create({ data: { calendar_entry_id: entry.id, user_id: w.me.id, organization_id: w.org, kind: 'USER' } });

    const office = await personFrom(w.org, 'DISPATCHER', { jobs_scope: 'all', leads_scope: 'all' });
    for (const person of [w.me, office]) {
      const result = await found(await person.api(), w.name);
      expect(result.servicePlans).toEqual([]);
      expect(result.calendarEntries).toEqual([]);
    }
    // They are reachable where they belong: the Schedule's own search.
    const onSchedule = await (await office.api()).get(`/api/search?q=${encodeURIComponent(w.name)}&scope=schedule`);
    const scheduleIds = [...onSchedule.body.results.servicePlans, ...onSchedule.body.results.calendarEntries].map((r: { id: string }) => r.id);
    expect(scheduleIds).toEqual(expect.arrayContaining([plan.id, entry.id]));
  });

  it('drops the job and their invoice on it on the very next request after they are taken off the job', async () => {
    const w = await fieldWork();
    await allowCreatingInvoices(w.org, w.me);
    const api = await w.me.api();
    const mine = await fx.addInvoice(w.org, w.customer, { jobId: w.mine.job, createdBy: w.me.id });
    const visitId = (await db.visit.findFirstOrThrow({ where: { job_id: w.mine.job }, select: { id: true } })).id;

    const before = await found(api, w.name);
    expect(before.jobs).toEqual([w.mine.job]);
    expect(before.invoices).toEqual([mine.id]);
    expect(before.estimates).toEqual(w.mineEstimates);

    await fx.removeCrew(visitId, w.me.id);

    const after = await found(api, w.name);
    expect(after.jobs).toEqual([]);
    expect(after.invoices).toEqual([]);
    // The estimate on that job goes with it; the one on the lead they are still assigned to stays.
    expect(after.estimates).toEqual([w.mineEstimateOnLead]);
    expect(after.leads).toEqual([w.mine.lead]);
  });

  it('gives a person with company-wide scope every job, lead, estimate and customer, as before', async () => {
    const w = await fieldWork();
    const office = await personFrom(w.org, 'DISPATCHER', { jobs_scope: 'all', leads_scope: 'all', estimates_scope: 'all', invoices_scope: 'all' });
    const result = await found(await office.api(), w.name);

    expect(result.jobs).toEqual([w.mine.job, w.others.job].sort());
    expect(result.leads).toEqual([w.mine.lead, w.others.lead].sort());
    expect(result.estimates).toEqual([...w.mineEstimates, ...w.othersEstimates].sort());
    expect(result.customers).toEqual([w.customer]);
  });
});

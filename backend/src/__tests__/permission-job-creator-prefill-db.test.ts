/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.16 - the creator pre-fill on the new-job form, on a duplicated job
   and on a job made from a call or from a customer-only estimate.

   The one creator rule (S03.15) says where a creator lands on what they make: Can own leads / be Sold By on
   gives Sold By; off with Can be a dispatcher on gives Dispatcher; both off gives Sold By; both on (the Admin
   preset) gives Sold By, never Dispatcher. The new-job form shows that result and the create route applies it
   for anyone without Assign people to jobs, so what the form shows is what is saved. A holder of the switch
   saves what they submit (each newly named person through slot eligibility). Duplicate job has no form and
   gives the rule's result as a person without the switch would get, copying nothing from the source's people.

   Every case uses people on custom roles whose base role and slot switch disagree (a Dispatcher base with Can
   own leads on, a Technician base with it off), so no role-name or base-role check can pass. Everything goes
   through the job routes. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Role } from '@prisma/client';

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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

const NOT_OWNER = "This person can't own leads or be Sold By.";
const NOT_DISPATCHER = "This person can't be a dispatcher.";

suite('the creator pre-fill on a new job (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;
  let phoneSequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `job-prefill-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, create_jobs: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A service location on the customer, so a standalone create can name it. */
  async function locationOf(customer: string): Promise<string> {
    const id = randomUUID();
    await db.serviceLocation.create({
      data: { id, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108', is_primary: true },
    });
    return id;
  }

  const newJob = (customer: string, location: string, extra: object = {}) => ({
    customer_id: customer, service_location_id: location, scope_notes: 'Fix the door', ...extra,
  });

  /** The people of a job as stored. */
  async function peopleOf(jobId: string) {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { salesperson_id: true, dispatcher_id: true } });
    return { soldBy: job.salesperson_id, dispatcher: job.dispatcher_id };
  }

  async function peopleEvents(jobId: string) {
    const rows = await db.timelineEvent.findMany({
      where: { entity_type: 'JOB', entity_id: jobId, event_type: { in: ['SOLD_BY_CHANGED', 'DISPATCHER_CHANGED'] } },
      orderBy: { created_at: 'asc' },
      select: { event_type: true, description: true, metadata: true },
    });
    return rows;
  }

  describe('the rule', () => {
    // [switches, base role, where the creator lands]
    const cases: Array<[string, Record<string, boolean>, Role, 'soldBy' | 'dispatcher']> = [
      ['Can own leads on, on a Dispatcher base', { can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER', 'soldBy'],
      ['Can own leads off and Can be a dispatcher on, on a Technician base', { can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN', 'dispatcher'],
      ['both off, on a Dispatcher base', { can_own_leads: false, can_be_dispatcher: false }, 'DISPATCHER', 'soldBy'],
      ['both off, on a Technician base', { can_own_leads: false, can_be_dispatcher: false }, 'TECHNICIAN', 'soldBy'],
      ['both on (the Admin preset), on a Technician base', { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN', 'soldBy'],
    ];

    it.each(cases)('gives the answer for %s, through the form pre-fill route', async (_label, values, base, expected) => {
      const { org } = await fx.newOrg();
      const creator = await personWith(org, values, base);
      const res = await (await creator.api()).get('/api/jobs/creator-prefill');
      expect(res.status).toBe(200);
      expect(res.body.prefill).toEqual({
        sold_by_id: expected === 'soldBy' ? creator.id : null,
        dispatcher_id: expected === 'dispatcher' ? creator.id : null,
      });
    });

    it('is the built-in Admin box for an Admin: Sold By, never Dispatcher', async () => {
      const { admin } = await fx.newOrg();
      const res = await (await fx.signedInAs(admin)).get('/api/jobs/creator-prefill');
      expect(res.status).toBe(200);
      expect(res.body.prefill).toEqual({ sold_by_id: admin.id, dispatcher_id: null });
    });

    it('is refused to a person who cannot create jobs', async () => {
      const { org } = await fx.newOrg();
      const cannot = await personWith(org, { create_jobs: false }, 'SALES');
      expect((await (await cannot.api()).get('/api/jobs/creator-prefill')).status).toBe(403);
    });
  });

  describe('without Assign people to jobs', () => {
    it('saves the rule\'s result whatever people the request names, on an existing and on a new customer', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const named = await personWith(org, { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN');
      const asSoldBy = await personWith(org, { assign_people_to_jobs: false, can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER');
      const asDispatcher = await personWith(org, { assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN');
      const asNeither = await personWith(org, { assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: false }, 'DISPATCHER');
      const asBoth = await personWith(org, { assign_people_to_jobs: false, can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN');

      const expectations: Array<[string, typeof asSoldBy, 'soldBy' | 'dispatcher']> = [
        ['Sold By', asSoldBy, 'soldBy'], ['Dispatcher', asDispatcher, 'dispatcher'], ['neither switch', asNeither, 'soldBy'], ['both switches', asBoth, 'soldBy'],
      ];
      for (const [label, creator, slot] of expectations) {
        const api = await creator.api();
        const people = { sold_by_id: named.id, dispatcher_id: named.id };
        const existing = await api.post('/api/jobs', newJob(customer, location, people));
        expect(existing.status, `${label}, existing customer: ${JSON.stringify(existing.body)}`).toBe(201);
        const viaNew = await api.post('/api/jobs', {
          new_customer: {
            first_name: 'New', last_name: `Person${creator.id.slice(0, 4)}`, phone: `617555${String(++phoneSequence).padStart(4, '0')}`,
            location: { address_line1: '2 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
          },
          scope_notes: 'Fix the door', ...people,
        });
        expect(viaNew.status, `${label}, new customer: ${JSON.stringify(viaNew.body)}`).toBe(201);

        for (const res of [existing, viaNew]) {
          expect(await peopleOf(res.body.job.id), label).toEqual({
            soldBy: slot === 'soldBy' ? creator.id : null,
            dispatcher: slot === 'dispatcher' ? creator.id : null,
          });
        }
      }
    });

    it('writes "set to the creator at creation" on the new job\'s history, one event for the slot filled', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await personWith(org, { assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN');
      const res = await (await creator.api()).post('/api/jobs', newJob(customer, location));
      expect(res.status).toBe(201);
      const events = await peopleEvents(res.body.job.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('DISPATCHER_CHANGED');
      expect(events[0]!.description).toContain('set to the creator at creation');
    });

    it('lets a creator with Attached scope open the job they just made, whichever slot the rule gave them', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creators = [
        await personWith(org, { jobs_scope: 'attached', assign_people_to_jobs: false, can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER'),
        await personWith(org, { jobs_scope: 'attached', assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN'),
        await personWith(org, { jobs_scope: 'attached', assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: false }, 'TECHNICIAN'),
      ];
      for (const creator of creators) {
        const api = await creator.api();
        const res = await api.post('/api/jobs', newJob(customer, location));
        expect(res.status).toBe(201);
        expect(res.body.job_openable).toBe(true);
        expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).toBe(200);
      }
    });

    it('treats a role copied from the Dispatcher preset as the preset: Dispatcher, Sold By empty', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      // The Dispatcher preset: Can be a dispatcher on, Can own leads / be Sold By off, no Assign people to jobs change needed.
      const copy = await personWith(org, { assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: true }, 'DISPATCHER');
      const res = await (await copy.api()).post('/api/jobs', newJob(customer, location));
      expect(res.status).toBe(201);
      expect(await peopleOf(res.body.job.id)).toEqual({ soldBy: null, dispatcher: copy.id });
    });
  });

  describe('with Assign people to jobs', () => {
    it('saves what was submitted: kept, changed or cleared, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const seller = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'SALES');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, { assign_people_to_jobs: true, can_own_leads: true, can_be_dispatcher: false }, base);
        const api = await holder.api();

        // Kept: the pre-fill, as the form holds it.
        const prefill = (await api.get('/api/jobs/creator-prefill')).body.prefill;
        const kept = await api.post('/api/jobs', newJob(customer, location, prefill));
        expect(kept.status, `${base}, kept`).toBe(201);
        expect(await peopleOf(kept.body.job.id), `${base}, kept`).toEqual({ soldBy: holder.id, dispatcher: null });
        expect((await peopleEvents(kept.body.job.id))[0]!.description).toContain('set to the creator at creation');

        // Changed: other people in both fields.
        const changed = await api.post('/api/jobs', newJob(customer, location, { sold_by_id: seller.id, dispatcher_id: dispatcher.id }));
        expect(changed.status, `${base}, changed`).toBe(201);
        expect(await peopleOf(changed.body.job.id), `${base}, changed`).toEqual({ soldBy: seller.id, dispatcher: dispatcher.id });
        expect((await peopleEvents(changed.body.job.id)).map((e) => e.description).join('|'), `${base}, changed`).toContain('picked at creation');

        // Cleared: both fields emptied on purpose; the job is accepted with no warning.
        const cleared = await api.post('/api/jobs', newJob(customer, location, { sold_by_id: null, dispatcher_id: null }));
        expect(cleared.status, `${base}, cleared`).toBe(201);
        expect(await peopleOf(cleared.body.job.id), `${base}, cleared`).toEqual({ soldBy: null, dispatcher: null });
        expect(await peopleEvents(cleared.body.job.id)).toEqual([]);
      }
    });

    it('refuses a Sold By who cannot be Sold By and a Dispatcher who cannot be a dispatcher, and saves no job', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const holder = await personWith(org, { assign_people_to_jobs: true, can_own_leads: true }, 'SALES');
      // Base roles that would pass a role-name check, switches that say no.
      const cannotOwn = await personWith(org, { can_own_leads: false }, 'SALES');
      const cannotDispatch = await personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');
      const api = await holder.api();
      const before = await db.job.count({ where: { customer_id: customer } });

      const owner = await api.post('/api/jobs', newJob(customer, location, { sold_by_id: cannotOwn.id }));
      expect(owner.status).toBe(400);
      expect(owner.body.error).toBe(NOT_OWNER);
      const dispatch = await api.post('/api/jobs', newJob(customer, location, { dispatcher_id: cannotDispatch.id }));
      expect(dispatch.status).toBe(400);
      expect(dispatch.body.error).toBe(NOT_DISPATCHER);

      expect(await db.job.count({ where: { customer_id: customer } })).toBe(before);
    });

    it('tells a holder who handed the job to others that they cannot open it, so the page can stay on the list', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const seller = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const holder = await personWith(org, { jobs_scope: 'attached', assign_people_to_jobs: true, can_own_leads: true }, 'TECHNICIAN');
      const api = await holder.api();
      const res = await api.post('/api/jobs', newJob(customer, location, { sold_by_id: seller.id, dispatcher_id: null }));
      expect(res.status).toBe(201);
      expect(res.body.job_openable).toBe(false);
      expect(res.body.job.id).toBeTruthy();
      expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).not.toBe(200);
    });
  });

  describe('a job made from a customer-only estimate', () => {
    async function customerOnlyEstimate(org: string, customer: string, adminId: string, location: string) {
      const estimate = await fx.addEstimate(org, customer, adminId);
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON', service_location_id: location } });
      return estimate.id;
    }

    it('gets the same people as a standalone create by the same user, and the same history', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const location = await locationOf(customer);
      const named = await personWith(org, { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN');
      const creators = [
        await personWith(org, { assign_people_to_jobs: false, can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER'),
        await personWith(org, { assign_people_to_jobs: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN'),
        await personWith(org, { assign_people_to_jobs: true, can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN'),
      ];
      for (const creator of creators) {
        const api = await creator.api();
        const standalone = await api.post('/api/jobs', newJob(customer, location));
        const fromEstimate = await api.post('/api/jobs', {
          estimate_id: await customerOnlyEstimate(org, customer, admin.id, location),
          service_location_id: location,
          sold_by_id: named.id, dispatcher_id: named.id, // a person without the switch has these ignored
        });
        expect(fromEstimate.status, JSON.stringify(fromEstimate.body)).toBe(201);
        const expected = await peopleOf(standalone.body.job.id);
        // A holder who sends people on this door is saved what they sent; the cases above cover that, here only the rule.
        if (creator === creators[2]) {
          expect(await peopleOf(fromEstimate.body.job.id)).toEqual({ soldBy: named.id, dispatcher: named.id });
        } else {
          expect(await peopleOf(fromEstimate.body.job.id)).toEqual(expected);
          expect((await peopleEvents(fromEstimate.body.job.id))[0]!.description).toContain('set to the creator at creation');
        }
      }
    });
  });

  describe('Duplicate job', () => {
    it('gives the rule\'s result, copies nothing from the source job\'s people, and writes the history line', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const location = await locationOf(customer);
      const seller = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'SALES');
      const source = await (await fx.signedInAs(admin)).post('/api/jobs', newJob(customer, location, { sold_by_id: seller.id, dispatcher_id: dispatcher.id }));
      expect(source.status).toBe(201);
      expect(await peopleOf(source.body.job.id)).toEqual({ soldBy: seller.id, dispatcher: dispatcher.id });

      const cases: Array<[string, Record<string, boolean>, Role, 'soldBy' | 'dispatcher']> = [
        ['Sold By by Can own leads', { can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER', 'soldBy'],
        ['Dispatcher by Can be a dispatcher alone', { can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN', 'dispatcher'],
        ['Sold By with both off', { can_own_leads: false, can_be_dispatcher: false }, 'TECHNICIAN', 'soldBy'],
        ['Sold By with both on', { can_own_leads: true, can_be_dispatcher: true }, 'SALES', 'soldBy'],
      ];
      for (const [label, values, base, slot] of cases) {
        // Holding Assign people to jobs changes nothing: there is no form to pick on.
        const creator = await personWith(org, { duplicate_jobs: true, assign_people_to_jobs: true, ...values }, base);
        const res = await (await creator.api()).post(`/api/jobs/${source.body.job.id}/duplicate`);
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(await peopleOf(res.body.job.id), label).toEqual({
          soldBy: slot === 'soldBy' ? creator.id : null,
          dispatcher: slot === 'dispatcher' ? creator.id : null,
        });
        const events = await peopleEvents(res.body.job.id);
        expect(events, label).toHaveLength(1);
        expect(events[0]!.description, label).toContain('set to the creator at creation');
      }
    });

    it('lands a duplicator with Attached scope on the new job, which they can open', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await personWith(org, { jobs_scope: 'attached', duplicate_jobs: true, can_own_leads: false, can_be_dispatcher: false }, 'TECHNICIAN');
      // The source job is one the duplicator is attached to (the Sold By is set directly: their own switch is off).
      const source = await (await fx.signedInAs(admin)).post('/api/jobs', newJob(customer, location));
      expect(source.status).toBe(201);
      await db.job.update({ where: { id: source.body.job.id }, data: { salesperson_id: creator.id } });
      const api = await creator.api();
      const res = await api.post(`/api/jobs/${source.body.job.id}/duplicate`);
      expect(res.status).toBe(201);
      expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).toBe(200);
    });
  });
});

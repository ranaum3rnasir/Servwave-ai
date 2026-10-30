/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.17 - book visit 1 with myself at job creation.

   The job create request may book visit 1 (the time it already carries) and put the creator on its crew.
   Booking at creation needs only Create jobs (not Schedule visits); putting oneself on it needs only Can be on a
   crew (not Assign people to jobs). Naming anyone else on visit 1 at creation is refused, for a holder of Assign
   people to jobs and Assign work to other people too: the crew is changed afterwards with the normal flow. The
   booking goes through today's booking code, so the same "Job is scheduled" notice goes out and the same crew
   conflict check runs (with the same 409 and the same override).

   Every case uses people on custom roles whose base role and switch disagree, so no role-name or base-role check
   can pass. Everything goes through the job routes. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}V${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const suite = realClient ? describe : describe.skip;

const NOT_CREW = "This person can't be on a crew.";
const SELF_ONLY = 'At creation you can only put yourself on the first visit.';
const NEEDS_TIME = 'Pick a time for the first visit before putting anyone on it.';

const HOUR = 3_600_000;
const startAt = (days: number) => new Date(Date.now() + days * 24 * HOUR - (Date.now() % HOUR)).toISOString();
const endAt = (start: string) => new Date(new Date(start).getTime() + HOUR).toISOString();

suite('visit 1 booked with the creator on its crew at job creation (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => vi.mocked(dispatchAutomationEvent).mockClear());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `job-visit-crew-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, create_jobs: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `v${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The creator the slice is about: Create jobs on, Schedule visits and Assign people to jobs off, can be on a crew. */
  const creatorWith = (org: string, values: Record<string, boolean | string> = {}, base: Role = 'TECHNICIAN') =>
    personWith(org, { schedule_visits: false, assign_people_to_jobs: false, can_be_on_crew: true, ...values }, base);

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

  const jobCount = (customer: string) => db.job.count({ where: { customer_id: customer } });

  /** The visits of a job as stored, with their crew. */
  const visitsOf = async (jobId: string) =>
    (await db.visit.findMany({
      where: { job_id: jobId },
      select: { scheduled_at: true, scheduled_end: true, visit_seq: true, assignees: { select: { user_id: true } } },
    })).map((v) => ({ ...v, crew: v.assignees.map((a) => a.user_id).sort() }));

  describe('a creator without Schedule visits and without Assign people to jobs', () => {
    it('books visit 1 at the time given with itself as the crew, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const creator = await creatorWith(org, {}, base);
        const when = startAt(3);
        const res = await (await creator.api()).post('/api/jobs', newJob(customer, location, {
          scheduled_start: when, scheduled_end: endAt(when), visit_assignee_ids: [creator.id],
        }));
        expect(res.status, `${base}: ${JSON.stringify(res.body)}`).toBe(201);
        const visits = await visitsOf(res.body.job.id);
        expect(visits, base).toHaveLength(1);
        expect(visits[0]!.crew, base).toEqual([creator.id]);
        expect(visits[0]!.scheduled_at?.toISOString(), base).toBe(when);
        expect(visits[0]!.visit_seq, base).toBe(1);
      }
    });

    it('does the same for a customer created in the same request', async () => {
      const { org } = await fx.newOrg();
      const creator = await creatorWith(org);
      const when = startAt(3);
      const res = await (await creator.api()).post('/api/jobs', {
        new_customer: {
          first_name: 'New', last_name: 'Person', phone: '6175550199',
          location: { address_line1: '2 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
        },
        scope_notes: 'Fix the door', scheduled_start: when, visit_assignee_ids: [creator.id],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await visitsOf(res.body.job.id))[0]!.crew).toEqual([creator.id]);
    });

    it('does the same for a job made from a customer-only estimate', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const estimate = await fx.addEstimate(org, customer, admin.id);
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON', service_location_id: location } });
      const when = startAt(4);
      const res = await (await creator.api()).post('/api/jobs', {
        estimate_id: estimate.id, service_location_id: location, scheduled_start: when, visit_assignee_ids: [creator.id],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await visitsOf(res.body.job.id))[0]!.crew).toEqual([creator.id]);
    });

    it('still books a visit with nobody on it when the request names no crew, as before', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const res = await (await creator.api()).post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3) }));
      expect(res.status).toBe(201);
      const visits = await visitsOf(res.body.job.id);
      expect(visits).toHaveLength(1);
      expect(visits[0]!.crew).toEqual([]);
    });

    it('lands a creator with Attached scope on a job they are now on the crew of, which they can open', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      // Sold By and Dispatcher both stay with other people, so the crew row is the only way in.
      const creator = await creatorWith(org, { jobs_scope: 'attached', can_own_leads: false, can_be_dispatcher: false });
      const other = await personWith(org, { can_own_leads: true, can_be_dispatcher: true, assign_people_to_jobs: true }, 'DISPATCHER');
      // A holder of Assign people to jobs gives the job to others; the creator without it is on Sold By by the rule.
      // To prove the crew row is what opens the job, clear Sold By straight in the database first.
      const api = await creator.api();
      const res = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3), visit_assignee_ids: [creator.id] }));
      expect(res.status).toBe(201);
      await db.job.update({ where: { id: res.body.job.id }, data: { salesperson_id: other.id, dispatcher_id: null } });
      expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).toBe(200);
    });
  });

  describe('naming someone else on visit 1 at creation', () => {
    it('is refused, with nothing created, even for a holder of Assign people to jobs and Assign work to other people', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const colleague = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const everything = await creatorWith(org, { assign_people_to_jobs: true, assign_work_to_others: true, schedule_visits: true });
      const plain = await creatorWith(org);
      for (const creator of [everything, plain]) {
        const api = await creator.api();
        for (const crew of [[colleague.id], [creator.id, colleague.id]]) {
          const before = await jobCount(customer);
          const res = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3), visit_assignee_ids: crew }));
          expect(res.status, JSON.stringify(crew)).toBe(403);
          expect(res.body.error).toBe(SELF_ONLY);
          expect(await jobCount(customer)).toBe(before);
        }
      }
    });
  });

  describe('a creator who cannot be on a crew', () => {
    it('is refused when the request puts them on the crew, with nothing created', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      // The base role and the switch disagree both ways.
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const creator = await creatorWith(org, { can_be_on_crew: false }, base);
        const before = await jobCount(customer);
        const res = await (await creator.api()).post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3), visit_assignee_ids: [creator.id] }));
        expect(res.status, base).toBe(400);
        expect(res.body.error, base).toBe(NOT_CREW);
        expect(await jobCount(customer)).toBe(before);
      }
    });

    it('can still book visit 1 with nobody on it', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org, { can_be_on_crew: false });
      const res = await (await creator.api()).post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3) }));
      expect(res.status).toBe(201);
      expect((await visitsOf(res.body.job.id))[0]!.crew).toEqual([]);
    });

    it('is told by the form route, from their own switch', async () => {
      const { org } = await fx.newOrg();
      // Base roles and the switch disagree both ways.
      for (const [base, on] of [['TECHNICIAN', false], ['SALES', true], ['DISPATCHER', false], ['TECHNICIAN', true]] as const) {
        const creator = await creatorWith(org, { can_be_on_crew: on }, base);
        const res = await (await creator.api()).get('/api/jobs/creator-prefill');
        expect(res.status, `${base} ${on}`).toBe(200);
        expect(res.body.can_be_on_crew, `${base} ${on}`).toBe(on);
      }
    });
  });

  describe('a crew without a time', () => {
    it('is refused: there is no visit to put anyone on', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const before = await jobCount(customer);
      const res = await (await creator.api()).post('/api/jobs', newJob(customer, location, { visit_assignee_ids: [creator.id] }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(NEEDS_TIME);
      expect(await jobCount(customer)).toBe(before);
    });
  });

  describe('the booking goes through today\'s booking code', () => {
    it('sends the same "Job is scheduled" notice as a create with nobody on the visit, now naming the crew', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const api = await creator.api();

      const plain = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(3) }));
      const crewed = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: startAt(4), visit_assignee_ids: [creator.id] }));
      expect(plain.status).toBe(201);
      expect(crewed.status).toBe(201);

      const scheduled = (jobId: string) => vi.mocked(dispatchAutomationEvent).mock.calls
        .map(([e]) => e).filter((e) => e.entity.id === jobId && e.type === 'JOB_SCHEDULED');
      expect(scheduled(plain.body.job.id)).toHaveLength(1);
      const events = scheduled(crewed.body.job.id);
      expect(events).toHaveLength(1);
      const visit = (await visitsOf(crewed.body.job.id))[0]!;
      const { first_name: creatorName } = await db.user.findUniqueOrThrow({ where: { id: creator.id }, select: { first_name: true } });
      expect(events[0]).toMatchObject({ organizationId: org, entity: { type: 'job', id: crewed.body.job.id }, actorId: creator.id });
      // The notice is for the trip that was booked, and its technician fields now describe the creator.
      expect(events[0]!.visitId).toBeTruthy();
      expect(JSON.stringify(events[0]!.eventPayload)).toContain(creatorName);
      expect(visit.crew).toEqual([creator.id]);
      expect(JSON.stringify(scheduled(plain.body.job.id)[0]!.eventPayload)).not.toContain(creatorName);
    });

    it('runs the crew conflict check, refuses with the same 409 and creates no job, unless forced', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const api = await creator.api();
      const when = startAt(5);
      const first = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: when, scheduled_end: endAt(when), visit_assignee_ids: [creator.id] }));
      expect(first.status).toBe(201);

      const before = await jobCount(customer);
      const clash = await api.post('/api/jobs', newJob(customer, location, { scheduled_start: when, scheduled_end: endAt(when), visit_assignee_ids: [creator.id] }));
      expect(clash.status).toBe(409);
      expect(clash.body.error).toBe('Schedule conflict detected');
      expect(clash.body.conflicts).toEqual([expect.objectContaining({ type: 'job', id: first.body.job.id, number: first.body.job.job_number })]);
      expect(await jobCount(customer)).toBe(before);

      const forced = await api.post('/api/jobs', newJob(customer, location, {
        scheduled_start: when, scheduled_end: endAt(when), visit_assignee_ids: [creator.id], visit_force: true,
      }));
      expect(forced.status).toBe(201);
      expect((await visitsOf(forced.body.job.id))[0]!.crew).toEqual([creator.id]);
    });

    it('asks no conflict question when nobody is on the visit', async () => {
      const { org, customer } = await fx.newOrg();
      const location = await locationOf(customer);
      const creator = await creatorWith(org);
      const api = await creator.api();
      const when = startAt(5);
      expect((await api.post('/api/jobs', newJob(customer, location, { scheduled_start: when, visit_assignee_ids: [creator.id] }))).status).toBe(201);
      expect((await api.post('/api/jobs', newJob(customer, location, { scheduled_start: when }))).status).toBe(201);
    });
  });
});

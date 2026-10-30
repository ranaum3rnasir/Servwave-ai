/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.2 - job slot writes follow eligibility (M5).

   Every write that newly places a person on a job slot asks slot eligibility and refuses an ineligible or an
   inactive person in plain words: the job Dispatcher write, a visit's crew (assign, set the job crew, set a
   visit's crew, bulk assign, book a visit, move a visit) and the crew named when a service plan visit is
   scheduled. Only a newly named person is asked about: a crew list that still holds an ineligible member
   already on it is accepted, and turning a switch off never takes a person out of a slot they hold.

   Every case uses people on custom roles whose base role and slot switch disagree (a Technician base with
   the switch on, a Dispatcher base with it off), so no role-name or base-role check can pass. Everything goes
   through the job, service plan and user routes. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const NOT_CREW = "This person can't be on a crew.";
const NOT_DISPATCHER = "This person can't be a dispatcher.";
const INACTIVE = 'This person is inactive.';

suite('job slot writes follow slot eligibility (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const planOrgs: string[] = [];
  afterAll(async () => {
    // Service plans are not part of the shared fixture's cleanup, and they pin their customer.
    for (const org of planOrgs) {
      await db.job.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
      await db.servicePlan.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { roleKey: string; api: () => Promise<Api> }> {
    const key = `job-slot-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  /** Each door gets its own day, so one door's booking never collides with another's. */
  let dayOffset = 20;
  const nextWindow = () => {
    const start = new Date(Date.now() + ++dayOffset * 86_400_000);
    return { scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString() };
  };

  type JobRef = { id: string; visitId?: string };
  type CrewDoor = {
    name: string;
    /** The job the door writes to, with a crew it may replace. */
    prepare: (org: string, customer: string, existing: Person) => Promise<JobRef>;
    run: (api: Api, job: JobRef, target: Person) => Promise<{ status: number; error?: string }>;
  };

  const reply = (res: { status: number; body: { error?: string } }) => ({ status: res.status, error: res.body?.error });

  const withJob = (org: string, customer: string, existing: Person) => fx.addJob(org, customer, { crew: [existing.id] });

  const crewDoors: CrewDoor[] = [
    {
      name: 'assign',
      prepare: withJob,
      run: async (api, job, target) => reply(await api.post(`/api/jobs/${job.id}/assign`, { assignee_ids: [target.id] })),
    },
    {
      name: 'set the job crew',
      prepare: withJob,
      run: async (api, job, target) => reply(await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [target.id] })),
    },
    {
      name: 'set a visit crew',
      prepare: withJob,
      run: async (api, job, target) => reply(await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [target.id] })),
    },
    {
      name: 'bulk assign',
      prepare: withJob,
      run: async (api, job, target) => {
        const res = await api.post('/api/jobs/bulk-assign', { ids: [job.id], assignee_ids: [target.id] });
        const failed = (res.body as { failed?: { error?: string }[] }).failed ?? [];
        // The batch answers 200 whatever happened to each job; a refused job is in `failed`.
        return failed.length > 0 ? { status: 400, error: failed[0]!.error } : { status: res.status };
      },
    },
    {
      name: 'book a visit',
      prepare: withJob,
      run: async (api, job, target) => reply(await api.post(`/api/jobs/${job.id}/visits`, { ...nextWindow(), assignee_ids: [target.id] })),
    },
    {
      name: 'move a visit',
      prepare: withJob,
      run: async (api, job, target) => reply(await api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, { assignee_ids: [target.id] })),
    },
    {
      name: 'schedule a service plan visit',
      prepare: async (org, customer) => {
        planOrgs.push(org);
        const location = await db.serviceLocation.create({
          data: { customer_id: customer, address_line1: '2 Plan Way', city: 'Testville', state: 'MA', zip: '02108' },
        });
        const plan = await db.servicePlan.create({
          data: {
            organization_id: org, customer_id: customer, service_location_id: location.id, service_plan_number: `SP-${++sequence}-${Date.now()}`,
            name: 'Annual check', status: 'ACTIVE', visit_cadence: 'MONTHLY', start_date: new Date(), contract_price: 100,
          },
        });
        return { id: plan.id };
      },
      run: async (api, plan, target) => reply(await api.post(`/api/service-plans/${plan.id}/schedule-visit`, { ...nextWindow(), assigned_to: target.id })),
    },
  ];

  describe('crew', () => {
    it.each(crewDoors.map((d) => [d.name, d] as const))('%s refuses a person who cannot be on a crew and one who is inactive, and takes one who can, whatever the role is based on', async (_name, door) => {
      const { org, customer, admin } = await fx.newOrg();
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      const api = await fx.signedInAs(admin);

      // The hard pairs: a Technician base with the switch on, and a Dispatcher base with it off.
      const technicianWhoCan = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const inactive = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN', { active: false });

      const refusedOff = await door.run(api, await door.prepare(org, customer, existing), dispatcherWhoCannot);
      expect(refusedOff.status, 'switch off').toBe(400);
      expect(refusedOff.error, 'switch off').toBe(NOT_CREW);

      const refusedInactive = await door.run(api, await door.prepare(org, customer, existing), inactive);
      expect(refusedInactive.status, 'inactive').toBe(400);
      expect(refusedInactive.error, 'inactive').toBe(INACTIVE);

      const allowed = await door.run(api, await door.prepare(org, customer, existing), technicianWhoCan);
      expect(allowed.status, 'switch on').toBeLessThan(300);
    });

    it('refuses nothing written when the person is ineligible: the crew stays as it was', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const existing = await fx.addUser(org, `existing${++sequence}`, 'TECHNICIAN');
      const cannot = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const job = await fx.addJob(org, customer, { crew: [existing.id] });
      const refused = await (await fx.signedInAs(admin)).post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [cannot.id] });
      expect(refused.status).toBe(400);
      const crew = await db.visitAssignee.findMany({ where: { visit_id: job.visitId! }, select: { user_id: true } });
      expect(crew.map((c) => c.user_id)).toEqual([existing.id]);
    });

    it('accepts a re-saved crew list that still holds an ineligible member, and refuses a newly named ineligible one in the same request', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const member = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      const colleague = await personWith(org, { can_be_on_crew: true }, 'DISPATCHER');
      const stranger = await personWith(org, { can_be_on_crew: false }, 'DISPATCHER');
      const job = await fx.addJob(org, customer, { crew: [member.id] });

      // Their switch is turned off, then they are deactivated: the job still holds them.
      await setRoleSwitchValues({ organizationId: org, roleKey: member.roleKey, values: { can_be_on_crew: false }, actorId: null, reason: 'manual' });
      await db.user.update({ where: { id: member.id }, data: { is_active: false } });

      const restated = await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [member.id, colleague.id] });
      expect(restated.status).toBe(200);
      const crewIds = async () => (await db.visitAssignee.findMany({ where: { visit_id: job.visitId! } })).map((c) => c.user_id).sort();
      expect(await crewIds()).toEqual([member.id, colleague.id].sort());

      const mixed = await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [member.id, colleague.id, stranger.id] });
      expect(mixed.status).toBe(400);
      expect(mixed.body.error).toBe(NOT_CREW);
      expect(await crewIds()).toEqual([member.id, colleague.id].sort());
    });
  });

  describe('Dispatcher', () => {
    it('refuses a person who cannot be a dispatcher and one who is inactive, and takes one who can, whatever the role is based on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const technicianWhoCan = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const dispatcherWhoCannot = await personWith(org, { can_be_dispatcher: false }, 'DISPATCHER');
      const inactive = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER', { active: false });
      const job = await fx.addJob(org, customer);

      const refused = await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: dispatcherWhoCannot.id });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(NOT_DISPATCHER);

      const refusedInactive = await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: inactive.id });
      expect(refusedInactive.status).toBe(400);
      expect(refusedInactive.body.error).toBe(INACTIVE);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).dispatcher_id).toBeNull();

      const allowed = await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: technicianWhoCan.id });
      expect(allowed.status).toBe(200);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).dispatcher_id).toBe(technicianWhoCan.id);
    });

    it('keeps a dispatcher whose switch is turned off on the jobs they hold, and the Team card still shows them', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const holder = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { dispatcher: holder.id });

      await setRoleSwitchValues({ organizationId: org, roleKey: holder.roleKey, values: { can_be_dispatcher: false }, actorId: null, reason: 'manual' });

      const detail = await api.get(`/api/jobs/${job.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.job.dispatcher.id).toBe(holder.id);

      // Naming the same person again changes nothing, so it is not refused.
      const same = await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: holder.id });
      expect(same.status).toBe(200);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).dispatcher_id).toBe(holder.id);
    });

    it('is refused without Assign people to jobs and let in with it, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { assign_people_to_jobs: false }, base);
        const withIt = await personWith(org, { assign_people_to_jobs: true }, base);
        const refusedJob = await fx.addJob(org, customer);
        expect((await (await without.api()).post(`/api/jobs/${refusedJob.id}/dispatcher`, { dispatcher_id: target.id })).status, base).toBe(403);
        const allowedJob = await fx.addJob(org, customer);
        expect((await (await withIt.api()).post(`/api/jobs/${allowedJob.id}/dispatcher`, { dispatcher_id: target.id })).status, base).toBe(200);
      }
    });
  });

  describe('Sales preset', () => {
    it('is refused a job Dispatcher write and a crew write, including on a job that came from its own lead', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await fx.addUser(org, `seller${++sequence}`, 'SALES');
      const api = await fx.signedInAs(seller);
      const target = await personWith(org, { can_be_dispatcher: true, can_be_on_crew: true }, 'DISPATCHER');
      const lead = await fx.addLead(org, customer, { assignees: [seller.id], owner: seller.id, createdBy: seller.id });
      const job = await fx.addJob(org, customer, { fromLead: lead.id, crew: [target.id], soldBy: seller.id, createdBy: seller.id });

      expect((await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: target.id })).status).toBe(403);
      expect((await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [seller.id] })).status).toBe(403);
      expect((await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [seller.id] })).status).toBe(403);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).dispatcher_id).toBeNull();
    });
  });

  describe('Assign work to other people', () => {
    it('still refuses naming someone other than oneself on a crew without it', async () => {
      const { org, customer } = await fx.newOrg();
      const target = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
        const me = await personWith(org, { assign_people_to_jobs: true, assign_work_to_others: false, can_be_on_crew: true }, base);
        const job = await fx.addJob(org, customer, { crew: [me.id] });
        const api = await me.api();
        expect((await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [me.id, target.id] })).status, base).toBe(403);
        expect((await api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [me.id] })).status, base).toBe(200);
      }
    });
  });

  describe('deleting a person', () => {
    it('is refused for a job Dispatcher who is also on a crew: a record\'s people are history (P19), and nothing changes', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const leaver = await personWith(org, { can_be_dispatcher: true, can_be_on_crew: true }, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [leaver.id], dispatcher: leaver.id });
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false } });

      const deleted = await api.delete(`/api/users/${leaver.id}/permanent`);
      expect(deleted.status).toBe(409);
      expect(await db.user.count({ where: { id: leaver.id } })).toBe(1);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).dispatcher_id).toBe(leaver.id);
      expect(await db.visitAssignee.count({ where: { visit_id: job.visitId! } })).toBe(1);
    });
  });
});

/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.21 - the Dispatch Scoreboard credits a job's CURRENT Dispatcher, and
   copying a plan's Sold By onto its visit jobs moves neither scoreboard.

   Everything goes through the public interface: the job and service plan routes to change the people, and
   GET /api/dashboard to read the two scoreboards. Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.

   Worded against "at or past Completed" so it holds when PRD 6 adds the later statuses: the statuses it
   walks are read from the job status enum (everything from Completed on, except Cancelled), not listed here.
   Today that is Completed alone.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { JobStatus } from '@prisma/client';
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

/** Every job status at or past Completed that is still a finished job: the statuses the scoreboards count. */
const ORDER = Object.values(JobStatus);
const COMPLETED_OR_LATER = ORDER.slice(ORDER.indexOf('COMPLETED')).filter((s) => s !== 'CANCELLED');

type Entry = { user_id: string | null; name: string; jobs: number; revenue?: number };
type Boards = { tech_scoreboard: Entry[]; dispatch_scoreboard: Entry[] };

suite('the scoreboards credit the Dispatcher and the crew, never the Sold By (real database)', () => {
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

  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role): Promise<Person> {
    const key = `scoreboard-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
  }

  const boardsAs = async (person: Person): Promise<Boards> => {
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect(res.status).toBe(200);
    // The answer is keyed by tile id (PRD 9).
    return { tech_scoreboard: res.body.data.tech_scoreboard, dispatch_scoreboard: res.body.data.dispatch_scoreboard } as Boards;
  };

  const creditOf = (board: Entry[], userId: string) => board.find((e) => e.user_id === userId)?.jobs ?? 0;

  it.each(COMPLETED_OR_LATER)('moves the count of a job at status %s to its new Dispatcher when it is reassigned', async (status) => {
    const { org, customer, admin } = await fx.newOrg();
    // The hard pair: a Technician base with Can be a dispatcher on takes the credit a Dispatcher base would.
    const first = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
    const second = await personWith(org, { can_be_dispatcher: true }, 'TECHNICIAN');
    const moved = await fx.addJob(org, customer, { status, dispatcher: first.id });
    await fx.addJob(org, customer, { status, dispatcher: first.id });
    await db.job.updateMany({ where: { organization_id: org }, data: { amount_invoiced: 100 } });

    const before = await boardsAs(admin);
    expect(creditOf(before.dispatch_scoreboard, first.id)).toBe(2);
    expect(creditOf(before.dispatch_scoreboard, second.id)).toBe(0);

    const api = await fx.signedInAs(admin);
    const reassigned = await api.post(`/api/jobs/${moved.id}/dispatcher`, { dispatcher_id: second.id });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);

    const after = await boardsAs(admin);
    expect(creditOf(after.dispatch_scoreboard, first.id)).toBe(1);
    expect(creditOf(after.dispatch_scoreboard, second.id)).toBe(1);
    // The credit follows the Dispatcher with its money, and nobody is counted twice.
    expect(after.dispatch_scoreboard.find((e) => e.user_id === second.id)!.revenue).toBe(100);
    expect(after.dispatch_scoreboard.reduce((sum, e) => sum + e.jobs, 0)).toBe(2);
  });

  it('stops counting a job for a Dispatcher it is taken from, and moves it under "No dispatcher" when the Dispatcher is cleared', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const holder = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
    const job = await fx.addJob(org, customer, { status: 'COMPLETED', dispatcher: holder.id });
    const api = await fx.signedInAs(admin);

    expect(creditOf((await boardsAs(admin)).dispatch_scoreboard, holder.id)).toBe(1);

    const cleared = await api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    // The job is credited to no person; it is counted under the empty slot's own name (S09.14).
    expect((await boardsAs(admin)).dispatch_scoreboard).toEqual([{ user_id: null, name: 'No dispatcher', jobs: 1, revenue: 0 }]);
  });

  describe('the "No dispatcher" row (S09.14)', () => {
    it.each(COMPLETED_OR_LATER)('counts a job at status %s with no Dispatcher under "No dispatcher", beside the Dispatcher\'s own row', async (status) => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
      await fx.addJob(org, customer, { status, dispatcher: holder.id });
      await fx.addJob(org, customer, { status });
      await fx.addJob(org, customer, { status });
      await db.job.updateMany({ where: { organization_id: org }, data: { amount_invoiced: 10 } });

      const board = (await boardsAs(admin)).dispatch_scoreboard;
      expect(board.find((e) => e.user_id === null)).toEqual({ user_id: null, name: 'No dispatcher', jobs: 2, revenue: 20 });
      expect(creditOf(board, holder.id)).toBe(1);
      expect(JSON.stringify(board)).not.toMatch(/unassigned/i);
    });

    it('leaves out a job that is not finished or has a Dispatcher, and draws no row when every finished job has one', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
      await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      await fx.addJob(org, customer, { status: 'CANCELLED' });
      await fx.addJob(org, customer, { status: 'COMPLETED', dispatcher: holder.id });

      const board = (await boardsAs(admin)).dispatch_scoreboard;
      expect(board.map((e) => e.name)).not.toContain('No dispatcher');
      expect(board.map((e) => e.user_id)).toEqual([holder.id]);
    });

    it('counts, for a person on the jobs they are on only, just those jobs, with no revenue', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await personWith(org, { can_be_on_crew: true, jobs_scope: 'attached' }, 'TECHNICIAN');
      const other = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      await fx.addJob(org, customer, { status: 'COMPLETED', crew: [crew.id], pastVisit: true });
      await fx.addJob(org, customer, { status: 'COMPLETED', crew: [other.id], pastVisit: true });
      await fx.addJob(org, customer, { status: 'COMPLETED', crew: [other.id], pastVisit: true });
      await db.job.updateMany({ where: { organization_id: org }, data: { amount_invoiced: 55 } });

      const board = (await boardsAs(crew)).dispatch_scoreboard;
      expect(board).toEqual([{ user_id: null, name: 'No dispatcher', jobs: 1 }]);
    });
  });

  describe('a completed plan visit job with a copied Sold By and no Dispatcher', () => {
    /** Two ordinary completed jobs, so both boards have rows to compare, and the plan visit job on top of them. */
    async function worldWithPlanVisit() {
      const setup = await fx.newOrg();
      const { org, customer } = setup;
      planOrgs.push(org);
      const seller = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
      const crew = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');

      await fx.addJob(org, customer, { status: 'COMPLETED', dispatcher: dispatcher.id, crew: [crew.id], pastVisit: true });

      // The plan visit job comes from the route, so the Sold By is the one the plan really copies.
      const plan = await fx.addServicePlan(org, customer, { soldBy: seller.id });
      const start = new Date(Date.now() + 30 * 86_400_000);
      const scheduled = await (await fx.signedInAs(setup.admin)).post(`/api/service-plans/${plan.id}/schedule-visit`, {
        scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString(), assigned_to: crew.id,
      });
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
      const jobId = scheduled.body.job.id as string;
      const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { salesperson_id: true, dispatcher_id: true } });
      expect(job.salesperson_id).toBe(seller.id);
      expect(job.dispatcher_id).toBeNull();
      await db.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', completed_at: new Date(), amount_invoiced: 0 } });
      return { ...setup, jobId, seller, crew, dispatcher };
    }

    it('changes neither the Tech nor the Dispatch Scoreboard', async () => {
      const world = await worldWithPlanVisit();
      const withSoldBy = await boardsAs(world.admin);

      await db.job.update({ where: { id: world.jobId }, data: { salesperson_id: null } });
      const withoutSoldBy = await boardsAs(world.admin);

      expect(withSoldBy.tech_scoreboard).toEqual(withoutSoldBy.tech_scoreboard);
      expect(withSoldBy.dispatch_scoreboard).toEqual(withoutSoldBy.dispatch_scoreboard);
    });

    it('credits the visit to its crew on the Tech Scoreboard and to no person on the Dispatch Scoreboard, and never to the seller', async () => {
      const world = await worldWithPlanVisit();
      const boards = await boardsAs(world.admin);

      // The ordinary job and the plan visit job are both the crew member's.
      expect(creditOf(boards.tech_scoreboard, world.crew.id)).toBe(2);
      expect(creditOf(boards.tech_scoreboard, world.seller.id)).toBe(0);
      // Only the ordinary job has a Dispatcher; the plan visit job has none and is counted under "No dispatcher".
      expect(boards.dispatch_scoreboard.map((e) => [e.user_id, e.jobs]).sort()).toEqual([[null, 1], [world.dispatcher.id, 1]].sort());
      expect(creditOf(boards.dispatch_scoreboard, world.seller.id)).toBe(0);
    });
  });

  describe('what the scoreboards answer for a person without See company figures', () => {
    it('carries no revenue for a stock Technician, ranks by job count, and does not widen with this slice', async () => {
      const { org, customer } = await fx.newOrg();
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'DISPATCHER');
      const crew = await personWith(org, { can_be_on_crew: true }, 'TECHNICIAN');
      await fx.addJob(org, customer, { status: 'COMPLETED', dispatcher: dispatcher.id, crew: [crew.id], pastVisit: true });
      await db.job.updateMany({ where: { organization_id: org }, data: { amount_invoiced: 987.65 } });
      const stockTechnician = await fx.addUser(org, `stock${++sequence}`, 'TECHNICIAN');

      const boards = await boardsAs(stockTechnician);

      expect(JSON.stringify(boards.tech_scoreboard)).not.toMatch(/revenue|987/);
      expect(JSON.stringify(boards.dispatch_scoreboard)).not.toMatch(/revenue|987/);
      // The shape is the one the endpoint always had: a user id, a name and a job count per row.
      for (const row of [...boards.tech_scoreboard, ...boards.dispatch_scoreboard]) {
        expect(Object.keys(row).sort()).toEqual(['jobs', 'name', 'user_id']);
      }
    });
  });
});

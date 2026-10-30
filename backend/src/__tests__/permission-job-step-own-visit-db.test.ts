/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.5 - job-level On my way, Arrived and Start obey the own-visit rule.

   The job-level steps stamp the job's CURRENT visit. Each needs the step's own switch (Mark on my way, Mark
   arrived, Start and finish visits) AND either a place on the crew of that current visit or Update any visit's
   status. Being crewed on some other visit of the job does not count; the switch for another step does not
   count. The bulk bar's Arrived and Start run the same check per job and hand a refused job back in `failed`.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

suite('job-level On my way, Arrived and Start obey the own-visit rule (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values, with Jobs scope All. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `own-visit-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A job with two upcoming visits: the first is the CURRENT one (the earliest upcoming), the second is later.
   * `onCurrent` is the crew of the current visit, `onLater` the crew of the later one.
   */
  async function twoVisitJob(org: string, customer: string, onCurrent: string[], onLater: string[]) {
    const job = await fx.addJob(org, customer, { crew: onCurrent });
    const laterVisit = await fx.addVisit(org, { jobId: job.id, crew: onLater, daysFromNow: 5, seq: 2 });
    return { id: job.id, currentVisit: job.visitId!, laterVisit };
  }

  const allSteps = { mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };
  const steps = [
    { name: 'On my way', needs: 'mark_on_my_way', path: (j: string) => `/api/jobs/${j}/en-route`, stamps: 'en_route_at' },
    { name: 'Arrived', needs: 'mark_arrived', path: (j: string) => `/api/jobs/${j}/arrive`, stamps: 'on_site_at' },
    { name: 'Start', needs: 'start_and_finish_visits', path: (j: string) => `/api/jobs/${j}/start`, stamps: 'started_at' },
  ] as const;

  for (const step of steps) {
    describe(`job-level ${step.name}`, () => {
      it('refuses a person with the step switch who is crewed on another visit but not the current one, and lets in the crew of the current visit, whatever the role is based on', async () => {
        const { org, customer } = await fx.newOrg();
        const otherCrew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
        for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
          const me = await personWith(org, { ...allSteps, update_any_visit_status: false }, base);

          const notCurrent = await twoVisitJob(org, customer, [otherCrew.id], [me.id]);
          const refused = await (await me.api()).post(step.path(notCurrent.id), {});
          expect(refused.status, `${base} crewed on a later visit only`).toBe(403);
          expect((await db.visit.findUniqueOrThrow({ where: { id: notCurrent.currentVisit } }))[step.stamps], base).toBeNull();
          expect((await db.visit.findUniqueOrThrow({ where: { id: notCurrent.laterVisit } }))[step.stamps], base).toBeNull();

          const current = await twoVisitJob(org, customer, [me.id], [otherCrew.id]);
          const allowed = await (await me.api()).post(step.path(current.id), {});
          expect(allowed.status, `${base} crewed on the current visit`).toBe(200);
          expect((await db.visit.findUniqueOrThrow({ where: { id: current.currentVisit } }))[step.stamps], base).not.toBeNull();
        }
      });

      it("lets a non-crew person in only when they hold Update any visit's status as well as the step's switch", async () => {
        const { org, customer } = await fx.newOrg();
        const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
        for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
          const anyOnly = await personWith(org, { ...allSteps, [step.needs]: false, update_any_visit_status: true }, base);
          const both = await personWith(org, { ...allSteps, update_any_visit_status: true }, base);

          const refusedJob = await twoVisitJob(org, customer, [crew.id], [crew.id]);
          expect((await (await anyOnly.api()).post(step.path(refusedJob.id), {})).status, `${base} any-visit switch without the step switch`).toBe(403);
          expect((await db.visit.findUniqueOrThrow({ where: { id: refusedJob.currentVisit } }))[step.stamps], base).toBeNull();

          const allowedJob = await twoVisitJob(org, customer, [crew.id], [crew.id]);
          expect((await (await both.api()).post(step.path(allowedJob.id), {})).status, `${base} both switches`).toBe(200);
          expect((await db.visit.findUniqueOrThrow({ where: { id: allowedJob.currentVisit } }))[step.stamps], base).not.toBeNull();
        }
      });

      it('refuses the crew of the current visit when the step switch is off', async () => {
        const { org, customer } = await fx.newOrg();
        for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
          const me = await personWith(org, { ...allSteps, [step.needs]: false, update_any_visit_status: true }, base);
          const job = await twoVisitJob(org, customer, [me.id], []);
          expect((await (await me.api()).post(step.path(job.id), {})).status, base).toBe(403);
        }
      });
    });
  }

  describe('bulk status', () => {
    for (const action of ['arrive', 'start'] as const) {
      it(`runs the same check per job for ${action}: a not-crewed job comes back in failed and a crewed job goes through`, async () => {
        const { org, customer } = await fx.newOrg();
        const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
        for (const base of ['TECHNICIAN', 'DISPATCHER'] as const) {
          const me = await personWith(org, { ...allSteps, update_any_visit_status: false }, base);
          const api = await me.api();
          const crewed = await twoVisitJob(org, customer, [me.id], [crew.id]);
          const laterOnly = await twoVisitJob(org, customer, [crew.id], [me.id]);
          const strangers = await twoVisitJob(org, customer, [crew.id], [crew.id]);

          const res = await api.post('/api/jobs/bulk-status', { ids: [crewed.id, laterOnly.id, strangers.id], action });
          expect(res.status, base).toBe(200);
          expect(res.body.updated, base).toEqual([crewed.id]);
          expect(res.body.failed.map((f: { id: string }) => f.id).sort(), base).toEqual([laterOnly.id, strangers.id].sort());
        }
      });
    }

    it("lets a holder of Update any visit's status step the jobs they are not crewed on", async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const me = await personWith(org, { ...allSteps, update_any_visit_status: true }, 'TECHNICIAN');
      const job = await twoVisitJob(org, customer, [crew.id], [crew.id]);
      const res = await (await me.api()).post('/api/jobs/bulk-status', { ids: [job.id], action: 'arrive' });
      expect(res.status).toBe(200);
      expect(res.body.updated).toEqual([job.id]);
      expect(res.body.failed).toEqual([]);
    });
  });
});

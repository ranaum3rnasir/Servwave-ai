/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.17 - Done and Cancelled refuse every door but Reopen.

   A job that is Done or Cancelled leaves only through Reopen (M7). Every other door that would set the job's status
   refuses it with "Reopen this job first" BEFORE any write: the status door (to Scheduled, In Progress, Unscheduled),
   the calendar drag and the reschedule from the job (the assign route with a window that moves), unschedule, job-level
   Start, job-level Arrived, and bulk start and bulk arrive. The refusal is the same for a custom role holding the
   ordinary crew switches, for one holding every switch (Change locked jobs and Reopen Done jobs included) and for the
   admin: it comes from the close-out state machine, not from the lock. A refused move changes nothing, so the tests
   read the job row, its visits and its history before and after and expect them to be identical.

   The status door also refuses Office review, Ready to close and Done as targets and points to the matching action.

   Everything goes through the public interface (the job routes, called as people on custom roles holding exactly the
   switch values under test, never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

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

vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** Every switch on (a choice at its widest option, a list empty): Change locked jobs and Reopen Done jobs included. */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** The PRD's own words (not read from the code). */
const REOPEN_FIRST = 'Reopen this job first';

/** What opening the job takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

/** Criterion 1's custom role: Assign people to jobs, Start and finish visits and Mark arrived, crewed on the job. */
const CREW_AND_DISPATCH = { ...OPENING, assign_people_to_jobs: true, start_and_finish_visits: true, mark_arrived: true };

const WINDOW = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false };

const CLOSED = ['CANCELLED', 'DONE'] as const;

suite('Done and Cancelled refuse every door but Reopen (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['job_reviews', 'visits', 'timeline_events']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    return w;
  }

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `closed-doors-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A job as Cancel or Mark Done leaves it: the stamps that went with the closed state, and a booked visit (on which `crew`
   * stands, so the job-level steps are theirs to press).
   */
  async function closedJob(w: { org: string; customer: string; admin: Person }, status: (typeof CLOSED)[number], crew: Person[] = []) {
    const job = await fx.addJob(w.org, w.customer, { status });
    await fx.addVisit(w.org, { jobId: job.id, crew: crew.map((p) => p.id) });
    const stamp = new Date(Date.now() - 3_600_000);
    await db.job.update({
      where: { id: job.id },
      data: status === 'CANCELLED'
        ? { cancelled_at: stamp, cancelled_reason: 'Customer moved away', cancel_reason_code: 'PRICE' }
        : { completed_at: stamp, closed_at: stamp, closed_by_id: w.admin.id },
    });
    return job;
  }

  /** Everything a refused move could have touched: the job row, its visits and its history. */
  async function snapshot(jobId: string) {
    return {
      job: await db.job.findUniqueOrThrow({ where: { id: jobId } }),
      visits: await db.visit.findMany({ where: { job_id: jobId }, orderBy: { id: 'asc' } }),
      history: await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: jobId } }),
    };
  }

  /** Each door, as the call a control makes. */
  const DOORS: Record<string, (api: Api, jobId: string) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'the status door to Scheduled': (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'SCHEDULED', ...WINDOW }),
    'the status door to In Progress': (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'IN_PROGRESS' }),
    'the status door to Unscheduled': (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'UNSCHEDULED' }),
    'a calendar drag (assign with a window)': (api, id) => api.post(`/api/jobs/${id}/assign`, { ...WINDOW, assignee_ids: [] }),
    'unschedule': (api, id) => api.post(`/api/jobs/${id}/unassign`, {}),
    'job-level Start': (api, id) => api.post(`/api/jobs/${id}/start`),
    'job-level Arrived': (api, id) => api.post(`/api/jobs/${id}/arrive`),
  };

  const BULK_DOORS = ['start', 'arrive'] as const;

  for (const status of CLOSED) {
    describe(`a ${status} job`, () => {
      for (const [who, shape] of [
        ['a custom role holding Assign people to jobs, Start and finish visits and Mark arrived', 'crew'],
        ['a custom role holding every switch', 'everything'],
      ] as const) {
        describe(`as ${who}`, () => {
          for (const [door, call] of Object.entries(DOORS)) {
            it(`refuses ${door} with "${REOPEN_FIRST}" and writes nothing`, async () => {
              const w = await world();
              const me = await personWith(w.org, shape === 'crew' ? CREW_AND_DISPATCH : ALL_ON);
              const job = await closedJob(w, status, [me]);

              const before = await snapshot(job.id);
              const res = await call(await me.api(), job.id);

              expect([res.status, res.body.error]).toEqual([409, REOPEN_FIRST]);
              expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
              expect(await snapshot(job.id)).toEqual(before);
            });
          }

          for (const action of BULK_DOORS) {
            it(`lists the job as failed with "${REOPEN_FIRST}" for bulk ${action} and writes nothing`, async () => {
              const w = await world();
              const me = await personWith(w.org, shape === 'crew' ? CREW_AND_DISPATCH : ALL_ON);
              const job = await closedJob(w, status, [me]);

              const before = await snapshot(job.id);
              const res = await (await me.api()).post('/api/jobs/bulk-status', { ids: [job.id], action });

              expect(res.status, JSON.stringify(res.body)).toBe(200);
              expect(res.body.updated).toEqual([]);
              expect(res.body.failed).toEqual([expect.objectContaining({ id: job.id, error: REOPEN_FIRST })]);
              expect(await snapshot(job.id)).toEqual(before);
            });
          }
        });
      }

      it('refuses the same doors for the org admin, and Reopen is the way out', async () => {
        const w = await world();
        const job = await closedJob(w, status);
        const api = await fx.signedInAs(w.admin);
        const before = await snapshot(job.id);
        for (const [door, call] of Object.entries(DOORS)) {
          const res = await call(api, job.id);
          expect([door, res.status, res.body.error]).toEqual([door, 409, REOPEN_FIRST]);
        }
        expect(await snapshot(job.id)).toEqual(before);

        const reopened = await api.post(`/api/jobs/${job.id}/reopen`);
        expect(reopened.status).toBe(200);
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('IN_PROGRESS');
      });

      it('still lets a crew-only assign through for a Change locked jobs holder: the crew changes, the status never moves', async () => {
        const w = await world();
        const me = await personWith(w.org, { ...OPENING, assign_people_to_jobs: true, assign_work_to_others: true, change_locked_jobs: true });
        const job = await closedJob(w, status, [me]);
        const res = await (await me.api()).post(`/api/jobs/${job.id}/assign`, { assignee_ids: [me.id] });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(status);
      });
    });
  }

  describe('the server tells the job page which status doors are closed', () => {
    it.each(CLOSED)('answers "Reopen this job first" on a %s job and nothing on an open one', async (status) => {
      const w = await world();
      const me = await personWith(w.org, { ...CREW_AND_DISPATCH, change_locked_jobs: true });
      const closed = await closedJob(w, status);
      const open = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS' });
      const api = await me.api();
      expect((await api.get(`/api/jobs/${closed.id}`)).body.job.status_door_closed_reason).toBe(REOPEN_FIRST);
      expect((await api.get(`/api/jobs/${open.id}`)).body.job.status_door_closed_reason).toBeNull();
    });
  });

  describe('the status door refuses the close-out statuses as targets and points to the matching action', () => {
    const POINTS_TO: Record<string, RegExp> = {
      OFFICE_REVIEW: /Complete job/,
      READY_TO_CLOSE: /Finish review/,
      DONE: /Mark Done/,
    };
    for (const target of Object.keys(POINTS_TO)) {
      it(`refuses ${target}, names the action and changes nothing`, async () => {
        const w = await world();
        const me = await personWith(w.org, ALL_ON);
        const job = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS' as JobStatus });
        const before = await snapshot(job.id);
        const res = await (await me.api()).post(`/api/jobs/${job.id}/status`, { status: target });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
        expect(res.body.error).toMatch(POINTS_TO[target]!);
        expect(await snapshot(job.id)).toEqual(before);
      });
    }
  });
});

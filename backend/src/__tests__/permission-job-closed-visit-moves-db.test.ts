/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.17 - a Done or Cancelled job's visit cannot be moved to a new time.

   The Schedule's drag and resize move a visit through PATCH /api/jobs/:id/visits/:visitId. That is the calendar drag
   S06.17 closes: a job that is Done or Cancelled leaves only through Reopen, so the move is refused with "Reopen this
   job first" before any write, for a custom role holding the visit switch, for one holding every switch (Change locked
   jobs included) and for the admin. A PATCH that leaves the visit's time alone (a note, a restated window) is not a
   move and stays under the completed-job lock; an open job's visit moves as always. A new visit on a closed job is
   refused by its own door (the same words); this suite pins that too, so the two cannot drift apart.

   A move is judged against the window the visit would END UP with (the fields the body states, the stored values for the
   rest), so a body that states only the end, only the all-day flag or only the start is a move like a full one. The other
   write that moves a closed job's visit by another door (the job edit's window) answers the same words. The per-visit
   steps (Start, On my way, Arrived, Finish, Cancel) are NOT part of this: PRD 6's door table leaves them under PRD 4's
   lock, so a Change locked jobs holder may use them and the job's status never moves; this suite pins that too.

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

/** A person who moves visits and, to show the lock is not the reason, may also change locked jobs. */
const VISIT_MOVER = { ...OPENING, schedule_visits: true, change_locked_jobs: true };

const MOVE = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false };

suite('a closed job refuses a visit move (real database)', () => {
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

  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    return w;
  }

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `closed-visit-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A job in this status with one booked visit; a Done job's visit is finished, the way Complete and Mark Done leave it. */
  async function jobWithVisit(w: { org: string; customer: string; admin: Person }, status: JobStatus) {
    const job = await fx.addJob(w.org, w.customer, { status });
    const visitId = await fx.addVisit(w.org, { jobId: job.id, crew: [] });
    const stamp = new Date(Date.now() - 3_600_000);
    if (status === 'DONE') {
      await db.job.update({ where: { id: job.id }, data: { completed_at: stamp, closed_at: stamp, closed_by_id: w.admin.id } });
      await db.visit.update({ where: { id: visitId }, data: { status: 'COMPLETED' } });
    }
    if (status === 'CANCELLED') {
      await db.job.update({ where: { id: job.id }, data: { cancelled_at: stamp, cancelled_reason: 'Customer moved away', cancel_reason_code: 'PRICE' } });
    }
    return { jobId: job.id, visitId };
  }

  /** Everything a refused move could have touched: the job row, its visits and its history. */
  async function snapshot(jobId: string) {
    return {
      job: await db.job.findUniqueOrThrow({ where: { id: jobId } }),
      visits: await db.visit.findMany({ where: { job_id: jobId }, orderBy: { id: 'asc' } }),
      history: await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: jobId } }),
    };
  }

  for (const status of ['DONE', 'CANCELLED'] as const) {
    describe(`a ${status} job`, () => {
      for (const [who, values] of [
        ['a custom role holding Schedule visits and Change locked jobs', VISIT_MOVER],
        ['a custom role holding every switch', ALL_ON],
      ] as const) {
        it(`refuses the drag to a new time for ${who} with "${REOPEN_FIRST}" and writes nothing`, async () => {
          const w = await world();
          const me = await personWith(w.org, values);
          const { jobId, visitId } = await jobWithVisit(w, status);

          const before = await snapshot(jobId);
          const res = await (await me.api()).patch(`/api/jobs/${jobId}/visits/${visitId}`, MOVE);

          expect([res.status, res.body.error]).toEqual([409, REOPEN_FIRST]);
          expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
          expect(await snapshot(jobId)).toEqual(before);
        });
      }

      it('refuses the drag for the org admin, and the visit moves after a Reopen', async () => {
        const w = await world();
        const { jobId, visitId } = await jobWithVisit(w, status);
        const api = await fx.signedInAs(w.admin);
        const before = await snapshot(jobId);

        const res = await api.patch(`/api/jobs/${jobId}/visits/${visitId}`, MOVE);
        expect([res.status, res.body.error]).toEqual([409, REOPEN_FIRST]);
        expect(await snapshot(jobId)).toEqual(before);

        expect((await api.post(`/api/jobs/${jobId}/reopen`)).status).toBe(200);
        // A reopened job takes a move again (its visit has to be a live one to be moved).
        await db.visit.update({ where: { id: visitId }, data: { status: 'SCHEDULED' } });
        const after = await api.patch(`/api/jobs/${jobId}/visits/${visitId}`, MOVE);
        expect(after.status, JSON.stringify(after.body)).toBe(200);
      });

      it('tells the person who may not schedule visits their own switch refusal, not the Reopen words', async () => {
        const w = await world();
        const me = await personWith(w.org, { ...OPENING, change_locked_jobs: true });
        const { jobId, visitId } = await jobWithVisit(w, status);
        const res = await (await me.api()).patch(`/api/jobs/${jobId}/visits/${visitId}`, MOVE);
        expect(res.status).toBe(403);
        expect(res.body.error).not.toBe(REOPEN_FIRST);
      });

      it('does not treat a restated window or a note as a move: the completed-job lock decides, as before', async () => {
        const w = await world();
        const holder = await personWith(w.org, VISIT_MOVER);
        const { jobId, visitId } = await jobWithVisit(w, status);
        const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });

        const restated = await (await holder.api()).patch(`/api/jobs/${jobId}/visits/${visitId}`, {
          scheduled_start: visit.scheduled_at!.toISOString(),
          scheduled_end: visit.scheduled_end!.toISOString(),
          notes: 'Gate code is 4521',
        });
        expect(restated.body.error).not.toBe(REOPEN_FIRST);
        expect(restated.body.code).not.toBe('JOB_CLOSE_OUT_REFUSED');
      });

      it('leaves the job in its closed status when a Change locked jobs holder re-crews the visit (the lock decides, the status never moves)', async () => {
        const w = await world();
        const holder = await personWith(w.org, { ...VISIT_MOVER, assign_people_to_jobs: true, assign_work_to_others: true });
        const { jobId, visitId } = await jobWithVisit(w, status);

        const recrew = await (await holder.api()).post(`/api/jobs/${jobId}/visits/${visitId}/assignees`, { assignee_ids: [holder.id] });
        expect(recrew.body.error).not.toBe(REOPEN_FIRST);

        expect((await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status).toBe(status);
      });

      for (const [what, body] of [
        ['only the end', { scheduled_end: '2031-01-01T11:00:00.000Z' }],
        ['only the all-day flag', { is_all_day: true }],
        ['only the start', { scheduled_start: '2031-01-01T10:00:00.000Z' }],
      ] as const) {
        for (const [who, values] of [
          ['a custom role holding Schedule visits and Change locked jobs', VISIT_MOVER],
          ['a custom role holding every switch', ALL_ON],
        ] as const) {
          it(`refuses a drag that states ${what} for ${who}, and writes nothing`, async () => {
            const w = await world();
            const me = await personWith(w.org, values);
            const { jobId, visitId } = await jobWithVisit(w, status);

            const before = await snapshot(jobId);
            const res = await (await me.api()).patch(`/api/jobs/${jobId}/visits/${visitId}`, body);

            expect([res.status, res.body.error]).toEqual([409, REOPEN_FIRST]);
            expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
            expect(await snapshot(jobId)).toEqual(before);
          });
        }
      }

      it('does not treat a body that restates only the end or only the all-day flag as a move', async () => {
        const w = await world();
        const holder = await personWith(w.org, VISIT_MOVER);
        const { jobId, visitId } = await jobWithVisit(w, status);
        const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
        const api = await holder.api();

        for (const body of [{ scheduled_end: visit.scheduled_end!.toISOString() }, { is_all_day: visit.is_all_day }]) {
          const res = await api.patch(`/api/jobs/${jobId}/visits/${visitId}`, body);
          expect(res.body.code, JSON.stringify(body)).not.toBe('JOB_CLOSE_OUT_REFUSED');
        }
      });

      it('refuses the job edit that moves the live visit by a new start and end, for a custom role holding every switch', async () => {
        const w = await world();
        const me = await personWith(w.org, ALL_ON);
        const { jobId, visitId } = await jobWithVisit(w, status);
        // A finished job whose visit is somehow live again is the state a job edit could still move.
        await db.visit.update({ where: { id: visitId }, data: { status: 'SCHEDULED' } });

        const before = await snapshot(jobId);
        const res = await (await me.api()).patch(`/api/jobs/${jobId}`, { scheduled_start: MOVE.scheduled_start, scheduled_end: MOVE.scheduled_end });

        expect([res.status, res.body.error]).toEqual([409, REOPEN_FIRST]);
        expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
        expect(await snapshot(jobId)).toEqual(before);
      });

      it('lets the job edit through when it restates the window or changes something else', async () => {
        const w = await world();
        const me = await personWith(w.org, ALL_ON);
        const { jobId, visitId } = await jobWithVisit(w, status);
        await db.visit.update({ where: { id: visitId }, data: { status: 'SCHEDULED' } });
        const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
        const api = await me.api();

        const note = await api.patch(`/api/jobs/${jobId}`, { scope_notes: 'Gate code is 4521' });
        expect(note.body.code).not.toBe('JOB_CLOSE_OUT_REFUSED');
        const same = await api.patch(`/api/jobs/${jobId}`, { scheduled_start: visit.scheduled_at!.toISOString(), scheduled_end: visit.scheduled_end!.toISOString() });
        expect(same.body.code).not.toBe('JOB_CLOSE_OUT_REFUSED');
      });

      // PRD 6's door table: per-visit On my way, Arrived, Start, Finish visit and a visit's cancel are locked by PRD 4's lock
      // (only a Change locked jobs holder) and never move the job's status. They are not the calendar drag, so no Reopen.
      it('leaves the per-visit steps under the lock: a Change locked jobs holder is not told to Reopen, and the job keeps its status', async () => {
        const w = await world();
        const holder = await personWith(w.org, ALL_ON);
        const { jobId, visitId } = await jobWithVisit(w, status);
        const api = await holder.api();

        for (const [step, body] of [['en-route', {}], ['arrive', {}], ['start', {}], ['complete', {}], ['cancel', { cancelled_reason: 'Called off' }]] as const) {
          const res = await api.post(`/api/jobs/${jobId}/visits/${visitId}/${step}`, body);
          expect([step, res.body.code]).not.toEqual([step, 'JOB_CLOSE_OUT_REFUSED']);
        }
        expect((await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status).toBe(status);
      });

      it('keeps the Add visit door closed with the same words', async () => {
        const w = await world();
        const me = await personWith(w.org, VISIT_MOVER);
        const { jobId } = await jobWithVisit(w, status);
        const res = await (await me.api()).post(`/api/jobs/${jobId}/visits`, { ...MOVE, assignee_ids: [] });
        expect([res.status, res.body.error]).toEqual([403, REOPEN_FIRST]);
      });
    });
  }

  it('lets the same drag through on a job that is still open, and the visit lands on the new time', async () => {
    const w = await world();
    const me = await personWith(w.org, VISIT_MOVER);
    const { jobId, visitId } = await jobWithVisit(w, 'SCHEDULED');
    const res = await (await me.api()).patch(`/api/jobs/${jobId}/visits/${visitId}`, MOVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await db.visit.findUniqueOrThrow({ where: { id: visitId } })).scheduled_at?.toISOString()).toBe(MOVE.scheduled_start);
  });

  it('leaves the per-visit steps open on a job that is still open', async () => {
    const w = await world();
    const me = await personWith(w.org, ALL_ON);
    const { jobId, visitId } = await jobWithVisit(w, 'SCHEDULED');
    const api = await me.api();
    for (const step of ['en-route', 'arrive', 'start', 'complete']) {
      const res = await api.post(`/api/jobs/${jobId}/visits/${visitId}/${step}`, {});
      expect([step, res.body.code]).not.toEqual([step, 'JOB_CLOSE_OUT_REFUSED']);
      expect([step, res.status < 400]).toEqual([step, true]);
    }
  });

  it('lets the same job edit move the live visit on a job that is still open', async () => {
    const w = await world();
    const me = await personWith(w.org, ALL_ON);
    const { jobId, visitId } = await jobWithVisit(w, 'SCHEDULED');
    const res = await (await me.api()).patch(`/api/jobs/${jobId}`, { scheduled_start: MOVE.scheduled_start, scheduled_end: MOVE.scheduled_end });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await db.visit.findUniqueOrThrow({ where: { id: visitId } })).scheduled_at?.toISOString()).toBe(MOVE.scheduled_start);
  });
});

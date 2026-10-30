/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.1 - the job-level Complete lands in Office review.

   Complete (M7) stamps the job completed, writes the Completed history entry, moves the job straight to Office review
   in the same write (its own history entry) and opens a review round. The job never rests at Completed. It is refused
   from Cancelled ("Reopen this job first") and from the statuses already past it.

   Everything goes through the public interface: the complete doors (the job route, the status door, the Jobs list bulk
   action), called as people on custom roles holding exactly the switch values under test, and the rows they leave
   behind. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed
   again.
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const LIVE: JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];
const PAST_COMPLETE: JobStatus[] = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'];

suite('the job-level Complete lands in Office review (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other toggle off). */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'TECHNICIAN'): Promise<Person> {
    const key = `close-out-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
  }

  const opensJobs = { view_jobs: true, jobs_scope: 'all' };
  const completer = { ...opensJobs, complete_jobs: true };

  const jobRow = (id: string) => db.job.findUniqueOrThrow({ where: { id } });
  const reviewsOf = (jobId: string) => db.jobReview.findMany({ where: { job_id: jobId }, orderBy: { created_at: 'asc' } });
  const historyOf = (jobId: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId }, orderBy: { created_at: 'asc' } });

  describe.each(LIVE)('Complete from %s', (status) => {
    it('stamps completed, lands in Office review, opens one review round and writes both history entries', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await fx.addJob(org, customer, { status });
      const before = await jobRow(job.id);
      const api = await fx.signedInAs(me);

      const res = await api.post(`/api/jobs/${job.id}/complete`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // The answer carries the job where it now stands: never at Completed.
      expect(res.body.job.status).toBe('OFFICE_REVIEW');
      const after = await jobRow(job.id);
      expect(after.status).toBe('OFFICE_REVIEW');
      expect(after.completed_at).not.toBeNull();

      const rounds = await reviewsOf(job.id);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ organization_id: org, state: 'OPEN', finished_at: null, finished_by_id: null });
      // The first round's change-set starts where the job did.
      expect(rounds[0]!.window_start.toISOString()).toBe(before.created_at.toISOString());

      const history = await historyOf(job.id);
      const completed = history.find((e) => e.event_type === 'COMPLETED');
      const review = history.find((e) => e.event_type === 'OFFICE_REVIEW_STARTED');
      expect(completed, 'Completed entry').toMatchObject({ created_by: me.id });
      expect(review, 'Office review entry').toMatchObject({ created_by: me.id });
      expect(review!.description).toMatch(/office review/i);
      expect(history.indexOf(completed!)).toBeLessThan(history.indexOf(review!));

      // The job's history route shows both entries, with who made them.
      const timeline = await api.get(`/api/jobs/${job.id}/timeline`);
      expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
      const events = (timeline.body.events ?? timeline.body) as { event_type: string; creator?: { id: string } | null }[];
      for (const type of ['COMPLETED', 'OFFICE_REVIEW_STARTED']) {
        const entry = events.find((e) => e.event_type === type);
        expect(entry, type).toBeDefined();
        expect(entry!.creator?.id, type).toBe(me.id);
      }
    });
  });

  it('needs no crew place on the job: a custom role with Complete jobs on completes a job it is not on', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [colleague.id] });
    expect((await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
    expect((await jobRow(job.id)).status).toBe('OFFICE_REVIEW');
  });

  it('refuses without Complete jobs, changes nothing, and lists no Complete job action on the job', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...opensJobs, start_and_finish_visits: true });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', crew: [me.id] });
    const api = await fx.signedInAs(me);

    expect((await api.get(`/api/jobs/${job.id}`)).body.job.actions).not.toContain('complete');
    const res = await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });
    expect(res.status).toBe(403);
    expect((await jobRow(job.id)).status).toBe('IN_PROGRESS');
    expect(await reviewsOf(job.id)).toEqual([]);
  });

  it('lists Complete job on a job before Completed and not on a job past it', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const api = await fx.signedInAs(me);
    for (const status of LIVE) {
      const job = await fx.addJob(org, customer, { status });
      expect((await api.get(`/api/jobs/${job.id}`)).body.job.actions, status).toContain('complete');
    }
    for (const status of [...PAST_COMPLETE, 'CANCELLED'] as JobStatus[]) {
      const job = await fx.addJob(org, customer, { status });
      expect((await api.get(`/api/jobs/${job.id}`)).body.job.actions, status).not.toContain('complete');
    }
  });

  it('refuses a cancelled job with "Reopen this job first", even with Complete jobs on, and changes nothing', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'CANCELLED' });
    await db.job.update({ where: { id: job.id }, data: { cancelled_at: new Date(), cancelled_reason: 'Customer backed out' } });
    const api = await fx.signedInAs(me);

    const res = await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Reopen this job first');
    const after = await jobRow(job.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelled_reason).toBe('Customer backed out');
    expect(after.completed_at).toBeNull();
    expect(await reviewsOf(job.id)).toEqual([]);
  });

  it.each(PAST_COMPLETE)('refuses a job already at %s and opens no second round', async (status) => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status });
    const api = await fx.signedInAs(me);

    const res = await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual(expect.any(String));
    expect((await jobRow(job.id)).status).toBe(status);
    expect(await reviewsOf(job.id)).toEqual([]);
  });

  it('answers the status refusal before the open-visits one: a Done job is never asked to cancel visits', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'DONE' });
    await fx.addVisit(org, { jobId: job.id, daysFromNow: 3 });
    const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.code).not.toBe('JOB_COMPLETE_HAS_OPEN_VISITS');
  });

  it('refuses a complete over booked visits with "This job still has booked visits." and changes nothing', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'SCHEDULED' });
    const visit = await fx.addVisit(org, { jobId: job.id, daysFromNow: 3 });
    const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^This job still has booked visits\./);
    expect((await jobRow(job.id)).status).toBe('SCHEDULED');
    expect((await db.visit.findUniqueOrThrow({ where: { id: visit } })).status).toBe('SCHEDULED');
    expect(await reviewsOf(job.id)).toEqual([]);
  });

  it('confirmed, cancels exactly the open visits (none finished) and lands the job in Office review', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'SCHEDULED' });
    const booked = await fx.addVisit(org, { jobId: job.id, daysFromNow: 3, seq: 1 });
    const finished = await fx.addVisit(org, { jobId: job.id, daysFromNow: -3, seq: 2 });
    const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await jobRow(job.id)).status).toBe('OFFICE_REVIEW');
    expect((await db.visit.findUniqueOrThrow({ where: { id: booked } })).status).toBe('CANCELLED');
    expect((await db.visit.findUniqueOrThrow({ where: { id: finished } })).status).toBe('COMPLETED');
    expect(await reviewsOf(job.id)).toHaveLength(1);
  });

  it('reuses the open round when a job comes back to be completed again, and starts a new one only after a finished round', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, completer);
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const api = await fx.signedInAs(me);
    expect((await api.post(`/api/jobs/${job.id}/complete`)).status).toBe(200);
    // Sent back out of review before the round was finished (a later slice owns the move), then completed again.
    await db.job.update({ where: { id: job.id }, data: { status: 'IN_PROGRESS' } });
    expect((await api.post(`/api/jobs/${job.id}/complete`)).status).toBe(200);
    expect(await reviewsOf(job.id)).toHaveLength(1);

    // A finished round is history: the next complete opens a new one whose window starts at that finish.
    const finishedAt = new Date('2026-02-01T12:00:00Z');
    await db.jobReview.updateMany({ where: { job_id: job.id }, data: { state: 'FINISHED', finished_at: finishedAt } });
    await db.job.update({ where: { id: job.id }, data: { status: 'IN_PROGRESS' } });
    expect((await api.post(`/api/jobs/${job.id}/complete`)).status).toBe(200);
    const rounds = await reviewsOf(job.id);
    expect(rounds).toHaveLength(2);
    expect(rounds[1]).toMatchObject({ state: 'OPEN' });
    expect(rounds[1]!.window_start.toISOString()).toBe(finishedAt.toISOString());
  });

  describe('the status door and the Jobs list bulk action run the same move', () => {
    it('the status door with Completed lands in Office review with a round', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...completer });
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/status`, { status: 'COMPLETED' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await jobRow(job.id)).status).toBe('OFFICE_REVIEW');
      expect(await reviewsOf(job.id)).toHaveLength(1);
    });

    it.each(['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'])('the status door refuses %s as a target and changes nothing', async (target) => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...completer, assign_people_to_jobs: true, start_and_finish_visits: true, cancel_jobs: true });
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/status`, { status: target });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
      expect((await jobRow(job.id)).status).toBe('IN_PROGRESS');
      expect(await reviewsOf(job.id)).toEqual([]);
    });

    it('bulk complete puts each job in Office review and lists a cancelled job as refused with its reason', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const a = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      const b = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const cancelled = await fx.addJob(org, customer, { status: 'CANCELLED' });
      const res = await (await fx.signedInAs(me)).post('/api/jobs/bulk-status', { ids: [a.id, b.id, cancelled.id], action: 'complete' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect([...res.body.updated].sort()).toEqual([a.id, b.id].sort());
      expect(res.body.failed).toEqual([expect.objectContaining({ id: cancelled.id, error: 'Reopen this job first' })]);
      expect((await jobRow(a.id)).status).toBe('OFFICE_REVIEW');
      expect((await jobRow(b.id)).status).toBe('OFFICE_REVIEW');
      expect((await jobRow(cancelled.id)).status).toBe('CANCELLED');
      expect(await reviewsOf(a.id)).toHaveLength(1);
      expect(await reviewsOf(cancelled.id)).toEqual([]);
    });

    it('bulk complete lists only jobs that can still be completed in its open-visits confirmation', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const open = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      await fx.addVisit(org, { jobId: open.id, daysFromNow: 2 });
      const done = await fx.addJob(org, customer, { status: 'DONE' });
      await fx.addVisit(org, { jobId: done.id, daysFromNow: 2 });
      const res = await (await fx.signedInAs(me)).post('/api/jobs/bulk-status', { ids: [open.id, done.id], action: 'complete' });
      expect(res.status).toBe(409);
      expect((res.body.jobs as { id: string }[]).map((j) => j.id)).toEqual([open.id]);
    });
  });

  describe('visit writes never move a job in or out of the close-out statuses', () => {
    it('finishing the last open visit leaves the job where it is, opens no round and starts no lock', async () => {
      const { org, customer } = await fx.newOrg();
      const crew = await personWith(org, { ...opensJobs, start_and_finish_visits: true, mark_arrived: true, mark_on_my_way: true });
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS', crew: [crew.id] });
      const api = await fx.signedInAs(crew);

      const res = await api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } })).status).toBe('COMPLETED');
      const after = await jobRow(job.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.completed_at).toBeNull();
      expect(await reviewsOf(job.id)).toEqual([]);
      // No lock: the job is not read as locked for the person.
      expect((await api.get(`/api/jobs/${job.id}`)).body.job.locked).toBe(false);
    });

    it.each(['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] as JobStatus[])(
      'a Change locked jobs holder booking, starting, finishing or cancelling a visit on a %s job leaves its status unchanged',
      async (status) => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, {
          ...opensJobs, change_locked_jobs: true, schedule_visits: true, start_and_finish_visits: true, mark_arrived: true, mark_on_my_way: true,
        });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const second = await fx.addVisit(org, { jobId: job.id, crew: [me.id], daysFromNow: 4, seq: 2 });
        const api = await fx.signedInAs(me);
        const calls = [
          () => api.post(`/api/jobs/${job.id}/visits`, { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', assignee_ids: [me.id] }),
          () => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/start`),
          () => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`),
          () => api.post(`/api/jobs/${job.id}/visits/${second}/cancel`, {}),
        ];
        for (const call of calls) {
          await call();
          expect((await jobRow(job.id)).status).toBe(status);
        }
        expect(await reviewsOf(job.id)).toEqual([]);
      },
    );

    it.each(['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'] as JobStatus[])(
      'job-level Arrived on a %s job is refused and leaves the status, the stamps and the visits alone',
      async (status) => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...opensJobs, change_locked_jobs: true, mark_arrived: true, update_any_visit_status: true });
        const job = await fx.addJob(org, customer, { status, crew: [me.id] });
        const stamp = new Date('2026-03-01T10:00:00Z');
        await db.job.update({ where: { id: job.id }, data: { completed_at: stamp, cancelled_at: status === 'CANCELLED' ? stamp : null } });
        const res = await (await fx.signedInAs(me)).post(`/api/jobs/${job.id}/arrive`);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        const after = await jobRow(job.id);
        expect(after.status).toBe(status);
        expect(after.completed_at?.toISOString()).toBe(stamp.toISOString());
        expect((await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } })).on_site_at).toBeNull();
      },
    );
  });

  it('moves a service-plan visit job\'s plan visit into history when the job is completed', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, completer);
    const plan = await fx.addServicePlan(org, customer);
    const start = new Date(Date.now() + 30 * 86_400_000);
    const scheduled = await (await fx.signedInAs(admin)).post(`/api/service-plans/${plan.id}/schedule-visit`, {
      scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const jobId = scheduled.body.job.id as string;

    const res = await (await fx.signedInAs(me)).post(`/api/jobs/${jobId}/complete`, { cancel_open_visits: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await jobRow(jobId)).status).toBe('OFFICE_REVIEW');
    const planVisit = await db.planVisit.findFirstOrThrow({ where: { job_id: jobId } });
    expect(planVisit.status).toBe('COMPLETED');
    expect(planVisit.completed_at).not.toBeNull();
  });
});

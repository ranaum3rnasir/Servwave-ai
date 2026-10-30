/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.18 - backward moves out of Office review and Ready to close.

   A job leaves Office review or Ready to close for Scheduled, Unscheduled or In Progress through the status door, the
   calendar drag and the reschedule from the job, unschedule, job-level Start and bulk start. It takes the door's own
   switch AND Complete jobs; without Complete jobs the door answers "Only someone who can complete jobs can move this job
   out of office review." Job-level Arrived (single or bulk) is refused on Office review, Ready to close, Done and
   Cancelled, whatever the person holds.

   A backward move is a close-out move, so the completed-job lock does not block it: a person with the step's switch and
   Complete jobs but WITHOUT Change locked jobs is let in, and a Change locked jobs holder WITHOUT Complete jobs is refused
   (the lock key does not open this door). The move lifts the lock while the job is back, keeps the review round with its
   checks and customer decisions (from Ready to close it opens the finished round again), writes one history entry, and the
   next Complete returns the job to Office review on the same round. Bulk crew assign changes crew only and never moves a
   status.

   Everything goes through the public interface (the job routes, called as people on custom roles holding exactly the
   switch values under test, never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite skips
   when it is unset. Every org it creates is removed again. Each refusal compares the job row, its visits, the rounds and
   the history before and after.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why). The client holds ONE connection,
// as the hosted database's does: a backward move that needed a second one inside its transaction would time out here.
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '5');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
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

// The job-completed trigger fires once per Complete and a backward move fires none.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** Every switch on (a choice at its widest option, a list empty): Change locked jobs and Complete jobs included. */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** The PRD's own words (not read from the code). */
const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';
const ARRIVED_IN_REVIEW = "Arrived can't move a job in office review. Use the status menu to send it back.";
const REOPEN_FIRST = 'Reopen this job first';
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

/** Criterion 3's custom role: Mark on my way, Mark arrived and Start and finish visits, and nothing else. */
const CREW_ONLY = { ...OPENING, mark_on_my_way: true, mark_arrived: true, start_and_finish_visits: true };

/** Criterion 4's custom role: Assign people to jobs and Schedule visits, and nothing else. */
const DISPATCHING = { ...OPENING, assign_people_to_jobs: true, assign_work_to_others: true, schedule_visits: true };

const WINDOW = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false };

const IN_REVIEW = ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const;
type ReviewStatus = (typeof IN_REVIEW)[number];

suite('backward moves out of Office review and Ready to close (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['job_reviews', 'record_contact_entries', 'visits']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Reply = { status: number; body: Record<string, any> };

  async function world() {
    const w = await fx.newOrg();
    orgs.push(w.org);
    return w;
  }

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `back-out-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A job as the close-out leaves it: in the status, completed, with one booked visit (crewed by `crew`) and the review round
   * it belongs to (open in Office review, finished in Ready to close and Done), holding one item check.
   */
  async function reviewedJob(w: { org: string; customer: string; admin: Person }, status: ReviewStatus | 'DONE', crew: Person[] = [], visit = true) {
    const job = await fx.addJob(w.org, w.customer, { status });
    const visitId = visit ? await fx.addVisit(w.org, { jobId: job.id, crew: crew.map((p) => p.id) }) : undefined;
    const stamp = new Date(Date.now() - 3_600_000);
    await db.job.update({ where: { id: job.id }, data: { completed_at: stamp, ...(status === 'DONE' ? { closed_at: stamp, closed_by_id: w.admin.id } : {}) } });
    const round = await db.jobReview.create({
      data: {
        organization_id: w.org, job_id: job.id, window_start: new Date(Date.now() - 7_200_000),
        ...(status === 'OFFICE_REVIEW' ? {} : { state: 'FINISHED', finished_by_id: w.admin.id, finished_at: stamp }),
      },
    });
    const entry = await db.timelineEvent.create({
      data: { organization_id: w.org, entity_type: 'JOB', entity_id: job.id, event_type: 'OFFICE_REVIEW_STARTED', description: 'Office review started' },
    });
    await db.jobReviewItemCheck.create({
      data: { organization_id: w.org, review_id: round.id, item_key: 'summary', entry_id: entry.id, checked_by_id: w.admin.id },
    });
    return { ...job, visitId, round };
  }

  /** Everything a refused move could have touched: the job row, its visits, its rounds, their checks and the history. */
  async function snapshot(jobId: string) {
    return {
      job: await db.job.findUniqueOrThrow({ where: { id: jobId } }),
      visits: await db.visit.findMany({ where: { job_id: jobId }, orderBy: { id: 'asc' } }),
      rounds: await db.jobReview.findMany({ where: { job_id: jobId }, orderBy: { id: 'asc' } }),
      checks: await db.jobReviewItemCheck.findMany({ where: { review: { job_id: jobId } }, orderBy: { id: 'asc' } }),
      decisions: await db.jobReviewCustomerDecision.findMany({ where: { review: { job_id: jobId } }, orderBy: { id: 'asc' } }),
      history: await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: jobId } }),
    };
  }

  const backOutEntries = (jobId: string) => db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: 'JOB_MOVED_BACK' } });

  /** Each door, as the call a control makes. */
  const DOORS: Record<string, { target: JobStatus; call: (api: Api, jobId: string) => Promise<Reply> }> = {
    'the status door to In Progress': { target: 'IN_PROGRESS', call: (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'IN_PROGRESS' }) },
    'job-level Start': { target: 'IN_PROGRESS', call: (api, id) => api.post(`/api/jobs/${id}/start`) },
    'bulk start': {
      target: 'IN_PROGRESS',
      call: async (api, id) => {
        const res = await api.post('/api/jobs/bulk-status', { ids: [id], action: 'start' });
        const failed = (res.body.failed as { error: string }[] | undefined)?.[0];
        return failed ? { status: 409, body: { error: failed.error } } : { status: res.status, body: res.body };
      },
    },
    'the status door to Scheduled': { target: 'SCHEDULED', call: (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'SCHEDULED', ...WINDOW }) },
    'a calendar drag (assign with a window)': { target: 'SCHEDULED', call: (api, id) => api.post(`/api/jobs/${id}/assign`, { ...WINDOW, assignee_ids: [] }) },
    'the status door to Unscheduled': { target: 'UNSCHEDULED', call: (api, id) => api.post(`/api/jobs/${id}/status`, { status: 'UNSCHEDULED' }) },
    'unschedule': { target: 'UNSCHEDULED', call: (api, id) => api.post(`/api/jobs/${id}/unassign`, {}) },
  };

  describe('job-level Start, job-level Arrived, the status door and the bulk steps, by a crew-only role on a job it is crewed on', () => {
    for (const status of [...IN_REVIEW, 'DONE'] as const) {
      const refusal = (door: string) => (status === 'DONE' ? REOPEN_FIRST : door.includes('Arrived') || door === 'bulk arrive' ? ARRIVED_IN_REVIEW : NEEDS_COMPLETE);
      const crewDoors: Record<string, (api: Api, jobId: string) => Promise<Reply>> = {
        'job-level Start': DOORS['job-level Start']!.call,
        'job-level Arrived': (api, id) => api.post(`/api/jobs/${id}/arrive`),
        'the status door to In Progress': DOORS['the status door to In Progress']!.call,
        'bulk start': DOORS['bulk start']!.call,
        'bulk arrive': async (api, id) => {
          const res = await api.post('/api/jobs/bulk-status', { ids: [id], action: 'arrive' });
          const failed = (res.body.failed as { error: string }[] | undefined)?.[0];
          return failed ? { status: 409, body: { error: failed.error } } : { status: res.status, body: res.body };
        },
      };

      for (const [door, call] of Object.entries(crewDoors)) {
        it(`refuses ${door} on a ${status} job and changes nothing`, async () => {
          const w = await world();
          const me = await personWith(w.org, CREW_ONLY);
          const job = await reviewedJob(w, status, [me]);
          const before = await snapshot(job.id);

          const res = await call(await me.api(), job.id);

          expect([door, res.status, res.body.error]).toEqual([door, 409, refusal(door)]);
          expect(await snapshot(job.id)).toEqual(before);
        });
      }
    }

    const visitSteps: Record<string, (api: Api, job: { id: string; visitId?: string }) => Promise<Reply>> = {
      'per-visit On my way': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/en-route`, {}),
      'per-visit Arrived': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/arrive`, {}),
      'per-visit Start': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/start`, {}),
      'per-visit Finish visit': (api, job) => api.post(`/api/jobs/${job.id}/visits/${job.visitId}/complete`, {}),
      'job-level On my way': (api, job) => api.post(`/api/jobs/${job.id}/en-route`, {}),
    };

    for (const status of [...IN_REVIEW, 'DONE'] as const) {
      for (const [step, call] of Object.entries(visitSteps)) {
        it(`refuses ${step} on a ${status} job with the lock, and lets a Change locked jobs holder through with the status unchanged`, async () => {
          const w = await world();
          const me = await personWith(w.org, CREW_ONLY);
          const holder = await personWith(w.org, { ...CREW_ONLY, change_locked_jobs: true });
          const locked = await reviewedJob(w, status, [me]);
          const beforeLocked = await snapshot(locked.id);
          const refused = await call(await me.api(), locked);
          expect([step, refused.status, refused.body.error]).toEqual([step, 403, LOCK_MESSAGE]);
          expect(await snapshot(locked.id)).toEqual(beforeLocked);

          const open = await reviewedJob(w, status, [holder]);
          const roundsBefore = (await snapshot(open.id)).rounds;
          const allowed = await call(await holder.api(), open);
          expect([step, allowed.status, allowed.body.error]).toEqual([step, 200, undefined]);
          const after = await snapshot(open.id);
          expect(after.job).toMatchObject({ status, completed_at: expect.any(Date) });
          expect(after.rounds).toEqual(roundsBefore);
        });
      }
    }
  });

  describe('job-level Arrived is refused on Office review, Ready to close, Done and Cancelled whatever the switches', () => {
    for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'] as const) {
      it(`refuses it on a ${status} job for a role holding every switch, single and bulk, and changes nothing`, async () => {
        const w = await world();
        const me = await personWith(w.org, ALL_ON);
        const job = status === 'CANCELLED' ? await fx.addJob(w.org, w.customer, { status, crew: [me.id] }) : await reviewedJob(w, status, [me]);
        const expected = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE' ? ARRIVED_IN_REVIEW : REOPEN_FIRST;
        const before = await snapshot(job.id);
        const api = await me.api();

        const single = await api.post(`/api/jobs/${job.id}/arrive`);
        expect([single.status, single.body.error]).toEqual([409, expected]);

        const bulk = await api.post('/api/jobs/bulk-status', { ids: [job.id], action: 'arrive' });
        expect(bulk.body.updated).toEqual([]);
        expect(bulk.body.failed).toEqual([expect.objectContaining({ id: job.id, error: expected })]);
        expect(await snapshot(job.id)).toEqual(before);
      });
    }
  });

  describe('the move back itself', () => {
    for (const status of IN_REVIEW) {
      for (const [door, { target, call }] of Object.entries(DOORS)) {
        const sent = (jobId: string) => `${door} on a ${status} job (${jobId.slice(0, 4)})`;

        it(`is refused with only the step's switch: ${door} on a ${status} job`, async () => {
          const w = await world();
          const me = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true });
          const job = await reviewedJob(w, status, [me]);
          const before = await snapshot(job.id);

          const res = await call(await me.api(), job.id);

          expect([sent(job.id), res.status, res.body.error]).toEqual([sent(job.id), 409, NEEDS_COMPLETE]);
          expect(await snapshot(job.id)).toEqual(before);
        });

        it(`is refused for a Change locked jobs holder without Complete jobs: ${door} on a ${status} job`, async () => {
          const w = await world();
          const me = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true, change_locked_jobs: true });
          const job = await reviewedJob(w, status, [me]);
          const before = await snapshot(job.id);

          const res = await call(await me.api(), job.id);

          expect([sent(job.id), res.status, res.body.error]).toEqual([sent(job.id), 409, NEEDS_COMPLETE]);
          expect(await snapshot(job.id)).toEqual(before);
        });

        it(`is let in with Complete jobs added, with no key to the lock, keeping the round and its checks: ${door} on a ${status} job`, async () => {
          const w = await world();
          const me = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true, complete_jobs: true, edit_jobs: true });
          const job = await reviewedJob(w, status, [me]);
          const before = await snapshot(job.id);
          const api = await me.api();

          // Locked before the move, for a person without Change locked jobs.
          expect((await api.patch(`/api/jobs/${job.id}`, { description: 'before' })).body.error).toBe(LOCK_MESSAGE);

          const res = await call(api, job.id);
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

          const after = await snapshot(job.id);
          expect(after.job.status).toBe(target);
          expect(after.job.completed_at).toBeNull();
          // The round stays: one round, open, the same one, with its check and customer decisions untouched.
          expect(after.rounds).toHaveLength(1);
          expect(after.rounds[0]).toMatchObject({ id: job.round.id, state: 'OPEN', finished_at: null, finished_by_id: null });
          expect(after.checks).toEqual(before.checks);
          expect(after.decisions).toEqual(before.decisions);
          // One history entry for the move, from and to.
          const entries = await backOutEntries(job.id);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({ created_by: me.id, metadata: expect.objectContaining({ from: status, to: target, review_id: job.round.id }) });
          expect(entries[0]!.description).toMatch(status === 'OFFICE_REVIEW' ? /Office review/ : /Ready to close/);
          // The lock lifted with the status.
          expect((await api.patch(`/api/jobs/${job.id}`, { description: 'after' })).status).toBe(200);
          // No job-completed trigger on the way back.
          expect(dispatched.mock.calls.filter(([e]) => e.type === 'JOB_COMPLETED' && e.entity.id === job.id)).toHaveLength(0);
        });
      }

      it(`the next Complete returns a ${status} job to Office review on the same round, and fires the job-completed trigger once`, async () => {
        const w = await world();
        // Update any visit's status: once Complete has called off the booked visit the dispatcher is crew on nothing.
        const me = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true, complete_jobs: true, update_any_visit_status: true });
        const job = await reviewedJob(w, status, [me]);
        const api = await me.api();

        expect((await api.post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
        const completed = await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true });
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);

        const after = await snapshot(job.id);
        expect(after.job.status).toBe('OFFICE_REVIEW');
        expect(after.rounds).toHaveLength(1);
        expect(after.rounds[0]).toMatchObject({ id: job.round.id, state: 'OPEN' });
        expect(after.checks).toHaveLength(1);
        expect(dispatched.mock.calls.filter(([e]) => e.type === 'JOB_COMPLETED' && e.entity.id === job.id)).toHaveLength(1);

        // And sent back and completed again: the trigger fires again, once more.
        expect((await api.post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
        expect((await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
        expect(dispatched.mock.calls.filter(([e]) => e.type === 'JOB_COMPLETED' && e.entity.id === job.id)).toHaveLength(2);
        expect((await snapshot(job.id)).rounds).toHaveLength(1);
      });
    }

    it('lets the status door to Scheduled send a job back with the window it already holds', async () => {
      const w = await world();
      const me = await personWith(w.org, { ...DISPATCHING, complete_jobs: true });
      const job = await reviewedJob(w, 'OFFICE_REVIEW', [me]);
      const visit = await db.visit.findUniqueOrThrow({ where: { id: job.visitId! } });
      const res = await (await me.api()).post(`/api/jobs/${job.id}/status`, {
        status: 'SCHEDULED', scheduled_start: visit.scheduled_at!.toISOString(), scheduled_end: visit.scheduled_end!.toISOString(), is_all_day: false,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await snapshot(job.id)).job).toMatchObject({ status: 'SCHEDULED', completed_at: null });
    });

    it('sends a job with no booked visit back to Scheduled by booking one, because the move back is the first step', async () => {
      const w = await world();
      const me = await personWith(w.org, { ...DISPATCHING, complete_jobs: true });
      const job = await reviewedJob(w, 'OFFICE_REVIEW', [], false);
      const res = await (await me.api()).post(`/api/jobs/${job.id}/assign`, { ...WINDOW, assignee_ids: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await snapshot(job.id)).job.status).toBe('SCHEDULED');
      expect(await db.visit.count({ where: { job_id: job.id } })).toBe(1);
    });

    it('does not let a person without Complete jobs book a trip on the job either', async () => {
      const w = await world();
      const me = await personWith(w.org, DISPATCHING);
      const job = await reviewedJob(w, 'OFFICE_REVIEW', [], false);
      const before = await snapshot(job.id);
      const res = await (await me.api()).post(`/api/jobs/${job.id}/assign`, { ...WINDOW, assignee_ids: [] });
      expect([res.status, res.body.error]).toEqual([409, NEEDS_COMPLETE]);
      expect(await snapshot(job.id)).toEqual(before);
    });

    it('keeps the crew-only assign under the lock: it never moves a status', async () => {
      const w = await world();
      const me = await personWith(w.org, { ...DISPATCHING, complete_jobs: true, can_be_on_crew: true });
      const holder = await personWith(w.org, { ...DISPATCHING, change_locked_jobs: true, can_be_on_crew: true });
      const job = await reviewedJob(w, 'OFFICE_REVIEW', [me]);
      const refused = await (await me.api()).post(`/api/jobs/${job.id}/assign`, { assignee_ids: [me.id, holder.id] });
      expect([refused.status, refused.body.error]).toEqual([403, LOCK_MESSAGE]);
      const allowed = await (await holder.api()).post(`/api/jobs/${job.id}/assign`, { assignee_ids: [me.id, holder.id] });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect((await snapshot(job.id)).job.status).toBe('OFFICE_REVIEW');
    });
  });

  describe('a review sent back from Ready to close and finished again', () => {
    interface Item { key: string; kind: string; checked: boolean; latest_entry_id: string; contact?: { choice: string | null; removed: boolean } }
    interface Review { version: string; summary: { checked: boolean; latest_entry_id: string | null }; groups: { key: string; items: Item[] }[] }
    const read = async (api: Api, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;
    const contactItems = (r: Review) => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items).filter((i) => i.kind === 'contact');

    /** Check the job summary and tick every customer item the way a person would. */
    async function checkEverything(api: Api, jobId: string) {
      let review = await read(api, jobId);
      if (!review.summary.checked && review.summary.latest_entry_id) {
        const res = await api.post(`/api/jobs/${jobId}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }] });
        expect(res.status).toBe(200);
      }
      review = await read(api, jobId);
      for (const item of contactItems(review)) {
        if (item.checked) continue;
        const res = await api.post(`/api/jobs/${jobId}/review/decisions`, {
          item_key: item.key, entry_id: item.latest_entry_id, ...(item.contact!.choice ? { choice: item.contact!.choice } : {}),
        });
        expect(res.status).toBe(200);
      }
      return read(api, jobId);
    }

    it('keeps the checks and the applied customer decision, and applies nothing to the customer a second time', async () => {
      const w = await world();
      const me = await personWith(w.org, { ...OPENING, office_review: true, complete_jobs: true, start_and_finish_visits: true, update_any_visit_status: true });
      const job = await fx.addJob(w.org, w.customer, { status: 'SCHEDULED' });
      const admin = await fx.signedInAs(w.admin);
      expect((await admin.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: '5552223333' })).status).toBe(201);
      await db.job.update({ where: { id: job.id }, data: { status: 'OFFICE_REVIEW', completed_at: new Date() } });
      const round = await db.jobReview.create({ data: { organization_id: w.org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
      const api = await me.api();

      // Finish the review: the customer gains the phone the reviewer added.
      const checked = await checkEverything(api, job.id);
      expect((await api.post(`/api/jobs/${job.id}/review/finish`, { version: checked.version })).status).toBe(200);
      const phones = () => db.customerPhone.count({ where: { customer_id: w.customer } });
      const customerEntries = () => db.timelineEvent.count({ where: { entity_type: 'CUSTOMER', entity_id: w.customer, event_type: 'CUSTOMER_UPDATED' } });
      expect(await phones()).toBe(1);
      expect(await customerEntries()).toBe(1);
      expect((await db.jobReview.findUniqueOrThrow({ where: { id: round.id } })).state).toBe('FINISHED');

      // Send it back, complete it again: the same round, its customer item still ticked, its decision still applied.
      expect((await api.post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
      expect(await db.jobReview.findUniqueOrThrow({ where: { id: round.id } })).toMatchObject({ state: 'OPEN', finished_at: null, finished_by_id: null });
      expect((await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
      expect(await db.jobReview.count({ where: { job_id: job.id } })).toBe(1);
      const again = await read(api, job.id);
      expect(contactItems(again).every((i) => i.checked)).toBe(true);
      expect(await db.jobReviewCustomerDecision.findMany({ where: { review_id: round.id } })).toEqual([expect.objectContaining({ applied: true })]);

      // The send-back and the second Complete are the close-out's own moves, not changes to the job: the summary stays
      // checked like every other check. Finishing again leaves the customer as it is.
      expect(again.summary.checked).toBe(true);
      const rechecked = await checkEverything(api, job.id);
      expect((await api.post(`/api/jobs/${job.id}/review/finish`, { version: rechecked.version })).status).toBe(200);
      expect((await snapshot(job.id)).job.status).toBe('READY_TO_CLOSE');
      expect(await phones()).toBe(1);
      expect(await customerEntries()).toBe(1);
      // And the job's history says the decision was applied once, not once per finish.
      expect(await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CUSTOMER_DECISION_APPLIED' } })).toBe(1);
    });
  });

  describe('bulk', () => {
    for (const status of IN_REVIEW) {
      it(`bulk start moves a ${status} job back for a Complete jobs holder and lists it as failed for one without`, async () => {
        const w = await world();
        const crew = await personWith(w.org, CREW_ONLY);
        const dispatcher = await personWith(w.org, { ...CREW_ONLY, complete_jobs: true });
        const stuck = await reviewedJob(w, status, [crew]);
        const sentBack = await reviewedJob(w, status, [dispatcher]);

        const refused = await (await crew.api()).post('/api/jobs/bulk-status', { ids: [stuck.id], action: 'start' });
        expect(refused.body.updated).toEqual([]);
        expect(refused.body.failed).toEqual([expect.objectContaining({ id: stuck.id, error: NEEDS_COMPLETE })]);
        expect((await snapshot(stuck.id)).job.status).toBe(status);

        const allowed = await (await dispatcher.api()).post('/api/jobs/bulk-status', { ids: [sentBack.id], action: 'start' });
        expect(allowed.body.failed).toEqual([]);
        expect(allowed.body.updated).toEqual([sentBack.id]);
        const after = await snapshot(sentBack.id);
        expect(after.job).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
        expect(after.rounds[0]).toMatchObject({ id: sentBack.round.id, state: 'OPEN', finished_at: null });
        expect(await backOutEntries(sentBack.id)).toHaveLength(1);
      });

      it(`bulk crew assign changes crew only on a ${status} job and never moves a status; it stays under the lock`, async () => {
        const w = await world();
        const me = await personWith(w.org, { ...DISPATCHING, complete_jobs: true, start_and_finish_visits: true, can_be_on_crew: true });
        const holder = await personWith(w.org, { ...DISPATCHING, change_locked_jobs: true, can_be_on_crew: true });
        const job = await reviewedJob(w, status, [me]);
        const before = await snapshot(job.id);

        const refused = await (await me.api()).post('/api/jobs/bulk-assign', { ids: [job.id], assignee_ids: [me.id, holder.id] });
        expect(refused.body.updated).toEqual([]);
        expect(refused.body.failed).toEqual([expect.objectContaining({ id: job.id, error: LOCK_MESSAGE })]);
        expect(await snapshot(job.id)).toEqual(before);

        const allowed = await (await holder.api()).post('/api/jobs/bulk-assign', { ids: [job.id], assignee_ids: [me.id, holder.id] });
        expect(allowed.body.failed).toEqual([]);
        const after = await snapshot(job.id);
        expect(after.job).toMatchObject({ status, completed_at: before.job.completed_at });
        expect(after.rounds).toEqual(before.rounds);
        const crewIds = (await db.visitAssignee.findMany({ where: { visit_id: job.visitId! } })).map((a) => a.user_id).sort();
        expect(crewIds).toEqual([me.id, holder.id].sort());
      });
    }
  });

  describe('the server tells the job page which controls are open', () => {
    it('answers the words beside Start and Schedule to a person who cannot complete jobs, and opens them to one who can', async () => {
      const w = await world();
      const without = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true, change_locked_jobs: true });
      const withIt = await personWith(w.org, { ...DISPATCHING, start_and_finish_visits: true, complete_jobs: true });
      for (const status of IN_REVIEW) {
        const job = await reviewedJob(w, status);
        const a = (await (await without.api()).get(`/api/jobs/${job.id}`)).body.job;
        expect([status, a.status_door_closed_reason, a.backward_move_open]).toEqual([status, NEEDS_COMPLETE, false]);
        const b = (await (await withIt.api()).get(`/api/jobs/${job.id}`)).body.job;
        expect([status, b.status_door_closed_reason, b.backward_move_open]).toEqual([status, null, true]);
        // The lock still withholds the rest of the finished job from the person without the key.
        expect(b.locked).toBe(true);
        expect(b.locked_actions).toContain('assign');
      }
    });

    it('opens nothing on a job that is still being worked, and says "Reopen this job first" on a Done job', async () => {
      const w = await world();
      const me = await personWith(w.org, { ...DISPATCHING, complete_jobs: true });
      const working = await fx.addJob(w.org, w.customer, { status: 'IN_PROGRESS' });
      const done = await reviewedJob(w, 'DONE');
      const a = (await (await me.api()).get(`/api/jobs/${working.id}`)).body.job;
      expect([a.status_door_closed_reason, a.backward_move_open]).toEqual([null, false]);
      const b = (await (await me.api()).get(`/api/jobs/${done.id}`)).body.job;
      expect([b.status_door_closed_reason, b.backward_move_open]).toEqual([REOPEN_FIRST, false]);
    });
  });
});

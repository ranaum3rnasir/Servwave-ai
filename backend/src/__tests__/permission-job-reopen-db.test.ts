/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.16 - Reopen Done and Cancelled jobs, and the second review round.

   Reopen (M7, Reopen Done jobs) sends a Done or Cancelled job back to In Progress: from Done it clears the completed
   stamp and the Done stamps; from Cancelled the cancel stamp, the reason code and its note. It does not un-void invoices
   or re-book visits. It is refused from the five statuses that are not closed. The lock lifts with the status. The next
   Complete opens a NEW review round whose window starts at the previous round's finish, so the panel shows the job
   summary again and only the changes after that finish.

   Everything goes through the public interface (the job routes, called as people on custom roles holding exactly the
   switch values under test). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

// Reopen fires no automation; the job-completed trigger fires once per Complete, so twice over a reopened job's life.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, invoices_scope: 'all' };

/** The whole round trip: complete, review, close (over money owed), reopen, edit the lines. */
const ROUND_TRIP = {
  ...OPENING, complete_jobs: true, office_review: true, close_jobs: true, close_jobs_with_money_owed: true,
  reopen_done_jobs: true, edit_job_line_items: true,
};

const NOT_CLOSED = /not closed/i;

suite('reopen a Done or Cancelled job (real database)', () => {
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
    const key = `job-reopen-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const reopenSwitch = { ...OPENING, reopen_done_jobs: true };
  const reopen = (api: Api, jobId: string) => api.post(`/api/jobs/${jobId}/reopen`);
  const jobOf = (jobId: string) => db.job.findUniqueOrThrow({ where: { id: jobId } });
  const historyOf = (jobId: string, type: string) =>
    db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: type }, orderBy: { created_at: 'asc' } });
  const actionsOn = async (api: Api, jobId: string): Promise<string[]> => (await api.get(`/api/jobs/${jobId}`)).body.job.actions;

  /** A job as Mark Done leaves it. */
  async function doneJob(org: string, customer: string, closedBy: string) {
    const job = await fx.addJob(org, customer, { status: 'DONE' });
    const at = new Date(Date.now() - 3_600_000);
    await db.job.update({ where: { id: job.id }, data: { completed_at: at, closed_at: new Date(), closed_by_id: closedBy } });
    return job;
  }

  /** A job as Cancel leaves it: the stamp, the reason code and its note, its visit called off and its invoice voided. */
  async function cancelledJob(org: string, customer: string) {
    const job = await fx.addJob(org, customer, { status: 'CANCELLED' });
    await db.job.update({
      where: { id: job.id },
      data: { cancelled_at: new Date(), cancelled_reason: 'Customer moved away', cancel_reason_code: 'PRICE' },
    });
    const visit = await fx.addVisit(org, { jobId: job.id });
    await db.visit.update({ where: { id: visit }, data: { status: 'CANCELLED', cancelled_at: new Date() } });
    const invoice = randomUUID();
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, job_id: job.id, invoice_number: `INV-${invoice.slice(0, 8)}`,
        subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 0, status: 'VOIDED', voided_at: new Date(), voided_reason: 'Job cancelled',
      },
    });
    return { ...job, visit, invoice };
  }

  describe('Done to In Progress', () => {
    it('sends the job back to In Progress, clears the completed and Done stamps, and writes a Reopened history entry', async () => {
      const { org, customer, admin } = await world();
      const me = await personWith(org, reopenSwitch);
      const job = await doneJob(org, customer, admin.id);

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe('IN_PROGRESS');
      const row = await jobOf(job.id);
      expect(row).toMatchObject({ status: 'IN_PROGRESS', completed_at: null, closed_at: null, closed_by_id: null, cancelled_at: null });
      const history = await historyOf(job.id, 'JOB_REOPENED');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ created_by: me.id });
      expect(history[0]!.description).toMatch(/reopened/);
      expect(history[0]!.metadata).toMatchObject({ from: 'DONE', to: 'IN_PROGRESS' });
    });

    it('is refused without Reopen Done jobs, and the job stays Done with its stamps', async () => {
      const { org, customer, admin } = await world();
      const me = await personWith(org, { ...OPENING, complete_jobs: true, close_jobs: true, cancel_jobs: true, change_locked_jobs: true });
      const job = await doneJob(org, customer, admin.id);

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(403);
      const row = await jobOf(job.id);
      expect(row).toMatchObject({ status: 'DONE', closed_by_id: admin.id });
      expect(row.completed_at).not.toBeNull();
      expect(row.closed_at).not.toBeNull();
      expect(await historyOf(job.id, 'JOB_REOPENED')).toHaveLength(0);
    });

    it('reopens a job the old flow left at Completed, so existing data stays reopenable', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, reopenSwitch);
      const job = await fx.addJob(org, customer, { status: 'COMPLETED' });
      await db.job.update({ where: { id: job.id }, data: { completed_at: new Date() } });

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(200);
      expect(await jobOf(job.id)).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
    });
  });

  describe('Cancelled to In Progress', () => {
    it('clears the cancel stamp, the reason code and its note, and leaves the visits called off and the invoices voided', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, reopenSwitch);
      const job = await cancelledJob(org, customer);

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(200);
      expect(await jobOf(job.id)).toMatchObject({
        status: 'IN_PROGRESS', cancelled_at: null, cancelled_reason: null, cancel_reason_code: null, completed_at: null,
      });
      expect((await db.visit.findUniqueOrThrow({ where: { id: job.visit } })).status).toBe('CANCELLED');
      expect((await db.invoice.findUniqueOrThrow({ where: { id: job.invoice } })).status).toBe('VOIDED');
      const history = await historyOf(job.id, 'JOB_REOPENED');
      expect(history).toHaveLength(1);
      expect(history[0]!.metadata).toMatchObject({ from: 'CANCELLED', to: 'IN_PROGRESS' });
    });

    it('lets a new visit in again, which a cancelled job refused', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, { ...reopenSwitch, schedule_visits: true, assign_people_to_jobs: true, edit_jobs: true });
      const api = await me.api();
      const job = await cancelledJob(org, customer);
      const visit = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false, assignee_ids: [] };

      expect((await api.post(`/api/jobs/${job.id}/visits`, visit)).status).toBe(403);
      expect((await reopen(api, job.id)).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/visits`, visit)).status).toBe(201);
    });

    it('is refused without Reopen Done jobs, and the job stays Cancelled with its stamp, reason code and note', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, { ...OPENING, complete_jobs: true, cancel_jobs: true, change_locked_jobs: true, assign_people_to_jobs: true });
      const job = await cancelledJob(org, customer);

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(403);
      const row = await jobOf(job.id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancelled_reason: 'Customer moved away', cancel_reason_code: 'PRICE' });
      expect(row.cancelled_at).not.toBeNull();
    });
  });

  describe('the statuses that are not closed', () => {
    const NOT_CLOSED_STATUSES: JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'READY_TO_CLOSE'];

    it.each(NOT_CLOSED_STATUSES)('refuses a job in %s, also for a holder, and changes nothing', async (status) => {
      const { org, customer } = await world();
      const me = await personWith(org, { ...reopenSwitch, change_locked_jobs: true });
      const job = await fx.addJob(org, customer, { status });
      const completed = status === 'OFFICE_REVIEW' || status === 'READY_TO_CLOSE' ? new Date() : null;
      if (completed) await db.job.update({ where: { id: job.id }, data: { completed_at: completed } });

      const res = await reopen(await me.api(), job.id);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JOB_CLOSE_OUT_REFUSED');
      expect(res.body.error).toMatch(NOT_CLOSED);
      const row = await jobOf(job.id);
      expect(row.status).toBe(status);
      expect(row.completed_at?.toISOString() ?? null).toBe(completed?.toISOString() ?? null);
      expect(await historyOf(job.id, 'JOB_REOPENED')).toHaveLength(0);
    });

    it('leaves a way out of Office review and Ready to close that is not Reopen: the status menu for a holder of Complete jobs (S06.18), and Cancel', async () => {
      const { org, customer } = await world();
      const holder = await personWith(org, { ...reopenSwitch, change_locked_jobs: true, complete_jobs: true, start_and_finish_visits: true, update_any_visit_status: true, cancel_jobs: true });
      const api = await holder.api();
      for (const status of ['OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
        const job = await fx.addJob(org, customer, { status });
        expect((await reopen(api, job.id)).status, `${status} reopen`).toBe(409);
        const moved = await api.post(`/api/jobs/${job.id}/status`, { status: 'IN_PROGRESS' });
        expect([moved.status, moved.body.error], `${status} status menu`).toEqual([200, undefined]);
        expect((await jobOf(job.id)).status).toBe('IN_PROGRESS');

        const second = await fx.addJob(org, customer, { status });
        const cancelled = await api.post(`/api/jobs/${second.id}/cancel`, { cancel_reason_code: 'PRICE' });
        expect([cancelled.status, cancelled.body.error], `${status} cancel`).toEqual([200, undefined]);
        // And the way back out of Cancelled is Reopen.
        expect((await reopen(api, second.id)).status, `${status} cancelled reopen`).toBe(200);
      }
    });
  });

  describe('the job action list', () => {
    it('offers Reopen on a Done and a Cancelled job to a holder, and on no other status', async () => {
      const { org, customer, admin } = await world();
      const me = await personWith(org, reopenSwitch);
      const api = await me.api();
      const done = await doneJob(org, customer, admin.id);
      const cancelled = await cancelledJob(org, customer);
      expect(await actionsOn(api, done.id)).toContain('reopen');
      expect(await actionsOn(api, cancelled.id)).toContain('reopen');
      for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
        const job = await fx.addJob(org, customer, { status });
        expect(await actionsOn(api, job.id), status).not.toContain('reopen');
      }
    });

    it('does not offer Reopen without Reopen Done jobs', async () => {
      const { org, customer, admin } = await world();
      const me = await personWith(org, { ...OPENING, complete_jobs: true, cancel_jobs: true, change_locked_jobs: true });
      const api = await me.api();
      expect(await actionsOn(api, (await doneJob(org, customer, admin.id)).id)).not.toContain('reopen');
      expect(await actionsOn(api, (await cancelledJob(org, customer)).id)).not.toContain('reopen');
    });

    it('stops offering it once the job is reopened', async () => {
      const { org, customer, admin } = await world();
      const me = await personWith(org, reopenSwitch);
      const api = await me.api();
      const job = await doneJob(org, customer, admin.id);
      expect((await reopen(api, job.id)).status).toBe(200);
      expect(await actionsOn(api, job.id)).not.toContain('reopen');
    });
  });

  describe('the second review round', () => {
    /** The review panel's items, flat, summary left out. */
    interface Item { key: string; kind: string; summary: string; checked: boolean; unusual: boolean; unusual_reason: string | null; latest_entry_id: string }
    interface Review {
      version: string;
      summary: { checked: boolean; latest_entry_id: string | null };
      groups: { key: string; items: Item[] }[];
      totals: { items: number; checked: number; unusual: number };
      round: { id: string; state: string; window_start: string } | null;
    }
    const readReview = async (api: Api, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;
    const itemsOf = (r: Review): Item[] => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

    /** Check the job summary and every item, then finish the review. */
    async function checkAndFinish(api: Api, jobId: string) {
      const review = await readReview(api, jobId);
      const items = [
        ...(review.summary.latest_entry_id ? [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }] : []),
        ...itemsOf(review).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id })),
      ];
      expect((await api.post(`/api/jobs/${jobId}/review/checks/all`, { items })).status).toBe(200);
      const fresh = await readReview(api, jobId);
      const finished = await api.post(`/api/jobs/${jobId}/review/finish`, { version: fresh.version });
      expect([finished.status, finished.body.error]).toEqual([200, undefined]);
    }

    const markDone = async (api: Api, jobId: string) => {
      const owed = (await api.get(`/api/jobs/${jobId}`)).body.job.ready_to_close.amount_owed as number;
      const res = await api.post(`/api/jobs/${jobId}/mark-done`, { confirmed_amount: owed });
      expect([res.status, res.body.error]).toEqual([200, undefined]);
    };

    it('opens a new round at the first round\'s finish, and shows the summary again with only what changed after it', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, ROUND_TRIP);
      const api = await me.api();
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });

      // Round one: two lines are added (one of them will be cut later), the job is completed, reviewed and closed.
      const hinge = (await api.post(`/api/jobs/${job.id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 100 })).body;
      const hingeId = (hinge.line ?? hinge.item ?? hinge).id as string;
      expect(hingeId).toBeTruthy();
      const bracket = (await api.post(`/api/jobs/${job.id}/line-items`, { description: 'Bracket', quantity: 1, unit_price: 20 })).body;
      expect((bracket.line ?? bracket.item ?? bracket).id).toBeTruthy();
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      const first = await readReview(api, job.id);
      expect(first.totals.items).toBe(3);
      await checkAndFinish(api, job.id);
      await markDone(api, job.id);
      const roundOne = await db.jobReview.findFirstOrThrow({ where: { job_id: job.id } });
      expect(roundOne.state).toBe('FINISHED');
      const finishedAt = roundOne.finished_at!;

      // Reopen, then change the job in round two: the hinge is cut, a seal is added.
      expect((await reopen(api, job.id)).status).toBe(200);
      expect((await api.patch(`/api/jobs/${job.id}/line-items/${hingeId}`, { unit_price: 80 })).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/line-items`, { description: 'Seal', quantity: 1, unit_price: 15 })).status).toBe(201);
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      expect((await jobOf(job.id)).status).toBe('OFFICE_REVIEW');

      const rounds = await db.jobReview.findMany({ where: { job_id: job.id }, orderBy: { created_at: 'asc' } });
      expect(rounds).toHaveLength(2);
      expect(rounds[1]).toMatchObject({ state: 'OPEN', finished_at: null });
      expect(rounds[1]!.window_start.toISOString()).toBe(finishedAt.toISOString());

      const second = await readReview(api, job.id);
      expect(second.round).toMatchObject({ id: rounds[1]!.id, state: 'OPEN' });
      // The job summary is back, unchecked: nothing carries over from round one's checks.
      expect(second.summary.checked).toBe(false);
      const items = itemsOf(second);
      expect(items.map((i) => i.summary).join(' | ')).not.toContain('Bracket');
      expect(items).toHaveLength(2);
      expect(items.every((i) => !i.checked)).toBe(true);
      expect(second.totals).toMatchObject({ items: 3, checked: 0, unusual: 1 });
      // The cut line is flagged against the price it had at round one's finish, not against nothing.
      const cut = items.find((i) => i.key === `line:${hingeId}`)!;
      expect(cut.unusual).toBe(true);
      expect(cut.unusual_reason).toBe('A price was lowered');
      expect(cut.summary).toContain('$100.00 to $80.00');
      expect(cut.summary).not.toContain('Line added');
      expect(items.find((i) => i.key !== `line:${hingeId}`)!.unusual).toBe(false);

      // The round can be finished only after everything in it is checked.
      const refused = await api.post(`/api/jobs/${job.id}/review/finish`, { version: second.version });
      expect(refused.status).toBe(409);
      await checkAndFinish(api, job.id);
      expect((await jobOf(job.id)).status).toBe('READY_TO_CLOSE');
    });

    it('shows a change made between round one\'s finish and the reopen as a change of round two', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, ROUND_TRIP);
      const api = await me.api();
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      await checkAndFinish(api, job.id);
      await markDone(api, job.id);
      const finishedAt = (await db.jobReview.findFirstOrThrow({ where: { job_id: job.id } })).finished_at!;
      await db.timelineEvent.create({
        data: {
          organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_NOTE_ADDED', description: 'Note added',
          metadata: { note_id: randomUUID() }, created_at: new Date(finishedAt.getTime() + 1000),
        },
      });
      expect((await reopen(api, job.id)).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);

      const review = await readReview(api, job.id);
      expect(itemsOf(review).map((i) => i.kind)).toEqual(['note']);
    });

    it('fires the job-completed automation once at each Complete and none at Reopen', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, ROUND_TRIP);
      const api = await me.api();
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      dispatched.mockClear();

      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      await checkAndFinish(api, job.id);
      await markDone(api, job.id);
      expect((await reopen(api, job.id)).status).toBe(200);
      const types = () => dispatched.mock.calls.map(([e]) => (e as { type: string }).type);
      expect(types()).toEqual(['JOB_COMPLETED']);
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      expect(types()).toEqual(['JOB_COMPLETED', 'JOB_COMPLETED']);
    });

    it('lets Complete run again after Reopen from Cancelled, which it refused before', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, ROUND_TRIP);
      const api = await me.api();
      const job = await cancelledJob(org, customer);

      const before = await api.post(`/api/jobs/${job.id}/complete`, {});
      expect(before.status).toBe(409);
      expect(before.body.error).toBe('Reopen this job first');

      expect((await reopen(api, job.id)).status).toBe(200);
      expect((await api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true })).status).toBe(200);
      expect((await jobOf(job.id)).status).toBe('OFFICE_REVIEW');
      expect(await db.jobReview.count({ where: { job_id: job.id } })).toBe(1);
    });

    it('keeps an open round open through a cancel and a reopen, and the next Complete returns to it with its checks', async () => {
      const { org, customer } = await world();
      const me = await personWith(org, { ...ROUND_TRIP, cancel_jobs: true });
      const api = await me.api();
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);
      const open = await db.jobReview.findFirstOrThrow({ where: { job_id: job.id } });
      const review = await readReview(api, job.id);
      expect((await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }] })).status).toBe(200);

      expect((await api.post(`/api/jobs/${job.id}/cancel`, { cancel_reason_code: 'PRICE' })).status).toBe(200);
      expect((await reopen(api, job.id)).status).toBe(200);
      expect(await db.jobReview.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({ state: 'OPEN', finished_at: null });
      expect((await api.post(`/api/jobs/${job.id}/complete`, {})).status).toBe(200);

      const rounds = await db.jobReview.findMany({ where: { job_id: job.id } });
      expect(rounds.map((r) => r.id)).toEqual([open.id]);
      expect(await db.jobReviewItemCheck.count({ where: { review_id: open.id } })).toBe(1);
    });
  });
});

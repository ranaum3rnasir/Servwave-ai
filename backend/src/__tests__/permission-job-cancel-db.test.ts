/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.15 - Cancel needs a reason from the list, single and bulk.

   POST /api/jobs/:id/cancel, POST /api/jobs/:id/status (to Cancelled) and POST /api/jobs/bulk-status (cancel) all ask the
   close-out state machine: Cancel jobs, a reason code the job's own org offers, and any status but Done. The job stores
   the reason CODE; the history and the job page read the label at read time. Everything goes through the public interface
   (the job routes, called as people on custom roles holding exactly the switch values under test).
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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

// Automations are fire-and-forget; here only whether a re-cancel fires one matters.
const { dispatched } = vi.hoisted(() => ({ dispatched: vi.fn() }));
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: dispatched }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { BUILT_IN_JOB_CANCEL_REASONS } from '../lib/jobCancelReasons';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

const REOPEN_FIRST = 'Reopen this job first';
const PRICE = BUILT_IN_JOB_CANCEL_REASONS.find((r) => r.code === 'PRICE')!;

suite('cancel a job with a reason from the list (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    for (const org of orgs) {
      for (const table of ['job_reviews', 'job_cancel_reason_options', 'visits']) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`).catch(() => undefined);
      }
    }
    await fx.cleanup();
  });

  let sequence = 0;
  type Setup = Awaited<ReturnType<typeof fx.newOrg>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  async function org(): Promise<Setup> {
    const s = await fx.newOrg();
    orgs.push(s.org);
    return s;
  }

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(orgId: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-cancel-role-${++sequence}`;
    const role = await fx.addCustomRole(orgId, key, base);
    await setRoleSwitchValues({ organizationId: orgId, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(orgId, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** Someone who cancels jobs and nothing else. */
  const canceller = (orgId: string, extra: Record<string, SwitchValue> = {}) => personWith(orgId, { ...OPENING, cancel_jobs: true, ...extra });

  const job = (s: Setup, status: JobStatus = 'IN_PROGRESS') => fx.addJob(s.org, s.customer, { status });
  const cancel = (api: Api, jobId: string, body: Record<string, unknown> = { cancel_reason_code: 'PRICE' }) => api.post(`/api/jobs/${jobId}/cancel`, body);
  const rowOf = (jobId: string) => db.job.findUniqueOrThrow({ where: { id: jobId } });
  const eventsOf = (jobId: string, type: string) => db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: type }, orderBy: { created_at: 'asc' } });
  const historyOf = async (api: Api, jobId: string) => (await api.get(`/api/jobs/${jobId}/timeline`)).body.events as { event_type: string; description: string }[];
  /** The company's own list, edited as its admin (Company settings). */
  const admin = async (s: Setup) => fx.signedInAs(s.admin);

  describe('a single cancel', () => {
    it('cancels with an active reason and no note, storing the reason code', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s);

      const res = await cancel(await me.api(), j.id);

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe('CANCELLED');
      const row = await rowOf(j.id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PRICE', cancelled_reason: null });
      expect(row.cancelled_at).not.toBeNull();
    });

    it('keeps the optional note beside the code', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s);

      const res = await cancel(await me.api(), j.id, { cancel_reason_code: 'PRICE', cancelled_reason: 'Quoted too high for the season' });

      expect(res.status).toBe(200);
      expect(await rowOf(j.id)).toMatchObject({ cancel_reason_code: 'PRICE', cancelled_reason: 'Quoted too high for the season' });
    });

    it('is refused without Cancel jobs, and the job stays as it was', async () => {
      const s = await org();
      const me = await personWith(s.org, { ...OPENING });
      const j = await job(s);

      const res = await cancel(await me.api(), j.id);

      expect(res.status).toBe(403);
      expect((await rowOf(j.id)).status).toBe('IN_PROGRESS');
    });

    it('is let in with Cancel jobs on, whatever else is off', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s);
      expect((await cancel(await me.api(), j.id)).status).toBe(200);
    });

    it('is refused with no reason, an unknown code and a blank code, changing nothing', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      for (const body of [{}, { cancelled_reason: 'only a note' }, { cancel_reason_code: 'NOT_A_REASON' }, { cancel_reason_code: '   ' }]) {
        const j = await job(s);
        const res = await cancel(api, j.id, body);
        expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(await rowOf(j.id)).toMatchObject({ status: 'IN_PROGRESS', cancel_reason_code: null, cancelled_at: null });
      }
    });

    it('is refused for a turned-off reason, but a job that used it keeps showing it', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      const used = await job(s);
      expect((await cancel(api, used.id, { cancel_reason_code: 'DUPLICATE_JOB' })).status).toBe(200);

      expect((await (await admin(s)).patch('/api/job-cancel-reasons/DUPLICATE_JOB', { is_active: false })).status).toBe(200);

      const next = await job(s);
      const refused = await cancel(api, next.id, { cancel_reason_code: 'DUPLICATE_JOB' });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect((await rowOf(next.id)).status).toBe('IN_PROGRESS');
      const shown = (await api.get(`/api/jobs/${used.id}`)).body.job;
      expect(shown.cancel_reason).toMatchObject({ code: 'DUPLICATE_JOB', label: 'Duplicate job', is_active: false });
    });

    it("never accepts another company's reason, nor offers it", async () => {
      const a = await org();
      const b = await org();
      expect((await (await admin(b)).post('/api/job-cancel-reasons', { label: 'Storm damage' })).status).toBe(201);
      const me = await canceller(a.org);
      const j = await job(a);

      const res = await cancel(await me.api(), j.id, { cancel_reason_code: 'STORM_DAMAGE' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect((await rowOf(j.id)).status).toBe('IN_PROGRESS');
    });

    it('accepts a reason the company added', async () => {
      const s = await org();
      expect((await (await admin(s)).post('/api/job-cancel-reasons', { label: 'Storm damage' })).status).toBe(201);
      const me = await canceller(s.org);
      const j = await job(s);
      expect((await cancel(await me.api(), j.id, { cancel_reason_code: 'STORM_DAMAGE' })).status).toBe(200);
      expect((await rowOf(j.id)).cancel_reason_code).toBe('STORM_DAMAGE');
    });

    it('refuses a Done job with "Reopen this job first" and writes nothing', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s, 'DONE');

      const res = await cancel(await me.api(), j.id);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(REOPEN_FIRST);
      expect(await rowOf(j.id)).toMatchObject({ status: 'DONE', cancel_reason_code: null, cancelled_at: null });
      expect(await eventsOf(j.id, 'CANCELLED')).toHaveLength(0);
    });

    it.each(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'READY_TO_CLOSE'] as const)('cancels a job that is %s', async (status) => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s, status);
      expect((await cancel(await me.api(), j.id)).status).toBe(200);
      expect((await rowOf(j.id)).status).toBe('CANCELLED');
    });

    it('leaves an open review round open when it cancels a job in Office review', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s, 'OFFICE_REVIEW');
      const round = await db.jobReview.create({ data: { organization_id: s.org, job_id: j.id, window_start: new Date(Date.now() - 86_400_000) }, select: { id: true } });

      expect((await cancel(await me.api(), j.id)).status).toBe(200);

      expect(await db.jobReview.findUniqueOrThrow({ where: { id: round.id } })).toMatchObject({ state: 'OPEN', finished_at: null });
    });

    it("names the reason's label on the job's history, and shows a later rename", async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      const j = await job(s);
      await cancel(api, j.id);

      const before = (await historyOf(api, j.id)).find((e) => e.event_type === 'CANCELLED')!;
      expect(before.description).toContain(PRICE.label);

      expect((await (await admin(s)).patch('/api/job-cancel-reasons/PRICE', { label: 'Too expensive' })).status).toBe(200);

      const after = (await historyOf(api, j.id)).find((e) => e.event_type === 'CANCELLED')!;
      expect(after.description).toContain('Too expensive');
      expect(after.description).not.toContain(PRICE.label);
      expect((await api.get(`/api/jobs/${j.id}`)).body.job.cancel_reason).toMatchObject({ code: 'PRICE', label: 'Too expensive', is_active: true });
    });

    it('shows a job cancelled before the list existed by its written reason alone', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s, 'CANCELLED');
      await db.job.update({ where: { id: j.id }, data: { cancelled_at: new Date(), cancelled_reason: 'Customer moved away' } });

      const shown = (await (await me.api()).get(`/api/jobs/${j.id}`)).body.job;

      expect(shown.cancel_reason).toBeNull();
      expect(shown.cancelled_reason).toBe('Customer moved away');
    });

    it('re-cancels a cancelled job to change the reason: one more history entry, no second clean-up', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      const j = await job(s);
      await cancel(api, j.id, { cancel_reason_code: 'PRICE' });
      const first = await rowOf(j.id);
      dispatched.mockClear();

      const res = await cancel(api, j.id, { cancel_reason_code: 'OTHER', cancelled_reason: 'Never mind' });

      expect(res.status).toBe(200);
      const row = await rowOf(j.id);
      expect(row).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'OTHER', cancelled_reason: 'Never mind' });
      expect(row.cancelled_at!.getTime()).toBe(first.cancelled_at!.getTime());
      // The cancel went into the history once; the change of reason is its own, single entry that says so.
      expect(await eventsOf(j.id, 'CANCELLED')).toHaveLength(1);
      const changes = await eventsOf(j.id, 'CANCEL_REASON_CHANGED');
      expect(changes).toHaveLength(1);
      expect(changes[0]!.description).toMatch(/reason changed/i);
      expect(changes[0]!.description).toContain('Other');
      // No second clean-up: nothing fired the cancelled automation again.
      expect(dispatched).not.toHaveBeenCalled();
    });

    it('cancels through the status door the same way: a reason is required there too', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      const without = await job(s);
      const missing = await api.post(`/api/jobs/${without.id}/status`, { status: 'CANCELLED' });
      expect(missing.status).toBe(400);
      expect((await rowOf(without.id)).status).toBe('IN_PROGRESS');

      const j = await job(s);
      const res = await api.post(`/api/jobs/${j.id}/status`, { status: 'CANCELLED', cancel_reason_code: 'PRICE' });
      expect(res.status).toBe(200);
      expect(await rowOf(j.id)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PRICE' });
    });

    it('is not a locked edit: a person with only Cancel jobs cancels a job in Office review', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const j = await job(s, 'OFFICE_REVIEW');
      expect((await cancel(await me.api(), j.id)).status).toBe(200);
    });

    it('is offered by the job page only where the route would let it in', async () => {
      const s = await org();
      const holder = await canceller(s.org);
      const other = await personWith(s.org, { ...OPENING });
      const open = await job(s);
      const done = await job(s, 'DONE');

      const offered = async (who: typeof holder, jobId: string) => ((await (await who.api()).get(`/api/jobs/${jobId}`)).body.job.actions as string[]).includes('cancel');

      expect(await offered(holder, open.id)).toBe(true);
      expect(await offered(other, open.id)).toBe(false);
      expect(await offered(holder, done.id)).toBe(false);
    });

    it('reaches only the jobs the person can reach', async () => {
      const s = await org();
      const me = await canceller(s.org, { jobs_scope: 'attached' });
      const j = await job(s);
      const res = await cancel(await me.api(), j.id);
      expect([403, 404]).toContain(res.status);
      expect((await rowOf(j.id)).status).toBe('IN_PROGRESS');
    });
  });

  describe('a bulk cancel', () => {
    const bulk = (api: Api, ids: string[], body: Record<string, unknown> = { cancel_reason_code: 'PRICE' }) =>
      api.post('/api/jobs/bulk-status', { ids, action: 'cancel', ...body });

    it('is refused as a whole without Cancel jobs', async () => {
      const s = await org();
      const me = await personWith(s.org, { ...OPENING });
      const a = await job(s);
      const res = await bulk(await me.api(), [a.id]);
      expect(res.status).toBe(403);
      expect((await rowOf(a.id)).status).toBe('IN_PROGRESS');
    });

    it('is refused as a whole without a reason, an unknown one or a blank one', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const api = await me.api();
      const a = await job(s);
      for (const body of [{}, { cancelled_reason: 'a note only' }, { cancel_reason_code: '' }, { cancel_reason_code: 'NOT_A_REASON' }]) {
        const res = await bulk(api, [a.id], body);
        expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect((await rowOf(a.id)).status).toBe('IN_PROGRESS');
      }
    });

    it('cancels the In Progress job with that reason and lists the Done job as failed with "Reopen this job first"', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const running = await job(s, 'IN_PROGRESS');
      const finished = await job(s, 'DONE');

      const res = await bulk(await me.api(), [running.id, finished.id], { cancel_reason_code: 'WENT_WITH_A_COMPETITOR', cancelled_reason: 'Batch note' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toEqual([running.id]);
      expect(res.body.failed).toEqual([expect.objectContaining({ id: finished.id, error: REOPEN_FIRST })]);
      expect(await rowOf(running.id)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'WENT_WITH_A_COMPETITOR', cancelled_reason: 'Batch note' });
      expect(await rowOf(finished.id)).toMatchObject({ status: 'DONE', cancel_reason_code: null });
    });

    it('lists a job outside the person\'s reach with the reason it gives today, and cancels the rest', async () => {
      const s = await org();
      const me = await canceller(s.org, { jobs_scope: 'attached' });
      const mine = await fx.addJob(s.org, s.customer, { status: 'IN_PROGRESS', crew: [me.id] });
      const theirs = await job(s);

      const res = await bulk(await me.api(), [mine.id, theirs.id]);

      expect(res.status).toBe(200);
      expect(res.body.updated).toEqual([mine.id]);
      expect(res.body.failed).toEqual([expect.objectContaining({ id: theirs.id, error: 'Insufficient permissions' })]);
    });

    it('lists every refused job with its reason', async () => {
      const s = await org();
      const me = await canceller(s.org);
      const d1 = await job(s, 'DONE');
      const d2 = await job(s, 'DONE');
      const ok = await job(s, 'SCHEDULED');

      const res = await bulk(await me.api(), [d1.id, ok.id, d2.id]);

      expect(res.body.updated).toEqual([ok.id]);
      expect(res.body.failed.map((f: { id: string }) => f.id).sort()).toEqual([d1.id, d2.id].sort());
    });
  });
});

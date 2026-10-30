/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.23 - no new visit on a locked job.

   Add visit is refused on a Completed and on a Cancelled job for everyone, a holder of Change locked jobs included:
   the lock (S04.22) lets that holder change what the job already holds, but a finished job takes no new trip. The
   refusal reads "Reopen this job first". After a Reopen the visit is let in. The per-record answer tells the page
   when a new visit is closed, so the control is drawn disabled with the same words.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The PRD's own wording for the refusal and the disabled control (not read from the code). */
const REOPEN_FIRST = 'Reopen this job first';
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening the job takes, with no action switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', create_jobs: true,
  view_invoices: true, invoices_scope: 'all', view_estimates: true, estimates_scope: 'all',
};

const SCHEDULING = { edit_jobs: true, schedule_visits: true, assign_people_to_jobs: true, assign_work_to_others: true };

const body = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z', is_all_day: false, assignee_ids: [] };

suite('no new visit on a locked job (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `add-visit-lock-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const visitCount = (jobId: string) => db.visit.count({ where: { job_id: jobId } });

  for (const status of ['COMPLETED', 'CANCELLED'] as const) {
    describe(`a ${status} job`, () => {
      it('refuses Add visit with "Reopen this job first" to a person who may schedule visits', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...SCHEDULING });
        const job = await fx.addJob(org, customer, { status });
        const before = await visitCount(job.id);
        const res = await (await me.api()).post(`/api/jobs/${job.id}/visits`, body);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe(REOPEN_FIRST);
        expect(await visitCount(job.id)).toBe(before);
      });

      it('refuses it even to a holder of Change locked jobs, who can change everything else the job holds', async () => {
        const { org, customer } = await fx.newOrg();
        const holder = await personWith(org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        const before = await visitCount(job.id);
        const api = await holder.api();
        const res = await api.post(`/api/jobs/${job.id}/visits`, body);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe(REOPEN_FIRST);
        expect(await visitCount(job.id)).toBe(before);
        // Not the lock: the same holder still changes the existing job.
        expect((await api.patch(`/api/jobs/${job.id}`, { description: 'changed by the holder' })).status).toBe(200);
      });

      it('answers the person who may not schedule visits with their own switch refusal, not the new words', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING });
        const job = await fx.addJob(org, customer, { status });
        const res = await (await me.api()).post(`/api/jobs/${job.id}/visits`, body);
        expect(res.status).toBe(403);
        expect(res.body.error).not.toBe(REOPEN_FIRST);
      });

      it('says in the per-record answer that a new visit is closed, to a holder and to everyone else', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...SCHEDULING });
        const holder = await personWith(org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        for (const person of [me, holder]) {
          const answer = (await (await person.api()).get(`/api/jobs/${job.id}`)).body.job;
          expect(answer.new_visit_closed).toBe(true);
        }
        // The holder is not locked out of the job's other changes: only the new visit is closed.
        const held = (await (await holder.api()).get(`/api/jobs/${job.id}`)).body.job;
        expect(held.locked).toBe(false);
        expect(held.actions).toContain('schedule');
      });

      it('refuses the two other doors that would mint a trip: the job edit and Assign, and the job keeps its status', async () => {
        const { org, customer } = await fx.newOrg();
        const holder = await personWith(org, { ...OPENING, ...SCHEDULING, change_locked_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        const api = await holder.api();
        const window = { scheduled_start: body.scheduled_start, scheduled_end: body.scheduled_end };
        const edit = await api.patch(`/api/jobs/${job.id}`, window);
        expect(edit.status).toBe(403);
        expect(edit.body.error).toBe(REOPEN_FIRST);
        const assign = await api.post(`/api/jobs/${job.id}/assign`, { ...window, is_all_day: false, assignee_ids: [] });
        // S06.17: on a Cancelled job Assign's moving window is refused by the close-out state machine, the same words as a 409.
        expect(assign.status).toBe(status === 'CANCELLED' ? 409 : 403);
        expect(assign.body.error).toBe(REOPEN_FIRST);
        expect(await visitCount(job.id)).toBe(0);
        expect((await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status).toBe(status);
      });

      it('lets Add visit in after a Reopen', async () => {
        const { org, customer } = await fx.newOrg();
        const me = await personWith(org, { ...OPENING, ...SCHEDULING, reopen_done_jobs: true });
        const job = await fx.addJob(org, customer, { status });
        const api = await me.api();
        expect((await api.post(`/api/jobs/${job.id}/visits`, body)).body.error).toBe(REOPEN_FIRST);
        expect((await api.post(`/api/jobs/${job.id}/reopen`)).status).toBe(200);
        const before = await visitCount(job.id);
        const res = await api.post(`/api/jobs/${job.id}/visits`, body);
        expect(res.status).toBe(201);
        expect(await visitCount(job.id)).toBe(before + 1);
        const answer = (await api.get(`/api/jobs/${job.id}`)).body.job;
        expect(answer.new_visit_closed).toBe(false);
      });
    });
  }

  it('leaves Add visit open on a job that is still open', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, ...SCHEDULING });
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const api = await me.api();
    const res = await api.post(`/api/jobs/${job.id}/visits`, body);
    expect(res.status).toBe(201);
    expect((await api.get(`/api/jobs/${job.id}`)).body.job.new_visit_closed).toBe(false);
  });

  it('never tells anyone the status of a job they cannot open', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...OPENING, ...SCHEDULING, jobs_scope: 'attached' });
    const job = await fx.addJob(org, customer, { status: 'COMPLETED', crew: [colleague.id] });
    const res = await (await me.api()).post(`/api/jobs/${job.id}/visits`, body);
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(REOPEN_FIRST);
    expect(res.body.error).not.toBe(LOCK_MESSAGE);
  });
});

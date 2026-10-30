/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.17 - completing a job that still has open visits.

   The job-level complete is the only way to Completed, wherever it appears (job page, board, Jobs list bulk
   Completed). When the job, or any job in a bulk batch, still has open visits (booked, on the way, on site or
   started) the server refuses unless the request says to cancel them. With that choice the open visits become
   Cancelled (never finished, stamps kept) and the job Completed. Finished and already-cancelled visits are history.

   Everything goes through the public interface: the three complete doors, called as people on custom roles
   holding exactly the switch values under test, and the rows they leave behind. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role, VisitStatus } from '@prisma/client';

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

suite('completing a job with open visits (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other toggle off). */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `open-visits-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
  }

  const opensJobs = { view_jobs: true, jobs_scope: 'all' };
  const completer = { ...opensJobs, complete_jobs: true };

  /** A job with one visit per given status (the first visit's stamps are set when it has been worked). */
  async function jobWithVisits(org: string, customer: string, statuses: VisitStatus[]) {
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const visits: string[] = [];
    for (const [i, status] of statuses.entries()) {
      const id = await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2 + i, seq: i + 1 });
      const worked = status === 'ON_SITE' || status === 'IN_PROGRESS' || status === 'COMPLETED';
      await db.visit.update({
        where: { id },
        data: {
          status,
          ...(worked ? { on_site_at: new Date('2026-01-05T10:00:00Z') } : {}),
          ...(status === 'IN_PROGRESS' || status === 'COMPLETED' ? { started_at: new Date('2026-01-05T10:05:00Z') } : {}),
          ...(status === 'COMPLETED' ? { completed_at: new Date('2026-01-05T11:00:00Z') } : {}),
        },
      });
      visits.push(id);
    }
    return { id: job.id, visits };
  }

  const jobStatus = async (id: string) => (await db.job.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const visitStatuses = async (ids: string[]) =>
    (await db.visit.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((v) => v.status);

  describe('the job page and board door (POST /api/jobs/:id/complete)', () => {
    it('refuses a complete over a booked visit without the cancel choice, and lists the open visits', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await jobWithVisits(org, customer, ['COMPLETED', 'SCHEDULED']);
      const api = await fx.signedInAs(me);

      const res = await api.post(`/api/jobs/${job.id}/complete`).send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JOB_COMPLETE_HAS_OPEN_VISITS');
      expect(res.body.open_visits).toEqual([expect.objectContaining({ id: job.visits[1], visit_seq: 2, status: 'SCHEDULED' })]);
      // Nothing changed: the job is not Completed and no visit was touched.
      expect(await jobStatus(job.id)).not.toBe('OFFICE_REVIEW');
      expect(await visitStatuses(job.visits)).toEqual(['COMPLETED', 'SCHEDULED']);
    });

    it('with the cancel choice, cancels every open visit (never finishes one) and completes the job', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await jobWithVisits(org, customer, ['COMPLETED', 'SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS', 'CANCELLED']);
      const api = await fx.signedInAs(me);

      const res = await api.post(`/api/jobs/${job.id}/complete`).send({ cancel_open_visits: true });

      expect(res.status).toBe(200);
      expect(await jobStatus(job.id)).toBe('OFFICE_REVIEW');
      expect(await visitStatuses(job.visits)).toEqual(['COMPLETED', 'CANCELLED', 'CANCELLED', 'CANCELLED', 'CANCELLED', 'CANCELLED']);

      // Cancelled visits keep their stamps as history, and none of them was marked finished.
      const worked = await db.visit.findUniqueOrThrow({ where: { id: job.visits[4]! } });
      expect(worked.on_site_at?.toISOString()).toBe('2026-01-05T10:00:00.000Z');
      expect(worked.started_at?.toISOString()).toBe('2026-01-05T10:05:00.000Z');
      expect(worked.completed_at).toBeNull();
      expect(worked.cancelled_by).toBe(me.id);
      expect(worked.cancelled_at).not.toBeNull();
      // The visit that was already finished is untouched.
      const finished = await db.visit.findUniqueOrThrow({ where: { id: job.visits[0]! } });
      expect(finished.cancelled_at).toBeNull();
      expect(finished.completed_at?.toISOString()).toBe('2026-01-05T11:00:00.000Z');
    });

    it('leaves a history line for each visit it cancelled', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await jobWithVisits(org, customer, ['SCHEDULED', 'IN_PROGRESS']);
      const api = await fx.signedInAs(me);

      await api.post(`/api/jobs/${job.id}/complete`).send({ cancel_open_visits: true });

      const events = await db.timelineEvent.findMany({ where: { entity_id: job.id, event_type: 'VISIT_CANCELLED' } });
      expect(events.map((e) => e.description).sort()).toEqual([
        'Visit 1 cancelled: Job completed',
        'Visit 2 cancelled: Job completed',
      ]);
    });

    it('completes a job with no open visits without any choice', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await jobWithVisits(org, customer, ['COMPLETED', 'CANCELLED']);
      const api = await fx.signedInAs(me);

      const res = await api.post(`/api/jobs/${job.id}/complete`).send({});

      expect(res.status).toBe(200);
      expect(await jobStatus(job.id)).toBe('OFFICE_REVIEW');
      expect(await visitStatuses(job.visits)).toEqual(['COMPLETED', 'CANCELLED']);
    });

    it('is refused with Complete jobs off, and does not reveal the open visits', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...opensJobs, start_and_finish_visits: true });
      const job = await jobWithVisits(org, customer, ['SCHEDULED']);
      const api = await fx.signedInAs(me);

      for (const body of [{}, { cancel_open_visits: true }]) {
        const res = await api.post(`/api/jobs/${job.id}/complete`).send(body);
        expect(res.status).toBe(403);
        expect(res.body.open_visits).toBeUndefined();
      }
      expect(await visitStatuses(job.visits)).toEqual(['SCHEDULED']);
    });

    it('the status door is no way around the choice', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const job = await jobWithVisits(org, customer, ['SCHEDULED']);
      const api = await fx.signedInAs(me);

      const refused = await api.post(`/api/jobs/${job.id}/status`).send({ status: 'COMPLETED' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('JOB_COMPLETE_HAS_OPEN_VISITS');
      expect(await jobStatus(job.id)).not.toBe('OFFICE_REVIEW');

      const allowed = await api.post(`/api/jobs/${job.id}/status`).send({ status: 'COMPLETED', cancel_open_visits: true });
      expect(allowed.status).toBe(200);
      expect(await jobStatus(job.id)).toBe('OFFICE_REVIEW');
      expect(await visitStatuses(job.visits)).toEqual(['CANCELLED']);
    });
  });

  describe('the Jobs list bulk Completed (POST /api/jobs/bulk-status)', () => {
    it('refuses the whole batch when any job has open visits, naming those jobs, and completes none', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const clean = await jobWithVisits(org, customer, ['COMPLETED']);
      const open = await jobWithVisits(org, customer, ['SCHEDULED', 'ON_SITE']);
      const api = await fx.signedInAs(me);

      const res = await api.post('/api/jobs/bulk-status').send({ ids: [clean.id, open.id], action: 'complete' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JOB_COMPLETE_HAS_OPEN_VISITS');
      expect(res.body.jobs).toHaveLength(1);
      expect(res.body.jobs[0]).toMatchObject({ id: open.id });
      expect(res.body.jobs[0].job_number).toEqual(expect.any(String));
      expect(res.body.jobs[0].open_visits.map((v: { id: string }) => v.id).sort()).toEqual([...open.visits].sort());
      // The clean job in the same batch was not completed behind the confirmation's back.
      expect(await jobStatus(clean.id)).not.toBe('OFFICE_REVIEW');
      expect(await jobStatus(open.id)).not.toBe('OFFICE_REVIEW');
      expect(await visitStatuses(open.visits)).toEqual(['SCHEDULED', 'ON_SITE']);
    });

    it('with the cancel choice, cancels the open visits and completes every job in the batch', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const clean = await jobWithVisits(org, customer, ['COMPLETED']);
      const open = await jobWithVisits(org, customer, ['SCHEDULED', 'IN_PROGRESS']);
      const api = await fx.signedInAs(me);

      const res = await api.post('/api/jobs/bulk-status').send({ ids: [clean.id, open.id], action: 'complete', cancel_open_visits: true });

      expect(res.status).toBe(200);
      expect([...res.body.updated].sort()).toEqual([clean.id, open.id].sort());
      expect(res.body.failed).toEqual([]);
      expect(await jobStatus(clean.id)).toBe('OFFICE_REVIEW');
      expect(await jobStatus(open.id)).toBe('OFFICE_REVIEW');
      expect(await visitStatuses(open.visits)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(await visitStatuses(clean.visits)).toEqual(['COMPLETED']);
    });

    it('completes a batch with no open visits without any choice', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, completer);
      const a = await jobWithVisits(org, customer, ['COMPLETED']);
      const b = await jobWithVisits(org, customer, []);
      const api = await fx.signedInAs(me);

      const res = await api.post('/api/jobs/bulk-status').send({ ids: [a.id, b.id], action: 'complete' });

      expect(res.status).toBe(200);
      expect([...res.body.updated].sort()).toEqual([a.id, b.id].sort());
    });

    it('does not list the open visits of a job the person may not complete', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached', complete_jobs: true });
      const notMine = await jobWithVisits(org, customer, ['SCHEDULED']);
      const api = await fx.signedInAs(me);

      const res = await api.post('/api/jobs/bulk-status').send({ ids: [notMine.id], action: 'complete' });

      expect(res.body.open_visits ?? res.body.jobs).toBeUndefined();
      expect(await visitStatuses(notMine.visits)).toEqual(['SCHEDULED']);
    });

    it('is refused with Complete jobs off', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...opensJobs, start_and_finish_visits: true });
      const open = await jobWithVisits(org, customer, ['SCHEDULED']);
      const api = await fx.signedInAs(me);

      const res = await api.post('/api/jobs/bulk-status').send({ ids: [open.id], action: 'complete', cancel_open_visits: true });

      expect(res.status).toBe(403);
      expect(await visitStatuses(open.visits)).toEqual(['SCHEDULED']);
    });
  });
});

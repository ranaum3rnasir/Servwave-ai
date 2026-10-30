/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.31 - the office review queue: the count behind the Jobs menu entry
   (GET /api/jobs/review-queue) and the two Jobs tiles (Office review, Ready to close) that ride on the Jobs list.

   The queue is per person and per switch: jobs in Office review count for a holder of Office review, jobs Ready to
   close for a holder of Close jobs, each within the person's Jobs reach, and the answer never says how many jobs
   wait in a queue the person does not hold. A tile's count and the rows its click-through lists come from one
   job set, for an All-scope person and an Attached-scope person alike.

   Everything goes through the public interface (HTTP), as people on custom roles holding exactly the switch values
   under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
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

// Every automation event the app raises is recorded here instead of enrolling anything.
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

import request from 'supertest';
import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening a job takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all' };

/** Every status except the two queues: none of them may ever count. */
const OUTSIDE_THE_QUEUES = Object.values(JobStatus).filter((s) => s !== 'OFFICE_REVIEW' && s !== 'READY_TO_CLOSE');

suite('the office review queue (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `review-queue-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** One job at `status`, with a trip crewed by `crew` (a job a person is attached to). */
  async function jobAt(org: string, customer: string, status: JobStatus, crew: string[] = []) {
    const job = await fx.addJob(org, customer, { status });
    if (crew.length) await fx.addVisit(org, { jobId: job.id, daysFromNow: 0, crew });
    return job;
  }

  /** `n` jobs in each queue, plus one job at every other status. */
  async function seedQueues(org: string, customer: string, review: number, ready: number, crew: string[] = []) {
    for (let i = 0; i < review; i++) await jobAt(org, customer, 'OFFICE_REVIEW', crew);
    for (let i = 0; i < ready; i++) await jobAt(org, customer, 'READY_TO_CLOSE', crew);
    for (const status of OUTSIDE_THE_QUEUES) await jobAt(org, customer, status, crew);
  }

  const ids = (body: { jobs: { id: string }[] }) => body.jobs.map((j) => j.id).sort();

  describe('GET /api/jobs/review-queue', () => {
    it('gives a holder of both switches the sum, with each queue named', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true, close_jobs: true });
      await seedQueues(org, customer, 3, 2);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ office_review: 3, ready_to_close: 2, total: 5 });
    });

    it('counts only Office review for a custom role with Office review on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true });
      await seedQueues(org, customer, 3, 2);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ office_review: 3, total: 3 });
    });

    it('counts only Ready to close for a custom role with Close jobs on', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, close_jobs: true });
      await seedQueues(org, customer, 3, 2);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ready_to_close: 2, total: 2 });
    });

    it('gives a person with neither switch zero, and says nothing about either queue', async () => {
      const { org, customer } = await fx.newOrg();
      // Complete jobs and Mark Done money rules are not the queue's switches.
      const me = await personWith(org, { ...OPENING, complete_jobs: true, close_jobs_with_money_owed: true });
      await seedQueues(org, customer, 3, 2);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ total: 0 });
    });

    it('counts only the jobs an Attached-scope person is attached to', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached', office_review: true, close_jobs: true });
      await seedQueues(org, customer, 2, 1, [me.id]);
      // The same queues on jobs crewed by somebody else: not this person's to open, so not counted.
      await seedQueues(org, customer, 4, 3, [admin.id]);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.body).toEqual({ office_review: 2, ready_to_close: 1, total: 3 });
    });

    it('does not count a job of another company', async () => {
      const mine = await fx.newOrg();
      const other = await fx.newOrg();
      const me = await personWith(mine.org, { ...OPENING, office_review: true, close_jobs: true });
      await seedQueues(other.org, other.customer, 5, 5);
      await seedQueues(mine.org, mine.customer, 1, 1);

      const res = await (await me.api()).get('/api/jobs/review-queue');

      expect(res.body).toEqual({ office_review: 1, ready_to_close: 1, total: 2 });
    });

    it('moves when a job moves between queues', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true, close_jobs: true });
      const job = await jobAt(org, customer, 'OFFICE_REVIEW');
      const api = await me.api();
      expect((await api.get('/api/jobs/review-queue')).body).toEqual({ office_review: 1, ready_to_close: 0, total: 1 });

      await db.job.update({ where: { id: job.id }, data: { status: 'READY_TO_CLOSE' } });

      expect((await api.get('/api/jobs/review-queue')).body).toEqual({ office_review: 0, ready_to_close: 1, total: 1 });
    });

    it('refuses a request with no session', async () => {
      const app = (await import('../app.js')).default as never;

      const res = await request(app).get('/api/jobs/review-queue');

      expect(res.status).toBe(401);
    });
  });

  describe('the Jobs tiles equal the rows their click-throughs list', () => {
    async function tilesAgainstRows(api: Api, expected: { office_review?: number; ready_to_close?: number }) {
      const stats = (await api.get('/api/jobs')).body.stats as { office_review?: number; ready_to_close?: number };
      expect(stats.office_review).toBe(expected.office_review);
      expect(stats.ready_to_close).toBe(expected.ready_to_close);

      if (expected.office_review !== undefined) {
        const rows = await api.get('/api/jobs?in_office_review=true&limit=100');
        expect(rows.status).toBe(200);
        expect(rows.body.jobs).toHaveLength(expected.office_review);
        expect(rows.body.pagination.total).toBe(expected.office_review);
        expect(rows.body.jobs.every((j: { status: string }) => j.status === 'OFFICE_REVIEW')).toBe(true);
      }
      if (expected.ready_to_close !== undefined) {
        const rows = await api.get('/api/jobs?ready_to_close=true&limit=100');
        expect(rows.status).toBe(200);
        expect(rows.body.jobs).toHaveLength(expected.ready_to_close);
        expect(rows.body.pagination.total).toBe(expected.ready_to_close);
        expect(rows.body.jobs.every((j: { status: string }) => j.status === 'READY_TO_CLOSE')).toBe(true);
      }
    }

    it('for an All-scope person holding both switches', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true, close_jobs: true });
      await seedQueues(org, customer, 3, 2);

      await tilesAgainstRows(await me.api(), { office_review: 3, ready_to_close: 2 });
    });

    it('for an Attached-scope person, counting only the jobs they are attached to', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached', office_review: true, close_jobs: true });
      await seedQueues(org, customer, 2, 1, [me.id]);
      await seedQueues(org, customer, 4, 3, [admin.id]);

      await tilesAgainstRows(await me.api(), { office_review: 2, ready_to_close: 1 });
    });

    it('matches the menu count, which is the two tiles added up', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true, close_jobs: true });
      await seedQueues(org, customer, 3, 2);
      const api = await me.api();

      const stats = (await api.get('/api/jobs')).body.stats as { office_review: number; ready_to_close: number };
      const menu = (await api.get('/api/jobs/review-queue')).body as { total: number };

      expect(menu.total).toBe(stats.office_review + stats.ready_to_close);
    });

    it('sends a tile only to the holder of its switch', async () => {
      const { org, customer } = await fx.newOrg();
      const reviewer = await personWith(org, { ...OPENING, office_review: true });
      const closer = await personWith(org, { ...OPENING, close_jobs: true });
      const neither = await personWith(org, { ...OPENING });
      await seedQueues(org, customer, 3, 2);

      await tilesAgainstRows(await reviewer.api(), { office_review: 3 });
      await tilesAgainstRows(await closer.api(), { ready_to_close: 2 });
      await tilesAgainstRows(await neither.api(), {});
    });

    it('ignores a tile filter the person does not hold the switch for, so the list is their ordinary view', async () => {
      const { org, customer } = await fx.newOrg();
      const neither = await personWith(org, { ...OPENING });
      const review = await jobAt(org, customer, 'OFFICE_REVIEW');
      const live = await jobAt(org, customer, 'IN_PROGRESS');
      const done = await jobAt(org, customer, 'DONE');

      const res = await (await neither.api()).get('/api/jobs?in_office_review=true&limit=100');

      expect(ids(res.body)).toEqual([review.id, live.id].sort());
      expect(ids(res.body)).not.toContain(done.id);
    });

    it('narrows the click-through further when a status is also chosen, never wider than the tile', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true, close_jobs: true });
      await jobAt(org, customer, 'OFFICE_REVIEW');
      await jobAt(org, customer, 'READY_TO_CLOSE');

      const res = await (await me.api()).get('/api/jobs?in_office_review=true&status=READY_TO_CLOSE');

      expect(res.body.jobs).toEqual([]);
    });
  });
});

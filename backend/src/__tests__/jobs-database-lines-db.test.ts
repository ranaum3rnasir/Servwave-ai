/* =============================================================================
   Background jobs get their own two database lines (#3105, Spider phase 1) - real app, real migrated database.

   Seam (agreed with Ran): an HTTP request from a user while jobs hold both of their lines. (The other seam, a job's
   statement under the tenant guard, is jobs-client-guard-db.test.ts.)

   The app's pool for users is 5 lines (as in production) and the jobs' pool is 2. A job reaches the database through the
   ordinary `prisma` import, exactly as the services the jobs call do, and is started in any of the ways the server starts
   one: by the scheduler's own wrapper `scheduleJob` (every cron job; the real scheduler, told to run the job now instead of
   waiting for a clock), by `runJobAtBoot` (the boot-time run of index.ts, #3109), or inside `runOnJobsClient`, the primitive
   both of those use.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    // The users' pool is 5 lines, as in production. The URL carries a connection_limit on purpose: the jobs client must
    // override it with its own 2, not inherit it.
    process.env.DATABASE_URL = `${dbUrl}?connection_limit=5`;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The app's config points at the same test database the clients above use. Every other value is the shared test env.
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL } };
});

// The app runs on the real client module (setup.ts gives every suite a mocked one): the point is how it spends its lines.
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());

import { env } from '../config/env';
import { switchFixture } from './permission-switches-fixture';

const suite = adminClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
/** Marks the statements the "jobs" hold, so the test can count the lines they really occupy. */
const HOLD = 'sp3105-hold';
const HOLD_SECONDS = 3;

suite('Background jobs and the users\' database lines (real database)', () => {
  const db = adminClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let runOnJobsClient: typeof import('../lib/prismaJobs').runOnJobsClient;
  let scheduleJob: typeof import('../lib/scheduleJob').scheduleJob;
  let runJobAtBoot: typeof import('../lib/scheduleJob').runJobAtBoot;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await import('../app.js');
    ({ runOnJobsClient } = await import('../lib/prismaJobs.js'));
    ({ prisma } = await import('../lib/prisma.js'));
    ({ scheduleJob, runJobAtBoot } = await import('../lib/scheduleJob.js'));
    // These jobs are probes under real job names: none of them may be paused, whatever the environment of the shell says.
    delete env.JOBS_PAUSED;
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** How many database sessions are right now running a held statement. */
  async function heldLines(): Promise<number> {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND query LIKE '%${HOLD}%' AND query NOT LIKE '%pg_stat_activity%'`,
    );
    return Number(rows[0]!.n);
  }

  async function spiderOrg() {
    const o = await fx.newOrg();
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    return o;
  }

  /** The ways the server starts a job. Each runs `work` as that kind of job and resolves when it has finished. */
  const startJob: Record<string, (work: () => Promise<unknown>) => Promise<unknown>> = {
    'started inside runOnJobsClient (the primitive)': (work) => Promise.resolve(runOnJobsClient(work)),
    'started by runJobAtBoot (the boot-time run)': (work) => Promise.resolve(runJobAtBoot('stripe-fees', work)),
    'started by scheduleJob (every cron job)': async (work) => {
      // A date that never comes: the scheduler is the real one, the job is run by hand instead of waiting for a clock.
      const task = scheduleJob('spider', '0 0 1 1 *', work);
      try {
        await task.execute();
      } finally {
        await task.destroy();
      }
    },
  };

  it.each(Object.keys(startJob))('a user request is served at once while the jobs hold both of their lines: job %s', async (door) => {
    const { admin } = await spiderOrg();
    const api = await fx.signedInAs(admin);
    // Warm the app (its first request builds caches) so the measured request is an ordinary one.
    expect((await api.get(STATUS)).status).toBe(200);

    // Six job statements at once: more than the users' 5 lines. Before this change they would take every user line.
    const outcomes: string[] = [];
    const job = startJob[door]!(async () => {
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => prisma.$queryRawUnsafe(`SELECT pg_sleep(${HOLD_SECONDS})::text /* ${HOLD} */`)),
      );
      outcomes.push(...settled.map((o) => o.status));
    });
    // Let the jobs take every line they can.
    const deadline = Date.now() + 2_000;
    while ((await heldLines()) < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300));
    const linesHeldByJobs = await heldLines();

    const startedAt = Date.now();
    const res = await api.get(STATUS);
    const userRequestMs = Date.now() - startedAt;
    console.info(`[#3105 measurement] user request while both job lines busy (job ${door}): ${userRequestMs} ms`);

    expect(res.status).toBe(200);
    // Served at once: well inside the time the jobs hold their lines (3 s).
    expect(userRequestMs).toBeLessThan(1_000);
    // The jobs held exactly their own two lines (not the users' five), before and after the request.
    expect(linesHeldByJobs).toBe(2);
    expect(await heldLines()).toBe(2);

    // The two statements on the jobs' lines finish; the other four had no line to wait for within the jobs' 2 s limit, so they
    // failed on the jobs' side. Not one of them waited on, or took, a line of the users.
    await job;
    expect(outcomes.filter((o) => o === 'fulfilled')).toHaveLength(2);
  }, 30_000);
});

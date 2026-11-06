/* =============================================================================
   The jobs' database client under the tenant guard (#3105, Spider phase 1) - real migrated database.

   Seam (agreed with Ran): a job's statement run through the jobs client under the tenant guard.

   A job statement here goes the way the server's jobs go: the ordinary `prisma` import, inside `runOnJobsClient`. Every
   connection acts as the non-bypass role the guard exists for (`app_rls`, as the live API does), with DB_TENANT_GUARD on.
   Two companies each have a customer; what a job statement can see is decided by the guard alone.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    // Every connection of the jobs client acts as the non-bypass role (a session setting the superuser may make), the
    // way the live API connects as `app_rls`. The guard is on, as in production.
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The jobs run on the real client module (setup.ts gives every suite a mocked one).
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture } from './permission-switches-fixture';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';

const suite = adminClient ? describe : describe.skip;

suite('The jobs client under the tenant guard (real database)', () => {
  const db = adminClient as PrismaClient;
  const fx = switchFixture(db, async () => { throw new Error('no HTTP in this suite'); });
  let prisma: PrismaClient;
  let runOnJobsClient: typeof import('../lib/prismaJobs').runOnJobsClient;

  beforeAll(async () => {
    // The runtime non-bypass role, as docs/rls-activation-runbook.md and the sign-in suites make it. Idempotent.
    await db.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_rls');
    await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
    ({ prisma } = await import('../lib/prisma.js'));
    ({ runOnJobsClient } = await import('../lib/prismaJobs.js'));
  }, 60_000);
  afterAll(async () => {
    await fx.cleanup();
    await prisma?.$disconnect();
  });

  it('an org-scoped read through the jobs client sees only that org', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();

    const seenByA = await runOnJobsClient(() => runWithOrg(a.org, () => prisma.customer.findMany({ select: { id: true, organization_id: true } })));
    expect(seenByA).toEqual([{ id: a.customer, organization_id: a.org }]);

    const seenByB = await runOnJobsClient(() => runWithOrg(b.org, () => prisma.customer.findMany({ select: { id: true } })));
    expect(seenByB).toEqual([{ id: b.customer }]);
  });

  it('a job that is unscoped on purpose (a cross-company sweep) sees both companies', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const seen = await runOnJobsClient(() => runUnscoped(() => prisma.customer.findMany({ where: { id: { in: [a.customer, b.customer] } }, select: { id: true } })));
    expect(seen.map((c) => c.id).sort()).toEqual([a.customer, b.customer].sort());
  });

  it('a job statement longer than 5 s is cancelled by the database, through the guard', async () => {
    const startedAt = Date.now();
    // The transaction's own time limit is lifted so that only the statement limit can stop an 8 s statement.
    const job = runOnJobsClient(() =>
      runUnscoped(() => prisma.$transaction((tx) => tx.$queryRawUnsafe('SELECT pg_sleep(8)::text'), { timeout: 30_000 })),
    );
    await expect(job).rejects.toThrow(/statement timeout/i);
    const elapsedMs = Date.now() - startedAt;
    console.info(`[#3105 measurement] 8 s job statement cancelled after ${elapsedMs} ms`);
    expect(elapsedMs).toBeGreaterThan(4_500);
    expect(elapsedMs).toBeLessThan(7_000);
  }, 20_000);

  it('a job waiting longer than 1 s for a row another session holds is cancelled, through the guard', async () => {
    const a = await fx.newOrg();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // Another session holds the customer's row until the test lets go.
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM customers WHERE id = $1::uuid FOR UPDATE', a.customer);
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    try {
      const startedAt = Date.now();
      const job = runOnJobsClient(() => runWithOrg(a.org, () => prisma.customer.update({ where: { id: a.customer }, data: { first_name: 'Locked' } })));
      // Without the limit the job would wait for as long as the other session holds the row; give it 4 s to be cancelled.
      const outcome = await Promise.race([
        job.then(() => 'finished', (err: Error) => err.message),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 4_000)),
      ]);
      const elapsedMs = Date.now() - startedAt;
      console.info(`[#3105 measurement] job waiting on a held row cancelled after ${elapsedMs} ms`);
      expect(outcome).toMatch(/lock timeout/i);
      expect(elapsedMs).toBeGreaterThan(900);
      expect(elapsedMs).toBeLessThan(2_500);
    } finally {
      release();
      await holder;
    }
  });
});

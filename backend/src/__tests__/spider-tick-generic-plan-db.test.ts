/* =============================================================================
   #3469: the check's ending (services/spider/tick.ts endChangedAlerts) with GENERIC plans, on a real migrated database.

   Production plans every statement for its own values (pgbouncer: no named prepared statements), and so does
   spider-tick-cost-db.test.ts. A direct connection that reuses a prepared statement may switch it to a generic plan,
   planned once for any values: this suite forces that from the first run (`plan_cache_mode=force_generic_plan`), so the
   ending is proven to stay fast whichever plan the database picks. The cases are shared (support/spider-ending-cost.ts):
   5,000 changed watch rows with 100 open alerts (3 people each, and the synthetic company's 60), on analyzed tables; each
   check that reads them stays well under the jobs' 5 s limit and no transaction stays open for 1 second.

   Every connection of the app's clients acts as the live API's role (`app_rls`, no BYPASSRLS) with the tenant guard on.
   Skips when TEST_DATABASE_URL is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, dbUrl } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls%20-c%20plan_cache_mode%3Dforce_generic_plan`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { dbUrl, adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL, SPIDER_PILOT_ORG_IDS: undefined } };
});

import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { removeCompanies } from './support/spider-company';
import { endingCostCases } from './support/spider-ending-cost';
import { _resetSpiderTick } from '../services/spider/tick';

const suite = adminClient ? describe : describe.skip;

suite("the check's ending with generic plans (#3469, real database)", () => {
  const db = adminClient as PrismaClient;
  const orgs: string[] = [];
  let usersClient: PrismaClient;
  let jobsClient: PrismaClient;

  beforeAll(async () => {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_rls');
    await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
    ({ prisma: usersClient } = await import('../lib/prisma.js'));
    ({ prismaJobs: jobsClient } = await import('../lib/prismaJobs.js'));
  }, 120_000);

  beforeEach(async () => {
    clearPermissionCache();
    await _resetSpiderTick();
  });
  afterEach(() => _resetSpiderTick());

  afterAll(async () => {
    await removeCompanies(db, orgs);
    await usersClient?.$disconnect();
    await jobsClient?.$disconnect();
    await db.$disconnect();
  }, 300_000);

  /** Spider switched off for every company but these (a check covers every switched-on company). */
  const only = async (...keep: string[]) => {
    await db.spiderSettings.updateMany({ where: { organization_id: { notIn: keep }, is_active: true }, data: { is_active: false } });
    await db.spiderSettings.updateMany({ where: { organization_id: { in: keep } }, data: { is_active: true } });
  };

  it("the app's job connections really plan generically", async () => {
    const [row] = await jobsClient.$queryRawUnsafe<{ mode: string }[]>(`SELECT current_setting('plan_cache_mode') AS mode`);
    expect(row!.mode).toBe('force_generic_plan');
  });

  endingCostCases({ db, orgs, dbUrl, only, label: 'generic plans' });
});

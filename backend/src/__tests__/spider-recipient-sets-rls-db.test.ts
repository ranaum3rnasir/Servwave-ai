/* =============================================================================
   #3107: the recipient sets work as the live API's database role (`app_rls`, no BYPASSRLS) under the tenant guard
   (DB_TENANT_GUARD=on), for two companies swept in the same run.

   Seam: the sweep's public entry (runSpiderSweep) writes a starting summary, and the Admin History HTTP endpoint reads it
   (through the recipient set), real app, real migrated database. The client the app uses here is the real client wrapped by
   the real tenant guard (lib/tenant-guard.ts), exactly as lib/prisma.ts builds it when the guard is on, with every
   transaction taking the `app_rls` role first (what the live API's login role is). That is wiring the real thing, not a
   substitute for it: if the role could not write or read the list, the summary and History below would fail.

   Role DDL: beforeAll makes the role if it is missing and grants it the runbook's grants, as login-lockout-rls.test.ts does,
   so run it under the role-DDL lock with the other suites that do.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

const { superClient } = vi.hoisted(() => {
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const dbUrl = process.env.TEST_DATABASE_URL;
  // The test's own client: the database's superuser, for setup and for looking at what was stored.
  return { superClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The app's client: the real client under the real tenant guard, every transaction run as app_rls.
vi.mock('../lib/prisma', async () => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { prisma: undefined };
  const { PrismaClient } = await import('@prisma/client');
  const { wrapWithTenantGuard } = await import('../lib/tenant-guard.js');
  // Options typed first, not inlined: an inline literal assigned to a `PrismaClient`-typed place costs ~39k types (~700k the first) and once ran CI's typecheck out of memory.
  const baseOptions: Prisma.PrismaClientOptions = { datasources: { db: { url: dbUrl } } };
  const base = new PrismaClient(baseOptions);
  const SET_ROLE = 'SET LOCAL ROLE app_rls';
  const asAppRls = new Proxy(base, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (arg: unknown, opts?: unknown) =>
          typeof arg === 'function'
            ? target.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(SET_ROLE);
                return (arg as (t: typeof tx) => Promise<unknown>)(tx);
              }, opts as never)
            : target.$transaction([target.$executeRawUnsafe(SET_ROLE), ...(arg as never[])], opts as never).then((r) => r.slice(1));
      }
      return Reflect.get(target, prop, target);
    },
  });
  return { prisma: wrapWithTenantGuard(asAppRls as typeof base) };
});
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';

const suite = superClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const STATUS = '/api/ai-farm/spider/status';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

suite('Recipient sets as the live API\'s database role, under the tenant guard (real database)', () => {
  const db = superClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);

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
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep'`);
  });

  /** A Spider company: made a month ago, its Admin switches Spider on and saves "tell the Admins" over HTTP, and one lead is overdue. */
  async function companyWithBacklog() {
    const o = await fx.newOrg();
    const monthAgo = new Date(Date.now() - 30 * DAY_MS);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true, created_at: monthAgo } });
    await db.user.update({ where: { id: o.admin.id }, data: { created_at: monthAgo } });
    await db.customer.update({ where: { id: o.customer }, data: { created_at: monthAgo } });
    const api = await fx.signedInAs(o.admin);
    expect(
      (await api.put(SETTINGS, {
        status_limits: {
          NEW: { enabled: true, value: 2, unit: 'HOUR' },
          CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
          WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
        },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
      })).status,
    ).toBe(200);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    const lead = (await fx.addLead(o.org, o.customer)).id;
    await db.lead.update({ where: { id: lead }, data: { created_at: new Date(Date.now() - 5 * HOUR_MS) } });
    return { ...o, lead };
  }

  const setsOf = (org: string) =>
    db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM spider_recipient_sets WHERE organization_id = $1::uuid`, org);

  it('a starting summary stores the list and History reads it back, as that role', async () => {
    const a = await companyWithBacklog();

    const result = await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
    expect(result.ran).toBe(true);

    expect(await setsOf(a.org)).toHaveLength(1);
    const res = await (await fx.signedInAs(a.admin)).get(`${HISTORY}?page_size=100&roles=ADMIN`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { lead_id: string }) => i.lead_id)).toEqual([a.lead]);
    expect(res.body.items[0].recipients.map((r: { id: string; role: string; type: string }) => [r.id, r.role, r.type])).toEqual([[a.admin.id, 'ADMIN', 'admin']]);
  });

  it('two companies swept in one run each keep their own list, and each Admin\'s History shows only its own people', async () => {
    const a = await companyWithBacklog();
    const b = await companyWithBacklog();

    const result = await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
    expect(result.ran).toBe(true);

    const [setA] = await setsOf(a.org);
    const [setB] = await setsOf(b.org);
    expect(await setsOf(a.org)).toHaveLength(1);
    expect(await setsOf(b.org)).toHaveLength(1);
    expect(setA!.id).not.toBe(setB!.id);
    for (const c of [a, b]) {
      const res = await (await fx.signedInAs(c.admin)).get(`${HISTORY}?page_size=100`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { lead_id: string }) => i.lead_id)).toEqual([c.lead]);
      expect(res.body.items[0].recipients.map((r: { id: string }) => r.id)).toEqual([c.admin.id]);
    }
  });
});

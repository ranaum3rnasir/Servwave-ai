/* =============================================================================
   #3469: Spider's check (services/spider/tick.ts) compares its times in UTC wall time whatever the session's time zone,
   proven on the real clock under a zone far EAST of UTC (Pacific/Auckland).

   Why east: the watch list's times are UTC wall time (timestamp(3) without zone, the trigger stamps `changed_at` with
   now() AT TIME ZONE 'UTC'). A compare that let the session zone read them would, west of UTC (the runner's New York),
   read them as LATER than they are, which the ending and the re-arm both survive; east of UTC it reads them 13 hours
   EARLIER, and a lead save is then older than the previous check, so its alert would never end. The other suites run at
   a fixed clock (1 Oct 2026) that the real-clock stamp is always after, so only a real-clock run under a far-east zone
   can tell the two apart.

   Every connection of the app's clients acts as the live API's role (`app_rls`, no BYPASSRLS) with the tenant guard on,
   in Pacific/Auckland. Skips when TEST_DATABASE_URL is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, zone } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const zone = 'Pacific/Auckland';
  if (dbUrl) {
    process.env.DATABASE_URL = `${dbUrl}?options=${encodeURIComponent(`-c role=app_rls -c TimeZone=${zone}`)}`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { zone, adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL,
      FRONTEND_URL: 'https://staging.app.test',
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});

import { runOnJobsClient } from '../lib/prismaJobs';
import { runWithOrg } from '../lib/tenant-context';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { HOUR, addLead, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import { _resetSpiderTick, rearmWatchedStays, runSpiderTick, stayKey } from '../services/spider/tick';

const suite = adminClient ? describe : describe.skip;
const QUIET = { in_app: true, red_frame: true, email: false, text: false };

suite("Spider's check under a session time zone far east of UTC, on the real clock (#3469)", () => {
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
    vi.clearAllMocks();
    clearPermissionCache();
    await _resetSpiderTick();
  });

  afterEach(async () => {
    await _resetSpiderTick();
  });

  afterAll(async () => {
    await removeCompanies(db, orgs);
    await usersClient?.$disconnect();
    await jobsClient?.$disconnect();
    await db.$disconnect();
  }, 120_000);

  /** A switched-on company (New at 2 hours, in-app and red frame only), and nobody else's. */
  async function company(): Promise<SpiderCompany> {
    const c = await spiderCompany(db, orgs, { leads: 0 });
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
    await db.spiderSettings.updateMany({ where: { organization_id: { not: c.org }, is_active: true }, data: { is_active: false } });
    return c;
  }

  const openRows = (org: string, lead: string) =>
    db.notificationRecipient.count({
      where: { organization_id: org, read_at: null, notification: { object_id: lead, verb: { in: ['spider.alert', 'spider.frame'] } } },
    });

  async function pending(lead: string): Promise<boolean | null> {
    const [row] = await db.$queryRawUnsafe<{ pending: boolean }[]>(`SELECT pending FROM spider_lead_watch WHERE lead_id = $1::uuid`, lead);
    return row ? row.pending : null;
  }

  it("the app's own connections, the users' and the jobs', run in Pacific/Auckland", async () => {
    const zoneOf = (client: PrismaClient) => client.$queryRawUnsafe<{ tz: string }[]>(`SELECT current_setting('TimeZone') AS tz`);
    expect((await zoneOf(usersClient))[0]!.tz).toBe(zone);
    expect((await runOnJobsClient(() => zoneOf(jobsClient)))[0]!.tz).toBe(zone);
  });

  it('a lead moved to Contacted while its New alert is open: its records end at the next check', async () => {
    const c = await company();
    const lead = await addLead(db, c, new Date(Date.now() - 2 * HOUR - 5_000));
    expect((await runSpiderTick(new Date())).claimed).toBe(1);
    expect(await openRows(c.org, lead)).toBe(3);

    await new Promise((resolve) => setTimeout(resolve, 200));
    await db.lead.update({ where: { id: lead }, data: { status: 'CONTACTED', contacted_at: new Date() } });
    expect((await runSpiderTick(new Date())).ended).toBe(3);
    expect(await openRows(c.org, lead)).toBe(0);
  });

  it('Activate watches again the stay not past its limit at the Activate moment, and leaves the one past it settled', async () => {
    const c = await company();
    const now = Date.now();
    const past = await addLead(db, c, new Date(now - 5 * HOUR));
    const notPast = await addLead(db, c, new Date(now - 2.5 * HOUR));
    expect((await runSpiderTick(new Date(now))).claimed).toBe(2);

    // Switched on again (Skip) with New at 3 hours: `past` is past it at Activate, `notPast` is 2 h 30 min in.
    const activatedAt = new Date();
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: {
        status_limits: { NEW: { enabled: true, value: 3, unit: 'HOUR' }, CONTACTED: { enabled: false, value: 1, unit: 'DAY' }, WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' } },
        activated_at: activatedAt, backlog_skipped_at: activatedAt, backlog_skipped_stays: [stayKey(past, 'NEW', new Date(now - 5 * HOUR))],
      },
    });
    expect(await runWithOrg(c.org, () => rearmWatchedStays(c.org))).toBe(1);
    expect(await pending(past)).toBe(false);
    expect(await pending(notPast)).toBe(true);
  });

  it('the starting summary (#3471) covers the stays past their limit AT THE TRIGGER, read from the watch list; the one that crossed after is alerted on its own', async () => {
    const c = await company();
    const now = Date.now();
    // Activated and triggered half an hour ago (the instants the switch route writes: UTC, whatever the session's zone).
    const trigger = new Date(now - 30 * 60_000);
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: { activated_at: trigger, summary_trigger_at: trigger, summary_trigger_since: trigger, summary_trigger_kind: 'SWITCHED_ON' },
    });
    // New is 2 hours: crossed 40 minutes before the trigger, crossed 20 minutes after it, crosses in 10 minutes.
    const before = await addLead(db, c, new Date(now - 2 * HOUR - 70 * 60_000));
    const after = await addLead(db, c, new Date(now - 2 * HOUR - 10 * 60_000));
    const later = await addLead(db, c, new Date(now - 2 * HOUR + 10 * 60_000));

    const first = await runSpiderTick(new Date(now));
    // The summary covers `before` only; `after` (past its limit now, but after the trigger) is alerted on its own at this check.
    expect(first).toMatchObject({ summaries: 1, summarized: 1, claimed: 1 });
    const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true, kind: true } });
    expect(rows.map((r) => [r.lead_id, r.kind]).sort()).toEqual([[before, 'SUMMARIZED'], [after, 'ALERTED']].sort());
    expect(await pending(later)).toBe(true);
    expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).summary_trigger_at).toBeNull();
  });
});

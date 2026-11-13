/* =============================================================================
   #3462 cost, under the PRODUCTION role: every connection is `app_rls` (no BYPASSRLS), the tenant guard is on (every Prisma
   call is BEGIN, set_config, the statement, COMMIT), and the code under test runs through the app's real `lib/prisma` and
   `lib/prismaJobs`. A superuser connection hides the cost that mattered once: a join from a notification's JSON to its alert
   cannot use an index under row-level security (the functions are not leakproof), so it scanned every company's alerts.

   - A large spider_alerts history in OTHER companies (50,000 rows), so a read that scans the table is slow here.
   - Every alert notification carries a real data.spider_alert_id pointing at a real spider_alerts row with its stored list.
   - 60 people x 50 alerts: the DISPATCHER-removing save and a sweep step, with budgets for time, statements and the longest
     open transaction (one transaction over 1 s is a failure).
   - 25,000 Admin rows with ADMIN unticked: the steady sweep step.
   - EXPLAIN (ANALYZE) of the per-page stored-reason read as app_rls: it reads the alert by primary key, never a Seq Scan.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { adminClient, dbUrl, saved } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const saved = { url: process.env.DATABASE_URL, guard: process.env.DB_TENANT_GUARD };
  if (dbUrl) {
    // Hash and merge joins off: production's statistics (large notification tables) pick nested loops for a page of candidates,
    // and a lookup that cannot use an index then costs a table scan per row. Forcing it here makes that plan the one under test.
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls%20-c%20enable_hashjoin%3Doff%20-c%20enable_mergejoin%3Doff`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { dbUrl, saved, adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL, SPIDER_PILOT_ORG_IDS: undefined } };
});
vi.mock('../services/live/liveLines', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/live/liveLines')>();
  return { ...real, deliverLive: () => 0 };
});

import { switchFixture } from './permission-switches-fixture';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { runOnJobsClient } from '../lib/prismaJobs';
import { runWithOrg } from '../lib/tenant-context';
import { countQueries } from './support/query-counter';
import { endUncoveredRecipientRows } from '../services/spider/sweep';

const suite = adminClient ? describe : describe.skip;
const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const HOUR = 3_600_000;
type Rec = { roles: string[]; user_ids: string[]; lead_owner: boolean };
const body = (recipients: Rec) => ({
  status_limits: {
    NEW: { enabled: true, value: 2, unit: 'HOUR' },
    CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
    WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
  },
  channels: { in_app: true, red_frame: true, email: false, text: false },
  recipients,
});

suite('#3462 cost under app_rls with the tenant guard on, in a database with a large alert history', () => {
  const db = adminClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  let usersClient: PrismaClient;
  let jobsClient: PrismaClient;

  beforeAll(async () => {
    await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN CREATE ROLE app_rls NOLOGIN NOBYPASSRLS; END IF; END $$;`);
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_rls');
    await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
    ({ prisma: usersClient } = await import('../lib/prisma.js'));
    ({ prismaJobs: jobsClient } = await import('../lib/prismaJobs.js'));
    await import('../app.js');
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notifications', 'spider_alerts', 'spider_summaries', 'spider_recipient_sets', 'spider_settings', 'leads']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
    }
    await fx.cleanup();
    await usersClient?.$disconnect();
    await jobsClient?.$disconnect();
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    if (saved.guard === undefined) delete process.env.DB_TENANT_GUARD;
    else process.env.DB_TENANT_GUARD = saved.guard;
  }, 900_000);

  async function newCompany(r: Rec) {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    const api = await fx.signedInAs(o.admin);
    expect((await api.put(SETTINGS, body(r))).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
    await db.spiderSettings.updateMany({ where: { organization_id: { not: o.org }, is_active: true }, data: { is_active: false } });
    return o;
  }

  async function bulkUsers(org: string, n: number, role: 'DISPATCHER' | 'SALES' | 'ADMIN', tag: string) {
    const users = Array.from({ length: n }, (_, i) => {
      const id = randomUUID();
      return { id, organization_id: org, email: `${tag}${i}-${id.slice(0, 8)}@example.test`, first_name: `${tag}${i}`, last_name: 'Tester', role, is_admin: role === 'ADMIN' };
    });
    await db.user.createMany({ data: users });
    return users.map((u) => u.id);
  }

  /** `count` old alerts in other companies: one lead per company, a different stage-entry instant per alert (the claim key). */
  async function alertHistory(companies: number, count: number) {
    for (let c = 0; c < companies; c++) {
      const o = await fx.newOrg();
      orgs.push(o.org);
      const lead = randomUUID();
      await db.lead.create({ data: { id: lead, organization_id: o.org, customer_id: o.customer, lead_number: `H-${c}`, service_request: 'x' } });
      const base = Date.now() - 400 * 24 * HOUR;
      for (let i = 0; i < count; i += 5000) {
        await db.spiderAlert.createMany({
          data: Array.from({ length: Math.min(5000, count - i) }, (_, j) => {
            const at = new Date(base + (i + j) * 60_000);
            return { organization_id: o.org, lead_id: lead, status: 'NEW' as const, entered_status_at: at, counted_from: at, limit_value: 2, limit_unit: 'HOUR' };
          }),
        });
      }
    }
  }

  /** `leads` open alerts each told to every one of `people`, stored as Spider stores them (alert row, its list, the record's data.spider_alert_id). */
  async function seedAlerts(org: string, customer: string, people: { id: string; role: string }[], leads: number) {
    const enteredAt = new Date(Date.now() - 3 * HOUR);
    const leadIds = Array.from({ length: leads }, () => randomUUID());
    for (let i = 0; i < leads; i += 1000) {
      await db.lead.createMany({
        data: leadIds.slice(i, i + 1000).map((id, j) => ({ id, organization_id: org, customer_id: customer, lead_number: `L-${i + j}-${id.slice(0, 6)}`, service_request: 'x', created_at: enteredAt })),
      });
    }
    const setId = randomUUID();
    await db.spiderRecipientSet.create({
      data: { id: setId, organization_id: org, hash: randomUUID(), recipients: people.map((p) => ({ id: p.id, name: 'P', email: 'x', role: p.role, type: 'admin' })) },
    });
    const alertIds = leadIds.map(() => randomUUID());
    for (let i = 0; i < leads; i += 1000) {
      await db.spiderAlert.createMany({
        data: leadIds.slice(i, i + 1000).map((leadId, j) => ({
          id: alertIds[i + j]!, organization_id: org, lead_id: leadId, status: 'NEW' as const, entered_status_at: enteredAt, counted_from: enteredAt,
          limit_value: 2, limit_unit: 'HOUR', recipient_set_id: setId, recipient_ids: people.map((p) => p.id),
        })),
      });
    }
    const nIds = leadIds.map(() => randomUUID());
    for (let i = 0; i < leads; i += 1000) {
      await db.notification.createMany({
        data: leadIds.slice(i, i + 1000).map((leadId, j) => ({
          id: nIds[i + j]!, organization_id: org, verb: 'spider.alert', category: 'LEAD' as const, priority: 'FEED' as const,
          object_type: 'LEAD', object_id: leadId, object_label: 'L', title: 'Spider',
          data: { status: 'NEW', entered_status_at: enteredAt.toISOString(), spider_alert_id: alertIds[i + j] },
        })),
      });
    }
    await db.$executeRawUnsafe(
      `INSERT INTO notification_recipients (id, notification_id, organization_id, recipient_id, priority)
       SELECT gen_random_uuid(), n.id, n.organization_id, u, 'FEED'::"NotificationPriority"
         FROM notifications n CROSS JOIN unnest($2::uuid[]) u WHERE n.organization_id = $1::uuid AND n.verb = 'spider.alert'`,
      org, people.map((p) => p.id),
    );
    for (const t of ['notification_recipients', 'notifications', 'users', 'spider_alerts', 'spider_recipient_sets']) await db.$executeRawUnsafe(`ANALYZE ${t}`);
    return { leadIds, alertIds };
  }

  /** Polls pg_stat_activity for the longest transaction any connection holds open while the work runs. */
  function watchLongest() {
    const watcher = new (require('@prisma/client') as typeof import('@prisma/client')).PrismaClient({ datasources: { db: { url: dbUrl! } } });
    const state = { longest: 0, watching: true, done: Promise.resolve() };
    state.done = (async () => {
      while (state.watching) {
        const [row] = await watcher.$queryRawUnsafe<{ secs: number | null }[]>(
          `SELECT max(extract(epoch FROM (clock_timestamp() - xact_start)))::float8 AS secs FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL AND backend_type = 'client backend'
              AND NOT (query LIKE 'SELECT max(extract(epoch%')`,
        );
        state.longest = Math.max(state.longest, row?.secs ?? 0);
        await new Promise((r) => setTimeout(r, 3));
      }
    })();
    return { stop: async () => { state.watching = false; await state.done; await watcher.$disconnect(); return state.longest; } };
  }

  /** The sweep's ending step on the jobs client, as app_rls with the guard: statements, time, longest transaction. */
  async function step(org: string, rec: Rec, before?: Rec) {
    const w = watchLongest();
    const t = Date.now();
    const both = await countQueries(
      async () => countQueries(() => runOnJobsClient(() => runWithOrg(org, () => endUncoveredRecipientRows(org, new Date(), rec as never, before as never))), jobsClient),
      usersClient,
    );
    return { ended: both.result.result, ms: Date.now() - t, jobs: both.result.count, users: both.count, longest: await w.stop() };
  }

  it('60 people x 50 alerts among 50,000 alerts of other companies: the DISPATCHER-removing save and a sweep step stay cheap', async () => {
    await alertHistory(3, 16_667);
    const o = await newCompany({ roles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'], user_ids: [], lead_owner: true });
    const d = await bulkUsers(o.org, 30, 'DISPATCHER', 'd');
    const s = await bulkUsers(o.org, 30, 'SALES', 's');
    await seedAlerts(o.org, o.customer, [...d.map((id) => ({ id, role: 'DISPATCHER' })), ...s.map((id) => ({ id, role: 'SALES' }))], 50);
    clearPermissionCache();
    const api = await fx.signedInAs(o.admin);
    await api.get('/api/ai-farm/spider/alerts/unread');

    // The save (users client): DISPATCHER removed.
    const w = watchLongest();
    const t0 = Date.now();
    const saved = await countQueries(async () => countQueries(() => api.put(SETTINGS, body({ roles: ['ADMIN', 'SALES', 'TECHNICIAN'], user_ids: [], lead_owner: true })), usersClient), jobsClient);
    const saveMs = Date.now() - t0;
    const saveLongest = await w.stop();
    expect(saved.result.result.status).toBe(200);
    // eslint-disable-next-line no-console
    console.log(`[#3462 cost app_rls] save: ${saveMs} ms request; users-client statements ${saved.result.count}; jobs ${saved.count}; longest transaction ${saveLongest.toFixed(3)} s`);
    expect(await db.notificationRecipient.count({ where: { organization_id: o.org, read_at: { not: null } } })).toBe(1_500);
    expect(saveMs).toBeLessThan(1_000);
    expect(saveLongest).toBeLessThan(1);
    // 3 full pages and a closing one: a candidate read, a lead read and an update each (4 statements a call), the rest of the request.
    expect(saved.result.count).toBeLessThanOrEqual(120);

    // The sweep step (jobs client): SALES removed.
    const rec = { roles: ['ADMIN', 'TECHNICIAN'], user_ids: [], lead_owner: true };
    await db.spiderSettings.update({ where: { organization_id: o.org }, data: { recipients: rec } });
    const st = await step(o.org, rec);
    // eslint-disable-next-line no-console
    console.log(`[#3462 cost app_rls] sweep step: ${st.ended} ended; ${st.ms} ms; jobs statements ${st.jobs}; users-client statements ${st.users}; longest transaction ${st.longest.toFixed(3)} s`);
    expect(st.ended).toBe(1_500);
    expect(st.users).toBe(0);
    expect(st.ms).toBeLessThan(1_000);
    expect(st.longest).toBeLessThan(1);
    expect(st.jobs).toBeLessThanOrEqual(60);
  }, 900_000);

  it('25,000 Admin rows with ADMIN unticked: the steady sweep step ends nothing, in bounded statements, no transaction near 1 s; the reason read uses the alert\'s primary key', async () => {
    const rec = { roles: ['DISPATCHER'], user_ids: [], lead_owner: true };
    const o = await newCompany({ roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true });
    const admins = [o.admin.id, ...(await bulkUsers(o.org, 4, 'ADMIN', 'a'))];
    const disp = await bulkUsers(o.org, 20, 'DISPATCHER', 'd');
    const { alertIds } = await seedAlerts(o.org, o.customer, [...admins.map((id) => ({ id, role: 'ADMIN' })), ...disp.map((id) => ({ id, role: 'DISPATCHER' }))], 5_000);
    await db.spiderSettings.update({ where: { organization_id: o.org }, data: { recipients: rec } });
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push(await step(o.org, rec));
    for (const r of runs) {
      // eslint-disable-next-line no-console
      console.log(`[#3462 cost app_rls] 25,000 Admin rows, ADMIN unticked: ${r.ended} ended; ${r.ms} ms; jobs statements ${r.jobs}; longest transaction ${r.longest.toFixed(3)} s`);
      expect(r.ended).toBe(0);
      expect(r.users).toBe(0);
      expect(r.longest).toBeLessThan(1);
      // 50 pages of 500 Admin rows: a candidate read and a stored-reason read each (4 statements a call), nothing per alert.
      expect(r.jobs).toBeLessThanOrEqual(50 * 2 * 4 + 16);
    }

    // The stored-reason read of one page, as app_rls under the tenant setting: the alert by primary key, never a scan.
    const ids = alertIds.slice(0, 20);
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true), set_config('app.bypass_rls', 'off', true)`, o.org);
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT a.id::text, p->>'id', p->>'type' FROM spider_alerts a
           LEFT JOIN spider_recipient_sets s ON s.id = a.recipient_set_id
           CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.recipients, a.recipients, '[]'::jsonb)) p
          WHERE a.organization_id = $1::uuid AND a.id = ANY($2::uuid[]) AND p->>'id' = ANY($3::text[])`,
        o.org, ids, admins.map(String),
      );
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    // eslint-disable-next-line no-console
    console.log(`[#3462 cost app_rls] EXPLAIN stored-reason read:\n${text}`);
    expect(text).not.toMatch(/Seq Scan on spider_alerts/);
    expect(text).toMatch(/spider_alerts_pkey/);
  }, 900_000);
});

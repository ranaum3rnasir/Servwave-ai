/* =============================================================================
   #3469: what one Spider check (services/spider/tick.ts) costs, on a real migrated database.

   - Statements, counted on the jobs client exactly as sent (every Prisma call under the tenant guard is BEGIN, set_config,
     the query, COMMIT; support/query-counter.ts counts all four):
       - a check costs the same for 3 switched-on companies as for 30, and the same for 3 due leads as for 30 (the
         emails and texts aside: Email and Text are off here);
       - a company with due stays adds the same fixed number of statements, however many due stays it has;
       - nothing on the users' client: every statement of a check goes through the jobs client.
   - Time: at 5,000 open leads (and 100 due), no transaction of the check stays open for as long as 1 second, and its due
     statement is fast (the local stand-in for "under 50 ms on the synthetic company", which waits for staging).
   - The ending, on analyzed tables: a check that reads 5,000 changed watch rows with 100 open alerts (3 people each, and
     the synthetic company's 60) stays well under the jobs' 5 s limit (support/spider-ending-cost.ts; the same cases run
     with generic plans in spider-tick-generic-plan-db.test.ts).
   - Time zones: the due statement returns the same stays whatever the session's time zone (the test runner's sessions are
     America/New_York; production's are UTC). Every TIMESTAMP comparison is in UTC wall time.

   Every connection of the app's clients acts as the live API's role (`app_rls`, no BYPASSRLS) with the tenant guard on, and plans
   every statement for its own values (`plan_cache_mode=force_custom_plan`), as production's pgbouncer-pooled connections do.
   Skips when TEST_DATABASE_URL is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { adminClient, dbUrl } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    // plan_cache_mode: production reaches the database through pgbouncer (`pgbouncer=true`), where Prisma keeps no named prepared
    // statements, so every statement is planned afresh for its own values. A direct connection (this test's) reuses a named
    // statement and, after 5 runs, may switch it to a generic plan that cannot see the values, which on a database that was never
    // analyzed was once enough to push one ending statement past the jobs' 5 s limit. Forcing a custom plan makes these connections
    // plan the way production's do. (The timing assertions below are unchanged.)
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls%20-c%20plan_cache_mode%3Dforce_custom_plan`;
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
import { countQueries } from './support/query-counter';
import { HOUR, MIN, T0, addLead, at, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import { endingCostCases } from './support/spider-ending-cost';
import { readStatusLimits } from '../services/spider/config';
import { _resetSpiderTick, findDueStays, runSpiderTick, type TickResult } from '../services/spider/tick';

const suite = adminClient ? describe : describe.skip;

suite('what one Spider check costs (#3469, real database)', () => {
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

  const QUIET = { in_app: true, red_frame: true, email: false, text: false };

  /** Spider switched off for every company but these (a check covers every switched-on company). */
  const only = async (...keep: string[]) => {
    await db.spiderSettings.updateMany({ where: { organization_id: { notIn: keep }, is_active: true }, data: { is_active: false } });
    await db.spiderSettings.updateMany({ where: { organization_id: { in: keep } }, data: { is_active: true } });
  };

  /** A switched-on company, Email and Text off, with `due` New leads past their limit at T0 and `waiting` not yet. */
  async function company(due: number, waiting = 2): Promise<SpiderCompany> {
    const c = await spiderCompany(db, orgs, { leads: due });
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
    for (let i = 0; i < waiting; i += 1) await addLead(db, c, at(-HOUR - i * MIN));
    return c;
  }

  /** One check at `now`, counted on both of the app's clients. */
  async function measure(now: Date): Promise<{ jobs: number; users: number; result: TickResult }> {
    clearPermissionCache();
    await _resetSpiderTick();
    let users = 0;
    let result: TickResult | undefined;
    const jobs = await countQueries(async () => {
      users = (await countQueries(async () => { result = await runSpiderTick(now); }, usersClient)).count;
    }, jobsClient);
    return { jobs: jobs.count, users, result: result! };
  }

  it('costs the same for 3 switched-on companies as for 30, and nothing on the users client', async () => {
    const companies: SpiderCompany[] = [];
    for (let i = 0; i < 30; i += 1) companies.push(await company(0));
    const ids = companies.map((c) => c.org);

    await only(...ids.slice(0, 3));
    const three = await measure(T0);
    await only(...ids);
    const thirty = await measure(T0);

    console.info(`[3469 counts] idle check: 3 companies ${three.jobs} statements; 30 companies ${thirty.jobs}`);
    expect(three.result).toMatchObject({ companies: 3, due: 0, claimed: 0 });
    expect(thirty.result).toMatchObject({ companies: 30, due: 0, claimed: 0 });
    expect(three.jobs).toBeGreaterThan(0);
    expect(thirty.jobs).toBe(three.jobs);
    expect(three.users).toBe(0);
    expect(thirty.users).toBe(0);
  });

  it('costs the same for 3 due leads as for 30 (sending aside), and nothing on the users client', async () => {
    const a = await company(3);
    const b = await company(30);

    await only(a.org);
    const three = await measure(T0);
    await only(b.org);
    const thirty = await measure(T0);

    console.info(`[3469 counts] due leads: 3 leads ${three.jobs} statements; 30 leads ${thirty.jobs}`);
    expect(three.result).toMatchObject({ companies: 1, due: 3, claimed: 3 });
    expect(thirty.result).toMatchObject({ companies: 1, due: 30, claimed: 30 });
    expect(thirty.jobs).toBe(three.jobs);
    expect(three.users).toBe(0);
    expect(thirty.users).toBe(0);
  });

  it('a company with due stays adds the same fixed number of statements as any other', async () => {
    const idle = [await company(0), await company(0), await company(0)];
    const one = [await company(2), await company(0), await company(0)];
    const three = [await company(2), await company(2), await company(2)];

    await only(...idle.map((c) => c.org));
    const base = await measure(T0);
    await only(...one.map((c) => c.org));
    const withOne = await measure(T0);
    await only(...three.map((c) => c.org));
    const withThree = await measure(T0);

    const perCompany = withOne.jobs - base.jobs;
    console.info(`[3469 counts] idle ${base.jobs} statements; each company with due stays adds ${perCompany}`);
    expect(withOne.result.claimed).toBe(2);
    expect(withThree.result.claimed).toBe(6);
    expect(perCompany).toBeGreaterThan(0);
    expect(withThree.jobs - base.jobs).toBe(3 * perCompany);
    expect(withThree.users).toBe(0);
  });

  // #3471: the starting summary the check builds (summaryStart.ts) costs a fixed number of statements however many leads it
  // covers, a waiting trigger costs the check nothing, and none of it touches the users' client.
  describe('the starting summary built by the check (#3471)', () => {
    /** A company Activated over `due` overdue leads (a SWITCHED_ON trigger an hour before T0), Email and Text off. */
    async function backlogCompany(due: number): Promise<SpiderCompany> {
      const c = await spiderCompany(db, orgs, { leads: due, trigger: true });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
      return c;
    }

    it('a waiting trigger (a widening Save inside its 30 s) costs the same for 3 companies as for 30', async () => {
      const companies: SpiderCompany[] = [];
      for (let i = 0; i < 30; i += 1) {
        const c = await company(0);
        await db.spiderSettings.update({
          where: { organization_id: c.org },
          data: { summary_trigger_at: T0, summary_trigger_since: T0, summary_trigger_kind: 'LIMIT_SHORTENED' },
        });
        companies.push(c);
      }
      const ids = companies.map((c) => c.org);
      await only(...ids.slice(0, 3));
      const three = await measure(T0);
      await only(...ids);
      const thirty = await measure(T0);
      console.info(`[3471 counts] waiting triggers: 3 companies ${three.jobs} statements; 30 companies ${thirty.jobs}`);
      expect(three.result).toMatchObject({ companies: 3, summaries: 0 });
      expect(thirty.result).toMatchObject({ companies: 30, summaries: 0 });
      expect(thirty.jobs).toBe(three.jobs);
      expect(thirty.users).toBe(0);
    });

    it('a summary of 5 leads and one of 300 run the same number of statements (what grows is the people, not the leads), all on the jobs client', async () => {
      const small = await backlogCompany(5);
      const big = await backlogCompany(300);
      await only(small.org);
      const five = await measure(at(1_000));
      await only(big.org);
      const threeHundred = await measure(at(1_000));
      console.info(`[3471 counts] one summary: 5 leads ${five.jobs} statements; 300 leads ${threeHundred.jobs}`);
      expect(five.result).toMatchObject({ summaries: 1, summarized: 5 });
      expect(threeHundred.result).toMatchObject({ summaries: 1, summarized: 300 });
      expect(threeHundred.jobs).toBe(five.jobs);
      expect(five.users).toBe(0);
      expect(threeHundred.users).toBe(0);
    });

    it('at 1,300 overdue leads x 20 recipients no transaction stays open for 1 second', async () => {
      const c = await spiderCompany(db, orgs, { leads: 1_300, trigger: true, admins: 20, dispatchers: 0 });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
      await only(c.org);
      const watcherClient = new (require('@prisma/client') as typeof import('@prisma/client')).PrismaClient({ datasources: { db: { url: dbUrl! } } });
      try {
        let longest = 0;
        let watching = true;
        const watcher = (async () => {
          while (watching) {
            const [row] = await watcherClient.$queryRawUnsafe<{ secs: number | null }[]>(
              `SELECT max(extract(epoch FROM (clock_timestamp() - xact_start)))::float8 AS secs
                 FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL AND backend_type = 'client backend'
                  AND NOT (query LIKE 'SELECT max(extract(epoch%')`,
            );
            longest = Math.max(longest, row?.secs ?? 0);
            await new Promise((r) => setTimeout(r, 3));
          }
        })();
        const started = Date.now();
        const result = await runSpiderTick(at(1_000));
        const took = Date.now() - started;
        watching = false;
        await watcher;
        console.info(`[3471 1,300 x 20] longest open transaction=${longest.toFixed(3)} s; the whole check and summary ${took} ms`);
        expect(result).toMatchObject({ summaries: 1, summarized: 1_300 });
        expect(longest).toBeLessThan(1);
      } finally {
        await watcherClient.$disconnect();
      }
    }, 240_000);
  });

  it('at 5,000 open leads (100 of them due) no transaction stays open for 1 second, and the due statement is fast', async () => {
    const c = await company(100, 0);
    // 4,900 more open New leads, still inside their 2-hour limit at T0, in one statement (each one's watch row by the trigger).
    await db.lead.createMany({
      data: Array.from({ length: 4_900 }, (_, i) => {
        const id = randomUUID();
        return {
          id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 12)}`, service_request: 'Fix the door',
          status: 'NEW' as const, created_at: at(-HOUR - i * 1_000),
        };
      }),
    });
    await only(c.org);
    const watcherClient = new (require('@prisma/client') as typeof import('@prisma/client')).PrismaClient({ datasources: { db: { url: dbUrl! } } });
    try {
      let longest = 0;
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          const [row] = await watcherClient.$queryRawUnsafe<{ secs: number | null }[]>(
            `SELECT max(extract(epoch FROM (clock_timestamp() - xact_start)))::float8 AS secs
               FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL AND backend_type = 'client backend'
                AND NOT (query LIKE 'SELECT max(extract(epoch%')`,
          );
          longest = Math.max(longest, row?.secs ?? 0);
          await new Promise((r) => setTimeout(r, 3));
        }
      })();
      const first = await runSpiderTick(T0);
      const second = await runSpiderTick(at(1_000));
      watching = false;
      await watcher;

      console.info(
        `[3469 5,000 open leads] longest open transaction=${longest.toFixed(3)} s; due statement ${first.dueMs} ms ` +
          `(100 due), then ${second.dueMs} ms (none due)`,
      );
      expect(first).toMatchObject({ due: 100, claimed: 100 });
      expect(second).toMatchObject({ due: 0, claimed: 0 });
      expect(longest).toBeLessThan(1);
      expect(second.dueMs).toBeLessThan(250);
    } finally {
      await watcherClient.$disconnect();
    }
  }, 180_000);

  // The ending when thousands of watch rows change at once, on analyzed tables (support/spider-ending-cost.ts); the same cases
  // run with generic plans in spider-tick-generic-plan-db.test.ts.
  describe('the ending at 5,000 changed watch rows (custom plans)', () => {
    endingCostCases({ db, orgs, dbUrl, only, label: 'custom plans' });
  });

  describe('the same stays whatever the session time zone', () => {
    const ZONES = ['UTC', 'America/New_York', 'Pacific/Auckland'];

    it('the due statement returns the same due stays, the same next crossing, and settles the same, under every zone', async () => {
      const now = new Date();
      const c = await company(0, 0);
      // A starting trigger half an hour ago: crossings before it belong to the summary, after it to the check.
      const trigger = new Date(now.getTime() - 30 * MIN);
      const beforeTrigger = await addLead(db, c, new Date(now.getTime() - 2 * HOUR - 40 * MIN));
      const afterTrigger = await addLead(db, c, new Date(now.getTime() - 2 * HOUR - 20 * MIN));
      const justDue = await addLead(db, c, new Date(now.getTime() - 2 * HOUR));
      const notYet = await addLead(db, c, new Date(now.getTime() - 2 * HOUR + 10 * MIN));
      const settings = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } });
      const input = {
        now,
        companies: [{ orgId: c.org, activatedAt: settings.activated_at!, limits: readStatusLimits(settings.status_limits), triggerAt: trigger }],
        unreachable: [],
      };

      const seen: Record<string, unknown> = {};
      for (const zone of ZONES) {
        const client = new (require('@prisma/client') as typeof import('@prisma/client')).PrismaClient({
          datasources: { db: { url: `${dbUrl}${dbUrl!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c TimeZone=${zone}`)}` } },
        });
        try {
          const [{ tz }] = await client.$queryRawUnsafe<{ tz: string }[]>(`SELECT current_setting('TimeZone') AS tz`);
          expect(tz).toBe(zone);
          const found = await findDueStays(client, input);
          seen[zone] = { due: found.due.map((d) => [d.leadId, d.enteredAt.getTime(), d.countedFrom.getTime()]), next: found.nextDueAt, settled: found.settled };
        } finally {
          await client.$disconnect();
        }
      }

      const createdAt = async (id: string) => (await db.lead.findUniqueOrThrow({ where: { id }, select: { created_at: true } })).created_at.getTime();
      const expected = {
        due: [
          [afterTrigger, await createdAt(afterTrigger), await createdAt(afterTrigger)],
          [justDue, await createdAt(justDue), await createdAt(justDue)],
        ],
        next: (await createdAt(notYet)) + 2 * HOUR,
        settled: 0,
      };
      for (const zone of ZONES) expect(seen[zone], zone).toEqual(expected);
      expect(JSON.stringify(seen)).not.toContain(beforeTrigger);
    });
  });
});

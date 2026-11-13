/* =============================================================================
   Test helper (not a test file): what the check's ending step costs (services/spider/tick.ts endChangedAlerts) when
   thousands of watch rows change at once, on tables with real statistics (ANALYZE'd, as production's are). Two suites
   run these same cases, each planning the app's statements its own way, so the ending is proven under both:
     - spider-tick-cost-db.test.ts: plan_cache_mode=force_custom_plan (production: through pgbouncer every statement is
       planned for its own values);
     - spider-tick-generic-plan-db.test.ts: force_generic_plan (a reused prepared statement planned once, for any values).

   The shapes:
     - 5,000 open leads whose watch rows all changed since the previous check, 100 of them alerted (3 people each);
     - the synthetic company of the staging rehearsal (#3474): 5,000 open leads, 100 alerted, 60 people told each.
   Both companies have worked for a while: 50,000 bell notifications of their own, unread (as most bells are). Reading
   the open Spider records must not grow with that history: a read that compared every unread bell row of the company
   with every open alert took 0.6-0.9 s at 20,000 rows, and twice that here.
   Each runs one check that ends nothing (the 5,000 rows read, the 100 alerts still open), then a mass status move (every
   lead to Contacted in one save) and one check that ends every open alert. Each such check must stay well under the
   jobs' 5 s statement limit (lib/prismaJobs.ts), and no transaction may stay open for a second while it runs.

   The record read (the open records of a page's alerts, by key) is also held to bounds that do not depend on the
   machine, under BOTH plan modes: the pages it reads (shared buffers) at most RECORD_READ_BUFFERS_PER_KEY a key, and the
   rows its plan handles (each node's runs plus the rows it gives) at most RECORD_READ_ROWS_PER_KEY a key. Both, as a
   bad plan may read few pages and still handle millions of rows (a merge join that re-sorted 1.5 million rows from 257
   buffers: 885 ms on one run). Two shapes
   among a crowd of 200,000 other notifications, 1,000 open alerts told to 3 people:
     - 100 of the leads move: 200 keys. A join of the keys to the records and their unread rows was planned (custom
       plans) as every key against every unread record of the company: 0.55-0.63 s a check, about 3,000 buffers a key;
     - all 1,000 move, the company also has 50,000 unread bell notifications: 2,000 keys on one page.
   The read the check really sent is captured and explained, as the production role reads it, on the data as it was
   before the check ended those records.

   The suite wires the app's clients (role app_rls, the tenant guard on) and passes its admin client, its company list
   and its `only` (Spider switched off for every other company).
   ========================================================================== */

import { expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { HOUR, MIN, T0, at, spiderCompany } from './spider-company';
import { countQueries, type CountedQuery } from './query-counter';
import { runSpiderTick } from '../../services/spider/tick';

/** A check whose ending reads 5,000 changed watch rows takes less than this, whole (the jobs' limit is 5 s per statement). */
export const ENDING_CHECK_MS = 1_000;

/** The company's own bell notifications before the test, every one unread. */
export const BELL_HISTORY = 50_000;

/**
 * The record read's work per key it looks up, in shared buffers, in either plan mode. A key's lookup is one probe of the
 * records' unique index and one of the unread rows' index (about 8 buffers); a read that meets every unread record of
 * the company for every key needs thousands.
 */
export const RECORD_READ_BUFFERS_PER_KEY = 30;

/**
 * The record read's rows per key, in either plan mode: summed over its plan's nodes, the times each ran plus the rows it
 * gave (about 9 a key for a lookup by key; every key against every unread record of the company gives millions).
 */
export const RECORD_READ_ROWS_PER_KEY = 30;

/** Other companies' notifications in the same table: the crowd every company's records sit among. */
const CROWD_NOTIFICATIONS = 200_000;

const QUIET = { in_app: true, red_frame: true, email: false, text: false };

/** `count` bell notifications of the company (a lead assigned), each to one of its people, unread; two statements. */
async function bellHistory(db: PrismaClient, org: string, people: string[], count: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO notifications (id, organization_id, verb, category, priority, object_type, object_id, title, dedup_key, created_at)
    SELECT gen_random_uuid(), ${org}::uuid, 'lead.assigned', 'LEAD'::"NotificationCategory", 'FEED'::"NotificationPriority",
           'lead', gen_random_uuid()::text, 'A lead was assigned to you', 'lead.assigned:history-' || g,
           (${T0.toISOString()}::timestamptz AT TIME ZONE 'UTC') - g * interval '1 minute'
      FROM generate_series(1, ${count}::int) AS g`;
  await db.$executeRaw`
    INSERT INTO notification_recipients (id, notification_id, organization_id, recipient_id, priority, created_at)
    SELECT gen_random_uuid(), n.id, n.organization_id,
           (${people}::uuid[])[1 + (row_number() OVER (ORDER BY n.created_at) % ${people.length}::int)::int],
           'FEED'::"NotificationPriority", n.created_at
      FROM notifications n
     WHERE n.organization_id = ${org}::uuid AND n.verb = 'lead.assigned'`;
}

/** `count` notifications of another company (a lead assigned), with no recipient rows; one statement. */
async function crowdNotifications(db: PrismaClient, org: string, count: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO notifications (id, organization_id, verb, category, priority, object_type, object_id, title, dedup_key, created_at)
    SELECT gen_random_uuid(), ${org}::uuid, 'lead.assigned', 'LEAD'::"NotificationCategory", 'FEED'::"NotificationPriority",
           'lead', gen_random_uuid()::text, 'A lead was assigned to you', 'lead.assigned:crowd-' || g,
           (${T0.toISOString()}::timestamptz AT TIME ZONE 'UTC') - g * interval '1 minute'
      FROM generate_series(1, ${count}::int) AS g`;
}

/** The tables the check reads, given real statistics (as autovacuum keeps them in production). */
export async function analyzeSpiderTables(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('ANALYZE spider_lead_watch, spider_alerts, spider_settings, notifications, notification_recipients, leads');
}

/**
 * The longest any transaction of this database (but the watcher's own) stays open while the watch runs, in seconds.
 * `ready` settles once the watcher has looked for the first time, so what follows it is watched from its start.
 */
export function watchLongestTransaction(dbUrl: string): { ready: Promise<void>; stop: () => Promise<number> } {
  const client = new (require('@prisma/client') as typeof import('@prisma/client')).PrismaClient({ datasources: { db: { url: dbUrl } } });
  let longest = 0;
  let watching = true;
  let looked!: () => void;
  const ready = new Promise<void>((resolve) => (looked = resolve));
  const watcher = (async () => {
    while (watching) {
      const [row] = await client.$queryRawUnsafe<{ secs: number | null }[]>(
        `SELECT max(extract(epoch FROM (clock_timestamp() - xact_start)))::float8 AS secs
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL AND backend_type = 'client backend'
            AND NOT (query LIKE 'SELECT max(extract(epoch%')`,
      );
      longest = Math.max(longest, row?.secs ?? 0);
      looked();
      await new Promise((r) => setTimeout(r, 3));
    }
  })();
  // A watcher that fails ends the wait too (stop() then rethrows its error).
  watcher.catch(() => looked());
  let stopped: Promise<number> | null = null;
  return {
    ready,
    stop: () =>
      (stopped ??= (async () => {
        watching = false;
        await watcher;
        await client.$disconnect();
        return longest;
      })()),
  };
}

/** Unread in-app and red-frame rows of this company: what keeps cards and frames on screen. */
async function openRecordRows(db: PrismaClient, org: string): Promise<number> {
  return db.notificationRecipient.count({
    where: { organization_id: org, read_at: null, notification: { verb: { in: ['spider.alert', 'spider.frame'] } } },
  });
}

/**
 * One check at `now`, timed, with the longest any transaction stays open while it runs (watched around the check alone,
 * so the test's own mass save is not counted); a check that throws gives its error as the outcome (still measured).
 */
async function timedCheck(dbUrl: string, now: Date): Promise<{ ms: number; outcome: unknown; longest: number }> {
  const watch = watchLongestTransaction(dbUrl);
  try {
    await watch.ready;
    const started = Date.now();
    const outcome = await runSpiderTick(now).catch((err: unknown) => err);
    const ms = Date.now() - started;
    return { ms, outcome, longest: await watch.stop() };
  } finally {
    await watch.stop();
  }
}

/** A captured statement's parameters as SQL literals, for EXECUTE (arrays as array literals). */
function literals(paramsJson: string): string[] {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return (JSON.parse(paramsJson) as unknown[]).map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return q(`{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`);
    return q(String(v));
  });
}

/** One explained record read: its plan mode, keys, time, work (shared buffers; rows handled) and plan shape (node, rows, loops). */
interface ExplainedRead {
  mode: string;
  keys: number;
  ms: number;
  buffers: number;
  rows: number;
  shape: string;
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

function shapeOf(node: PlanNode, depth = 0): string[] {
  const on = node['Index Name'] ? ` using ${String(node['Index Name'])}` : node['Relation Name'] ? ` on ${String(node['Relation Name'])}` : '';
  const line = `${'  '.repeat(depth)}${String(node['Node Type'])}${on} (rows ${String(node['Actual Rows'])}, loops ${String(node['Actual Loops'])})`;
  return [line, ...(node.Plans ?? []).flatMap((p) => shapeOf(p, depth + 1))];
}

/** The rows a plan handles: summed over its nodes, the times each ran plus the rows it gave in all. */
function rowsOf(node: PlanNode): number {
  const loops = Number(node['Actual Loops'] ?? 0);
  return loops + Number(node['Actual Rows'] ?? 0) * loops + (node.Plans ?? []).reduce((sum, p) => sum + rowsOf(p), 0);
}

class Rollback extends Error {}
let explained = 0;

/**
 * The record reads a check sent (FROM unnest(...) over the notifications), each explained (ANALYZE, BUFFERS) under both
 * plan modes as the production role reads them (app_rls; row security bypassed, as the check's unscoped reads are), on
 * the data as it was before the check: the records it ended (these leads' Spider records) are unread again inside the
 * explain's transaction, which is rolled back.
 */
async function explainRecordReads(db: PrismaClient, sent: CountedQuery[], org: string, leads: string[]): Promise<ExplainedRead[]> {
  const reads = sent.filter((q) => q.sql.includes('FROM unnest(') && q.sql.includes('notifications n'));
  const out: ExplainedRead[] = [];
  for (const read of reads) {
    const keys = ((JSON.parse(read.params) as unknown[])[1] as unknown[]).length;
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      const name = `ending_record_read_${(explained += 1)}`;
      await db
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`
              UPDATE notification_recipients r SET read_at = NULL
                FROM notifications n
               WHERE n.id = r.notification_id AND n.organization_id = ${org}::uuid AND r.organization_id = ${org}::uuid
                 AND n.verb IN ('spider.alert', 'spider.frame') AND n.object_id = ANY(${leads}::text[])`;
            await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
            await tx.$executeRawUnsafe(`SET LOCAL plan_cache_mode = ${mode}`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '', true), set_config('app.bypass_rls', 'on', true)`);
            await tx.$executeRawUnsafe(`PREPARE ${name} AS ${read.sql}`);
            const [row] = await tx.$queryRawUnsafe<{ 'QUERY PLAN': unknown }[]>(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ${name}(${literals(read.params).join(', ')})`,
            );
            await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);
            const [plan] = row!['QUERY PLAN'] as [{ Plan: PlanNode; 'Execution Time': number }];
            out.push({
              mode, keys, ms: plan['Execution Time'],
              buffers: Number(plan.Plan['Shared Hit Blocks'] ?? 0) + Number(plan.Plan['Shared Read Blocks'] ?? 0),
              rows: rowsOf(plan.Plan),
              shape: shapeOf(plan.Plan).join('\n'),
            });
            throw new Rollback();
          },
          { timeout: 120_000 },
        )
        .catch((err: unknown) => {
          if (!(err instanceof Rollback)) throw err;
        });
    }
  }
  return out;
}

export function endingCostCases(ctx: {
  db: PrismaClient;
  orgs: string[];
  dbUrl: string | undefined;
  only: (...keep: string[]) => Promise<unknown>;
  label: string;
}): void {
  const shapes = [
    { name: '5,000 changed watch rows x 100 open alerts (3 people each)', admins: 2, dispatchers: 1 },
    { name: 'the synthetic company: 5,000 open leads, 100 open alerts told to 60 people each', admins: 60, dispatchers: 0 },
  ];
  for (const shape of shapes) {
    it(`${shape.name}, ${BELL_HISTORY.toLocaleString('en-US')} unread bell notifications, tables analyzed: each check that reads them stays well under the 5 s limit, and no transaction is open for 1 second`, async () => {
      const { db, orgs } = ctx;
      const c = await spiderCompany(db, orgs, { leads: 100, admins: shape.admins, dispatchers: shape.dispatchers });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
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
      await bellHistory(db, c.org, c.people.map((p) => p.id), BELL_HISTORY);
      await ctx.only(c.org);
      expect(await runSpiderTick(T0)).toMatchObject({ due: 100, claimed: 100 });
      await analyzeSpiderTables(db);
      const open = await openRecordRows(db, c.org);

      // Every one of the 5,000 watch rows changed since the previous check; the 100 alerts are all still open.
      const steady = await timedCheck(ctx.dbUrl!, at(1_000));
      // A mass status move: every lead to Contacted in one save, so the 5,000 rows change at once and every alert ends.
      await db.lead.updateMany({ where: { organization_id: c.org }, data: { status: 'CONTACTED', contacted_at: at(1_500) } });
      const moved = await timedCheck(ctx.dbUrl!, at(2_000));

      console.info(
        `[ending cost, ${ctx.label}] ${shape.name}: open rows ${open}; check that ends nothing ${steady.ms} ms ` +
          `(longest open transaction ${steady.longest.toFixed(3)} s), check after the mass move ${moved.ms} ms ` +
          `(longest open transaction ${moved.longest.toFixed(3)} s)`,
      );
      expect(steady.ms).toBeLessThan(ENDING_CHECK_MS);
      expect(moved.ms).toBeLessThan(ENDING_CHECK_MS);
      expect(steady.longest).toBeLessThan(1);
      expect(moved.longest).toBeLessThan(1);
      expect(steady.outcome).toMatchObject({ due: 0, claimed: 0, ended: 0 });
      expect(open).toBeGreaterThanOrEqual(100 * (shape.admins + shape.dispatchers));
      expect(moved.outcome).toMatchObject({ ended: open });
      expect(await openRecordRows(db, c.org)).toBe(0);
    }, 300_000);
  }

  const crowdShapes = [
    { name: 'among 200,000 other notifications, 1,000 open alerts (3 people each), 100 leads move: 200 keys', moving: 100, bell: 0 },
    {
      name: 'among 200,000 other notifications, 1,000 open alerts (3 people each) and 50,000 unread bell notifications, all 1,000 leads move: 2,000 keys',
      moving: 1_000,
      bell: BELL_HISTORY,
    },
  ];
  for (const shape of crowdShapes) {
    it(`${shape.name}: the record read works per key in both plan modes, and the check stays well under the 5 s limit`, async () => {
      const { db, orgs } = ctx;
      const { prismaJobs } = await import('../../lib/prismaJobs.js');
      const k = await spiderCompany(db, orgs, { leads: 1_000, admins: 3, dispatchers: 0 });
      await db.spiderSettings.update({ where: { organization_id: k.org }, data: { channels: QUIET } });
      const crowd = await spiderCompany(db, orgs, { leads: 0 });
      await ctx.only(k.org);
      // 1,000 alerts, 100 per check (the flood cap per 2 minutes), each told to the company's 3 people.
      for (let i = 0; i < 10; i += 1) expect((await runSpiderTick(at(i * (2 * MIN + 1_000)))).claimed).toBe(100);
      await crowdNotifications(db, crowd.org, CROWD_NOTIFICATIONS);
      if (shape.bell > 0) await bellHistory(db, k.org, k.people.map((p) => p.id), shape.bell);
      // The company's leads were last saved long ago: only the leads that move below are changed rows.
      await db.$executeRaw`UPDATE spider_lead_watch SET changed_at = changed_at - interval '400 days' WHERE organization_id = ${k.org}::uuid`;
      await analyzeSpiderTables(db);
      const open = await openRecordRows(db, k.org);
      expect(open).toBe(3_000);

      const moving = k.leads.slice(0, shape.moving);
      await db.lead.updateMany({ where: { id: { in: moving } }, data: { status: 'CONTACTED', contacted_at: new Date() } });
      const counted = await countQueries(() => timedCheck(ctx.dbUrl!, new Date()), prismaJobs);
      const moved = counted.result;
      const reads = await explainRecordReads(db, counted.queries, k.org, moving);

      console.info(
        `[record read, ${ctx.label}] ${shape.name}: check ${moved.ms} ms (longest open transaction ${moved.longest.toFixed(3)} s); ` +
          reads.map((r) => `${r.mode} ${r.keys} keys ${r.ms.toFixed(1)} ms ${r.buffers} buffers ${r.rows} rows:\n${r.shape}`).join('\n'),
      );
      expect(moved.outcome).toMatchObject({ ended: 3 * shape.moving });
      expect(await openRecordRows(db, k.org)).toBe(open - 3 * shape.moving);
      expect(reads.map((r) => r.keys).reduce((a, b) => a + b, 0)).toBe(2 * 2 * shape.moving);
      for (const r of reads) {
        expect(r.buffers, `${r.mode}, ${r.keys} keys, buffers`).toBeLessThanOrEqual(RECORD_READ_BUFFERS_PER_KEY * r.keys + 100);
        expect(r.rows, `${r.mode}, ${r.keys} keys, rows`).toBeLessThanOrEqual(RECORD_READ_ROWS_PER_KEY * r.keys + 100);
      }
      expect(moved.ms).toBeLessThan(ENDING_CHECK_MS);
      expect(moved.longest).toBeLessThan(1);
    }, 300_000);
  }
}

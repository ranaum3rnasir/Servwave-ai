/* =============================================================================
   #3058: the Spider sweep's paging read of a company's open leads uses the database's open-lead index as a keyset seek.

   The sweep reads a company's open leads in pages of 500 by lead id (services/spider/sweep.ts, currentStageVisits). Each
   page after the first must start where the last one ended, so the work does not grow with the square of the open
   leads. The evidence is the database's own query plan (EXPLAIN) of the exact SQL the sweep sent, captured with the
   query counter (support/query-counter.ts) and never a hand-copied statement: if the code's query stops matching the
   index, this fails.

   One journey over HTTP on a real migrated database: two Admins switch Spider on and save their settings, a third
   company excludes all but two of its leads (#3434), and one sweep runs. Two companies hold 20,000 open leads each (41 pages), so a
   page that strayed into the other company's leads shows, among a table of 40,000 more leads of a company not on Spider
   (alone in a small table any plan is cheap and the planner's choice says little). A company's summary is then read back
   over HTTP.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    // Built with the query-event log, so the query counter can count it (support/query-counter.ts).
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined,
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The app's database URL points at the same test database as the client above; every other value is the shared test env.
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { countQueries, reads, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';

const suite = realClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const SUMMARY = '/api/ai-farm/spider/summary';

const OPEN_LEADS = 20_000; // with a few overdue ones: forty full pages of 500 and a short last one
const PAGE = 500;
const BYSTANDER_LEADS = 40_000;
const MIN = 60_000;
/** The database's current instant as UTC wall-clock, the form the app stores in its `timestamp without time zone` columns. */
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

/** One node of EXPLAIN (FORMAT JSON), and its children. */
interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] }
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

/** The statement with its parameters written in as literals, so the database plans the very values the sweep sent. */
function withLiterals(q: CountedQuery): string {
  const params = JSON.parse(q.params) as unknown[];
  return q.sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const v = params[Number(n) - 1];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
}

/** The open-lead paging reads among a run's queries: SELECTs of leads that carry the open-lead condition and a limit. */
function openLeadPages(queries: CountedQuery[]): CountedQuery[] {
  return reads(queries, ['leads']).filter(
    (q) => /"leads"\."won_at" IS NULL/.test(q.sql) && /"leads"\."cancelled_at" IS NULL/.test(q.sql) && /\bLIMIT\b/.test(q.sql),
  );
}
/** The text of a call's arguments, from just after its opening parenthesis to the matching closing one. */
function callFrom(source: string, start: number): string {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}
/** The database's plan for exactly the statement the sweep sent. */
async function planOf(db: PrismaClient, q: CountedQuery): Promise<PlanNode> {
  const [{ 'QUERY PLAN': plan }] = await db.$queryRawUnsafe<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(`EXPLAIN (FORMAT JSON) ${withLiterals(q)}`);
  return plan[0]!.Plan;
}
const orgOf = (q: CountedQuery) => (JSON.parse(q.params) as string[])[0]!;

suite('Spider sweep: paging read of open leads (#3058, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);
  const orgs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const table of ['spider_alerts', 'spider_summaries', 'spider_settings']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, orgs));
    }
    await quietly(clearLease());
    await fx.cleanup();
  }, 180_000);

  interface Company { org: string; admin: Person; customer: string }

  /** A Scale demo company, Spider Not active until its Admin saves the settings (saveSettings). */
  async function company(): Promise<Company> {
    const { org, admin, customer } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { is_demo: true } });
    return { org, admin, customer };
  }

  /**
   * The Admin's saved settings, then Activate over HTTP (#3431: set up first): New watched at 2 hours, nothing else; all
   * leads but the excluded ones. The exclusion list is written straight to the row: the picker's Save (PATCH
   * /spider/exclusions) takes at most 5,000 ids at a time, and the list here is the subject's input, not its subject.
   */
  async function saveSettings(c: Company, excluded?: string[]) {
    const api = await fx.signedInAs(c.admin);
    const res = await api.put(SETTINGS, {
      status_limits: {
        NEW: { enabled: true, value: 2, unit: 'HOUR' },
        CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
        WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
      },
      channels: { in_app: true, red_frame: true, email: false, text: false },
      recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
    });
    expect(res.status).toBe(200);
    if (excluded) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { excluded_lead_ids: excluded } });
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
  }

  /**
   * `count` leads in one statement: New, created `hoursAgo` hours ago, with the given won / lost / cancelled stamps (SQL).
   * The lead times are `timestamp without time zone` read back as UTC by the app (as the app writes them), so the fixture
   * writes UTC wall-clock too: a bare now() lands in the database session's zone and, in any zone but UTC, makes every
   * lead look hours older or newer than it is.
   */
  async function addLeads(c: Company, count: number, o: { hoursAgo?: number; status?: string; won?: boolean; lost?: boolean; cancelled?: boolean } = {}) {
    await db.$executeRawUnsafe(
      `INSERT INTO leads (id, organization_id, customer_id, lead_number, service_request, status, created_at, updated_at, won_at, lost_at, cancelled_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'L-' || md5(random()::text), 'Fix the door', $3::"LeadStatus",
              ${UTC_NOW} - make_interval(hours => $4::int), ${UTC_NOW},
              ${o.won ? UTC_NOW : 'NULL'}, ${o.lost ? UTC_NOW : 'NULL'}, ${o.cancelled ? UTC_NOW : 'NULL'}
       FROM generate_series(1, $5::int)`,
      c.org, c.customer, o.status ?? 'NEW', o.hoursAgo ?? 0, count,
    );
  }

  const openIds = async (org: string) =>
    (await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM leads WHERE organization_id = $1::uuid AND won_at IS NULL AND lost_at IS NULL AND cancelled_at IS NULL
         AND status NOT IN ('WON', 'LOST') ORDER BY id`, org)).map((r) => r.id);

  let a!: Company;
  let b!: Company;
  let c!: Company;
  let overdueA: string[] = [];
  let pages: CountedQuery[] = [];
  let ran = false;

  beforeAll(async () => {
    await import('../app.js');
    // Company A and B: Spider saved and activated over HTTP; open leads, three (A) and one (B) of them overdue; and leads that are
    // not open (won, lost, cancelled, and one that is New but cancelled) which a page must never hold.
    a = await company();
    b = await company();
    c = await company();
    for (const co of [a, b]) {
      await addLeads(co, OPEN_LEADS);
      await addLeads(co, 40, { status: 'WON', won: true });
      await addLeads(co, 40, { status: 'LOST', lost: true });
      await addLeads(co, 40, { cancelled: true });
    }
    await addLeads(a, 3, { hoursAgo: 5 });
    await addLeads(b, 1, { hoursAgo: 5 });
    overdueA = (await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM leads WHERE organization_id = $1::uuid AND created_at < ${UTC_NOW} - interval '4 hours' ORDER BY id`, a.org)).map((r) => r.id);
    // Company C selects only two of as many open leads as A: the rest are excluded (#3434).
    await addLeads(c, OPEN_LEADS);
    const excludedC = (await openIds(c.org)).slice(2);
    for (const co of [a, b]) await saveSettings(co);
    await saveSettings(c, excludedC);
    // The company the table is mostly full of: not on Spider, so never swept, but its leads are what a read of A's or B's
    // open leads must pick them out from. (Alone in a small table, any plan is cheap and the planner's pick says little.)
    const bystander = await fx.newOrg();
    orgs.push(bystander.org);
    await addLeads(bystander, BYSTANDER_LEADS);
    await db.$executeRawUnsafe('ANALYZE leads');

    await clearLease();
    // Past the starting summary's quiet period.
    const later = new Date(Date.now() + 15 * MIN);
    const run = await countQueries(() => runSpiderSweep(later));
    ran = run.result.ran;
    pages = openLeadPages(run.queries);
  }, 300_000);

  it('an Admin switches Spider on over HTTP, the sweep finds their overdue leads through the new index, and each Admin reads only their own starting summary', async () => {
    expect(ran).toBe(true);
    expect(overdueA).toHaveLength(3);
    const mine = await (await fx.signedInAs(a.admin)).get(SUMMARY);
    expect(mine.status).toBe(200);
    expect(mine.body.summary.total).toBe(3);
    expect(mine.body.summary.leads.map((l: { lead_id: string }) => l.lead_id).sort()).toEqual(overdueA);
    const theirs = await (await fx.signedInAs(b.admin)).get(SUMMARY);
    expect(theirs.body.summary.total).toBe(1);
    expect(theirs.body.summary.leads.map((l: { lead_id: string }) => l.lead_id)).not.toContain(overdueA[0]);
    // And the reads that found those leads were seeks of the open-lead (company, lead id) index.
    const plans = await Promise.all(pages.filter((q) => orgOf(q) === a.org).map((q) => planOf(db, q)));
    expect(plans).toHaveLength(41);
    for (const plan of plans) expect(nodesOf(plan).map((n) => n['Index Name'])).toContain('leads_open_org_id_idx');
  });

  describe.each([
    { name: 'A', get: () => a, openCount: 20_003 },
    { name: 'B', get: () => b, openCount: 20_001 },
  ])('company $name, with $openCount open leads among 120 that are not', ({ get, openCount }) => {
    const mine = () => pages.filter((q) => orgOf(q) === get().org);

    it('reads the open leads in pages of at most 500, each page after the first beginning after the last lead of the page before', async () => {
      const expected = await openIds(get().org);
      expect(expected).toHaveLength(openCount);
      const seen: string[] = [];
      expect(mine()).toHaveLength(41); // forty full pages and a short one
      for (const [i, q] of mine().entries()) {
        const rows = await db.$queryRawUnsafe<{ id: string }[]>(withLiterals(q));
        expect(rows.length).toBe(Math.min(PAGE, expected.length - i * PAGE));
        seen.push(...rows.map((r) => r.id));
        if (i > 0) expect(JSON.parse(q.params)).toContain(seen[i * PAGE - 1]);
      }
      // Together exactly the company's open leads in lead id order: none of the other company's, none that is not open.
      expect(seen).toEqual(expected);
    });

    it('seeks the open-lead (company, lead id) index on every page: an index condition on the company and, after the first page, on id above the last lead read', async () => {
      const lastOfPrevious: (string | undefined)[] = [];
      expect(mine()).toHaveLength(41);
      for (const [i, q] of mine().entries()) {
        const rows = await db.$queryRawUnsafe<{ id: string }[]>(withLiterals(q));
        lastOfPrevious.push(rows.at(-1)?.id);
        const plan = await planOf(db, q);
        const nodes = nodesOf(plan);
        const used = nodes.filter((n) => n['Index Name'] === 'leads_open_org_id_idx');
        const where = `page ${i + 1}: ${JSON.stringify(plan)}`;
        expect(used, where).toHaveLength(1);
        // No scan of the table or of the lead id key from the front. (A short last page may be planned as a bitmap scan of the
        // index tail, then sorted: still a read that starts at the cursor, so the plan's shape is not pinned beyond that.)
        expect(nodes.map((n) => n['Node Type']), where).not.toContain('Seq Scan');
        expect(nodes.filter((n) => n['Index Name'] === 'leads_pkey'), where).toEqual([]);
        const cond = used[0]!['Index Cond'] ?? '';
        expect(cond, where).toContain(`organization_id = '${get().org}'`);
        if (i === 0) expect(cond, where).not.toMatch(/\(id > /);
        else expect(cond, where).toContain(`(id > '${lastOfPrevious[i - 1]}'`);
      }
    });
  });

  it('a company with an exclusion list is paged the same way, its exclusions never sent to the database (#3434)', async () => {
    expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).excluded_lead_ids).toHaveLength(OPEN_LEADS - 2);
    // 20,000 open leads: forty full pages and the empty read that ends them, the same reads as with nothing excluded.
    const mine = pages.filter((q) => orgOf(q) === c.org);
    expect(mine).toHaveLength(41);
    for (const q of mine) expect(JSON.parse(q.params).length).toBeLessThanOrEqual(10);
    expect(pages.filter((q) => ![a.org, b.org, c.org].includes(orgOf(q)))).toEqual([]);
  });

  it('the paged read of open leads has exactly one source: currentStageVisits in the sweep', () => {
    const dir = join(__dirname, '..', 'services', 'spider');
    const pagedLeadReads = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const source = readFileSync(join(dir, f), 'utf8');
        const calls = [...source.matchAll(/\blead\.findMany\(/g)].map((m) => callFrom(source, m.index! + m[0].length));
        return calls.filter((call) => /orderBy:\s*\{\s*id:\s*'asc'\s*\}/.test(call)).map(() => f);
      });
    expect(pagedLeadReads).toEqual(['sweep.ts']);
  });
});

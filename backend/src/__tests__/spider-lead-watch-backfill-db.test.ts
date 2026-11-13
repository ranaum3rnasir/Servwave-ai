/* =============================================================================
   #3468: the watch list's backfill and nightly check, as the server starts them (real migrated database).

   Seam: the two job entry points, started through the doors index.ts uses (`runJobAtBoot('spider-watch-backfill', ...)`
   and `scheduleJob('spider-watch-check', ...)`, lib/scheduleJob.ts), run now instead of at boot or at their clock time.

   - Neither runs unless SPIDER_WATCH_LIST chooses it: unset, the other value, or a typo reads nothing at all (measured on
     both of the app's database clients, the users' and the jobs').
   - The backfill writes every missing row, across companies, 2,000 leads per statement by lead id, each statement its own
     transaction on the jobs' lines, none on the users' lines.
   - Stopped half-way (a deploy, a restart), the next boot finishes it and writes only what is still missing; a third run
     writes nothing.
   - The nightly check: in sync, it repairs nothing and says 0 (info); with drift (a wrong stage, a wrong entry instant, a
     missing row, a wrong company) it repairs exactly those, logs the count as an error, and leaves a correct row alone.
   - A lead a user is saving at that very moment is skipped, not waited for, and repaired the next night.

   Every connection acts as the live API's database role (`app_rls`, no BYPASSRLS) with the tenant guard on, as
   jobs-client-guard-db.test.ts wires it, so the pass is proven to work unscoped under row-level security.

   Each test first brings the whole list in step (a pass over every lead), so a count it asserts is its own leads' alone.
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

const { adminClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    // Every connection of the app's clients acts as the non-bypass role, as the live API connects; the guard is on.
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // The test's own client: the database's superuser, for setup and for looking at what was stored.
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The jobs run on the real client module (setup.ts gives every suite a mocked one).
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { env } from '../config/env';
import { logger } from '../lib/logger';
import { switchFixture } from './permission-switches-fixture';
import { countQueries, type QueryCount } from './support/query-counter';
import { spiderStageOf, SPIDER_LEAD_TIMES_SELECT } from '../services/spider/config';
import type { WatchListPass, WatchListPassOptions } from '../services/spider/watchList';

const suite = adminClient ? describe : describe.skip;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const STOPPED = new Error('the server stopped here (a deploy)');

/** One lead in each state the rules tell apart. */
const KINDS: Partial<Prisma.LeadUncheckedCreateInput>[] = [
  {},
  { returned_to_new_at: ago(6) },
  { status: 'CONTACTED' },
  { status: 'CONTACTED', contacted_at: ago(3) },
  { status: 'WALKTHROUGH_COMPLETED', walkthrough_first_booked_at: ago(30), last_visit_completed_at: ago(5) },
  { status: 'WON', won_at: ago(2) },
  { status: 'LOST', lost_at: ago(2) },
];

interface WatchRow {
  organization_id: string;
  stage: string | null;
  entered_at: string | null;
  pending: boolean;
  changed_at: string;
}

// The setting is read through the app's configuration (config/env.ts, mocked above).
const originalMode = env.SPIDER_WATCH_LIST;
const setMode = (value: string | undefined) => {
  if (value === undefined) delete env.SPIDER_WATCH_LIST;
  else env.SPIDER_WATCH_LIST = value;
};

suite("Spider watch list: the backfill and the nightly check, as the server starts them (real database)", () => {
  const db = adminClient as PrismaClient;
  const fx = switchFixture(db, async () => { throw new Error('no HTTP in this suite'); });
  let scheduleJob: typeof import('../lib/scheduleJob').scheduleJob;
  let runJobAtBoot: typeof import('../lib/scheduleJob').runJobAtBoot;
  let runOnJobsClient: typeof import('../lib/prismaJobs').runOnJobsClient;
  let watchList: typeof import('../services/spider/watchList');
  let usersClient: PrismaClient;
  let jobsClient: PrismaClient;

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
    ({ scheduleJob, runJobAtBoot } = await import('../lib/scheduleJob.js'));
    ({ runOnJobsClient } = await import('../lib/prismaJobs.js'));
    watchList = await import('../services/spider/watchList.js');
    ({ prisma: usersClient } = await import('../lib/prisma.js'));
    ({ prismaJobs: jobsClient } = await import('../lib/prismaJobs.js'));
  }, 120_000);
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setMode(originalMode));
  afterAll(async () => {
    await fx.cleanup();
    await usersClient?.$disconnect();
    await jobsClient?.$disconnect();
  });

  // ── The jobs, started as index.ts starts them ────────────────────────────────────────────────────────────────────

  /** The backfill at boot (index.ts), with no pause between chunks. */
  const backfillAtBoot = (opts: WatchListPassOptions = {}) =>
    runJobAtBoot('spider-watch-backfill', () => watchList.runWatchListBackfill({ pauseMs: 0, ...opts }));

  /** The nightly check (index.ts), run now instead of at its clock time. */
  async function checkTonight(opts: WatchListPassOptions = {}): Promise<WatchListPass | null | undefined> {
    let result: WatchListPass | null | undefined;
    const job = scheduleJob('spider-watch-check', '0 0 1 1 *', async () => {
      result = await watchList.runWatchListCheck({ pauseMs: 0, ...opts });
    });
    try {
      await job.execute();
    } finally {
      await job.destroy();
    }
    return result;
  }

  /** Brings every lead's row in step, so what a test then counts is its own leads'. */
  const settle = () => runOnJobsClient(() => watchList.reconcileWatchList({ pauseMs: 0 }));

  /** What `run` sends: on the jobs' lines (where a job's queries go), and how many on the users' lines. */
  async function queriesSent<T>(run: () => Promise<T>): Promise<{ result: T; onJobs: QueryCount; onUsers: number }> {
    let onUsers = 0;
    let result!: T;
    const onJobs = await countQueries(async () => {
      onUsers = (await countQueries(async () => { result = await run(); }, usersClient)).count;
    }, jobsClient);
    return { result, onJobs, onUsers };
  }

  const lines = (level: 'info' | 'warn' | 'error') =>
    vi.mocked(logger[level]).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[spider-watch]'));

  // ── Leads and their rows ─────────────────────────────────────────────────────────────────────────────────────────

  async function addLeads(org: { org: string; customer: string }, kinds = KINDS): Promise<string[]> {
    const ids: string[] = [];
    for (const extra of kinds) {
      const id = randomUUID();
      await db.lead.create({
        data: { id, organization_id: org.org, customer_id: org.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', created_at: ago(48), ...extra },
      });
      ids.push(id);
    }
    return ids;
  }

  /** The rows as they were before the migration: none. */
  const forgetRows = (ids: string[]) => db.$executeRawUnsafe(`DELETE FROM spider_lead_watch WHERE lead_id = ANY($1::uuid[])`, ids);

  async function rowsOf(ids: string[]): Promise<Map<string, WatchRow>> {
    const rows = await db.$queryRawUnsafe<(WatchRow & { lead_id: string })[]>(
      `SELECT lead_id::text, organization_id::text, stage, to_char(entered_at, ${ISO}) AS entered_at, pending,
              to_char(changed_at, ${ISO}) AS changed_at
         FROM spider_lead_watch WHERE lead_id = ANY($1::uuid[])`, ids);
    return new Map(rows.map(({ lead_id, ...row }) => [lead_id, row]));
  }

  /** Each lead's row says what spiderStageOf says about the lead as it is now. */
  async function expectInStep(ids: string[]) {
    const leads = await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true, organization_id: true, ...SPIDER_LEAD_TIMES_SELECT } });
    expect(leads).toHaveLength(ids.length);
    const rows = await rowsOf(ids);
    for (const lead of leads) {
      const s = spiderStageOf(lead);
      const row = rows.get(lead.id);
      expect(row, `lead ${lead.id} has no row`).toBeDefined();
      expect({ organization_id: row!.organization_id, stage: row!.stage, entered_at: row!.entered_at }, `lead ${lead.id}`).toEqual({
        organization_id: lead.organization_id, stage: s?.stage ?? null, entered_at: s?.enteredAt.toISOString() ?? null,
      });
    }
    return rows;
  }

  // ── Off unless chosen ────────────────────────────────────────────────────────────────────────────────────────────

  it('neither job reads anything unless SPIDER_WATCH_LIST chooses it', async () => {
    const o = await fx.newOrg();
    const leads = await addLeads(o, KINDS.slice(0, 2));
    await forgetRows(leads);

    for (const mode of [undefined, '', 'check', 'backfil']) {
      setMode(mode);
      vi.clearAllMocks();
      const sent = await queriesSent(() => backfillAtBoot());
      expect(sent.result, `backfill with SPIDER_WATCH_LIST=${mode}`).toBeNull();
      expect({ mode, onJobs: sent.onJobs.count, onUsers: sent.onUsers }).toEqual({ mode, onJobs: 0, onUsers: 0 });
      // The boot says what the setting asks for; a value it does not know is a warning, never a crash.
      expect([...lines('info'), ...lines('warn')]).toHaveLength(1);
      if (mode === 'backfil') expect(lines('warn')[0]).toMatch(/SPIDER_WATCH_LIST=backfil is neither backfill nor check/);
    }

    for (const mode of [undefined, 'backfill', 'nightly']) {
      setMode(mode);
      vi.clearAllMocks();
      let result: WatchListPass | null | undefined;
      const sent = await queriesSent(async () => { result = await checkTonight(); });
      expect(result, `check with SPIDER_WATCH_LIST=${mode}`).toBeNull();
      expect({ mode, onJobs: sent.onJobs.count, onUsers: sent.onUsers }).toEqual({ mode, onJobs: 0, onUsers: 0 });
      expect(lines('info')).toEqual(['[spider-watch] the nightly check is off (it runs only with SPIDER_WATCH_LIST=check)']);
    }

    expect((await rowsOf(leads)).size).toBe(0);
  });

  // ── The backfill ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("the backfill writes every missing row across companies, 2,000 leads per statement by lead id, on the jobs' lines only", async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const leads = [...(await addLeads(a)), ...(await addLeads(b))];
    await settle();
    await forgetRows(leads);
    const [{ total }] = await db.$queryRawUnsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM leads');

    setMode('backfill');
    const before = Date.now();
    const sent = await queriesSent(() => backfillAtBoot());

    expect(sent.result).toMatchObject({ leadsRead: total, written: leads.length, found: leads.length, busy: 0 });
    const rows = await expectInStep(leads);
    for (const row of rows.values()) {
      expect(row.pending).toBe(true);
      expect(Date.parse(row.changed_at)).toBeGreaterThanOrEqual(before - 1_000);
    }

    // One statement per 2,000 leads (and the one that finds none left when the count is a multiple), each its own
    // transaction (the guard's BEGIN, its setting, the statement, COMMIT), nothing else, and nothing on the users' lines.
    const chunks = sent.onJobs.queries.filter((q) => q.sql.includes('WITH chunk AS'));
    expect(chunks).toHaveLength(Math.floor(total / 2_000) + 1);
    for (const q of chunks) expect((JSON.parse(q.params) as unknown[])[0]).toBe(2_000);
    expect(sent.onJobs.count).toBe(chunks.length * 4);
    expect(sent.onUsers).toBe(0);

    expect(lines('info')[0]).toBe('[spider-watch] backfill started (SPIDER_WATCH_LIST=backfill)');
    expect(lines('info').at(-1)).toMatch(new RegExp(`^\\[spider-watch\\] backfill finished: ${leads.length} rows written, ${total} leads read in ${chunks.length} statements`));
  });

  it('a backfill stopped half-way is finished by the next boot, which writes only what is still missing', async () => {
    const o = await fx.newOrg();
    const leads = await addLeads(o, KINDS.slice(0, 5));
    await settle();
    await forgetRows(leads);

    // A chunk size that ends the first chunk right after the second of these leads (in lead id order).
    const all = (await db.$queryRawUnsafe<{ id: string }[]>('SELECT id::text FROM leads ORDER BY id')).map((r) => r.id);
    const mine = leads.map((id) => all.indexOf(id)).sort((x, y) => x - y);
    const chunk = mine[1]! + 1;
    const firstTwo = [all[mine[0]!]!, all[mine[1]!]!];
    const rest = leads.filter((id) => !firstTwo.includes(id));

    setMode('backfill');
    // The first boot: the server stops after the first statement.
    await expect(backfillAtBoot({ chunk, onChunk: () => { throw STOPPED; } })).rejects.toBe(STOPPED);
    const afterFirst = await rowsOf(leads);
    expect([...afterFirst.keys()].sort()).toEqual([...firstTwo].sort());

    // The next boot finishes it: only the three still missing are written; the two already there are not touched.
    const second = await backfillAtBoot({ chunk });
    expect(second).toMatchObject({ written: 3, found: 3 });
    const afterSecond = await expectInStep(leads);
    for (const id of firstTwo) expect(afterSecond.get(id)).toEqual(afterFirst.get(id));
    expect(rest.every((id) => afterSecond.has(id))).toBe(true);

    // A third boot finds nothing to do.
    vi.clearAllMocks();
    expect(await backfillAtBoot({ chunk })).toMatchObject({ written: 0, found: 0 });
    expect(lines('info').at(-1)).toMatch(/^\[spider-watch\] backfill finished: 0 rows written/);
  });

  // ── The nightly check ────────────────────────────────────────────────────────────────────────────────────────────

  it('the nightly check says 0 when the list is in step, and repairs each kind of drift, logging the count as an error', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const [wrongStage, wrongInstant, missing, wrongCompany, claimed] = await addLeads(a, [
      {}, { status: 'CONTACTED', contacted_at: ago(3) }, { returned_to_new_at: ago(6) }, { status: 'CONTACTED' }, { status: 'CONTACTED', contacted_at: ago(4) },
    ]) as [string, string, string, string, string];
    await settle();
    setMode('check');

    const inStep = await checkTonight();
    expect(inStep).toMatchObject({ written: 0, found: 0, busy: 0 });
    expect(lines('info')).toEqual([expect.stringMatching(/^\[spider-watch\] check: 0 rows repaired, \d+ leads read in \d+ statements/)]);
    expect(lines('error')).toEqual([]);

    // Drift of every kind the check compares, and one row claimed long ago that is right as it is.
    await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET stage = 'WALKTHROUGH_COMPLETED' WHERE lead_id = $1::uuid`, wrongStage);
    await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET entered_at = entered_at - interval '1 hour' WHERE lead_id = $1::uuid`, wrongInstant);
    await forgetRows([missing]);
    await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET organization_id = $2::uuid WHERE lead_id = $1::uuid`, wrongCompany, b.org);
    await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET pending = false, changed_at = '2000-01-01 00:00:00' WHERE lead_id = $1::uuid`, claimed);
    const before = Date.now();

    vi.clearAllMocks();
    const repaired = await checkTonight();
    expect(repaired).toMatchObject({ written: 4, found: 4, busy: 0 });
    expect(lines('error')).toEqual([expect.stringMatching(/^\[spider-watch\] check: 4 rows repaired \(expected 0\), \d+ leads read/)]);
    const rows = await expectInStep([wrongStage, wrongInstant, missing, wrongCompany, claimed]);
    for (const id of [wrongStage, wrongInstant, missing, wrongCompany]) {
      expect(rows.get(id)!.pending).toBe(true);
      expect(Date.parse(rows.get(id)!.changed_at)).toBeGreaterThanOrEqual(before - 1_000);
    }
    expect(rows.get(claimed)).toMatchObject({ pending: false, changed_at: '2000-01-01T00:00:00.000Z' });

    vi.clearAllMocks();
    expect(await checkTonight()).toMatchObject({ written: 0 });
    expect(lines('error')).toEqual([]);
  });

  it('a lead a user is saving at that moment is skipped, not waited for, and repaired the next night', async () => {
    const o = await fx.newOrg();
    const [lead] = await addLeads(o, [{}]);
    await settle();
    await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET stage = 'CONTACTED' WHERE lead_id = $1::uuid`, lead);
    setMode('check');

    // A save in progress: the lead's row lock is held until the save commits.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const save = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE leads SET service_request = service_request WHERE id = $1::uuid`, lead);
      locked();
      await released;
    }, { timeout: 30_000 });
    await isLocked;

    // The check runs while the save is still open. Had it waited for the lead, it could not finish before the save
    // ends, and the save ends only after it: the jobs' 1 s lock limit would have failed its statement instead.
    let tonight: WatchListPass | null | undefined;
    try {
      tonight = await checkTonight();
    } finally {
      release();
      await save;
    }
    expect(tonight).toMatchObject({ found: 1, busy: 1, written: 0 });
    expect(lines('info')).toEqual([expect.stringMatching(/check: 0 rows repaired, .*1 being saved at that moment \(left to their save\)/)]);
    expect((await rowsOf([lead!])).get(lead!)).toMatchObject({ stage: 'CONTACTED' });

    vi.clearAllMocks();
    expect(await checkTonight()).toMatchObject({ found: 1, busy: 0, written: 1 });
    await expectInStep([lead!]);
  });
});

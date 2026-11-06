/* =============================================================================
   #3108: what a starting summary for 5,000 overdue leads and 60 people costs the database - MEASUREMENTS first.

   Seam: the sweep's public entry (runSpiderSweep) on a real migrated database. Two runs of the ticket's company:
   1. on the jobs' client (started the way the server starts a job): the longest transaction any session held open while
      the summary was written, found by asking the database about every open transaction every few milliseconds, and the
      time from the start of the run to the summary being READY. Every statement a job sends is its own transaction there.
   2. on the users' client (the only one that reports its statements to the query counter): how many statements the
      summary sends, the largest, and how many of them are claim statements.

   The numbers are printed for the build report. The assertions are the ticket's lines: no transaction longer than 1 s,
   no statement over 1 MB, claims saved 250 to 500 to a statement, and no transaction of more than one statement.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, watcherClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const clientAt = (url: string) => new PrismaClient({ datasources: { db: { url } } } as import('@prisma/client').Prisma.PrismaClientOptions);
  return { adminClient: dbUrl ? clientAt(dbUrl) : undefined, watcherClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL,
      FRONTEND_URL: 'https://staging.app.test',
      RESEND_API_KEY: 're_test_key',
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { runOnJobsClient } from '../lib/prismaJobs';
import { countQueries, writes, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { T0, removeCompanies, spiderCompany } from './support/spider-company';
import { clearLease, onlyThisCompany } from './support/spider-summary-world';

const suite = adminClient ? describe : describe.skip;

const MEGABYTE = 1_000_000;
const LEADS = 5_000;
const PEOPLE = 60;
const bytesOf = (q: CountedQuery) => Buffer.byteLength(q.sql) + Buffer.byteLength(q.params);
function kindOf(sql: string): string {
  const s = sql.trim();
  const kind = (s.match(/^\w+/)?.[0] ?? '?').toUpperCase();
  const table = s.match(/(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"?(\w+)"?/i)?.[1];
  return table ? `${kind} ${table}` : kind;
}

suite('what a starting summary for 5,000 leads and 60 people costs (#3108, real database)', () => {
  const db = adminClient as PrismaClient;
  const orgs: string[] = [];

  beforeEach(async () => {
    await clearLease(db);
    vi.clearAllMocks();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });
  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await removeCompanies(db, orgs);
    await db.$disconnect();
    await watcherClient?.$disconnect();
  });

  it('on the jobs client no transaction stays open for as long as 1 second, and the summary is READY after a measured time', async () => {
    const c = await spiderCompany(db, orgs, { leads: LEADS, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
    await onlyThisCompany(db, c.org);

    let longest = 0;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const [row] = await watcherClient!.$queryRawUnsafe<{ secs: number | null }[]>(
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
    const result = await runOnJobsClient(() => runSpiderSweep(T0));
    const totalMs = Date.now() - started;
    watching = false;
    await watcher;

    expect(result.ran).toBe(true);
    expect(await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org, status: 'READY' } })).toMatchObject({
      lead_count: LEADS,
      recipient_count: PEOPLE,
    });
    console.info(
      `[3108 jobs client] ${PEOPLE} people x ${LEADS} leads: longest open transaction=${longest.toFixed(3)} s, ` +
        `total time to READY and delivered=${(totalMs / 1000).toFixed(1)} s`,
    );
    expect(longest).toBeLessThan(1);
  }, 900_000);

  it('sends no statement over 1 MB, saves the claims 250 to 500 to a statement, and opens no transaction of several statements', async () => {
    const c = await spiderCompany(db, orgs, { leads: LEADS, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
    await onlyThisCompany(db, c.org);

    const { queries, result } = await countQueries(() => runSpiderSweep(T0));

    expect(result.ran).toBe(true);
    const sized = queries.map((q) => ({ kind: kindOf(q.sql), bytes: bytesOf(q), write: writes([q]).length === 1 }));
    const largest = [...sized].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    const claimInserts = queries.filter((q) => kindOf(q.sql) === 'INSERT spider_alerts');
    const claimRows = claimInserts.map((q) => (q.sql.match(/\)\s*,\s*\(/g)?.length ?? 0) + 1);
    // Statements between a BEGIN and its COMMIT: how many a transaction holds (Prisma wraps one multi-row insert in a
    // transaction of that one statement; an interactive transaction would hold several).
    let open: string[] | null = null;
    const transactions: string[][] = [];
    for (const q of queries) {
      if (/^\s*BEGIN/i.test(q.sql)) open = [];
      else if (/^\s*(COMMIT|ROLLBACK)/i.test(q.sql)) {
        if (open) transactions.push(open);
        open = null;
      } else open?.push(kindOf(q.sql));
    }
    const longestTransaction = Math.max(0, ...transactions.map((t) => t.length));
    console.info(
      `[3108 statements] ${PEOPLE} people x ${LEADS} leads: statements=${sized.length}, writes=${sized.filter((s) => s.write).length}, ` +
        `claim statements=${claimInserts.length} (rows each: ${JSON.stringify(claimRows)}), transactions=${transactions.length} ` +
        `(longest holds ${longestTransaction} statements), largest=${JSON.stringify(largest)}`,
    );

    expect(Math.max(...sized.map((s) => s.bytes))).toBeLessThan(MEGABYTE);
    // 250 to 500 claims to a statement (the last one takes what is left).
    expect(claimRows.reduce((a, b) => a + b, 0)).toBe(LEADS);
    expect(Math.max(...claimRows)).toBeLessThanOrEqual(500);
    expect(Math.min(...claimRows.slice(0, -1))).toBeGreaterThanOrEqual(250);
    expect(longestTransaction).toBeLessThanOrEqual(1);
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(LEADS);
  }, 900_000);
});

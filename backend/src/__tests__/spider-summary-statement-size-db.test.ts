/* =============================================================================
   #3107: a starting summary for 5,000 overdue leads and 60 people sends no single statement over 1 MB.

   Seam: the sweep's public entry (runSpiderSweep) on a real migrated database, with the query counter
   (support/query-counter.ts) listing every statement the run sends. A statement's size is its SQL text plus its
   parameters as Prisma reports them (an upper bound of the bytes on the wire: the parameters are shown as JSON text).

   The sizes are MEASUREMENTS first: they are printed (largest statement, total bytes written, count of statements) for
   the build report, before and after. The one assertion is the ticket's line: no statement over 1 MB.

   Every channel is on (bell, email, text), so every kind of write the summary makes is in the run.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // Options typed first, not inlined: an inline literal assigned to a `PrismaClient`-typed place costs ~39k types (~700k the first) and once ran CI's typecheck out of memory.
  const options: Prisma.PrismaClientOptions = {
    datasources: { db: { url: dbUrl } },
    log: [{ emit: 'event', level: 'query' }],
    transactionOptions: { maxWait: 20000, timeout: 30000 },
  };
  return {
    // Built with the query-event log, so the query counter can count it (support/query-counter.ts), and with the
    // transaction limits the app's own client has (lib/prisma.ts), not Prisma's 5 s default.
    realClient: dbUrl ? new PrismaClient(options) : undefined,
    resendSend: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@test.com',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'https://staging.app.test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test',
    SPIDER_PILOT_ORG_IDS: undefined,
  },
}));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    // One alert's emails go out as one batch request (#3470); this answers it from the per-email fake above.
    batch = { send: async (...a: [never, never?]) => (await import('./spider-batch-test-helpers.js')).batchOverSingleSends(resendSend as never)(...(a as [never, never])) };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { countQueries, writes, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { T0, removeCompanies, spiderCompany } from './support/spider-company';

const suite = realClient ? describe : describe.skip;

const MEGABYTE = 1_000_000;
const LEADS = 5_000;
const PEOPLE = 60;

const bytesOf = (q: CountedQuery) => Buffer.byteLength(q.sql) + Buffer.byteLength(q.params);
/** "INSERT spider_alerts", "UPDATE spider_alerts", "SELECT users"...: the statement's kind and first table. */
function kindOf(sql: string): string {
  const s = sql.trim();
  const kind = (s.match(/^\w+/)?.[0] ?? '?').toUpperCase();
  const table = s.match(/(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"?(\w+)"?/i)?.[1];
  return table ? `${kind} ${table}` : kind;
}

suite('a starting summary for 5,000 leads and 60 people (#3107, real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);

  beforeEach(async () => {
    await clearLease();
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
    await clearLease().catch(() => undefined);
    await removeCompanies(db, orgs);
    await db.$disconnect();
  });

  it('is one summary to 60 people and sends no single statement over 1 MB', async () => {
    const c = await spiderCompany(db, orgs, { leads: LEADS, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
    await clearLease();

    const { queries, result } = await countQueries(() => runSpiderSweep(T0));

    // The run did what the ticket describes: every lead in one summary, told to all 60 people.
    expect(result.ran).toBe(true);
    const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org, status: 'READY' } });
    expect(summary).toMatchObject({ lead_count: LEADS, recipient_count: PEOPLE });

    // The measurements, for the build report.
    const sized = queries.map((q) => ({ kind: kindOf(q.sql), bytes: bytesOf(q), write: writes([q]).length === 1 }));
    const largest = [...sized].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    const written = sized.filter((s) => s.write).reduce((sum, s) => sum + s.bytes, 0);
    const alertInserts = sized.filter((s) => s.kind === 'INSERT spider_alerts');
    console.info(
      `[3107 sizes] ${PEOPLE} people x ${LEADS} leads: statements=${sized.length}, bytes written=${written}, ` +
        `largest=${JSON.stringify(largest)}, alert-log inserts=${alertInserts.length} (${JSON.stringify(alertInserts.map((s) => s.bytes))})`,
    );

    expect(Math.max(...sized.map((s) => s.bytes))).toBeLessThan(MEGABYTE);

    // And the 60 people are stored once, not in each of the 5,000 rows.
    const [stored] = await db.$queryRawUnsafe<{ sets: number; copies: number; rows: number }[]>(
      `SELECT (SELECT count(*) FROM spider_recipient_sets WHERE organization_id = $1::uuid)::int AS sets,
              (SELECT count(*) FROM spider_alerts WHERE organization_id = $1::uuid AND recipients IS NOT NULL)::int AS copies,
              (SELECT count(*) FROM spider_alerts WHERE organization_id = $1::uuid)::int AS rows`,
      c.org,
    );
    expect(stored).toEqual({ sets: 1, copies: 0, rows: LEADS });
  }, 900_000);
});

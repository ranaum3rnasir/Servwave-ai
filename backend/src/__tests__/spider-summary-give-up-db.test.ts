/* =============================================================================
   #3108: a starting summary that keeps failing is given up on after 3 attempts, and the company falls back to the
   capped per-lead alerts - which reach every lead, including those whose claims the summary had already saved.

   Seam (agreed with Ran): the sweep's public entry (runSpiderSweep) on a real migrated database, started the way the server
   starts it (on the jobs' client). Nothing is faked. The failure is real: another connection holds an uncommitted claim
   for one of the leads, so the summary's claim statement that carries that lead waits on it until the jobs' client's
   1-second lock limit cancels it. The leads go in id order, so the statements before that one are saved; the run's attempt
   fails after them, every time.

   The clock is the one the sweep takes (`runSpiderSweep(now)`); the next-attempt time the summary's run stores is data
   computed from it, so a test drives the attempts by running the sweep at chosen times: the public seam, with no fake
   clock of ours.

   The email provider's client and the phone system's client are the only fakes (the boundaries).
   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, blockerClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const clientAt = (url: string) => new PrismaClient({ datasources: { db: { url } } } as import('@prisma/client').Prisma.PrismaClientOptions);
  return { adminClient: dbUrl ? clientAt(dbUrl) : undefined, blockerClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
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
import { runSpiderSweep } from '../services/spider/sweep';
import { logger } from '../lib/logger';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { MIN, at, removeCompanies, spiderCompany } from './support/spider-company';
import { clearLease, onlyThisCompany } from './support/spider-summary-world';

const suite = adminClient ? describe : describe.skip;

const LEADS = 1_200;
/** A lead far enough along in id order to be in the second claim statement, never the first. */
const BLOCKED_INDEX = 700;
/** Per-lead alerts a run may send for a company (runCaps.ts). */
const PER_RUN_CAP = 100;

suite('a starting summary that keeps failing is given up on after 3 attempts (#3108, real database)', () => {
  const db = adminClient as PrismaClient;
  const orgs: string[] = [];
  let releaseBlocker: () => void = () => undefined;
  let blocker: Promise<unknown> = Promise.resolve();

  beforeEach(() => {
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
    releaseBlocker();
    await blocker.catch(() => undefined);
    await clearLease(db).catch(() => undefined);
    await removeCompanies(db, orgs);
    await db.$disconnect();
    await blockerClient?.$disconnect();
  });

  /** The sweep, started the way the server's scheduler starts it. */
  const sweepAt = (time: Date) => runOnJobsClient(() => runSpiderSweep(time));
  const runOf = (org: string) => db.spiderSummaryRun.findMany({ where: { organization_id: org } });

  /**
   * Another connection claims one lead of the company in a transaction it leaves open: the same claim key the summary
   * writes. Any statement that tries to claim that lead waits for the transaction to end.
   */
  async function holdAClaim(org: string, leadId: string) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { created_at: true } });
    const settings = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org }, select: { activated_at: true } });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const done = new Promise<void>((resolve) => (releaseBlocker = resolve));
    blocker = blockerClient!
      .$transaction(
        async (tx) => {
          await tx.spiderAlert.create({
            data: {
              organization_id: org, lead_id: leadId, status: 'NEW', entered_status_at: lead.created_at,
              counted_from: settings.activated_at!, limit_value: 2, limit_unit: 'HOUR', alerted_at: at(0),
            },
          });
          held();
          await done;
          throw new Error('rolled back on purpose');
        },
        { timeout: 600_000, maxWait: 10_000 },
      )
      .catch(() => undefined);
    await holding;
  }

  it('abandons the run after 3 attempts with no fourth, logs it once, and the per-lead alerts then reach every lead', async () => {
    const c = await spiderCompany(db, orgs, { leads: LEADS, admins: 2, dispatchers: 1, trigger: true });
    await clearLease(db);
    await onlyThisCompany(db, c.org);
    const leadsById = [...c.leads].sort();
    await holdAClaim(c.org, leadsById[BLOCKED_INDEX]!);
    const errors = vi.spyOn(logger, 'error');
    const gaveUp = () => errors.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('gave up') && m.includes(c.org));

    // Attempt 1, at T0.
    await sweepAt(at(0));
    let [run] = await runOf(c.org);
    expect(run).toMatchObject({ status: 'RUNNING', attempts: 1, next_attempt_at: at(2 * MIN) });
    const savedAfterFirst = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true }, orderBy: { lead_id: 'asc' } });
    // The statements before the blocked lead are saved, in id order; the blocked one and everything after it is not.
    expect(savedAfterFirst.length).toBeGreaterThan(0);
    expect(savedAfterFirst.length).toBeLessThanOrEqual(BLOCKED_INDEX);
    expect(savedAfterFirst.map((s) => s.lead_id)).toEqual(leadsById.slice(0, savedAfterFirst.length));

    // Not due yet: a minute later nothing is tried.
    await clearLease(db);
    await sweepAt(at(MIN));
    [run] = await runOf(c.org);
    expect(run).toMatchObject({ status: 'RUNNING', attempts: 1 });

    // Attempt 2 after 2 minutes; its next try is 8 minutes after it began.
    await clearLease(db);
    await sweepAt(at(2 * MIN));
    [run] = await runOf(c.org);
    expect(run).toMatchObject({ status: 'RUNNING', attempts: 2, next_attempt_at: at(10 * MIN) });
    await clearLease(db);
    await sweepAt(at(9 * MIN));
    [run] = await runOf(c.org);
    expect(run).toMatchObject({ status: 'RUNNING', attempts: 2 });

    // Attempt 3 after 8 more minutes: the last. The run is given up on.
    await clearLease(db);
    await sweepAt(at(10 * MIN));
    [run] = await runOf(c.org);
    expect(run).toMatchObject({ status: 'ABANDONED', attempts: 3 });
    expect(gaveUp()).toHaveLength(1);
    // The summary never became readable, its saved claims were released, and the trigger is spent.
    expect(await db.spiderSummary.findMany({ where: { organization_id: c.org }, select: { status: true } })).toEqual([{ status: 'SUPERSEDED' }]);
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
    expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).summary_trigger_at).toBeNull();
    expect(resendSend).not.toHaveBeenCalled();

    // The other connection lets go. From now on the company alerts per lead, at most PER_RUN_CAP a run, and no
    // fourth attempt of the summary ever starts.
    releaseBlocker();
    await blocker;
    const alertsEach: number[] = [];
    for (let i = 1; i <= LEADS / PER_RUN_CAP; i++) {
      await clearLease(db);
      const before = await db.spiderAlert.count({ where: { organization_id: c.org } });
      await sweepAt(at(10 * MIN + i * 2 * MIN));
      alertsEach.push((await db.spiderAlert.count({ where: { organization_id: c.org } })) - before);
    }
    expect(alertsEach).toEqual(Array(LEADS / PER_RUN_CAP).fill(PER_RUN_CAP));
    const alerted = await db.spiderAlert.findMany({ where: { organization_id: c.org, kind: 'ALERTED' }, select: { lead_id: true } });
    expect(alerted.map((a) => a.lead_id).sort()).toEqual(leadsById);
    expect(await runOf(c.org)).toEqual([expect.objectContaining({ status: 'ABANDONED', attempts: 3 })]);
    expect(gaveUp()).toHaveLength(1);
    expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.starting_summary' } })).toBe(0);
    errors.mockRestore();
  }, 900_000);
});

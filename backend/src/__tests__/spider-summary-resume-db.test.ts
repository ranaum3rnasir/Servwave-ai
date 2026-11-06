/* =============================================================================
   #3108: a starting summary written in small saved pieces survives a stop and a restart.

   Seams (agreed with Ran): the sweep's public entry (runSpiderSweep) on a real migrated database across a stop and a
   restart, and the summary as History and the bell read it over HTTP.

   The sweep is started the way the server starts it, in its own process on the jobs' client (support/spider-sweep-child.ts),
   and stopped with SIGKILL after some claim statements are saved; then the sweep runs again. The company is the ticket's:
   5,000 overdue leads and 60 people (support/spider-company.ts). The email provider's client and the phone system's client
   are the only fakes (the boundaries); the stopped process has neither, so it can send nothing.

   The numbers the expectations come from: a claim statement carries at most 500 claims, so 5,000 leads are at least ten
   statements; a stopped run has saved some of them and not all; the leads go in id order, so what is saved is the first
   leads by id; the first attempt began at T0 (its next try is due at T0 + 2 minutes).

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { adminClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    // The real jobs' client: the sweep below runs on the same two lines, statement and lock limits the server's jobs have.
    process.env.DATABASE_URL = dbUrl;
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } } as import('@prisma/client').Prisma.PrismaClientOptions) : undefined, resendSend: vi.fn() };
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
// The app and the sweep run on the real client module (setup.ts gives every suite a mocked one).
vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
// The email provider's client is the boundary: the real lib/email runs, its client is fake.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { countQueries } from './support/query-counter';
import { switchFixture } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { MIN, T0, at, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import {
  COMPANY_SUMMARY, HISTORY, HISTORY_COUNT, HISTORY_EXPORT,
  adminView, clearLease, expireLease, onlyThisCompany, personView, startSweepProcess, waitUntil,
} from './support/spider-summary-world';

const suite = adminClient ? describe : describe.skip;

const LEADS = 5_000;
const PEOPLE = 60;

suite('a starting summary stopped part way, then restarted (#3108, real database)', () => {
  const db = adminClient as PrismaClient;
  const dbUrl = process.env.TEST_DATABASE_URL as string;
  const orgs: string[] = [];
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await fx.cleanup();
    await removeCompanies(db, orgs);
    await db.$disconnect();
  });
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

  const claimsOf = (org: string) => db.spiderAlert.count({ where: { organization_id: org } });
  const sortedLeads = (c: SpiderCompany) => [...c.leads].sort();
  const admin = (c: SpiderCompany) => c.people.find((p) => p.role === 'ADMIN')!;
  const dispatcher = (c: SpiderCompany) => c.people.find((p) => p.role === 'DISPATCHER')!;

  /**
   * Starts the sweep in its own process and kills it as soon as more claims are saved than one statement can carry (a
   * statement carries 500 at most, so at least two statements are saved, and the first one's cursor with them) - or when
   * the process ends by itself, which the tests then see as a summary that was never part way.
   */
  async function stopMidSummary(c: SpiderCompany) {
    await clearLease(db);
    await onlyThisCompany(db, c.org);
    const child = startSweepProcess(dbUrl, T0);
    await waitUntil(async () => child.process.exitCode !== null || (await claimsOf(c.org)) > 500, 'more than one claim statement to be saved');
    child.process.kill('SIGKILL');
    await child.exited;
    return child.output();
  }

  describe('stopped after some claim statements were saved', () => {
    let c: SpiderCompany;
    beforeAll(async () => {
      c = await spiderCompany(db, orgs, { leads: LEADS, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await stopMidSummary(c);
    }, 600_000);

    it('has saved the first leads by id, not all of them, and counted the attempt before doing any work', async () => {
      const saved = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true }, orderBy: { lead_id: 'asc' } });
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.length).toBeLessThan(LEADS);
      expect(saved.map((s) => s.lead_id)).toEqual(sortedLeads(c).slice(0, saved.length));
      const run = await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } });
      expect(run).toMatchObject({ status: 'RUNNING', attempts: 1, next_attempt_at: at(2 * MIN) });
    });

    it('keeps the cursor at a lead whose claim is saved', async () => {
      const run = await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } });
      const saved = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true }, orderBy: { lead_id: 'asc' } });
      expect(run.cursor).not.toBeNull();
      expect(saved.map((s) => s.lead_id)).toContain(run.cursor);
    });

    it('is a BUILDING summary that has begun no delivery: no bell notice, no email, no text', async () => {
      expect(await db.spiderSummary.findMany({ where: { organization_id: c.org }, select: { status: true, delivery: true } })).toEqual([
        { status: 'BUILDING', delivery: {} },
      ]);
      expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.starting_summary' } })).toBe(0);
      expect(resendSend).not.toHaveBeenCalled();
      expect(ctm.sendSms).not.toHaveBeenCalled();
    });

    // Every place a person can read a summary (and the History rows its claims make), asked for over HTTP.
    it.each([
      ['History rows', HISTORY, (b: any) => b.total], // eslint-disable-line @typescript-eslint/no-explicit-any
      ['History export', HISTORY_EXPORT, (b: any) => b.total], // eslint-disable-line @typescript-eslint/no-explicit-any
      ['History count badge', HISTORY_COUNT, (b: any) => b.total], // eslint-disable-line @typescript-eslint/no-explicit-any
      ['the Spider page card', COMPANY_SUMMARY, (b: any) => (b.summary ? 1 : 0)], // eslint-disable-line @typescript-eslint/no-explicit-any
    ])('shows an Admin nothing of the half-written summary: %s', async (_name, url, shown) => {
      const api = await fx.signedInAs(admin(c));
      const res = await api.get(url);
      expect(res.status).toBe(200);
      expect(shown(res.body)).toBe(0);
    });

    it("shows a person nothing of it: their summary page and their bell", async () => {
      const view = await personView(await fx.signedInAs(dispatcher(c)));
      expect(view.mine).toBeNull();
      expect(view.summaryNotices).toEqual([]);
    });
  });

  describe('restarted', () => {
    let c: SpiderCompany;
    let savedBefore: { id: string; lead_id: string }[];
    let resumed: Awaited<ReturnType<typeof countQueries>>;
    // What the provider boundaries were given by the restarted run (the mocks are cleared between tests).
    let emailed: string[];
    let texts: number;

    beforeAll(async () => {
      c = await spiderCompany(db, orgs, { leads: LEADS, admins: PEOPLE / 2, dispatchers: PEOPLE / 2, trigger: true });
      await stopMidSummary(c);
      savedBefore = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { id: true, lead_id: true } });
      // The stopped process's lease runs out (2 minutes after its last renewal), then the next server's first run starts.
      await expireLease(db);
      await onlyThisCompany(db, c.org);
      vi.clearAllMocks();
      resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
      vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
      vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
      vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
      vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
      // Three minutes after the first attempt began: its 2-minute wait is over.
      resumed = await countQueries(() => runSpiderSweep(at(3 * MIN)));
      emailed = resendSend.mock.calls.map(([m]) => m.to as string).sort();
      texts = vi.mocked(ctm.sendSms).mock.calls.length;
    }, 900_000);

    it('resumes after the cursor and writes no claim twice: every lead is claimed once and none of the saved ones is sent again', async () => {
      expect(savedBefore.length).toBeGreaterThan(0);
      expect(savedBefore.length).toBeLessThan(LEADS);
      const claims = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { id: true, lead_id: true, alerted_at: true } });
      expect(claims).toHaveLength(LEADS);
      expect(new Set(claims.map((x) => x.lead_id)).size).toBe(LEADS);
      // The rows saved before the stop are the very rows still there, written by the first attempt (T0), not rewritten.
      const byId = new Map(claims.map((x) => [x.id, x]));
      for (const s of savedBefore) expect(byId.get(s.id)?.alerted_at).toEqual(T0);
      // The restarted run's claim statements name only the leads that were left.
      const savedLeads = new Set(savedBefore.map((s) => s.lead_id));
      const named = new Set<string>();
      for (const q of resumed.queries.filter((x) => /^\s*INSERT INTO "public"\."spider_alerts"/i.test(x.sql))) {
        for (const v of JSON.parse(q.params) as unknown[]) if (typeof v === 'string' && c.leads.includes(v)) named.add(v);
      }
      expect(named.size).toBe(LEADS - savedBefore.length);
      expect([...named].filter((id) => savedLeads.has(id))).toEqual([]);
    });

    it('makes the summary READY, finishes the run after a second attempt, and records the delivery once on the summary', async () => {
      const summaries = await db.spiderSummary.findMany({ where: { organization_id: c.org, status: { not: 'SUPERSEDED' } } });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ status: 'READY', lead_count: LEADS, recipient_count: PEOPLE });
      expect(summaries[0]!.delivery).toMatchObject({
        in_app: { outcome: 'Shown in the app' },
        email: { outcome: 'Email sent' },
        text: { outcome: 'Text message sent' },
      });
      expect(await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'DONE', attempts: 2 });
    });

    it('sends each of the 60 people one email and one text', async () => {
      expect(emailed).toEqual(c.people.map((p) => p.email).sort());
      expect(texts).toBe(PEOPLE);
    });

    it('shows the Admin the summary once in History and on the Spider page, and a person it once in their bell and on their page', async () => {
      const a = await adminView(await fx.signedInAs(admin(c)));
      expect(a).toMatchObject({ historyTotal: LEADS, countTotal: LEADS, exportTotal: LEADS });
      expect(a.historyItems.every((i) => i.in_starting_summary)).toBe(true);
      expect(a.card?.total).toBe(LEADS);
      const p = await personView(await fx.signedInAs(dispatcher(c)));
      expect(p.mine?.total).toBe(LEADS);
      expect(p.summaryNotices).toHaveLength(1);
    });

    it('does not send again when the sweep runs after that', async () => {
      await runSpiderSweep(at(10 * MIN));
      await runSpiderSweep(at(40 * MIN));
      expect(resendSend).not.toHaveBeenCalled();
      expect(ctm.sendSms).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.starting_summary' } })).toBe(PEOPLE);
      expect(await claimsOf(c.org)).toBe(LEADS);
    });
  });
});

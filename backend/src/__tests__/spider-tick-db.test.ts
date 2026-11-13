/* =============================================================================
   #3469: Spider's check (services/spider/tick.ts) on a real migrated database: a lead alerts at the first check after
   it crosses its limit, and its alert ends within one check of the lead leaving the stage.

   Seam: `runSpiderTick(now)`, one check exactly as the loop runs it (on the jobs client, unscoped at the top, per
   company inside), and `startSpiderTick` through the door index.ts uses for the loop itself. The email provider and the
   phone system are the only fakes (as in the sweep suites); everything between is real: the watch list the database
   keeps (#3468), the claims, the pop-up and red-frame records, the delivery records.

   Every connection of the app's clients acts as the live API's role (`app_rls`, no BYPASSRLS) with the tenant guard on,
   so the check is proven to work unscoped under row-level security, every statement in its own transaction.

   Each case switches Spider off for every company but its own (a check covers every switched-on company).
   Skips when TEST_DATABASE_URL is unset. Every company it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

const { adminClient, resendSend, live, batchHook } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    process.env.DATABASE_URL = `${dbUrl}?options=-c%20role%3Dapp_rls`;
    process.env.DB_TENANT_GUARD = 'on';
    delete (globalThis as { prisma?: unknown }).prisma;
    delete (globalThis as { prismaJobs?: unknown }).prismaJobs;
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    adminClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined,
    resendSend: vi.fn(),
    /** What the live line was handed (the transport, services/live/liveLines.ts deliverLive): a case listens here. */
    live: { onDeliver: null as null | ((orgId: string, type: string, payloadFor: (p: { id: string; orgId: string; isAdmin: boolean }) => object | null) => void) },
    /** A case that fakes the provider's batch request itself (its timing, its key) sets this; unset, the per-email fake answers. */
    batchHook: { fn: null as null | ((payload: unknown[], options?: { idempotencyKey?: string }) => Promise<unknown>) },
  };
});

vi.mock('../lib/prisma', async (importOriginal) => importOriginal());
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.DATABASE_URL ?? testEnv.DATABASE_URL,
      EMAIL_FROM: 'no-reply@test.com',
      EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
      FRONTEND_URL: 'https://staging.app.test',
      RESEND_API_KEY: 're_test_key',
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    // One alert's emails go out as one batch request (#3470); this answers it from the per-email fake above.
    batch = {
      send: async (...a: [never, never?]) =>
        batchHook.fn
          ? batchHook.fn(a[0], a[1])
          : (await import('./spider-batch-test-helpers.js')).batchOverSingleSends(resendSend as never)(...(a as [never, never])),
    };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));
// The live line's transport, so a case can see what each person's screen is told and when; no line is open here.
vi.mock('../services/live/liveLines', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/live/liveLines')>();
  return {
    ...real,
    deliverLive: (orgId: string, type: string, payloadFor: (p: { id: string; orgId: string; isAdmin: boolean }) => object | null) => {
      live.onDeliver?.(orgId, type, payloadFor);
      return 0;
    },
  };
});

import { env } from '../config/env';
import { logger } from '../lib/logger';
import { runJobAtBoot } from '../lib/scheduleJob';
import { runOnJobsClient } from '../lib/prismaJobs';
import { runWithOrg } from '../lib/tenant-context';
import { _resetStopRequest, installStopSignals, stopRequested, type StopProcess } from '../lib/graceful-stop';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { countQueries } from './support/query-counter';
import { DAY, HOUR, MIN, T0, addLead, at, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import { clearLease } from './support/spider-summary-world';
import { runSpiderSweep } from '../services/spider/sweep';
import { claimWatchedStays } from '../services/spider/alertLog';
import { EMAIL_OUTCOME, TEXT_OUTCOME, _setSpiderEmailRequestLimit } from '../services/spider/delivery';
import { HISTORY_ROW_SELECT, historyItem } from '../services/spider/history';
import {
  ENDING_PAGES_PER_CHECK,
  ENDING_PAGE_SIZE,
  SEND_STOP_MARGIN_MS,
  STOP_RECORD_MS,
  _resetSpiderTick,
  rearmIncludedLeads,
  rearmWatchedStays,
  runSpiderTick,
  spiderTickRunning,
  startSpiderTick,
  stayKey,
  wakeSpiderTick,
  whenSpiderTickIdle,
} from '../services/spider/tick';

const suite = adminClient ? describe : describe.skip;

const originalMode = env.SPIDER_WATCH_LIST;
const originalPaused = env.JOBS_PAUSED;
const setEnv = (key: 'SPIDER_WATCH_LIST' | 'JOBS_PAUSED', value: string | undefined) => {
  if (value === undefined) delete env[key];
  else env[key] = value;
};

suite("Spider's check: alerted at the crossing, ended within a check (#3469, real database)", () => {
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
    _resetCtmSmsDoubleFireGuard();
    await _resetSpiderTick();
    await clearLease(db);
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  afterEach(async () => {
    live.onDeliver = null;
    await _resetSpiderTick();
    _resetStopRequest();
    batchHook.fn = null;
    _setSpiderEmailRequestLimit();
    setEnv('SPIDER_WATCH_LIST', originalMode);
    setEnv('JOBS_PAUSED', originalPaused);
  });

  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await removeCompanies(db, orgs);
    await usersClient?.$disconnect();
    await jobsClient?.$disconnect();
    await db.$disconnect();
  }, 120_000);

  // ── The world ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Spider switched off for every company but these (a check covers every switched-on company). */
  const only = (...keep: string[]) =>
    db.spiderSettings.updateMany({ where: { organization_id: { notIn: keep }, is_active: true }, data: { is_active: false } });

  /** A switched-on company (New at 2 hours, every channel on, its 2 Admins and 1 Dispatcher told), and nobody else's. */
  async function company(leads = 0, opts: { channels?: object } = {}): Promise<SpiderCompany> {
    const c = await spiderCompany(db, orgs, { leads });
    if (opts.channels) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: opts.channels } });
    await only(c.org);
    return c;
  }

  const QUIET = { in_app: true, red_frame: true, email: false, text: false };
  const EMAIL_ONLY = { in_app: true, red_frame: true, email: true, text: false };
  const TEXT_ONLY = { in_app: true, red_frame: true, email: false, text: true };
  const ALL = { in_app: true, red_frame: true, email: true, text: true };
  const SENT_OK = { data: { id: 'msg_1' }, error: null };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const alertsOf = (org: string) =>
    db.spiderAlert.findMany({ where: { organization_id: org }, orderBy: [{ alerted_at: 'asc' }, { lead_id: 'asc' }] });

  /** Unread pop-up / red-frame rows of this lead: what keeps its card and the frame on screen. */
  const openRows = (org: string, lead: string) =>
    db.notificationRecipient.count({
      where: { organization_id: org, read_at: null, notification: { object_id: lead, verb: { in: ['spider.alert', 'spider.frame'] } } },
    });

  async function pending(lead: string): Promise<boolean | null> {
    const [row] = await db.$queryRawUnsafe<{ pending: boolean }[]>(`SELECT pending FROM spider_lead_watch WHERE lead_id = $1::uuid`, lead);
    return row ? row.pending : null;
  }

  /** The check's log lines, with their fields. */
  const checkLines = () =>
    (vi.mocked(logger.info).mock.calls as unknown[][])
      .filter((c) => String(c[0]) === '[spider-tick] check')
      .map((c) => c[1] as Record<string, unknown>);

  /**
   * The stop handler (lib/graceful-stop.ts installStopSignals) on a stand-in process, its own seam, waiting on the check
   * as the server's does (index.ts): `raise` delivers SIGTERM as a deploy would; `killed` is when the handler then ended
   * the process by the same signal.
   */
  function stopSignals(maxWaitMs?: number) {
    const handlers = new Map<string, Parameters<StopProcess['on']>[1]>();
    const killed: { signal: string; at: number }[] = [];
    const proc: StopProcess = {
      pid: 4242,
      on: (signal, fn) => handlers.set(signal, fn),
      removeListener: (signal) => handlers.delete(signal),
      kill: (_pid, signal) => killed.push({ signal, at: Date.now() }),
    };
    installStopSignals({ finishing: () => whenSpiderTickIdle(), maxWaitMs, proc });
    return { raise: () => handlers.get('SIGTERM')?.('SIGTERM'), killed };
  }

  const interruptedOf = <T extends { delivery: unknown }>(alerts: T[]) =>
    alerts.filter((a) => JSON.stringify(a.delivery).includes('interrupted by a restart'));

  /** What an alert's History says of its email: INTERRUPTED, the channel's status, or NO-RECORD before any. */
  const emailState = (a: { channels: unknown; delivery: unknown }) =>
    JSON.stringify((a.delivery as { email?: unknown } | null)?.email ?? null).includes('interrupted by a restart')
      ? 'INTERRUPTED'
      : ((a.channels as { email?: { status?: string } } | null)?.email?.status ?? 'NO-RECORD');

  /** The same for its texts. */
  const textState = (a: { channels: unknown; delivery: unknown }) =>
    JSON.stringify((a.delivery as { text?: unknown } | null)?.text ?? null).includes('interrupted by a restart')
      ? 'INTERRUPTED'
      : ((a.channels as { sms?: { status?: string } } | null)?.sms?.status ?? 'NO-RECORD');

  /** The alert's row as the History tab shows it (the route's own shaping of each row). */
  const historyOf = async (alertId: string) =>
    historyItem(await db.spiderAlert.findUniqueOrThrow({ where: { id: alertId }, select: HISTORY_ROW_SELECT }), new Map());

  /** Which of these leads an email is about (its lead number is in the message), or null. */
  async function leadOfEmail(leads: readonly string[]) {
    const numbers = await db.lead.findMany({ where: { id: { in: [...leads] } }, select: { id: true, lead_number: true } });
    return (message: unknown) => numbers.find((n) => n.lead_number && JSON.stringify(message).includes(n.lead_number))?.id ?? null;
  }

  /** A promise that settles to 'still waiting' after `ms`: raced against a check that must not wait on another's send. */
  const stillWaitingAfter = (ms: number) => new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms));

  // ── At the crossing ────────────────────────────────────────────────────────────────────────────────────────────────

  it('a lead is alerted at the first check after it crosses its limit: once, a pop-up for each person, then its email and text, and its watch row settled', async () => {
    const c = await company();
    const lead = await addLead(db, c, at(-2 * HOUR + 30_000));

    const before = await runSpiderTick(T0);
    expect(before).toMatchObject({ companies: 1, due: 0, claimed: 0 });
    // The timer's next wake is the crossing itself.
    expect(before.nextDueAt).toBe(T0.getTime() + 30_000);
    expect(await pending(lead)).toBe(true);

    const r = await runSpiderTick(at(30_000));
    expect(r).toMatchObject({ due: 1, claimed: 1, sent: 1 });
    const alerts = await alertsOf(c.org);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ lead_id: lead, kind: 'ALERTED', status: 'NEW', alerted_at: at(30_000) });
    expect(await openRows(c.org, lead)).toBe(3);
    expect(await pending(lead)).toBe(false);
    expect(resendSend).toHaveBeenCalled();
    expect(ctm.sendSms).toHaveBeenCalled();
    // History holds each channel's outcome.
    expect(alerts[0]!.channels).toMatchObject({ in_app: { enabled: true, status: 'SENT' }, email: { status: 'SENT' }, sms: { status: 'SENT' } });

    const again = await runSpiderTick(at(35_000));
    expect(again).toMatchObject({ due: 0, claimed: 0 });
    expect(await alertsOf(c.org)).toHaveLength(1);
  });

  it('five leads created in the same second all alert in the same check, once each', async () => {
    const c = await company(0, { channels: QUIET });
    const created = at(-2 * HOUR + 20_000);
    const leads = [];
    for (let i = 0; i < 5; i += 1) leads.push(await addLead(db, c, created));

    expect((await runSpiderTick(at(19_999))).claimed).toBe(0);
    expect(await runSpiderTick(at(20_000))).toMatchObject({ due: 5, claimed: 5 });
    expect((await runSpiderTick(at(21_000))).claimed).toBe(0);
    const alerts = await alertsOf(c.org);
    expect(alerts.map((a) => a.lead_id).sort()).toEqual([...leads].sort());
    expect(new Set(alerts.map((a) => a.alerted_at.getTime()))).toEqual(new Set([at(20_000).getTime()]));
  });

  it("every pop-up record exists before the first email or text of the check is handed over", async () => {
    const c = await company(4);
    const seen: number[] = [];
    const recordsNow = () => db.notification.count({ where: { organization_id: c.org, verb: 'spider.alert' } });
    resendSend.mockImplementation(async () => {
      seen.push(await recordsNow());
      return { data: { id: 'msg_1' }, error: null };
    });
    vi.mocked(ctm.sendSms).mockImplementation(async () => {
      seen.push(await recordsNow());
      return { id: 'sms_1' };
    });

    expect(await runSpiderTick(T0)).toMatchObject({ claimed: 4, sent: 4 });
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(new Set(seen)).toEqual(new Set([4]));
  });

  it('a deploy stop during the sends: every alert already shown still gets its email and text inside the stop budget, each record is written as it goes, nothing is sent twice', async () => {
    const c = await company(3);
    const stop = stopSignals();
    let lastSendAt = 0;
    const recordedWhenSending: number[] = [];
    const recordedNow = () => db.spiderAlert.count({ where: { organization_id: c.org, channels: { path: ['email', 'status'], equals: 'SENT' } } });
    resendSend.mockImplementation(async () => {
      // The deploy's SIGTERM arrives while the first email is on its way.
      if (!stopRequested()) stop.raise();
      else recordedWhenSending.push(await recordedNow());
      lastSendAt = Date.now();
      return { data: { id: 'msg_1' }, error: null };
    });
    vi.mocked(ctm.sendSms).mockImplementation(async () => {
      lastSendAt = Date.now();
      return { id: 'sms_1' };
    });

    const r = await runSpiderTick(T0);
    expect(stopRequested()).toBe(true);
    expect(r).toMatchObject({ claimed: 3, sent: 3 });
    for (const lead of c.leads) expect(await openRows(c.org, lead)).toBe(3);
    const alerts = await alertsOf(c.org);
    expect(interruptedOf(alerts)).toEqual([]);
    for (const a of alerts) expect(a.channels).toMatchObject({ email: { status: 'SENT' }, sms: { status: 'SENT' } });
    // Stopping, each alert's record is written once its sends are done, not at the end: the third alert's emails find two.
    expect(Math.max(...recordedWhenSending)).toBe(2);
    // The handler ended the process only once the sends were done.
    await vi.waitFor(() => expect(stop.killed).toHaveLength(1));
    expect(stop.killed[0]).toMatchObject({ signal: 'SIGTERM' });
    expect(stop.killed[0]!.at).toBeGreaterThanOrEqual(lastSendAt);

    // Never sent twice: the next server (here, the next check) has nothing to send.
    const emails = resendSend.mock.calls.length;
    const texts = vi.mocked(ctm.sendSms).mock.calls.length;
    _resetStopRequest();
    expect((await runSpiderTick(at(MIN))).claimed).toBe(0);
    expect(resendSend.mock.calls.length).toBe(emails);
    expect(vi.mocked(ctm.sendSms).mock.calls.length).toBe(texts);
  });

  it('a deploy stop: the alerts whose sends cannot fit in the stop budget are recorded interrupted, every pop-up stays, and nothing is sent later', async () => {
    const c = await company(3);
    // A bounded wait with room for one alert's sends and no second: just over the margin an alert needs.
    const stop = stopSignals(SEND_STOP_MARGIN_MS + 200);
    resendSend.mockImplementation(async () => {
      if (!stopRequested()) {
        stop.raise();
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return { data: { id: 'msg_1' }, error: null };
    });

    const r = await runSpiderTick(T0);
    expect(r).toMatchObject({ claimed: 3, sent: 1 });
    for (const lead of c.leads) expect(await openRows(c.org, lead)).toBe(3);
    const alerts = await alertsOf(c.org);
    const interrupted = interruptedOf(alerts);
    expect(interrupted).toHaveLength(2);
    for (const a of interrupted) expect(a.channels).toMatchObject({ email: { enabled: true, status: 'SKIPPED' }, sms: { enabled: true, status: 'SKIPPED' } });
    expect(alerts.filter((a) => (a.channels as { email?: { status?: string } }).email?.status === 'SENT')).toHaveLength(1);
    await vi.waitFor(() => expect(stop.killed).toHaveLength(1));

    const emails = resendSend.mock.calls.length;
    _resetStopRequest();
    expect((await runSpiderTick(at(MIN))).claimed).toBe(0);
    expect(resendSend.mock.calls.length).toBe(emails);
  });

  it('a deploy stop while an email hangs: just before the stop budget ends, the alert in flight and every alert behind it are recorded interrupted, the other company is sent, and the process ends then; a late answer still replaces its record', { timeout: 30_000 }, async () => {
    const a = await spiderCompany(db, orgs, { leads: 3 });
    const b = await spiderCompany(db, orgs, { leads: 2 });
    for (const c of [a, b]) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: EMAIL_ONLY } });
    await only(a.org, b.org);
    const BUDGET = 7_000;
    const stop = stopSignals(BUDGET);
    let raisedAt = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The deploy's SIGTERM arrives with the first email, which then hangs; every later email answers at once.
    resendSend.mockImplementation(async () => {
      if (!stopRequested()) {
        raisedAt = Date.now();
        stop.raise();
        await held;
      }
      return SENT_OK;
    });
    const statesOf = async (org: string) => (await alertsOf(org)).map(emailState);
    let hung = a;
    let other = b;
    const run = runSpiderTick(T0);
    try {
      await vi.waitFor(() => expect(stop.killed).toHaveLength(1), { timeout: 15_000, interval: 50 });
      // Ended STOP_RECORD_MS before the budget runs out, not by the budget's own end.
      expect(stop.killed[0]!.at - raisedAt).toBeLessThan(BUDGET - STOP_RECORD_MS + 1_000);
      // No shown alert is left without a record: the hung company's are all interrupted, the other's all sent.
      if (!(await statesOf(a.org)).includes('INTERRUPTED')) [hung, other] = [b, a];
      expect(new Set(await statesOf(hung.org))).toEqual(new Set(['INTERRUPTED']));
      expect(new Set(await statesOf(other.org))).toEqual(new Set(['SENT']));
      for (const c of [a, b]) for (const lead of c.leads) expect(await openRows(c.org, lead)).toBe(3);
    } finally {
      release();
    }
    expect(await run).toMatchObject({ claimed: 5 });
    // The hung email answers while the process still lives: that alert's real record replaces its interrupted one; the
    // alerts behind it stay interrupted, and none of their emails is ever sent.
    await _resetSpiderTick();
    expect((await statesOf(hung.org)).sort()).toEqual([...Array(hung.leads.length - 1).fill('INTERRUPTED'), 'SENT']);
    expect(new Set(await statesOf(other.org))).toEqual(new Set(['SENT']));
    // 3 people each: the hung alert's 3 emails and the other company's.
    expect(resendSend).toHaveBeenCalledTimes(3 + 3 * other.leads.length);
  });

  it('a deploy stop: an alert started with just over the margin left whose email then hangs is recorded interrupted with the one behind it, before the budget ends', { timeout: 30_000 }, async () => {
    const c = await company(3, { channels: EMAIL_ONLY });
    const BUDGET = 6_000;
    const stop = stopSignals(BUDGET);
    const leadOf = await leadOfEmail(c.leads);
    let raisedAt = 0;
    const seen = { first: null as string | null };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const emailedLeads = new Set<string>();
    // The first alert's emails take 500 ms (the stop arrives with them); the second alert's then hang.
    resendSend.mockImplementation(async (message: unknown) => {
      const lead = leadOf(message);
      if (lead) emailedLeads.add(lead);
      if (!stopRequested()) {
        raisedAt = Date.now();
        seen.first = lead;
        stop.raise();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else if (lead !== seen.first) {
        await held;
      }
      return SENT_OK;
    });
    const run = runSpiderTick(T0);
    try {
      await vi.waitFor(() => expect(stop.killed).toHaveLength(1), { timeout: 15_000, interval: 50 });
      expect(stop.killed[0]!.at - raisedAt).toBeLessThan(BUDGET - STOP_RECORD_MS + 1_000);
      const alerts = await alertsOf(c.org);
      const byLead = Object.fromEntries(alerts.map((a) => [a.lead_id, emailState(a)]));
      expect(byLead[seen.first!]).toBe('SENT');
      expect(Object.values(byLead).sort()).toEqual(['INTERRUPTED', 'INTERRUPTED', 'SENT']);
      // The second alert was started (it had 5.5 s left, over the margin); the third never was.
      expect(emailedLeads.size).toBe(2);
    } finally {
      release();
    }
    expect(await run).toMatchObject({ claimed: 3, sent: 1 });
  });

  it("a deploy stop while some of an alert's texts went out: each person who got it is recorded as sent and only the rest as interrupted, and the usage counts the texts that went out", { timeout: 30_000 }, async () => {
    const c = await company(1, { channels: TEXT_ONLY });
    const stop = stopSignals(4_000);
    let n = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Three people, texted side by side: the deploy's SIGTERM arrives with the first text; the first two answer, the third hangs.
    vi.mocked(ctm.sendSms).mockImplementation(async () => {
      n += 1;
      if (n === 1) stop.raise();
      if (n === 3) await held;
      return { id: 'sms_1' };
    });
    const run = runSpiderTick(T0);
    try {
      await vi.waitFor(() => expect(stop.killed).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const [alert] = await alertsOf(c.org);
      const text = (alert!.delivery as { text: { outcome: string; recipients: { outcome: string }[] } }).text;
      expect(text.recipients.map((r) => r.outcome).sort()).toEqual([TEXT_OUTCOME.interrupted, TEXT_OUTCOME.sent, TEXT_OUTCOME.sent].sort());
      expect(text.outcome).toBe(`${TEXT_OUTCOME.sent} (2 of 3)`);
      expect(alert!.channels).toMatchObject({ sms: { enabled: true, status: 'SENT', sent: 2, skipped: 1, failed: 0 } });
      expect(alert!.texts_sent).toBe(2);
      const history = await historyOf(alert!.id);
      expect(history.outcomes.sms).toMatchObject({ status: 'SENT', sent: 2, skipped: 1 });
      expect(history.recipients.map((r) => r.text_outcome).sort()).toEqual([TEXT_OUTCOME.interrupted, TEXT_OUTCOME.sent, TEXT_OUTCOME.sent].sort());
    } finally {
      release();
    }
    await run;
    // The third text answers while the process still lives: the alert's real record replaces the one written at the cut.
    await _resetSpiderTick();
    const [after] = await alertsOf(c.org);
    expect((after!.delivery as { text: { outcome: string } }).text.outcome).toBe(TEXT_OUTCOME.sent);
    expect(after!.texts_sent).toBe(3);
  });

  it('a crash while the sends are on their way: an alert already shown whose emails and texts never finished keeps no outcome that says sent, in History or in its stored channels', { timeout: 30_000 }, async () => {
    const c = await company(3, { channels: ALL });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const requested: string[] = [];
    // The first alert's email request hangs: its own sends never finish, and the alerts behind it never start.
    batchHook.fn = async (payload) => {
      requested.push(String((payload[0] as { tags: { value: string }[] }).tags[0]!.value));
      await held;
      return { data: { data: payload.map((_, i) => ({ id: `m${i}` })), errors: [] }, error: null };
    };
    const run = runSpiderTick(T0);
    try {
      await vi.waitFor(() => expect(requested).toHaveLength(1), { timeout: 5_000, interval: 20 });
      // What a crash now leaves: three alerts shown, one email request out, the first alert's texts (3 people), nothing more.
      const alerts = await alertsOf(c.org);
      expect(alerts).toHaveLength(3);
      for (const lead of c.leads) expect(await openRows(c.org, lead)).toBe(3);
      expect(ctm.sendSms).toHaveBeenCalledTimes(3);
      const neverStarted = alerts.filter((a) => a.id !== requested[0]);
      expect(neverStarted).toHaveLength(2);
      for (const a of alerts) {
        const stored = a.channels as { email?: object; sms?: object };
        // The claim's own record: each channel on, no status (History reads it as not yet known).
        expect(stored.email).toEqual({ enabled: true });
        expect(stored.sms).toEqual({ enabled: true });
        expect(JSON.stringify((a.delivery as { email?: unknown; text?: unknown } | null) ?? {})).not.toMatch(/sent/i);
        const history = await historyOf(a.id);
        expect(history.outcome).toBeNull();
        expect(history.outcomes).toMatchObject({ email: null, sms: null });
        expect(history.channels).toMatchObject({ email: null, text: null });
        for (const r of history.recipients) expect(r).toMatchObject({ email_outcome: null, text_outcome: null });
      }
    } finally {
      release();
    }
    expect(await run).toMatchObject({ claimed: 3, sent: 3 });
  });

  it("a deploy while a company's sends are backed up: later checks still claim and show its crossings at once, and the stop records the alert in flight and every batch waiting behind it interrupted, before its budget ends; nothing is sent later", { timeout: 30_000 }, async () => {
    const c = await company(1, { channels: EMAIL_ONLY });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    resendSend.mockImplementation(async () => {
      await held;
      return SENT_OK;
    });
    const later: string[] = [];
    const checks: Promise<unknown>[] = [runSpiderTick(T0)];
    try {
      await vi.waitFor(() => expect(resendSend).toHaveBeenCalled());
      // Two more leads cross while the first alert's email is held: each next check claims and shows its lead at once, and
      // its batch waits its turn behind the first.
      for (const [i, crossing] of [1_000, 2_000].entries()) {
        later.push(await addLead(db, c, at(-2 * HOUR + crossing)));
        checks.push(runSpiderTick(at(crossing + 500)));
        await vi.waitFor(async () => expect(await alertsOf(c.org)).toHaveLength(i + 2), { timeout: 3_000, interval: 20 });
      }
      for (const lead of later) {
        await vi.waitFor(async () => expect(await openRows(c.org, lead)).toBe(3), { timeout: 2_000, interval: 20 });
        expect(await pending(lead)).toBe(false);
      }
      expect((await alertsOf(c.org)).map(emailState)).toEqual(['NO-RECORD', 'NO-RECORD', 'NO-RECORD']);

      // A deploy now: every shown alert gets a record before the budget ends.
      const BUDGET = STOP_RECORD_MS + 1_000;
      const stop = stopSignals(BUDGET);
      const raisedAt = Date.now();
      stop.raise();
      await vi.waitFor(() => expect(stop.killed).toHaveLength(1), { timeout: 5_000, interval: 50 });
      expect(stop.killed[0]!.at - raisedAt).toBeLessThan(BUDGET);
      expect((await alertsOf(c.org)).map(emailState)).toEqual(['INTERRUPTED', 'INTERRUPTED', 'INTERRUPTED']);
      // Only the first alert's first email was ever handed over.
      expect(resendSend).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await Promise.all(checks);
    await _resetSpiderTick();
    // The next server finds them claimed: nothing is sent again.
    const emails = resendSend.mock.calls.length;
    _resetStopRequest();
    expect((await runSpiderTick(at(MIN))).claimed).toBe(0);
    expect(resendSend.mock.calls.length).toBe(emails);
  });

  // ── Ending within a check ──────────────────────────────────────────────────────────────────────────────────────────

  it('a lead moved to Contacted while its New alert is open: its records end at the next check, and nothing alerts again', async () => {
    const c = await company(1, { channels: QUIET });
    const [lead] = c.leads;
    await runSpiderTick(T0);
    expect(await openRows(c.org, lead!)).toBe(3);

    await db.lead.update({ where: { id: lead }, data: { status: 'CONTACTED', contacted_at: at(5_000) } });
    const r = await runSpiderTick(at(10_000));
    expect(r.ended).toBe(3);
    expect(await openRows(c.org, lead!)).toBe(0);
    expect(await alertsOf(c.org)).toHaveLength(1);
    // An unrelated lead save changes no stay and ends nothing.
    const other = await addLead(db, c, at(-HOUR));
    await db.lead.update({ where: { id: other }, data: { service_request: 'Fix the gate' } });
    expect((await runSpiderTick(at(15_000))).ended).toBe(0);
  });

  it("each person's screen is told on the live line: the new card once its row is written, then its end once that is written", async () => {
    const c = await company(0, { channels: QUIET });
    const lead = await addLead(db, c, at(-2 * HOUR + 1_000));
    const told: Promise<{ type: string; ids: string[]; stored: { id: string; read_at: Date | null }[] }>[] = [];
    live.onDeliver = (orgId, type, payloadFor) => {
      if (orgId !== c.org) return;
      const ids = c.people.flatMap((p) => {
        const payload = payloadFor({ id: p.id, orgId, isAdmin: p.role === 'ADMIN' }) as { alerts?: { id: string }[]; ids?: string[] } | null;
        return payload ? [...(payload.alerts ?? []).map((a) => a.id), ...(payload.ids ?? [])] : [];
      });
      // Read on another connection the moment the message is handed over: the rows it names are already there.
      told.push(
        db.notificationRecipient
          .findMany({ where: { id: { in: ids } }, select: { id: true, read_at: true } })
          .then((stored) => ({ type, ids, stored })),
      );
    };

    expect((await runSpiderTick(at(1_000))).claimed).toBe(1);
    await db.lead.update({ where: { id: lead }, data: { status: 'CONTACTED', contacted_at: at(2_000) } });
    expect((await runSpiderTick(at(3_000))).ended).toBe(3);

    const [added, ended, ...more] = await Promise.all(told);
    expect(more).toEqual([]);
    expect(added!.type).toBe('spider.alert.added');
    expect(added!.ids).toHaveLength(3);
    expect(added!.stored.map((s) => s.id).sort()).toEqual([...added!.ids].sort());
    expect(ended!.type).toBe('spider.alert.ended');
    expect([...ended!.ids].sort()).toEqual([...added!.ids].sort());
    expect(ended!.stored.every((s) => s.read_at !== null)).toBe(true);
  });

  // The two cases below run on the real clock: the ending reads the watch rows the database stamped (with its own clock)
  // since a minute before its window start, and a fixed clock in the past would read every row at every check.

  it('a check whose ending fails still claims, shows its pop-ups and starts a ready summary; the next check ends what it could not', { timeout: 60_000 }, async () => {
    const c = await company(1, { channels: QUIET });
    const moved = c.leads[0]!;
    expect(await runSpiderTick(new Date())).toMatchObject({ claimed: 1 });
    await db.lead.update({ where: { id: moved }, data: { status: 'CONTACTED', contacted_at: new Date() } });
    // The failing check runs two minutes on: had its window moved on with it, the next check would no longer read the move.
    const failingAt = new Date(Date.now() + 2 * MIN);
    const crossing = await addLead(db, c, new Date(failingAt.getTime() - 2 * HOUR - 1_000));
    const backlog = await spiderCompany(db, orgs, { leads: 2, trigger: true });
    await db.spiderSettings.update({ where: { organization_id: backlog.org }, data: { channels: QUIET } });

    /** Statements of this database waiting for a lock whose text matches `like`. */
    const waiting = async (like: string) => {
      const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        like,
      );
      return row!.n;
    };
    // The database refuses the ending's read: the records' table is held, and a job gives up waiting for a lock after 1 s
    // (lib/prismaJobs.ts). The hold ends as soon as the read has given up; nothing else of the check reads that table first.
    let release!: () => void;
    let held!: () => void;
    const releaseNow = new Promise<void>((resolve) => (release = resolve));
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const hold = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE notification_recipients IN ACCESS EXCLUSIVE MODE');
        held();
        await releaseNow;
      },
      { timeout: 30_000 },
    );
    await isHeld;
    const failing = runSpiderTick(failingAt).catch((err: unknown) => err);
    // The ending's record read is the statement with the keys' table `k(org, dedup)`.
    try {
      await vi.waitFor(async () => expect(await waiting('%AS k(org, dedup)%')).toBeGreaterThan(0), { timeout: 10_000, interval: 10 });
      await vi.waitFor(async () => expect(await waiting('%AS k(org, dedup)%')).toBe(0), { timeout: 10_000, interval: 10 });
    } finally {
      release();
      await hold;
    }
    const result = await failing;

    // The same check claimed the lead that crossed, wrote its pop-ups and started the waiting summary.
    expect(await openRows(c.org, crossing)).toBe(3);
    expect(result).toMatchObject({ claimed: 1, summaries: 1, summarized: 2, ended: 0 });
    // The failure is logged by the error's class name only, never its message (which can carry the values it failed on).
    const errors = vi.mocked(logger.error).mock.calls.map((x) => String(x[0]));
    expect(errors.filter((l) => l.startsWith('[spider-tick] could not end alerts'))).toEqual([
      expect.stringMatching(/^\[spider-tick\] could not end alerts: PrismaClient\w+Error( P\d{4})?$/),
    ]);
    // Nothing was ended, and the ending's window did not move: the next check reads the move again and ends its alert.
    expect(await openRows(c.org, moved)).toBe(3);
    expect((await runSpiderTick(new Date(failingAt.getTime() + 1_000))).ended).toBe(3);
    expect(await openRows(c.org, moved)).toBe(0);
  });

  it('thousands of rows changed at once: a check ends at most its pages, the next goes on from there, and no row is lost between checks', { timeout: 240_000 }, async () => {
    const c = await company(4, { channels: QUIET });
    const [late, ...tail] = c.leads as [string, ...string[]];
    expect(await runSpiderTick(new Date())).toMatchObject({ claimed: 4 });
    // An import of one check's worth of open leads (every page a check reads), in one statement: their rows share one stamp.
    const bulk = Array.from({ length: ENDING_PAGE_SIZE * ENDING_PAGES_PER_CHECK }, () => randomUUID());
    const base = Date.now() - 10 * MIN;
    await db.lead.createMany({
      data: bulk.map((id, i) => ({
        id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 12)}`, service_request: 'Fix the door',
        status: 'NEW' as const, created_at: new Date(base - i * 100),
      })),
    });
    const stamp = (await db.spiderLeadWatch.findUniqueOrThrow({ where: { lead_id: bulk[0] } })).changed_at.getTime();
    // Three alerted leads move after the import: their rows come after every imported row.
    await db.lead.updateMany({ where: { id: { in: tail } }, data: { status: 'CONTACTED', contacted_at: new Date() } });

    // This check reads the first alerted lead's row and then imported rows up to its page limit; the moved three lie beyond it.
    expect((await runSpiderTick(new Date(stamp + 30_000))).ended).toBe(0);
    for (const lead of tail) expect(await openRows(c.org, lead)).toBe(3);
    // The first lead moves in a save that began before the import and commits only now: its row carries the earlier stamp,
    // behind where the pass already stands.
    await db.lead.update({ where: { id: late }, data: { status: 'CONTACTED', contacted_at: new Date() } });
    await db.spiderLeadWatch.update({ where: { lead_id: late }, data: { changed_at: new Date(stamp - 10_000) } });

    // The next check goes on from where the last one stopped: it reaches the moved three and ends their alerts.
    expect((await runSpiderTick(new Date(stamp + 90_000))).ended).toBe(9);
    for (const lead of tail) expect(await openRows(c.org, lead)).toBe(0);
    expect(await openRows(c.org, late)).toBe(3);
    // The pass is done; the next one starts a minute before that pass BEGAN, so it reads the late save and ends its alert.
    expect((await runSpiderTick(new Date(stamp + 91_000))).ended).toBe(3);
    expect(await openRows(c.org, late)).toBe(0);
  });

  it("one company's ending fails on a page that holds another's rows: the other's alerts end, the place stays, and the failed company's alerts end once they can", { timeout: 60_000 }, async () => {
    const failing = await spiderCompany(db, orgs, { leads: 3 });
    const other = await spiderCompany(db, orgs, { leads: 3 });
    for (const x of [failing, other]) await db.spiderSettings.update({ where: { organization_id: x.org }, data: { channels: QUIET, is_active: true } });
    await only(failing.org, other.org);
    expect(await runSpiderTick(new Date())).toMatchObject({ claimed: 6 });
    // Both companies' leads move in one save: their six rows lie on one page.
    await db.lead.updateMany({ where: { id: { in: [...failing.leads, ...other.leads] } }, data: { status: 'CONTACTED', contacted_at: new Date() } });

    // The database refuses the failing company's end: one of its unread rows is held (a row lock), and a job gives up
    // waiting for a lock after 1 s (lib/prismaJobs.ts). The reads never wait on a row lock; only that end does.
    const heldRow = await db.notificationRecipient.findFirstOrThrow({ where: { organization_id: failing.org, read_at: null } });
    let release!: () => void;
    let held!: () => void;
    const releaseNow = new Promise<void>((resolve) => (release = resolve));
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const hold = db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM notification_recipients WHERE id = $1::uuid FOR UPDATE', heldRow.id);
        held();
        await releaseNow;
      },
      { timeout: 30_000 },
    );
    await isHeld;
    const startedAt = Date.now();
    let first: Awaited<ReturnType<typeof runSpiderTick>>;
    let second: Awaited<ReturnType<typeof runSpiderTick>>;
    try {
      first = await runSpiderTick(new Date(startedAt + 1_000));
      // Two minutes on, still refused: had the place moved past the failing company's rows, the next window (a minute
      // before this check) would no longer reach them.
      second = await runSpiderTick(new Date(startedAt + 2 * MIN));
    } finally {
      release();
      await hold;
    }

    // The other company's alerts ended on the page where the failing company's end failed, and were not ended twice.
    expect(first.ended).toBe(9);
    expect(second.ended).toBe(0);
    for (const lead of other.leads) expect(await openRows(other.org, lead)).toBe(0);
    for (const lead of failing.leads) expect(await openRows(failing.org, lead)).toBe(3);
    // Each failure is logged for the failing company alone, by the error's class name only.
    const failures = vi.mocked(logger.error).mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith('[spider-tick] could not end'));
    expect(failures.length).toBe(2);
    for (const line of failures) {
      expect(line).toMatch(new RegExp(`^\\[spider-tick\\] could not end 3 alerts for org ${failing.org}: PrismaClient\\w+Error( P\\d{4})?$`));
    }
    // Once the hold is gone the next check ends the failing company's alerts: nothing was skipped.
    expect((await runSpiderTick(new Date(startedAt + 2 * MIN + 5_000))).ended).toBe(9);
    for (const lead of failing.leads) expect(await openRows(failing.org, lead)).toBe(0);
    expect((await runSpiderTick(new Date(startedAt + 2 * MIN + 10_000))).ended).toBe(0);
  });

  // ── The sweep's rules ──────────────────────────────────────────────────────────────────────────────────────────────

  it('Activate + Skip: a stay past its limit at Activate is never alerted (and is settled); one that crosses after is alerted on its own', async () => {
    const c = await company(1, { channels: QUIET });
    const [old] = c.leads;
    const oldLead = await db.lead.findUniqueOrThrow({ where: { id: old }, select: { created_at: true } });
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: { activated_at: at(-MIN), backlog_skipped_at: at(-MIN), backlog_skipped_stays: [stayKey(old!, 'NEW', oldLead.created_at)] },
    });
    const later = await addLead(db, c, at(-2 * HOUR + 10_000));

    const first = await runSpiderTick(T0);
    expect(first).toMatchObject({ due: 0, claimed: 0, settled: 1 });
    expect(await pending(old!)).toBe(false);
    expect(await runSpiderTick(at(10_000))).toMatchObject({ claimed: 1 });
    expect((await alertsOf(c.org)).map((a) => a.lead_id)).toEqual([later]);
  });

  it('Activate + Send: the first check builds the starting summary at once (the backlog only); a lead that crosses 10 s after Activate is alerted on its own at once, and is not in the summary', async () => {
    const c = await company(1, { channels: QUIET });
    const [old] = c.leads;
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: { activated_at: T0, summary_trigger_at: T0, summary_trigger_since: T0, summary_trigger_kind: 'SWITCHED_ON' },
    });
    const later = await addLead(db, c, at(-2 * HOUR + 10_000));

    // #3471: no wait for Activate (Send): the first check starts the summary, beside the check, and it covers the stays past
    // their limit at Activate. Nothing is alerted one by one.
    expect(await runSpiderTick(at(5_000))).toMatchObject({ due: 0, claimed: 0, summaries: 1, summarized: 1 });
    expect((await alertsOf(c.org)).map((a) => [a.lead_id, a.kind])).toEqual([[old, 'SUMMARIZED']]);
    // The lead crossing 10 s after Activate is alerted on its own at its crossing; the check also settles the summarized stay.
    expect(await runSpiderTick(at(10_000))).toMatchObject({ due: 1, claimed: 1, settled: 1, summaries: 0 });
    const alerts = await alertsOf(c.org);
    expect(alerts.map((a) => [a.lead_id, a.kind]).sort()).toEqual([[later, 'ALERTED'], [old, 'SUMMARIZED']].sort());
    expect(await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ lead_count: 1 });
    expect(await pending(old!)).toBe(false);
    // The sweep (the check is off here) finds no trigger left: it does nothing more.
    await runSpiderSweep(at(3 * MIN));
    expect(await alertsOf(c.org)).toHaveLength(2);
    expect(await runSpiderTick(at(3 * MIN + 1_000))).toMatchObject({ claimed: 0, settled: 0 });
  });

  it('leaves out an excluded lead (its due stay settled, read once), a stage whose limit is off, a company switched off and one outside the gate', async () => {
    const open = await spiderCompany(db, orgs, { leads: 2 });
    await db.spiderSettings.update({ where: { organization_id: open.org }, data: { excluded_lead_ids: [open.leads[0]!], channels: QUIET } });
    const limitOff = await spiderCompany(db, orgs, { leads: 1 });
    await db.spiderSettings.update({
      where: { organization_id: limitOff.org },
      data: { status_limits: { NEW: { enabled: false, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' }, WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' } } },
    });
    const off = await spiderCompany(db, orgs, { leads: 1 });
    const outside = await spiderCompany(db, orgs, { leads: 1 });
    await db.organization.update({ where: { id: outside.org }, data: { is_demo: false } });
    await only(open.org, limitOff.org, outside.org);

    const r = await runSpiderTick(T0);
    expect(r).toMatchObject({ companies: 2, due: 1, claimed: 1, settled: 1 });
    expect((await alertsOf(open.org)).map((a) => a.lead_id)).toEqual([open.leads[1]]);
    for (const other of [limitOff, off, outside]) expect(await alertsOf(other.org)).toEqual([]);
    // The excluded lead's due stay is settled by that check and not read again; included again through the picker, it is
    // watched again (spider-save-time-ending-db.test.ts, through the routes).
    expect(await pending(open.leads[0]!)).toBe(false);
    expect(await runSpiderTick(at(1_000))).toMatchObject({ due: 0, claimed: 0, settled: 0 });
    expect(await alertsOf(open.org)).toHaveLength(1);
  });

  it('a lead included again just as a check reads it as excluded: that check never settles the stay the include watched again', { timeout: 30_000 }, async () => {
    const c = await company(1, { channels: QUIET });
    const lead = c.leads[0]!;
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { excluded_lead_ids: [lead] } });
    expect(await pending(lead)).toBe(true);
    /** A statement whose text matches `like` is waiting for a lock (the activity view cuts long text: matched by its opening). */
    const waitingFor = (like: string) => async () => {
      const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        like,
      );
      expect(row!.n).toBeGreaterThan(0);
    };
    let rearm: Promise<number> | undefined;
    let checkRun: ReturnType<typeof runSpiderTick> | undefined;
    // The picker's save includes the lead and its re-arm (the real rearmIncludedLeads) follows. Both are held behind a hold
    // on the lead's watch row, so the check reads the lead as still excluded and then waits for the re-arm's write to the
    // same row; the save commits, the re-arm writes, and only then does the check's settle look at the row again.
    await db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1 FROM spider_lead_watch WHERE lead_id = $1::uuid FOR UPDATE`, lead);
        await tx.$executeRawUnsafe(`UPDATE spider_settings SET excluded_lead_ids = '{}' WHERE organization_id = $1::uuid`, c.org);
        rearm = runWithOrg(c.org, () => rearmIncludedLeads(c.org, [lead]));
        await vi.waitFor(waitingFor('%SET pending = true%'), { timeout: 5_000, interval: 10 });
        checkRun = runSpiderTick(T0);
        await vi.waitFor(waitingFor('%WITH lim AS%'), { timeout: 800, interval: 10 });
      },
      { timeout: 10_000 },
    );
    expect(await rearm).toBe(1);
    // It read the lead as excluded, so it claims nothing; and it leaves the stay the re-arm watched again for the next check.
    expect(await checkRun).toMatchObject({ claimed: 0, settled: 0 });
    expect(await pending(lead)).toBe(true);
  });

  it("each company's excluded leads and skipped stays are its own: another company's lists never hold back this company's leads", async () => {
    const x = await spiderCompany(db, orgs, { leads: 1 });
    const y = await spiderCompany(db, orgs, { leads: 2 });
    for (const c of [x, y]) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
    await only(x.org, y.org);
    const yStay = await db.lead.findUniqueOrThrow({ where: { id: y.leads[1]! }, select: { created_at: true } });
    // X's lists name Y's lead and Y's stay (never written by the app, which keeps each list to the company's own leads).
    await db.spiderSettings.update({
      where: { organization_id: x.org },
      data: { excluded_lead_ids: [y.leads[0]!], backlog_skipped_stays: [stayKey(y.leads[1]!, 'NEW', yStay.created_at)] },
    });

    expect(await runSpiderTick(T0)).toMatchObject({ claimed: 3, settled: 0 });
    expect((await alertsOf(y.org)).map((a) => a.lead_id).sort()).toEqual([...y.leads].sort());
    expect((await alertsOf(x.org)).map((a) => a.lead_id)).toEqual(x.leads);
  });

  it('Activate watches again only the stays the new period may still alert on their own; the backlog past its limit stays settled (#3468)', async () => {
    const c = await company(0, { channels: QUIET });
    const limits = (newHours: number, contactedOn: boolean) => ({
      NEW: { enabled: true, value: newHours, unit: 'HOUR' },
      CONTACTED: { enabled: contactedOn, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
    });
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { status_limits: limits(2, true) } });
    const past = await addLead(db, c, at(-5 * HOUR));
    const notPast = await addLead(db, c, at(-2.5 * HOUR));
    const excluded = await addLead(db, c, at(-4 * HOUR));
    const contacted = await addLead(db, c, at(-3 * DAY));
    await db.lead.update({ where: { id: contacted }, data: { status: 'CONTACTED', contacted_at: at(-2 * DAY) } });
    // The first switched-on period alerts all four, and settles them.
    expect((await runSpiderTick(T0)).claimed).toBe(4);
    for (const lead of [past, notPast, excluded, contacted]) expect(await pending(lead)).toBe(false);

    // Switched off, then on again with Skip: New at 3 hours, Contacted's limit off, one lead excluded. `past` is the
    // only stay past its limit at Activate (5 h > 3 h); `notPast` is 2 h 40 min in; `excluded` and `contacted` are not
    // watched right now.
    const activatedAt = at(10 * MIN);
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: {
        status_limits: limits(3, false), excluded_lead_ids: [excluded], activated_at: activatedAt, backlog_skipped_at: activatedAt,
        backlog_skipped_stays: [stayKey(past, 'NEW', at(-5 * HOUR))], summary_trigger_at: null, summary_trigger_since: null, summary_trigger_kind: null,
      },
    });
    // Watched again: `notPast` (it may still cross) and `contacted` (it may once its stage is switched on). Not `past`
    // (the backlog) nor `excluded` (past its limit: included again, the picker's save watches it again).
    expect(await runWithOrg(c.org, () => rearmWatchedStays(c.org))).toBe(2);
    for (const lead of [past, excluded]) expect(await pending(lead)).toBe(false);
    for (const lead of [notPast, contacted]) expect(await pending(lead)).toBe(true);

    // `notPast` alerts on its own when it crosses 3 hours; the backlog never does. Including `excluded` and switching
    // Contacted on are widening saves (a starting summary): the journey through the routes is in
    // spider-save-time-ending-db.test.ts.
    expect(await runSpiderTick(at(10 * MIN + 1_000))).toMatchObject({ claimed: 0, settled: 0 });
    expect((await runSpiderTick(at(30 * MIN))).claimed).toBe(1);
    const period2 = await db.spiderAlert.findMany({ where: { organization_id: c.org, counted_from: { gte: activatedAt } } });
    expect(period2.map((a) => a.lead_id)).toEqual([notPast]);
    for (const lead of [past, excluded]) expect(await pending(lead)).toBe(false);
    expect(await pending(contacted)).toBe(true);
  });

  it('a stay someone else claimed (the sweep) is not alerted again, and its watch row is settled by the check', async () => {
    const c = await company(2, { channels: QUIET });
    await runSpiderSweep(T0);
    expect(await alertsOf(c.org)).toHaveLength(2);
    expect(await pending(c.leads[0]!)).toBe(true);

    const r = await runSpiderTick(at(1_000));
    expect(r).toMatchObject({ due: 0, claimed: 0, settled: 2 });
    for (const lead of c.leads) expect(await pending(lead)).toBe(false);
    expect(await alertsOf(c.org)).toHaveLength(2);
  });

  it('the sweep and the check at the same moment: each stay is alerted once', async () => {
    const c = await company(6, { channels: QUIET });
    await Promise.all([runSpiderSweep(T0), runSpiderTick(T0)]);
    const alerts = await alertsOf(c.org);
    expect(alerts.map((a) => a.lead_id).sort()).toEqual([...c.leads].sort());
    await runSpiderTick(at(1_000));
    for (const lead of c.leads) expect(await pending(lead)).toBe(false);
  });

  describe('the claim (claimWatchedStays): one statement that claims and settles', () => {
    const claimFor = (c: SpiderCompany, lead: string, enteredAt: Date, countedFrom: Date): Prisma.SpiderAlertCreateManyInput => ({
      organization_id: c.org, lead_id: lead, status: 'NEW', entered_status_at: enteredAt, counted_from: countedFrom,
      limit_value: 2, limit_unit: 'HOUR', alerted_at: T0,
    });
    const claim = (c: SpiderCompany, activatedAt: Date, rows: Prisma.SpiderAlertCreateManyInput[]) =>
      runOnJobsClient(() => runWithOrg(c.org, () => claimWatchedStays(c.org, activatedAt, rows)));

    it('a backfilled or repaired row of a stay already claimed comes back pending: the conflicting claim writes nothing and settles it', async () => {
      const c = await company(1, { channels: QUIET });
      const [lead] = c.leads;
      const settings = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } });
      const { created_at } = await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { created_at: true } });
      await runSpiderTick(T0);
      // The nightly check repaired the row (#3468): pending again, for the same stay.
      await db.$executeRawUnsafe(`UPDATE spider_lead_watch SET pending = true WHERE lead_id = $1::uuid`, lead);

      const written = await claim(c, settings.activated_at!, [claimFor(c, lead!, created_at, created_at > settings.activated_at! ? created_at : settings.activated_at!)]);
      expect(written.size).toBe(0);
      expect(await pending(lead!)).toBe(false);
      expect(await alertsOf(c.org)).toHaveLength(1);
    });

    it('claims nothing, and leaves the row pending, for a stay the lead has left or a switched-on period that is over', async () => {
      const c = await company(1, { channels: QUIET });
      const [lead] = c.leads;
      const settings = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } });
      const { created_at } = await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { created_at: true } });
      const countedFrom = created_at > settings.activated_at! ? created_at : settings.activated_at!;

      // An older stay than the lead's own.
      expect((await claim(c, settings.activated_at!, [claimFor(c, lead!, new Date(created_at.getTime() - DAY), countedFrom)])).size).toBe(0);
      // Spider switched off and on since the check read it.
      expect((await claim(c, new Date(settings.activated_at!.getTime() - 1), [claimFor(c, lead!, created_at, countedFrom)])).size).toBe(0);
      expect(await pending(lead!)).toBe(true);
      expect(await alertsOf(c.org)).toEqual([]);
      // The real one is claimed and settled.
      expect((await claim(c, settings.activated_at!, [claimFor(c, lead!, created_at, countedFrom)])).size).toBe(1);
      expect(await pending(lead!)).toBe(false);
    });
  });

  // ── The flood guard and the people ─────────────────────────────────────────────────────────────────────────────────

  it('the flood guard (#2991): at most 100 per-lead alerts per company in any 2 minutes, overdue longest first', async () => {
    const c = await company(120, { channels: QUIET });
    // The fixture made lead i a minute before lead i-1: the last ones crossed first.
    const oldestFirst = [...c.leads].reverse();

    expect((await runSpiderTick(T0)).claimed).toBe(100);
    expect(new Set((await alertsOf(c.org)).map((a) => a.lead_id))).toEqual(new Set(oldestFirst.slice(0, 100)));
    expect((await runSpiderTick(at(MIN))).claimed).toBe(0);
    expect((await runSpiderTick(at(2 * MIN - 1))).claimed).toBe(0);
    // Two minutes after the first 100, as the sweep's next run would: the rest.
    expect((await runSpiderTick(at(2 * MIN))).claimed).toBe(20);
    expect(await alertsOf(c.org)).toHaveLength(120);
  });

  it('a stay nobody can be told about takes no place and is not read again for 2 minutes; once someone can be told, it alerts', async () => {
    const c = await company(1, { channels: QUIET });
    await db.user.updateMany({ where: { organization_id: c.org }, data: { is_active: false } });
    const first = await runSpiderTick(T0);
    expect(first).toMatchObject({ due: 1, claimed: 0 });

    const { queries } = await countQueries(() => runSpiderTick(at(10_000)), jobsClient);
    expect(queries.filter((q) => /"leads"/.test(q.sql))).toEqual([]);
    await db.user.updateMany({ where: { organization_id: c.org }, data: { is_active: true } });
    clearPermissionCache();
    expect((await runSpiderTick(at(MIN))).claimed).toBe(0);
    expect((await runSpiderTick(at(2 * MIN + 1))).claimed).toBe(1);
  });

  // ── One company's sends never delay another's ──────────────────────────────────────────────────────────────────────────

  it("one company's held email never delays another company's: the second is claimed, shown and emailed while the first still waits", { timeout: 30_000 }, async () => {
    const slow = await spiderCompany(db, orgs, { leads: 1 });
    const quick = await spiderCompany(db, orgs, { leads: 0 });
    for (const c of [slow, quick]) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: EMAIL_ONLY } });
    await only(slow.org, quick.org);
    const leadOf = await leadOfEmail(slow.leads);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    resendSend.mockImplementation(async (message: unknown) => {
      if (leadOf(message)) await held;
      return SENT_OK;
    });
    const slowEmail = async () => emailState(await db.spiderAlert.findFirstOrThrow({ where: { organization_id: slow.org } }));
    try {
      const first = runSpiderTick(T0);
      await vi.waitFor(() => expect(resendSend).toHaveBeenCalled());
      const lead = await addLead(db, quick, at(-2 * HOUR + 1_000));
      const second = await Promise.race([runSpiderTick(at(2_000)), stillWaitingAfter(5_000)]);
      expect(second).toMatchObject({ companies: 2, claimed: 1, sent: 1 });
      const [alert] = await alertsOf(quick.org);
      expect(alert).toMatchObject({ lead_id: lead });
      expect(emailState(alert!)).toBe('SENT');
      expect(await openRows(quick.org, lead)).toBe(3);
      expect(await slowEmail()).toBe('NO-RECORD');
      release();
      expect(await first).toMatchObject({ claimed: 1, sent: 1 });
    } finally {
      release();
    }
    expect(await slowEmail()).toBe('SENT');
  });

  // ── Its log line ───────────────────────────────────────────────────────────────────────────────────────────────────

  it('logs one line per check, only when it did something: ids and counts, never a name', async () => {
    const c = await company(0, { channels: QUIET });
    await addLead(db, c, at(-2 * HOUR + 5_000));
    await runSpiderTick(T0);
    // Nothing done: no line (unless its due statement was slow, which is logged on its own).
    expect(checkLines().filter((l) => (l.dueMs as number) < 50)).toEqual([]);
    vi.mocked(logger.info).mockClear();
    await runSpiderTick(at(5_000));
    expect(checkLines()).toHaveLength(1);
    const fields = checkLines()[0]!;
    expect(Object.keys(fields).sort()).toEqual(['claimed', 'companies', 'due', 'dueMs', 'durationMs', 'ended', 'sent', 'settled', 'summaries', 'waiting']);
    for (const v of Object.values(fields)) expect(typeof v).toBe('number');
    // Its one alert is waiting for its sends when the line is written.
    expect(fields).toMatchObject({ companies: 1, due: 1, claimed: 1, sent: 0, waiting: 1, ended: 0 });
    // Its emails and texts go out after its line: the next check's line counts them, and is the only line there is.
    vi.mocked(logger.info).mockClear();
    await runSpiderTick(at(6_000));
    expect(checkLines()).toHaveLength(1);
    expect(checkLines()[0]).toMatchObject({ due: 0, claimed: 0, sent: 1, waiting: 0 });
    expect(vi.mocked(logger.info).mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith('[spider-tick]'))).toEqual(['[spider-tick] check']);
    vi.mocked(logger.info).mockClear();
    await runSpiderTick(at(7_000));
    expect(checkLines().filter((l) => (l.dueMs as number) < 50)).toEqual([]);
  });

  // ── Started as the server starts it ────────────────────────────────────────────────────────────────────────────────

  describe('the loop, started through the door index.ts uses', () => {
    const start = () => runJobAtBoot('spider-tick', () => startSpiderTick());

    it.each([[undefined], ['backfill'], ['chek']])('SPIDER_WATCH_LIST=%s: it does not start and reads nothing; the 2-minute sweep alerts as before', async (mode) => {
      setEnv('SPIDER_WATCH_LIST', mode);
      const c = await company(1, { channels: QUIET });
      let users = 0;
      const jobs = await countQueries(async () => {
        users = (await countQueries(async () => expect(await start()).toBe(false), usersClient)).count;
      }, jobsClient);
      expect(jobs.count).toBe(0);
      expect(users).toBe(0);
      expect(spiderTickRunning()).toBe(false);
      expect(vi.mocked(logger.info).mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith('[spider-tick]'))).toHaveLength(1);
      await runSpiderSweep(T0);
      expect(await alertsOf(c.org)).toHaveLength(1);
    });

    it('JOBS_PAUSED=spider-tick: it says it is paused and reads nothing', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      setEnv('JOBS_PAUSED', 'spider-tick');
      await company(1, { channels: QUIET });
      let users = 0;
      const jobs = await countQueries(async () => {
        users = (await countQueries(async () => expect(await start()).toBeUndefined(), usersClient)).count;
      }, jobsClient);
      expect(jobs.count).toBe(0);
      expect(users).toBe(0);
      expect(spiderTickRunning()).toBe(false);
      const paused = vi.mocked(logger.info).mock.calls.map((x) => String(x[0])).filter((l) => /paused/.test(l));
      expect(paused).toEqual(['[jobs] spider-tick is paused (JOBS_PAUSED): this run was skipped']);
    });

    it('SPIDER_WATCH_LIST=check: it runs on its own clock, and a lead is alerted within a second of crossing its limit', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await company(0, { channels: QUIET });
      const crossesAt = Date.now() + 1_500;
      const lead = await addLead(db, c, new Date(crossesAt - 2 * HOUR));
      expect(await start()).toBe(true);
      expect(spiderTickRunning()).toBe(true);
      const alert = await waitForAlert(c.org, lead, 8_000);
      const late = alert.alerted_at.getTime() - crossesAt;
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(1_000);
    });

    it('a wake (a save in this process) runs the check at once, not at its next 5-second timer', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await company(0, { channels: QUIET });
      expect(await start()).toBe(true);
      // Let its first check pass and its sleep begin: nothing is due, so it sleeps the whole 5 s.
      await new Promise((r) => setTimeout(r, 1_000));
      const lead = await addLead(db, c, new Date(Date.now() - 3 * HOUR));
      const woken = Date.now();
      wakeSpiderTick();
      const alert = await waitForAlert(c.org, lead, 8_000);
      expect(alert.alerted_at.getTime() - woken).toBeLessThan(1_000);
    });

    it("a slow email never holds the check: another company's crossing is shown at once while the first one's email is still on its way", { timeout: 30_000 }, async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const slow = await spiderCompany(db, orgs, { leads: 0 });
      await db.spiderSettings.update({ where: { organization_id: slow.org }, data: { channels: { in_app: true, red_frame: true, email: true, text: false } } });
      const quick = await spiderCompany(db, orgs, { leads: 0 });
      await db.spiderSettings.update({ where: { organization_id: quick.org }, data: { channels: QUIET } });
      await only(slow.org, quick.org);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let emailStarted = false;
      resendSend.mockImplementation(async () => {
        emailStarted = true;
        await held;
        return { data: { id: 'msg_1' }, error: null };
      });
      const overdue = await addLead(db, slow, new Date(Date.now() - 3 * HOUR));
      const crossesAt = Date.now() + 2_000;
      const crossing = await addLead(db, quick, new Date(crossesAt - 2 * HOUR));
      const emailOf = async () =>
        ((await db.spiderAlert.findFirstOrThrow({ where: { organization_id: slow.org, lead_id: overdue } })).channels as { email?: { status?: string } } | null)?.email?.status;
      try {
        expect(await start()).toBe(true);
        await waitForAlert(slow.org, overdue, 8_000);
        await vi.waitFor(() => expect(emailStarted).toBe(true), { timeout: 5_000 });
        const alert = await waitForAlert(quick.org, crossing, 8_000);
        expect(alert.alerted_at.getTime()).toBeGreaterThanOrEqual(crossesAt);
        expect(alert.alerted_at.getTime() - crossesAt).toBeLessThan(1_000);
        // Its pop-ups are written right after its claim, while the first company's email is still on its way.
        await vi.waitFor(async () => expect(await openRows(quick.org, crossing)).toBe(3), { timeout: 2_000 });
        expect(await emailOf()).not.toBe('SENT');
      } finally {
        release();
      }
      // Once it answers, it is recorded.
      await vi.waitFor(async () => expect(await emailOf()).toBe('SENT'), { timeout: 5_000 });
    });

    it("a company's email held: its stays that cross meanwhile are claimed and shown at their crossing, their emails wait their turn behind it, and every email goes once", { timeout: 30_000 }, async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await company(0, { channels: EMAIL_ONLY });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      resendSend.mockImplementation(async () => {
        await held;
        return SENT_OK;
      });
      const now = Date.now();
      const l1 = await addLead(db, c, new Date(now - 3 * HOUR));
      const l2 = await addLead(db, c, new Date(now + 1_500 - 2 * HOUR));
      const l3 = await addLead(db, c, new Date(now + 3_000 - 2 * HOUR));
      try {
        expect(await start()).toBe(true);
        await waitForAlert(c.org, l1, 8_000);
        // Each later lead is claimed and shown within a second of its crossing, the first email still held.
        const late = await Promise.all([waitForAlert(c.org, l2, 8_000), waitForAlert(c.org, l3, 8_000)]);
        expect(late[0]!.alerted_at.getTime() - (now + 1_500)).toBeLessThan(1_000);
        expect(late[1]!.alerted_at.getTime() - (now + 3_000)).toBeLessThan(1_000);
        for (const lead of [l2, l3]) await vi.waitFor(async () => expect(await openRows(c.org, lead)).toBe(3), { timeout: 2_000, interval: 20 });
        // Their emails wait their turn on the company's chain: none is handed over while the first one is held.
        expect((await alertsOf(c.org)).map(emailState)).toEqual(['NO-RECORD', 'NO-RECORD', 'NO-RECORD']);
        expect(resendSend).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      await vi.waitFor(async () => expect((await alertsOf(c.org)).map(emailState)).toEqual(['SENT', 'SENT', 'SENT']), { timeout: 8_000 });
      // 3 people, one email each per alert: nothing twice.
      expect(resendSend).toHaveBeenCalledTimes(9);
    });

    it('60 people with email and text on and every request taking 300 ms: every pop-up lands within a second of its crossing, about one check of alerts waits for its sends, and every email and text goes once', { timeout: 120_000 }, async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await spiderCompany(db, orgs, { leads: 0, admins: 60, dispatchers: 0 });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: ALL } });
      await only(c.org);
      const requests: string[] = [];
      batchHook.fn = async (payload, options) => {
        requests.push(options?.idempotencyKey ?? '');
        await sleep(300);
        return { data: { data: payload.map((_, i) => ({ id: `m${i}` })), errors: [] }, error: null };
      };
      vi.mocked(ctm.sendSms).mockImplementation(async () => {
        await sleep(300);
        return { id: 'sms_1' };
      });
      // Five leads cross together, a sixth a second later (each alert's 60 texts take 12 rounds of 300 ms, about 3.6 s).
      const now = Date.now();
      const together = now + 3_000;
      const sixth = now + 4_000;
      const five: string[] = [];
      for (let i = 0; i < 5; i += 1) five.push(await addLead(db, c, new Date(together - 2 * HOUR)));
      const six = await addLead(db, c, new Date(sixth - 2 * HOUR));
      expect(await start()).toBe(true);
      const firstFive = await Promise.all(five.map((l) => waitForAlert(c.org, l, 15_000)));
      const last = await waitForAlert(c.org, six, 15_000);
      for (const a of firstFive) expect(a.alerted_at.getTime() - together).toBeLessThan(1_000);
      expect(last.alerted_at.getTime() - sixth).toBeLessThan(1_000);
      // The sixth's 60 pop-ups are written while the first five alerts' texts are still going out.
      await vi.waitFor(async () => expect(await openRows(c.org, six)).toBe(60), { timeout: 2_000, interval: 50 });
      expect(vi.mocked(ctm.sendSms).mock.calls.length).toBeLessThan(5 * 60);
      // Then every alert's email and texts go out, each once.
      await vi.waitFor(async () => expect((await alertsOf(c.org)).map(textState)).toEqual(Array(6).fill('SENT')), { timeout: 60_000, interval: 250 });
      expect((await alertsOf(c.org)).map(emailState)).toEqual(Array(6).fill('SENT'));
      expect(ctm.sendSms).toHaveBeenCalledTimes(6 * 60);
      expect(requests).toHaveLength(6);
      expect(new Set(requests).size).toBe(6);
      // What waited for its sends: the first check's five and the one crossing behind them, never more.
      expect(Math.max(...checkLines().map((l) => l.waiting as number))).toBe(6);
    });

    it('the email provider stalled: a crossing still gets its pop-up within a second, and the alerts behind drain at the time limit, each request sent once more under the same key and then recorded not delivered', { timeout: 60_000 }, async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const LIMIT = 1_000;
      _setSpiderEmailRequestLimit(LIMIT);
      const c = await company(0, { channels: EMAIL_ONLY });
      const requests: { key: string; at: number }[] = [];
      const answers: (() => void)[] = [];
      const refused = { data: null, error: { name: 'application_error', statusCode: 500 } };
      let ended = false;
      // No request ever answers until the case ends (then each is refused at once, so nothing is left waiting).
      batchHook.fn = (_payload, options) => {
        requests.push({ key: options?.idempotencyKey ?? '', at: Date.now() });
        if (ended) return Promise.resolve(refused);
        return new Promise((resolve) => answers.push(() => resolve(refused)));
      };
      const now = Date.now();
      const l1 = await addLead(db, c, new Date(now - 3 * HOUR));
      const l2 = await addLead(db, c, new Date(now + 1_500 - 2 * HOUR));
      const l3 = await addLead(db, c, new Date(now + 2_500 - 2 * HOUR));
      try {
        expect(await start()).toBe(true);
        const a1 = await waitForAlert(c.org, l1, 8_000);
        const [a2, a3] = await Promise.all([waitForAlert(c.org, l2, 8_000), waitForAlert(c.org, l3, 8_000)]);
        expect(a2.alerted_at.getTime() - (now + 1_500)).toBeLessThan(1_000);
        expect(a3.alerted_at.getTime() - (now + 2_500)).toBeLessThan(1_000);
        for (const lead of [l2, l3]) await vi.waitFor(async () => expect(await openRows(c.org, lead)).toBe(3), { timeout: 2_000, interval: 20 });
        // Each alert's request goes unanswered for the limit, is sent once more under the same key, and the next alert's
        // request follows: the backlog drains at 2 x the limit an alert.
        await vi.waitFor(async () => expect((await alertsOf(c.org)).map(emailState)).toEqual(['FAILED', 'FAILED', 'FAILED']), { timeout: 15_000, interval: 100 });
        expect(requests.map((r) => r.key)).toEqual([a1, a1, a2, a2, a3, a3].map((a) => `spider-alert:${a.id}:0`));
        for (const [i, r] of requests.slice(1).entries()) {
          expect(r.at - requests[i]!.at).toBeGreaterThanOrEqual(LIMIT - 50);
          expect(r.at - requests[i]!.at).toBeLessThan(LIMIT + 1_000);
        }
        // In History: not delivered, for each person, in the existing words.
        for (const a of await alertsOf(c.org)) {
          const email = (a.delivery as { email: { outcome: string; recipients: { outcome: string }[] } }).email;
          expect(email.outcome).toBe(EMAIL_OUTCOME.failed);
          expect(new Set(email.recipients.map((r) => r.outcome))).toEqual(new Set([EMAIL_OUTCOME.failed]));
        }
        await sleep(2 * LIMIT);
        expect(requests).toHaveLength(6);
      } finally {
        ended = true;
        for (const answer of answers) answer();
      }
    });

    it("each company's alerts carry the moment of their own claim, not the check's start", async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const first = await spiderCompany(db, orgs, { leads: 0 });
      const second = await spiderCompany(db, orgs, { leads: 0 });
      for (const c of [first, second]) await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
      await only(first.org, second.org);
      const leads = [await addLead(db, first, new Date(Date.now() - 3 * HOUR)), await addLead(db, second, new Date(Date.now() - 3 * HOUR))];
      // The first company's new cards take 300 ms to hand to the live line: inside the check, before the next claim.
      let held = false;
      live.onDeliver = (_orgId, type) => {
        if (type !== 'spider.alert.added' || held) return;
        held = true;
        const until = Date.now() + 300;
        while (Date.now() < until) {
          // The check is held here.
        }
      };
      expect(await start()).toBe(true);
      const alerts = await Promise.all([waitForAlert(first.org, leads[0]!, 8_000), waitForAlert(second.org, leads[1]!, 8_000)]);
      const [earlier, later] = alerts.map((a) => a.alerted_at.getTime()).sort((p, q) => p - q);
      expect(held).toBe(true);
      expect(later! - earlier!).toBeGreaterThanOrEqual(300);
    });

    async function waitForAlert(org: string, lead: string, ms: number) {
      const end = Date.now() + ms;
      for (;;) {
        const found = await db.spiderAlert.findFirst({ where: { organization_id: org, lead_id: lead } });
        if (found) return found;
        if (Date.now() > end) throw new Error('no alert in time');
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  });
});

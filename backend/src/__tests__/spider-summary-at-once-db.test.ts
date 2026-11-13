/* =============================================================================
   #3471: the starting summary starts at once, and the 2-minute sweep becomes a 10-minute safety net - on a real migrated
   database, through the app's own routes and the check (services/spider/tick.ts) exactly as the loop runs it.

   1. When a trigger is ready (summaryStart.ts): Activate with "Send" at once; a widening Save 30 s after the LAST one, never
      later than 2 minutes after the FIRST one still waiting (a table, and the real Save's own write simulated at 20 s steps).
   2. The journey: Activate (Send) -> the first check builds the summary: every recipient's bell exists, the emails and
      texts are handed over in the same check, the trigger is cleared. A lead crossing 10 s after Activate is alerted on its
      own at its crossing and is not in the summary. Pilot size (1,300 overdue leads x 20 recipients) is the local proxy for the
      staging line "every bell within 60 s".
   3. Saves: two widening Saves 20 s apart give ONE summary built ~30 s after the second; a Save that only narrows, or
      changes recipients or channels, starts none; a Save racing an "Include again" never overwrites its trigger (#3444 item 1).
   4. Failure: a summary that fails 3 times is abandoned with no 4th attempt and the per-lead alerts take over within the flood
      guard (100 per company in any 2 minutes); the check never retries on every pass (the run's own waits, 2 / 8 / 30 min).
   5. The sweep: 10 minutes ONLY while the check runs (SPIDER_WATCH_LIST=check, not paused), its lease follows the interval;
      it never acts on a trigger then, alerts only the stays after the trigger's moment, logs `safetyCaught`, and shares the
      flood guard with the check. With the check off it is today's 2-minute alerter and still acts on triggers.
   6. Carried: a release that keeps failing leaves a run no trigger will ever resume - the sweep closes it (#3264 L1); a newer
      trigger never makes an orphan summary while an old run cannot be closed (L2); the summary logs emailMs / textMs and saves
      the email outcome BEFORE the texts start (#3470).

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return {
    env: {
      ...testEnv,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL,
      EMAIL_FROM: 'no-reply@test.com',
      EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
      FRONTEND_URL: 'https://staging.app.test',
      RESEND_API_KEY: 're_test_key',
      SPIDER_PILOT_ORG_IDS: undefined,
    },
  };
});
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    batch = { send: async (...a: [never, never?]) => (await import('./spider-batch-test-helpers.js')).batchOverSingleSends(resendSend as never)(...(a as [never, never])) };
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { env } from '../config/env';
import { logger } from '../lib/logger';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { switchFixture, type Person } from './permission-switches-fixture';
import { MIN, T0, at, addLead, removeCompanies, spiderCompany, type SpiderCompany } from './support/spider-company';
import { clearLease } from './support/spider-summary-world';
import { claimSweepLease, summaryLeaseName } from '../services/spider/sweepLease';
import * as summaryModule from '../services/spider/summary';
import * as summaryRunsModule from '../services/spider/summaryRuns';
import { runStartingSummary } from '../services/spider/summary';
import { SWEEP_INTERVAL_MS, SWEEP_SAFETY_NET_INTERVAL_MS, runSpiderSweep, spiderSweepCron, spiderSweepIntervalMs } from '../services/spider/sweep';
import { _resetSpiderTick, runSpiderTick } from '../services/spider/tick';
import { SUMMARY_MAX_WAIT_MS, SUMMARY_QUIET_MS, summaryTriggerReady, summaryTriggerReadyAt } from '../services/spider/summaryStart';
import { triggerData } from '../controllers/spider.controller';
import { FLOOD_WINDOW_MS, SPIDER_ALERTS_PER_COMPANY_RUN } from '../services/spider/runCaps';

const suite = realClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';
const MY_SUMMARY = '/api/ai-farm/spider/summary';
const HOUR = 3_600_000;
const SEC = 1_000;

const originalMode = env.SPIDER_WATCH_LIST;
const originalPaused = env.JOBS_PAUSED;
const setEnv = (key: 'SPIDER_WATCH_LIST' | 'JOBS_PAUSED', value: string | undefined) => {
  if (value === undefined) delete env[key];
  else env[key] = value;
};

const QUIET = { in_app: true, red_frame: true, email: false, text: false };

/** A settings save: New watched at `minutes`, in-app alerts and the red frame to the Admins, Email and Text off. */
const settingsSave = (minutes: number, extra: Record<string, unknown> = {}) => ({
  status_limits: {
    NEW: { enabled: true, value: minutes, unit: 'MINUTE' },
    CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
    WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
  },
  channels: QUIET,
  recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
  ...extra,
});

describe('when a trigger is ready (summaryStart.ts)', () => {
  const t = (kind: string, sinceMsBeforeTrigger = 0) => ({
    triggerAt: new Date(T0),
    triggerSince: new Date(T0.getTime() - sinceMsBeforeTrigger),
    triggerKind: kind,
  });

  it('Activate (Send) is ready at once; a widening Save 30 s after the last Save, never later than 2 minutes after the first', () => {
    expect(SUMMARY_QUIET_MS).toBe(30 * SEC);
    expect(SUMMARY_MAX_WAIT_MS).toBe(2 * MIN);
    // [kind, how long before the last Save the first one was, how long after the last Save it is, ready?]
    const table: [string, number, number, boolean][] = [
      ['SWITCHED_ON', 0, 0, true],
      ['SWITCHED_ON', 90 * SEC, 0, true],
      ['SCOPE_WIDENED', 0, 29_999, false],
      ['SCOPE_WIDENED', 0, 30 * SEC, true],
      ['LIMIT_SHORTENED', 20 * SEC, 29 * SEC, false],
      ['LIMIT_SHORTENED', 20 * SEC, 30 * SEC, true],
      // Saves keep coming: 100 s after the first, the last was 10 s ago - not yet; 120 s after the first it is ready.
      ['STAGE_ADDED', 90 * SEC, 29 * SEC, false],
      ['STAGE_ADDED', 90 * SEC, 30 * SEC, true],
      ['SETTINGS_CHANGED', 110 * SEC, 9 * SEC, false],
      ['SETTINGS_CHANGED', 110 * SEC, 10 * SEC, true],
      ['SETTINGS_CHANGED', 3 * MIN, 0, true],
    ];
    for (const [kind, first, after, ready] of table) {
      expect(summaryTriggerReady(t(kind, first), new Date(T0.getTime() + after)), `${kind} first ${first} after ${after}`).toBe(ready);
    }
  });

  it('Saves every 20 s for 3 minutes (the real Save write, simulated): the summary starts no later than 2 minutes after the first Save', () => {
    let row = { summary_trigger_at: null as Date | null, summary_trigger_kind: null as string | null, summary_trigger_since: null as Date | null };
    const saveAt = (ms: number) => {
      row = { ...row, ...triggerData(row, 'LIMIT_SHORTENED', new Date(T0.getTime() + ms)) };
    };
    const readyAtMs = (checkEvery: number) => {
      for (let ms = 0; ms <= 400 * SEC; ms += checkEvery) {
        // A Save at every 20 s mark up to 180 s, made before the check of the same instant.
        if (ms <= 180 * SEC && ms % (20 * SEC) === 0) saveAt(ms);
        const trig = { triggerAt: row.summary_trigger_at!, triggerSince: row.summary_trigger_since, triggerKind: row.summary_trigger_kind };
        if (summaryTriggerReady(trig, new Date(T0.getTime() + ms))) return ms;
      }
      return null;
    };
    const ms = readyAtMs(5 * SEC);
    expect(ms).not.toBeNull();
    expect(ms!).toBeLessThanOrEqual(120 * SEC);
    // ...and not before the cap while Saves keep coming (each 20 s is under the 30 s of quiet).
    expect(ms!).toBe(120 * SEC);
    expect(summaryTriggerReadyAt({ triggerAt: new Date(T0.getTime() + 100 * SEC), triggerSince: T0, triggerKind: 'LIMIT_SHORTENED' })).toBe(T0.getTime() + 120 * SEC);
  });
});

suite('the starting summary starts at once; the sweep is a safety net (#3471, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    await import('../app.js');
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
    await _resetSpiderTick();
    setEnv('SPIDER_WATCH_LIST', originalMode);
    setEnv('JOBS_PAUSED', originalPaused);
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_claims ON spider_alerts');
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_release ON spider_alerts');
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_ready ON spider_summaries');
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_count ON spider_summaries');
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_run ON spider_summary_runs');
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await clearLease(db).catch(() => undefined);
    await removeCompanies(db, orgs);
    await fx.cleanup();
  }, 300_000);

  /** Spider switched off for every company but this one (a check and a sweep cover every switched-on company). */
  const only = (org: string) => db.spiderSettings.updateMany({ where: { organization_id: { not: org }, is_active: true }, data: { is_active: false } });

  /** A switched-on company Activated over its backlog (SWITCHED_ON trigger at at(-1 h)), `leads` leads past their 2-hour limit. */
  async function backlog(leads: number, opts: { channels?: object; admins?: number } = {}): Promise<SpiderCompany> {
    const c = await spiderCompany(db, orgs, { leads, trigger: true, admins: opts.admins, dispatchers: opts.admins ? 0 : undefined });
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: opts.channels ?? QUIET } });
    await only(c.org);
    return c;
  }

  const summaries = (org: string) => db.spiderSummary.findMany({ where: { organization_id: org }, orderBy: { created_at: 'asc' } });
  const kinds = async (org: string) => {
    const rows = await db.spiderAlert.findMany({ where: { organization_id: org }, select: { kind: true } });
    return { alerted: rows.filter((r) => r.kind === 'ALERTED').length, summarized: rows.filter((r) => r.kind === 'SUMMARIZED').length };
  };
  const triggerOf = async (org: string) =>
    (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org }, select: { summary_trigger_at: true, summary_trigger_kind: true, summary_trigger_since: true } }));
  const bells = (org: string) => db.notificationRecipient.count({ where: { organization_id: org, notification: { verb: 'spider.starting_summary' } } });

  /** The error lines logged while `run` goes on (the logger is silenced: failures here are the point). */
  async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; errors: string[]; infos: [string, unknown?][]; warns: string[] }> {
    const errors: string[] = [];
    const warns: string[] = [];
    const infos: [string, unknown?][] = [];
    vi.spyOn(logger, 'error').mockImplementation((m: unknown) => (errors.push(String(m)), logger));
    vi.spyOn(logger, 'warn').mockImplementation((m: unknown) => (warns.push(String(m)), logger));
    vi.spyOn(logger, 'info').mockImplementation((m: unknown, meta?: unknown) => (infos.push([String(m), meta]), logger));
    try {
      return { value: await run(), errors, warns, infos };
    } finally {
      vi.mocked(logger.error).mockRestore();
      vi.mocked(logger.warn).mockRestore();
      vi.mocked(logger.info).mockRestore();
    }
  }

  // ── 2. The journey ───────────────────────────────────────────────────────────────────────────────────────────────────

  describe('Activate (Send): the summary starts at the first check', () => {
    it('over HTTP: every bell exists after the first check, the trigger is cleared, and a lead that crosses 10 s after Activate is alerted on its own and is not in the summary', async () => {
      const { org, admin, customer } = await fx.newOrg();
      orgs.push(org);
      await db.organization.update({ where: { id: org }, data: { is_demo: true } });
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, settingsSave(120))).status).toBe(200);
      await only(org);
      const lead = async (createdAt: Date) => {
        const id = randomUUID();
        await db.lead.create({ data: { id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW', created_at: createdAt } });
        return id;
      };
      const old1 = await lead(new Date(Date.now() - 3 * HOUR));
      const old2 = await lead(new Date(Date.now() - 5 * HOUR));
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'send' })).status).toBe(200);
      const { summary_trigger_at: trigger, summary_trigger_kind: kind } = await triggerOf(org);
      expect(kind).toBe('SWITCHED_ON');
      // Crosses its 2-hour limit 10 s after the click.
      const later = await lead(new Date(trigger!.getTime() - 2 * HOUR + 10 * SEC));

      // The first check after Activate: no wait.
      const first = await runSpiderTick(new Date(trigger!.getTime() + 2 * SEC));
      expect(first).toMatchObject({ summaries: 1, summarized: 2, claimed: 0 });
      const [summary] = await summaries(org);
      expect(summary).toMatchObject({ status: 'READY', lead_count: 2 });
      expect(await bells(org)).toBe(1);
      expect((await triggerOf(org)).summary_trigger_at).toBeNull();
      const mine = await api.get(MY_SUMMARY);
      expect(mine.status).toBe(200);
      expect(mine.body.summary).toMatchObject({ total: 2 });

      // 10 s after the click it crosses: the next check (within 5 s of the crossing) alerts it on its own.
      const second = await runSpiderTick(new Date(trigger!.getTime() + 11 * SEC));
      expect(second).toMatchObject({ claimed: 1, summaries: 0 });
      const rows = await db.spiderAlert.findMany({ where: { organization_id: org }, select: { lead_id: true, kind: true } });
      expect(rows.filter((r) => r.kind === 'SUMMARIZED').map((r) => r.lead_id).sort()).toEqual([old1, old2].sort());
      expect(rows.filter((r) => r.kind === 'ALERTED').map((r) => r.lead_id)).toEqual([later]);
    });

    it('a lead that crosses during the BUILD (after the trigger, before the summary is done) is alerted on its own, never summarized', async () => {
      const c = await backlog(5);
      const late = await addLead(db, c, at(-2 * HOUR + 10 * SEC - 0)); // crosses at at(10 s): after the trigger (at(-1 h))
      // Held in the middle of the build: the summary waits at its claims while the check alerts the late stay.
      const real = summaryModule.runStartingSummary;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const spy = vi.spyOn(summaryModule, 'runStartingSummary').mockImplementation(async (a) => {
        await held;
        return real(a);
      });
      // The first check is before the late lead crosses (at 10 s): it starts the summary, which is held mid-build.
      const building = runSpiderTick(at(5 * SEC));
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      // The summary is still being built when the next check runs, and that check alerts the late stay at once.
      const during = await runSpiderTick(at(12 * SEC));
      expect(during).toMatchObject({ claimed: 1, summaries: 0 });
      release();
      expect(await building).toMatchObject({ summaries: 1, summarized: 5 });
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true, kind: true } });
      expect(rows.filter((r) => r.kind === 'ALERTED').map((r) => r.lead_id)).toEqual([late]);
      expect(rows.filter((r) => r.kind === 'SUMMARIZED')).toHaveLength(5);
    });

    it('the summary never takes a stay that crossed AFTER the trigger, even one the flood guard has not alerted yet: those stay for the per-lead alerts', async () => {
      const c = await backlog(2);
      // 150 more cross after the trigger (at(-1 h)): at(-30 min). The check may alert 100 of them in a window; the other 50 wait.
      const afterTrigger = await Promise.all(Array.from({ length: 150 }, (_, i) => addLead(db, c, at(-2 * HOUR - 30 * MIN - i * 1000))));
      expect(await runSpiderTick(at(2 * SEC))).toMatchObject({ summaries: 1, summarized: 2, claimed: SPIDER_ALERTS_PER_COMPANY_RUN });
      expect(await kinds(c.org)).toEqual({ alerted: 100, summarized: 2 });
      // Once the window passes the other 50 are alerted one by one - never summarized.
      expect((await runSpiderTick(at(2 * MIN + 3 * SEC))).claimed).toBe(50);
      expect(await kinds(c.org)).toEqual({ alerted: 150, summarized: 2 });
      expect(new Set((await db.spiderAlert.findMany({ where: { organization_id: c.org, kind: 'ALERTED' }, select: { lead_id: true } })).map((r) => r.lead_id))).toEqual(new Set(afterTrigger));
    });

    it('the summary leaves out an excluded lead, a stay skipped by Activate + Skip and a stay already claimed; it takes the rest', async () => {
      const c = await backlog(6);
      const created = async (id: string) => (await db.lead.findUniqueOrThrow({ where: { id }, select: { created_at: true } })).created_at;
      const [excluded, skipped, claimed, ...rest] = c.leads;
      const entered = await created(skipped!);
      await db.spiderSettings.update({
        where: { organization_id: c.org },
        data: { excluded_lead_ids: [excluded!], backlog_skipped_stays: [`${skipped}|NEW|${entered.getTime()}`] },
      });
      // `claimed` was alerted on its own in this switched-on period already.
      const enteredClaimed = await created(claimed!);
      await db.spiderAlert.create({
        data: {
          organization_id: c.org, lead_id: claimed!, status: 'NEW', entered_status_at: enteredClaimed, counted_from: c.switchedOnAt, limit_value: 2, limit_unit: 'HOUR',
          alerted_at: at(-HOUR), recipient_ids: [], kind: 'ALERTED', lead_number: 'L-1', customer_id: c.customer, customer_name: 'Pat', stage_name: 'New', elapsed_value: 1, elapsed_unit: 'HOUR',
        },
      });
      expect(await runSpiderTick(at(2 * SEC))).toMatchObject({ summaries: 1, summarized: 3 });
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org, kind: 'SUMMARIZED' }, select: { lead_id: true } });
      expect(rows.map((r) => r.lead_id).sort()).toEqual([...rest].sort());
    });

    it('a Save that lands during the build starts its own wait: the first summary clears nothing, and the Save\'s summary follows after its quiet time', async () => {
      const c = await backlog(2);
      const real = summaryModule.runStartingSummary;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(summaryModule, 'runStartingSummary').mockImplementation(async (a) => {
        await held;
        return real(a);
      });
      const building = runSpiderTick(at(2 * SEC));
      await vi.waitFor(() => expect(summaryModule.runStartingSummary).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      // A widening Save merges into the trigger being served (kind stays SWITCHED_ON, moment moves).
      const saved = at(5 * SEC);
      await db.spiderSettings.update({
        where: { organization_id: c.org },
        data: { summary_trigger_at: saved, summary_trigger_since: at(-HOUR), summary_trigger_kind: 'SWITCHED_ON' },
      });
      release();
      expect(await building).toMatchObject({ summaries: 1, summarized: 2 });
      // Not cleared: it is the Save's now, a widening Save from this moment (30 s of quiet, 2 minutes at most), not "switched on".
      const t = await triggerOf(c.org);
      expect(t.summary_trigger_at).toEqual(saved);
      expect(t.summary_trigger_kind).toBe('SETTINGS_CHANGED');
      expect(t.summary_trigger_since!.getTime()).toBeGreaterThan(at(-HOUR).getTime());
      vi.mocked(summaryModule.runStartingSummary).mockRestore();
      expect((await runSpiderTick(new Date(saved.getTime() + 10 * SEC))).summaries).toBe(0);
      expect((await runSpiderTick(new Date(saved.getTime() + 31 * SEC))).summaries).toBe(1);
      expect((await triggerOf(c.org)).summary_trigger_at).toBeNull();
    });

    it('pilot size, the local proxy for "every bell within 60 s": 1,300 overdue leads x 20 recipients, all channels on - the first check delivers the bells, the emails and the texts', async () => {
      const c = await backlog(1_300, { channels: { in_app: true, red_frame: true, email: true, text: true }, admins: 20 });
      const started = Date.now();
      const r = await runSpiderTick(at(2 * SEC));
      const elapsed = Date.now() - started;
      console.info(`[3471 pilot proxy] 1,300 leads x 20 recipients: bells + emails + texts handed over in ${elapsed} ms`);
      expect(r).toMatchObject({ summaries: 1, summarized: 1_300 });
      expect(await bells(c.org)).toBe(20);
      expect(resendSend).toHaveBeenCalledTimes(20);
      expect(vi.mocked(ctm.sendSms)).toHaveBeenCalledTimes(20);
      expect((await triggerOf(c.org)).summary_trigger_at).toBeNull();
      expect(elapsed).toBeLessThan(60_000);
    }, 240_000);
  });

  // ── 3. Saves ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('Saves while Active', () => {
    /** An Active company (Skip) with New at `minutes`, three leads 90, 150 and 200 minutes in New. */
    async function active(minutes: number) {
      const { org, admin, customer } = await fx.newOrg();
      orgs.push(org);
      await db.organization.update({ where: { id: org }, data: { is_demo: true } });
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, settingsSave(minutes))).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      await only(org);
      const ids: string[] = [];
      for (const m of [90, 150, 200]) {
        const id = randomUUID();
        await db.lead.create({ data: { id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW', created_at: new Date(Date.now() - m * MIN) } });
        ids.push(id);
      }
      await _resetSpiderTick();
      return { org, admin, api, ids };
    }
    /** Pretends the trigger was written `ms` earlier (the Saves' own 20 s apart): the real clock cannot wait that long. */
    const age = (org: string, ms: number) =>
      db.$executeRawUnsafe(
        `UPDATE spider_settings SET summary_trigger_at = summary_trigger_at - $2 * interval '1 millisecond',
                summary_trigger_since = summary_trigger_since - $2 * interval '1 millisecond' WHERE organization_id = $1::uuid`,
        org,
        ms,
      );

    it('two widening Saves 20 s apart give ONE summary, built about 30 s after the second Save, of everything past the limit then', async () => {
      const { org, api, ids } = await active(300);
      expect((await runSpiderTick()).claimed).toBe(0);
      // Save 1: New 300 -> 180 minutes (the 200-minute lead is past it). 20 s pass.
      expect((await api.put(SETTINGS, settingsSave(180))).status).toBe(200);
      await age(org, 20 * SEC);
      // Save 2: 180 -> 120 (the 150-minute lead too).
      expect((await api.put(SETTINGS, settingsSave(120))).status).toBe(200);
      const t = await triggerOf(org);
      expect(t.summary_trigger_kind).toBe('LIMIT_SHORTENED');
      const second = t.summary_trigger_at!.getTime();
      expect(second - t.summary_trigger_since!.getTime()).toBeGreaterThanOrEqual(20 * SEC);

      // Nothing at 5 s, 20 s, 29 s after the second Save; the summary at 31 s. The check's timer knows the moment too.
      for (const after of [5 * SEC, 20 * SEC, 29 * SEC]) {
        const r = await runSpiderTick(new Date(second + after));
        expect(r, `${after}`).toMatchObject({ summaries: 0, claimed: 0 });
        expect(r.nextDueAt).toBe(second + 30 * SEC);
      }
      expect(await summaries(org)).toHaveLength(0);
      expect(await runSpiderTick(new Date(second + 31 * SEC))).toMatchObject({ summaries: 1, summarized: 2, claimed: 0 });
      const all = await summaries(org);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ status: 'READY', lead_count: 2 });
      expect((await db.spiderAlert.findMany({ where: { organization_id: org, kind: 'SUMMARIZED' } })).map((a) => a.lead_id).sort()).toEqual([ids[1], ids[2]].sort());
      expect((await triggerOf(org)).summary_trigger_at).toBeNull();
    });

    it('Saves every 20 s for 3 minutes give a summary no later than 2 minutes after the first Save', async () => {
      const { org, api } = await active(400);
      // Six Saves, each shortening New by a minute and each "20 s later" than the one before (the stored trigger is aged by
      // 20 s before the next Save): the first was 100 s before the last.
      for (let i = 0; i < 6; i += 1) {
        if (i > 0) await age(org, 20 * SEC);
        expect((await api.put(SETTINGS, settingsSave(399 - i))).status).toBe(200);
      }
      const t = await triggerOf(org);
      const last = t.summary_trigger_at!.getTime();
      const since = t.summary_trigger_since!.getTime();
      expect(last - since).toBeGreaterThanOrEqual(100 * SEC);
      expect(last - since).toBeLessThan(105 * SEC);
      // 10 s after the last Save: 110 s after the first - quiet for 10 s only, cap not reached: nothing.
      expect(await runSpiderTick(new Date(last + 10 * SEC))).toMatchObject({ summaries: 0 });
      // The 2 minutes after the first Save are up (at since + 120 s) though the last Save was 20 s ago: the summary starts.
      const capAt = since + 2 * MIN;
      expect(capAt).toBeLessThan(last + 30 * SEC);
      expect((await runSpiderTick(new Date(capAt - 1))).summaries).toBe(0);
      expect((await runSpiderTick(new Date(capAt))).summaries).toBe(1);
    });

    it('a Save that only narrows, or changes recipients or channels, starts no summary and records no trigger', async () => {
      const { org, api } = await active(120);
      expect((await api.put(SETTINGS, settingsSave(240))).status).toBe(200); // lengthened: narrows
      expect((await api.put(SETTINGS, settingsSave(240, { channels: { in_app: true, red_frame: false, email: false, text: false } }))).status).toBe(200);
      expect((await api.put(SETTINGS, settingsSave(240, { recipients: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: true } }))).status).toBe(200);
      expect(await triggerOf(org)).toEqual({ summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null });
      const r = await runSpiderTick(new Date(Date.now() + 10 * MIN));
      expect(r.summaries).toBe(0);
      expect(await summaries(org)).toHaveLength(0);
    });

    it('a Save racing an Include again never overwrites its trigger: the two merge (#3444 item 1)', async () => {
      const { org, api } = await active(300);
      let saving!: Promise<{ status: number }>;
      await db.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM spider_settings WHERE organization_id = $1::uuid FOR UPDATE`, org);
          // The Save reads the settings (no trigger yet) and then waits at its write for this lock.
          saving = Promise.resolve(api.put(SETTINGS, settingsSave(120)));
          await vi.waitFor(
            async () => {
              const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
                `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE "public"."spider_settings"%'`,
              );
              expect(row!.n).toBeGreaterThan(0);
            },
            { timeout: 10_000, interval: 20 },
          );
          // The Include again (its own trigger) commits while the Save waits.
          await tx.$executeRawUnsafe(
            `UPDATE spider_settings SET summary_trigger_at = now() AT TIME ZONE 'UTC', summary_trigger_kind = 'SCOPE_WIDENED',
                    summary_trigger_since = (now() AT TIME ZONE 'UTC') - interval '30 seconds' WHERE organization_id = $1::uuid`,
            org,
          );
        },
        { timeout: 20_000 },
      );
      // The lock is released: the Save's write goes on, finds the trigger changed, and merges from the newer one.
      const res = await saving;
      expect(res.status).toBe(200);
      const t = await triggerOf(org);
      // Both changes are in the one trigger, and it keeps the moment the first of them started waiting.
      expect(t.summary_trigger_kind).toBe('SETTINGS_CHANGED');
      expect(Date.now() - t.summary_trigger_since!.getTime()).toBeGreaterThanOrEqual(30 * SEC - 2_000);
      expect(t.summary_trigger_at!.getTime()).toBeGreaterThan(t.summary_trigger_since!.getTime());
    }, 60_000);

    it('a Save and an Include again one after the other fold into one trigger (the picker locks the row; the Save checks the trigger it read)', async () => {
      const { org, api, ids } = await active(120);
      expect((await api.put(SETTINGS, settingsSave(100))).status).toBe(200);
      const afterSave = await triggerOf(org);
      expect(afterSave.summary_trigger_kind).toBe('LIMIT_SHORTENED');
      expect((await api.patch(EXCLUSIONS, { exclude: [ids[0]], include: [] })).status).toBe(200);
      expect((await api.patch(EXCLUSIONS, { exclude: [], include: [ids[0]] })).status).toBe(200);
      const t = await triggerOf(org);
      expect(t.summary_trigger_kind).toBe('SETTINGS_CHANGED');
      expect(t.summary_trigger_since).toEqual(afterSave.summary_trigger_since);
    });
  });

  // ── 4. Failure ───────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a summary that fails', () => {
    async function refuseClaims(org: string) {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sp3471_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER sp3471_refuse_claims BEFORE INSERT ON spider_alerts FOR EACH ROW WHEN (NEW.kind = 'SUMMARIZED' AND NEW.organization_id = '${org}'::uuid) EXECUTE FUNCTION sp3471_refuse()`,
      );
    }

    it('3 attempts, waits of 2 and 8 minutes, no 4th; then the per-lead alerts take over, 100 per company in any 2 minutes', async () => {
      const c = await backlog(150);
      await refuseClaims(c.org);
      const spy = vi.spyOn(summaryModule, 'runStartingSummary');
      const { value: results } = await quietly(async () => {
        const out: Record<string, Awaited<ReturnType<typeof runSpiderTick>>> = {};
        // Attempt 1; then passes inside the 2-minute wait never call the summary again.
        out.a1 = await runSpiderTick(at(0));
        for (let s = 5; s < 120; s += 5) out[`wait1-${s}`] = await runSpiderTick(at(s * SEC));
        out.a2 = await runSpiderTick(at(2 * MIN + SEC));
        for (let m = 3; m < 10; m += 1) out[`wait2-${m}`] = await runSpiderTick(at(m * MIN));
        out.a3 = await runSpiderTick(at(10 * MIN + 2 * SEC));
        return out;
      });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(results.a1!.summaries).toBe(1);
      expect(Object.entries(results).filter(([k]) => k.startsWith('wait')).every(([, r]) => r.summaries === 0)).toBe(true);
      // Nothing per lead meanwhile: the backlog crossed before the trigger and belongs to the summary.
      expect(Object.values(results).every((r) => r.claimed === 0)).toBe(true);
      const run = await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } });
      expect(run).toMatchObject({ status: 'ABANDONED', attempts: 3 });
      expect((await triggerOf(c.org)).summary_trigger_at).toBeNull();

      // The per-lead alerts take over, within the flood guard: 100 now, none in the same window, the rest after it.
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_claims ON spider_alerts');
      const t3 = at(10 * MIN + 3 * SEC);
      expect((await runSpiderTick(t3)).claimed).toBe(SPIDER_ALERTS_PER_COMPANY_RUN);
      expect((await runSpiderTick(new Date(t3.getTime() + 5 * SEC))).claimed).toBe(0);
      expect((await runSpiderTick(new Date(t3.getTime() + FLOOD_WINDOW_MS - 1))).claimed).toBe(0);
      expect((await runSpiderTick(new Date(t3.getTime() + FLOOD_WINDOW_MS + 1))).claimed).toBe(50);
      // No 4th attempt, ever: an hour later still one run, three attempts, one summary.
      await runSpiderTick(at(2 * HOUR));
      expect(spy).toHaveBeenCalledTimes(3);
      expect(await db.spiderSummaryRun.count({ where: { organization_id: c.org } })).toBe(1);
      expect(await summaries(c.org)).toHaveLength(1);
    }, 300_000);

    it('a failure before any run exists is held off the same way: 3 failures in this process, then the trigger is dropped and the leads alert one by one', async () => {
      const c = await backlog(3);
      // The stays cannot even be read: nothing was started, so no run counts the attempts.
      const read = vi.spyOn(realClient!.spiderSummary, 'findFirst').mockRejectedValue(new Error('the read failed'));
      const { value: seen } = await quietly(async () => {
        const out = [];
        for (const t of [at(0), at(SEC), at(2 * MIN + SEC), at(2 * MIN + 10 * SEC), at(10 * MIN + 5 * SEC)]) out.push(await runSpiderTick(t));
        return out;
      });
      read.mockRestore();
      expect(seen.map((r) => [r.summaries, r.claimed])).toEqual([[1, 0], [0, 0], [1, 0], [0, 0], [1, 0]]);
      expect((await triggerOf(c.org)).summary_trigger_at).toBeNull();
      // The trigger is gone: the next check alerts the 3 leads one by one.
      expect((await runSpiderTick(at(11 * MIN))).claimed).toBe(3);
    }, 120_000);
  });

  // ── 5. The sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('the sweep as the safety net', () => {
    it('runs every 10 minutes ONLY while the check runs (SPIDER_WATCH_LIST=check, not paused); else today\'s 2 minutes', () => {
      setEnv('SPIDER_WATCH_LIST', undefined);
      setEnv('JOBS_PAUSED', undefined);
      expect([spiderSweepIntervalMs(), spiderSweepCron()]).toEqual([SWEEP_INTERVAL_MS, '*/2 * * * *']);
      setEnv('SPIDER_WATCH_LIST', 'backfill');
      expect(spiderSweepIntervalMs()).toBe(SWEEP_INTERVAL_MS);
      setEnv('SPIDER_WATCH_LIST', 'check');
      expect([spiderSweepIntervalMs(), spiderSweepCron()]).toEqual([SWEEP_SAFETY_NET_INTERVAL_MS, '*/10 * * * *']);
      setEnv('JOBS_PAUSED', 'spider-tick');
      expect(spiderSweepIntervalMs()).toBe(SWEEP_INTERVAL_MS);
      setEnv('JOBS_PAUSED', 'all');
      expect(spiderSweepIntervalMs()).toBe(SWEEP_INTERVAL_MS);
      expect(SWEEP_SAFETY_NET_INTERVAL_MS).toBe(10 * MIN);
    });

    it('its lease follows the interval: one interval long, renewed four times in it', async () => {
      const held = async (intervalMs?: number) => {
        await clearLease(db);
        const lease = await claimSweepLease(intervalMs);
        const [row] = await db.$queryRawUnsafe<{ secs: number }[]>(`SELECT extract(epoch FROM (expires_at - claimed_at))::float8 AS secs FROM spider_sweep_leases WHERE name = 'spider.sweep'`);
        await lease!.release();
        return Math.round(row!.secs);
      };
      expect(await held()).toBe(120);
      expect(await held(SWEEP_SAFETY_NET_INTERVAL_MS)).toBe(600);
      // A company's summary has its own row, so the sweep's lease never blocks it and the other way round.
      const mine = await claimSweepLease(undefined, summaryLeaseName(randomUUID()));
      expect(mine).not.toBeNull();
      const sweep = await claimSweepLease();
      expect(sweep).not.toBeNull();
      await mine!.release();
      await sweep!.release();
    });

    it('with the check ON it never acts on a trigger: only the stays after the trigger are alerted, safetyCaught says how many and warns above 0', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await backlog(3);
      // Two leads cross after the trigger (at(-1 h)): at at(-30 min) and at at(-10 min) (a lead crosses 2 hours after its creation).
      const after = await Promise.all([addLead(db, c, at(-2 * HOUR - 30 * MIN)), addLead(db, c, at(-2 * HOUR - 10 * MIN))]);
      const { value: r, warns, infos } = await quietly(() => runSpiderSweep(at(0)));
      expect(r).toMatchObject({ ran: true, leadsSummarized: 0, alertsSent: 2, safetyCaught: 2 });
      expect(await summaries(c.org)).toHaveLength(0);
      expect((await db.spiderAlert.findMany({ where: { organization_id: c.org } })).map((a) => [a.lead_id, a.kind]).sort()).toEqual(after.map((id) => [id, 'ALERTED']).sort());
      // The trigger stays for the check.
      expect((await triggerOf(c.org)).summary_trigger_at).not.toBeNull();
      expect(warns.filter((w) => /safety sweep alerted leads the check should have/.test(w))).toHaveLength(1);
      expect(infos.filter(([m]) => /safety sweep ran/.test(m))).toHaveLength(0);
    });

    it('with the check ON and nothing missed it logs safetyCaught 0 (info), and ends nothing it should not', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await backlog(2);
      expect((await runSpiderTick(at(0))).summarized).toBe(2);
      const { value: r, warns, infos } = await quietly(() => runSpiderSweep(at(10 * MIN)));
      expect(r).toMatchObject({ ran: true, alertsSent: 0, leadsSummarized: 0, safetyCaught: 0 });
      expect(warns).toEqual([]);
      const line = infos.find(([m]) => /safety sweep ran/.test(m));
      expect(line?.[1]).toMatchObject({ safetyCaught: 0 });
      expect(await kinds(c.org)).toEqual({ alerted: 0, summarized: 2 });
    });

    it('with the check OFF it is today\'s alerter: it waits out a trigger\'s quiet time and then builds the summary itself', async () => {
      setEnv('SPIDER_WATCH_LIST', undefined);
      const c = await backlog(3);
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: at(0), summary_trigger_since: at(0), summary_trigger_kind: 'SETTINGS_CHANGED' } });
      expect(await runSpiderSweep(at(MIN))).toMatchObject({ leadsSummarized: 0, alertsSent: 0, safetyCaught: 0 });
      expect(await summaries(c.org)).toHaveLength(0);
      await clearLease(db);
      expect(await runSpiderSweep(at(2 * MIN + SEC))).toMatchObject({ leadsSummarized: 3, safetyCaught: 0 });
      expect(await summaries(c.org)).toHaveLength(1);
      expect((await triggerOf(c.org)).summary_trigger_at).toBeNull();
    });

    it('the flood guard counts the check and the sweep together: 100 per company in any 2 minutes across both', async () => {
      setEnv('SPIDER_WATCH_LIST', 'check');
      const c = await spiderCompany(db, orgs, { leads: 160 });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
      await only(c.org);
      // The check alerts the 100 allowed in this window...
      expect((await runSpiderTick(at(0))).claimed).toBe(100);
      // ...so the sweep, a moment later, may alert none of the other 60 (it used to take another 100: 200 in the window).
      expect(await runSpiderSweep(at(10 * SEC))).toMatchObject({ alertsSent: 0, safetyCaught: 0 });
      expect(await kinds(c.org)).toEqual({ alerted: 100, summarized: 0 });
      // The window passes: the sweep gets the 60 left (it is the net: it only takes what the check has not).
      await clearLease(db);
      expect(await runSpiderSweep(at(FLOOD_WINDOW_MS + 5 * SEC))).toMatchObject({ alertsSent: 60, safetyCaught: 60 });
      expect(await kinds(c.org)).toEqual({ alerted: 160, summarized: 0 });
    });

    it('the sweep alone (the check off) keeps its 100 per run', async () => {
      setEnv('SPIDER_WATCH_LIST', undefined);
      const c = await spiderCompany(db, orgs, { leads: 160 });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { channels: QUIET } });
      await only(c.org);
      expect(await runSpiderSweep(at(0))).toMatchObject({ alertsSent: 100 });
      await clearLease(db);
      expect(await runSpiderSweep(at(10 * SEC))).toMatchObject({ alertsSent: 60 });
    });
  });

  // ── 6. Carried ───────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('carried from #3264 and #3470', () => {
    const callAt = async (c: SpiderCompany, time: Date, trigger?: Date, withOverdue = false) => {
      const settings = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } });
      const lead = await db.lead.findUniqueOrThrow({ where: { id: c.leads[0]! }, select: { created_at: true } });
      return runStartingSummary({
        orgId: c.org,
        now: time,
        triggeredAt: trigger ?? settings.summary_trigger_at!,
        triggerKind: 'SWITCHED_ON',
        activatedAt: settings.activated_at!,
        overdue: withOverdue
          ? [{ id: c.leads[0]!, status: 'NEW', entered_at: lead.created_at, counted_from: lead.created_at, limit: { value: 2, unit: 'HOUR' } }]
          : [],
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipientsConfig: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false },
      });
    };

    it('L1: a release that fails 3 times in this process leaves a run no trigger resumes; the sweep closes it and frees its leads, restart or not', async () => {
      const c = await backlog(40);
      // A summary still being built, its 3 attempts used, 40 claims saved.
      expect((await runSpiderTick(at(0))).summarized).toBe(40);
      await db.spiderSummary.updateMany({ where: { organization_id: c.org }, data: { status: 'BUILDING', delivery: {} } });
      await db.spiderSummaryRun.updateMany({ where: { organization_id: c.org }, data: { status: 'RUNNING', finished_at: null, attempts: 3, next_attempt_at: at(30 * MIN) } });
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: at(-HOUR), summary_trigger_since: at(-HOUR), summary_trigger_kind: 'SWITCHED_ON' } });
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sp3471_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER sp3471_refuse_release BEFORE DELETE ON spider_alerts FOR EACH ROW EXECUTE FUNCTION sp3471_refuse()`);
      await quietly(async () => {
        expect((await callAt(c, at(31 * MIN))).state).toBe('retry');
        expect((await callAt(c, at(33 * MIN + 1))).state).toBe('retry');
        expect((await callAt(c, at(35 * MIN + 2))).state).toBe('abandoned');
      });
      // The process stopped trying and the trigger goes (the sweep/check clears it on 'abandoned'): the run stays RUNNING.
      await db.spiderSettings.update({ where: { organization_id: c.org }, data: { summary_trigger_at: null, summary_trigger_since: null, summary_trigger_kind: null } });
      expect(await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'RUNNING' });
      expect((await kinds(c.org)).summarized).toBe(40);
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_release ON spider_alerts');

      // Nothing waits for the run any more. A sweep (any process, no hold-off in memory) closes it and frees the claims.
      await clearLease(db);
      await quietly(() => runSpiderSweep(new Date(Date.now() + 11 * MIN)));
      expect(await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'ABANDONED' });
      expect(await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'SUPERSEDED' });
      // ...and the 40 leads, no longer held by claims, are alerted one by one by that same sweep.
      expect(await kinds(c.org)).toEqual({ alerted: 40, summarized: 0 });
    }, 120_000);

    it('L1: a run being written right now (touched in the last 10 minutes) is never reaped', async () => {
      const c = await backlog(4);
      expect((await runSpiderTick(at(0))).summarized).toBe(4);
      await db.spiderSummary.updateMany({ where: { organization_id: c.org }, data: { status: 'BUILDING', delivery: {} } });
      await db.spiderSummaryRun.updateMany({ where: { organization_id: c.org }, data: { status: 'RUNNING', finished_at: null } });
      await clearLease(db);
      await quietly(() => runSpiderSweep(new Date(Date.now() + 5 * MIN)));
      expect(await db.spiderSummaryRun.findFirstOrThrow({ where: { organization_id: c.org } })).toMatchObject({ status: 'RUNNING' });
      expect((await kinds(c.org)).summarized).toBe(4);
    });

    it('L2: while an old run cannot be closed, a newer trigger makes no summary at all (it used to make an orphan one per call)', async () => {
      const c = await backlog(3);
      expect((await runSpiderTick(at(0))).summarized).toBe(3);
      // The finished summary's run was left RUNNING with its delivery unfinished, and counting a try is refused.
      await db.spiderSummary.updateMany({ where: { organization_id: c.org }, data: { delivery: { state: 'SENDING' } } });
      await db.spiderSummaryRun.updateMany({ where: { organization_id: c.org }, data: { status: 'RUNNING', finished_at: null } });
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sp3471_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER sp3471_refuse_count BEFORE UPDATE ON spider_summaries FOR EACH ROW WHEN (NEW.delivery ? 'finish_attempts') EXECUTE FUNCTION sp3471_refuse()`,
      );
      const old = (await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org } })).triggered_at;
      await quietly(async () => {
        expect((await callAt(c, at(3 * MIN), old)).state).toBe('retry');
        expect((await callAt(c, at(5 * MIN + 1), old)).state).toBe('retry');
        expect((await callAt(c, at(7 * MIN + 2), old)).state).toBe('abandoned');
        // A newer trigger, five calls: no second summary may appear while the old run is still RUNNING.
        const newer = at(8 * MIN);
        for (let i = 0; i < 5; i += 1) expect((await callAt(c, at(9 * MIN + i * SEC), newer, true)).state).toBe('waiting');
      });
      expect(await summaries(c.org)).toHaveLength(1);
      expect(await db.spiderSummaryRun.count({ where: { organization_id: c.org } })).toBe(1);
    }, 120_000);

    it('L2: a summary whose run cannot be created is taken back, and the summary it replaced is given back', async () => {
      const c = await backlog(2);
      expect((await runSpiderTick(at(0))).summarized).toBe(2);
      const before = await summaries(c.org);
      expect(before).toHaveLength(1);
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sp3471_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER sp3471_refuse_run BEFORE INSERT ON spider_summary_runs FOR EACH ROW WHEN (NEW.organization_id = '${c.org}'::uuid) EXECUTE FUNCTION sp3471_refuse()`,
      );
      try {
        // A newer trigger with a stay to report: the run cannot be made, so the call fails...
        await expect(callAt(c, at(MIN), at(10 * MIN), true)).rejects.toThrow();
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp3471_refuse_run ON spider_summary_runs');
      }
      // ...and leaves nothing behind: no BUILDING summary, the READY one still READY (the one made for the call is SUPERSEDED).
      const after = await summaries(c.org);
      expect(after.filter((x) => x.status === 'BUILDING')).toEqual([]);
      expect(after.filter((x) => x.status === 'READY').map((x) => x.id)).toEqual(before.map((x) => x.id));
    });

    it('#3470 L1: the email outcome is saved BEFORE the texts start, so a stop can never leave text_started without email_done', async () => {
      const c = await backlog(3, { channels: { in_app: true, red_frame: true, email: true, text: true } });
      // Saving the email outcome takes a while: a text released meanwhile would be saved as started first.
      const real = summaryRunsModule.markChannelDone;
      vi.spyOn(summaryRunsModule, 'markChannelDone').mockImplementation(async (...args) => {
        if (args[1] === 'email') await sleep(500);
        return real(...args);
      });
      let violated = 0;
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          const [row] = await db.$queryRawUnsafe<{ bad: number }[]>(
            `SELECT count(*)::int AS bad FROM spider_summaries WHERE organization_id = $1::uuid AND delivery ? 'text_started' AND NOT (delivery ? 'email_done')`,
            c.org,
          );
          violated += row!.bad;
          await sleep(5);
        }
      })();
      const r = await runSpiderTick(at(0));
      watching = false;
      await watcher;
      expect(r.summarized).toBe(3);
      expect(violated).toBe(0);
      expect(vi.mocked(ctm.sendSms)).toHaveBeenCalled();
    }, 60_000);

    it('#3470: the summary logs how long its email and its texts took (emailMs, textMs)', async () => {
      const c = await backlog(2, { channels: { in_app: true, red_frame: true, email: true, text: true } });
      const { infos } = await quietly(() => runSpiderTick(at(0)));
      const line = infos.find(([m]) => /starting summary channels done/.test(m));
      expect(line?.[1]).toMatchObject({ orgId: c.org, recipients: 3 });
      const meta = line![1] as { emailMs: number; textMs: number };
      expect(Number.isFinite(meta.emailMs) && Number.isFinite(meta.textMs)).toBe(true);
      expect(JSON.stringify(line![1])).not.toMatch(/@|\+1617/);
    });
  });

  // keep `Person` imported for the helper types used above
  void (null as unknown as Person);
});

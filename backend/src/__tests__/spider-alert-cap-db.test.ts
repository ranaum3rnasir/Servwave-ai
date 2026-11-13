/* =============================================================================
   #2991: one Spider run alerts at most 100 leads per company, or stops after about 45 s for that company, and the
   rest wait for the next run. Nothing is lost and nothing is sent twice. A server that is stopping stops the same way.

   1. The alert cap: 250 newly overdue leads go out 100 per run, the leads overdue longest first, each lead exactly
      once across the runs, and a lead that becomes overdue later never overtakes one that is waiting. The run claims
      only the 100 it will send (counted at its first email). The company's log line says `stoppedBy: 'alert_cap'`.
   2. The time cap: with a clock the test moves (no real waiting), the run stops between two alerts once the
      company's 45 s are up, never halfway through one: every lead it started is emailed, texted and recorded in full;
      the claims it did not reach are released, and the next run sends exactly those. `stoppedBy: 'time_cap'`.
   3. The stop signal: a run told to stop after N of M alerts finishes the alert under way and its end step (unsent
      claims released, records, bell and usage written), the process's wait (whenSpiderSweepIdle) ends only after
      that, no new run starts meanwhile, and the next run sends exactly the M - N others. `stoppedBy: 'shutdown'`.
   4. The starting summary is never split: 1,300 overdue leads are one summary message per person, in the same run
      in which another company hits the per-lead cap, and with the company's time long past.
   5. The cap bounds the work: a 250-lead backlog costs exactly the queries of a 100-lead one, and the same writes
      as 3 leads.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    // Built with the query-event log, so the query counter can count it (support/query-counter.ts).
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined,
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

import { countQueries, writes } from './support/query-counter';
import { runSpiderSweep, whenSpiderSweepIdle, _spiderSweepInFlight } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import { SPIDER_ALERTS_PER_COMPANY_RUN, SPIDER_COMPANY_RUN_MS, _setSpiderRunClock } from '../services/spider/runCaps';
import { requestStop, stopRequested, _resetStopRequest } from '../lib/graceful-stop';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
/** Runs are 2 minutes apart, as the timer runs them. */
const run = (n: number) => at(n * 2 * MIN);

suite('Spider caps each run at 100 per-lead alerts or 45 s per company (#2991, real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let seq = 0;

  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);
  /** This file's companies leave the sweep: their Spider settings, alerts, summaries and records go. */
  async function retireCompanies() {
    if (!orgs.length) return;
    await db.notification.deleteMany({ where: { organization_id: { in: orgs }, verb: { startsWith: 'spider.' } } });
    await db.spiderAlert.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.spiderSummary.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.spiderSettings.deleteMany({ where: { organization_id: { in: orgs } } });
  }

  beforeEach(async () => {
    await retireCompanies();
    await clearLease();
    vi.clearAllMocks();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    _resetStopRequest();
    // Frozen unless a case moves it: the time cap never fires on a slow machine by accident.
    _setSpiderRunClock(() => 0);
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  afterEach(() => {
    _resetStopRequest();
    _setSpiderRunClock();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(retireCompanies());
    await quietly(clearLease());
    for (const org of orgs) {
      for (const table of ['notifications', 'leads', 'phone_numbers', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /**
   * A company that passes the Spider gate with `n` New leads past their 2-hour limit, and one Admin Spider tells (with
   * an email and a phone). Lead i entered New `i` minutes before lead i-1, so the higher the index the longer it has
   * been overdue. In-app and email are on; text only when asked.
   */
  async function company(n: number, opts: { trigger?: boolean; text?: boolean } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const short = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-cap-${short}`, email: `org-${short}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: 'SCALE', is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
        ctm_account_id: `acct-${short}`, ctm_sms_ready: true, sms_sending_enabled: true,
      },
    });
    await db.phoneNumber.create({
      data: { organization_id: org, e164: '+16175550000', sms_enabled: true, ctm_number_id: `TPN-${short}`, status: 'active', is_org_default: true },
    });
    const admin = { id: randomUUID(), email: `cap${++seq}-${tag}@example.test` };
    await db.user.create({
      data: {
        id: admin.id, organization_id: org, email: admin.email, first_name: 'Admin', last_name: 'Tester', role: 'ADMIN', is_admin: true,
        phone: `+1617557${String(1000 + seq).slice(-4)}`, is_active: true, has_login: true,
      },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${short}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const leads = await addLeads(org, customer, n, (i) => at(-DAY - i * MIN));
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: at(-60 * DAY),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: true, text: !!opts.text },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads: true, selected_lead_ids: [],
        summary_trigger_at: opts.trigger ? at(-HOUR) : null,
        summary_trigger_since: opts.trigger ? at(-HOUR) : null,
        summary_trigger_kind: opts.trigger ? 'SWITCHED_ON' : null,
      },
    });
    return { org, admin, customer, leads };
  }

  /** `n` New leads, created at createdAt(i), in one insert. Returns their ids in index order. */
  async function addLeads(org: string, customer: string, n: number, createdAt: (i: number) => Date): Promise<string[]> {
    const ids = Array.from({ length: n }, () => randomUUID());
    if (n > 0) {
      await db.lead.createMany({
        data: ids.map((id, i) => ({
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW' as const,
          created_at: createdAt(i),
        })),
      });
    }
    return ids;
  }

  /** The lead each email to this person was about (its link names the lead), in the order they went out. */
  const emailedLeads = (email: string) =>
    resendSend.mock.calls
      .map(([m]) => m as { to: string | string[]; text?: string })
      .filter((m) => [m.to].flat().includes(email))
      .map((m) => m.text?.match(/\/leads\/([0-9a-f-]{36})/)?.[1] ?? '?');

  /** The lead each text was about. */
  const textedLeads = (leads: string[]) =>
    vi.mocked(ctm.sendSms).mock.calls
      .map(([, m]) => (m as { msg: string }).msg.match(/\/leads\/([0-9a-f-]{36})/)?.[1])
      .filter((id): id is string => !!id && leads.includes(id));

  /** The company's log lines (#2986), one per run. */
  const companyLines = (org: string) =>
    (vi.mocked(logger.info).mock.calls as unknown as unknown[][])
      .filter((c) => c[0] === '[spider] company swept' && (c[1] as { orgId?: string })?.orgId === org)
      .map((c) => c[1] as Record<string, unknown>);

  const sweep = async (when: Date) => {
    await clearLease();
    clearPermissionCache();
    vi.mocked(logger.info).mockClear();
    return runSpiderSweep(when);
  };

  const countBy = (ids: string[]) => ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());

  // ─── 1. The alert cap ──────────────────────────────────────────────────────────────────────────

  it('250 newly overdue leads: 100 per run, longest overdue first, each exactly once, and later ones never overtake', async () => {
    expect(SPIDER_ALERTS_PER_COMPANY_RUN).toBe(100);
    const c = await company(250);
    // Highest index = overdue longest.
    const oldestFirst = [...c.leads].reverse();

    // How many claims the run holds when its first email goes out: only the 100 it will send.
    const claimsAtFirstSend: number[] = [];
    resendSend.mockImplementation(async (m: { to: string }) => {
      if ([m.to].flat().includes(c.admin.email) && claimsAtFirstSend.length === 0) {
        claimsAtFirstSend.push(await db.spiderAlert.count({ where: { organization_id: c.org } }));
      }
      return { data: { id: 'msg_1' }, error: null };
    });

    // Run 1: the 100 overdue longest, in that order.
    const r1 = await sweep(run(0));
    expect(r1.ran).toBe(true);
    expect(claimsAtFirstSend[0]).toBe(100);
    const sent1 = emailedLeads(c.admin.email);
    expect(sent1).toEqual(oldestFirst.slice(0, 100));
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(100);
    expect(companyLines(c.org)).toEqual([
      expect.objectContaining({ overdue: 250, alreadyClaimed: 0, claimed: 100, alertsSent: 100, stoppedBy: 'alert_cap' }),
    ]);

    // 50 leads become overdue between the runs: they wait behind the 150 already waiting.
    const late = await addLeads(c.org, c.customer, 50, (i) => at(2 * MIN - 2 * HOUR - 30_000 - i * 1000));

    // Run 2: the next 100 of the original backlog.
    await sweep(run(1));
    const sent2 = emailedLeads(c.admin.email).slice(100);
    expect(sent2).toEqual(oldestFirst.slice(100, 200));
    expect(companyLines(c.org)).toEqual([
      expect.objectContaining({ overdue: 300, alreadyClaimed: 100, claimed: 100, alertsSent: 100, stoppedBy: 'alert_cap' }),
    ]);

    // Run 3: the last 50 of the original backlog, then the 50 that came later (exactly 100: not capped).
    await sweep(run(2));
    const sent3 = emailedLeads(c.admin.email).slice(200);
    expect(sent3).toEqual([...oldestFirst.slice(200), ...[...late].reverse()]);
    const line3 = companyLines(c.org)[0]!;
    expect(line3).toMatchObject({ overdue: 300, alreadyClaimed: 200, claimed: 100, alertsSent: 100 });
    expect(line3).not.toHaveProperty('stoppedBy');

    // Run 4: nothing left.
    await sweep(run(3));
    expect(emailedLeads(c.admin.email)).toHaveLength(300);
    expect(companyLines(c.org)[0]).toMatchObject({ overdue: 300, alreadyClaimed: 300, claimed: 0, alertsSent: 0 });

    // Each lead alerted exactly once: one email, one alert-log row, one bell record.
    const all = [...c.leads, ...late];
    const perLead = countBy(emailedLeads(c.admin.email));
    expect(perLead.size).toBe(300);
    for (const id of all) expect(perLead.get(id), id).toBe(1);
    const rows = await db.spiderAlert.groupBy({ by: ['lead_id'], where: { organization_id: c.org }, _count: true });
    expect(rows).toHaveLength(300);
    for (const r of rows) expect(r._count).toBe(1);
    expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.alert' } })).toBe(300);
  });

  // ─── 2. The time cap ───────────────────────────────────────────────────────────────────────────

  describe('the time cap', () => {
    it('stops between two alerts once the company has used its 45 s; the next run sends exactly the rest', async () => {
      expect(SPIDER_COMPANY_RUN_MS).toBe(45_000);
      const c = await company(5, { text: true });
      // Each email takes 20 s on the test's clock: alerts start at 0, 20 and 40 s; at 60 s the company's time is up.
      let t = 0;
      _setSpiderRunClock(() => t);
      resendSend.mockImplementation(async () => {
        t += 20_000;
        return { data: { id: 'msg_1' }, error: null };
      });

      await sweep(run(0));
      const oldestFirst = [...c.leads].reverse();
      const sent = oldestFirst.slice(0, 3);
      expect(emailedLeads(c.admin.email)).toEqual(sent);
      // Never halfway: each alert that started was texted too, and recorded in full.
      expect(textedLeads(c.leads)).toEqual(sent);
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
      expect(rows.map((r) => r.lead_id).sort()).toEqual([...sent].sort());
      for (const r of rows) {
        expect(r.delivery).toMatchObject({ email: { outcome: 'Email sent' }, text: { outcome: 'Text message sent' }, in_app: { outcome: 'Shown in the app' } });
        expect(r.texts_sent).toBe(1);
      }
      expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.alert' } })).toBe(3);
      expect(companyLines(c.org)).toEqual([expect.objectContaining({ overdue: 5, claimed: 3, alertsSent: 3, stoppedBy: 'time_cap' })]);

      // The next run (a fresh 45 s) sends exactly the two it did not reach.
      t = 0;
      resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
      await sweep(run(1));
      expect(emailedLeads(c.admin.email)).toEqual(oldestFirst);
      expect(textedLeads(c.leads)).toEqual(oldestFirst);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(5);
      const line = companyLines(c.org)[0]!;
      expect(line).toMatchObject({ alreadyClaimed: 3, claimed: 2, alertsSent: 2 });
      expect(line).not.toHaveProperty('stoppedBy');
    });

    it('time running out in the middle of an alert never cuts it short: it is texted and recorded, then the run stops', async () => {
      const c = await company(4, { text: true });
      // The company's whole time and more passes during the first alert's email.
      let t = 0;
      _setSpiderRunClock(() => t);
      resendSend.mockImplementation(async () => {
        t += 10 * SPIDER_COMPANY_RUN_MS;
        return { data: { id: 'msg_1' }, error: null };
      });

      await sweep(run(0));
      const first = [...c.leads].reverse()[0]!;
      expect(emailedLeads(c.admin.email)).toEqual([first]);
      expect(textedLeads(c.leads)).toEqual([first]);
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.delivery).toMatchObject({ email: { outcome: 'Email sent' }, text: { outcome: 'Text message sent' } });
      expect(companyLines(c.org)).toEqual([expect.objectContaining({ claimed: 1, alertsSent: 1, stoppedBy: 'time_cap' })]);
    });
  });

  // ─── 3. The stop signal ────────────────────────────────────────────────────────────────────────

  it('a run told to stop after 2 of 5 alerts finishes that alert and its end step; the next run sends exactly the other 3', async () => {
    const c = await company(5, { text: true });
    const oldestFirst = [...c.leads].reverse();
    // The stop arrives while the 2nd alert's email is going out.
    let emails = 0;
    resendSend.mockImplementation(async () => {
      if (++emails === 2) requestStop();
      return { data: { id: 'msg_1' }, error: null };
    });

    await clearLease();
    vi.mocked(logger.info).mockClear();
    const running = runSpiderSweep(run(0));
    // What the stop handler waits on (index.ts): it settles only once the run, its end step included, is over.
    await whenSpiderSweepIdle();
    expect(_spiderSweepInFlight()).toBe(false);
    expect(stopRequested()).toBe(true);
    // The end step had run by then: the 2 sent alerts are recorded, their bell rows and texts counted, the other
    // 3 claims released.
    const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
    expect(rows.map((r) => r.lead_id).sort()).toEqual(oldestFirst.slice(0, 2).sort());
    for (const r of rows) {
      expect(r.delivery).toMatchObject({ email: { outcome: 'Email sent' }, text: { outcome: 'Text message sent' }, in_app: { outcome: 'Shown in the app' } });
      expect(r.texts_sent).toBe(1);
    }
    expect(await db.notification.count({ where: { organization_id: c.org, verb: 'spider.alert' } })).toBe(2);
    // The lease was given up as usual.
    expect(await db.$queryRawUnsafe(`SELECT name FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE)).toEqual([]);
    expect((await running).ran).toBe(true);
    expect(emailedLeads(c.admin.email)).toEqual(oldestFirst.slice(0, 2));
    expect(textedLeads(c.leads)).toEqual(oldestFirst.slice(0, 2));
    expect(companyLines(c.org)).toEqual([expect.objectContaining({ overdue: 5, claimed: 2, alertsSent: 2, stoppedBy: 'shutdown' })]);

    // While the server is stopping, no new run starts.
    expect((await sweep(run(1))).ran).toBe(false);
    expect(emailedLeads(c.admin.email)).toHaveLength(2);

    // The next server's first run sends exactly the 3 others, none twice.
    _resetStopRequest();
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await sweep(run(2));
    expect(emailedLeads(c.admin.email)).toEqual(oldestFirst);
    expect(textedLeads(c.leads)).toEqual(oldestFirst);
    const perLead = await db.spiderAlert.groupBy({ by: ['lead_id'], where: { organization_id: c.org }, _count: true });
    expect(perLead).toHaveLength(5);
    for (const r of perLead) expect(r._count).toBe(1);
    expect(companyLines(c.org)[0]).toMatchObject({ alreadyClaimed: 2, claimed: 3, alertsSent: 3 });
  });

  // ─── 4. The starting summary is never split ───────────────────────────────────────────────────

  it('1,300 overdue leads are one summary message per person, while another company hits the per-lead cap in the same run', async () => {
    const big = await company(1300, { trigger: true });
    const capped = await company(250);
    // Every clock reading is a minute later than the last: every company's time is long past at every check.
    let t = 0;
    _setSpiderRunClock(() => (t += MIN));

    await sweep(run(0));

    const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: big.org, status: 'READY' } });
    expect(summary).toMatchObject({ lead_count: 1300, recipient_count: 1 });
    const claims = await db.spiderAlert.findMany({ where: { organization_id: big.org }, select: { kind: true, summary_id: true } });
    expect(claims).toHaveLength(1300);
    expect(new Set(claims.map((x) => `${x.kind}|${x.summary_id}`))).toEqual(new Set([`SUMMARIZED|${summary.id}`]));
    const toBig = resendSend.mock.calls.map(([m]) => m as { to: string; subject: string }).filter((m) => [m.to].flat().includes(big.admin.email));
    expect(toBig).toHaveLength(1);
    expect(toBig[0]!.subject).toMatch(/1,?300 of your leads/);
    expect(await db.notification.count({ where: { organization_id: big.org, verb: { startsWith: 'spider.' } } })).toBe(1);
    expect(companyLines(big.org)).toEqual([expect.objectContaining({ overdue: 1300, claimed: 1300, alertsSent: 0 })]);
    expect(companyLines(big.org)[0]).not.toHaveProperty('stoppedBy');

    // The other company, per lead, in the same run: its time was up before its second alert.
    expect(emailedLeads(capped.admin.email)).toHaveLength(1);
    expect(companyLines(capped.org)).toEqual([expect.objectContaining({ overdue: 250, claimed: 1, alertsSent: 1, stoppedBy: 'time_cap' })]);

    // With the clock frozen, the same company hits the alert cap instead.
    _setSpiderRunClock(() => 0);
    await sweep(run(1));
    expect(emailedLeads(capped.admin.email)).toHaveLength(101);
    expect(companyLines(capped.org)).toEqual([expect.objectContaining({ overdue: 250, alreadyClaimed: 1, claimed: 100, alertsSent: 100, stoppedBy: 'alert_cap' })]);
    // The summarized company has nothing new to send.
    expect(resendSend.mock.calls.filter(([m]) => [(m as { to: string }).to].flat().includes(big.admin.email))).toHaveLength(1);
  });

  // A lead nobody can be told about never takes one of the 100 places (#2991's verifier probe P4, added in #2992).
  // Without that, a company whose 100 oldest overdue leads reach nobody would send no per-lead alert ever again: every
  // run would pick those same 100 and plan none of them.
  it('leads nobody can be told about never take places in the 100: the alertable newer leads still go out', async () => {
    // 150 old leads owned by nobody; the only Admin (the backstop) cannot sign in; Spider tells the lead's owner.
    const c = await company(150);
    await db.user.update({ where: { id: c.admin.id }, data: { is_active: false } });
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { recipients: { roles: [], user_ids: [], lead_owner: true } } });
    const sales = { id: randomUUID(), email: `cap-sales${++seq}-${tag}@example.test` };
    await db.user.create({
      data: {
        id: sales.id, organization_id: c.org, email: sales.email, first_name: 'Sal', last_name: 'Es', role: 'SALES', is_admin: false,
        phone: '+16175559999', is_active: true, has_login: true,
      },
    });
    // 50 newer overdue leads, each owned by an active salesperson who can open them.
    const owned = Array.from({ length: 50 }, () => randomUUID());
    await db.lead.createMany({
      data: owned.map((id, i) => ({
        id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW' as const,
        created_at: at(-DAY + HOUR - i * 1000), commission_owner_id: sales.id,
      })),
    });

    await sweep(run(0));

    expect([...emailedLeads(sales.email)].sort()).toEqual([...owned].sort());
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(50);
    expect(companyLines(c.org)).toEqual([expect.objectContaining({ overdue: 200, claimed: 50, alertsSent: 50 })]);
    expect(companyLines(c.org)[0]).not.toHaveProperty('stoppedBy');
  });

  // ─── 5. The cap bounds the work ───────────────────────────────────────────────────────────────

  it('a 250-lead backlog costs exactly the queries of a 100-lead one, and the same writes as 3 leads', async () => {
    /** One count: the other companies settle first (a sweep before the company exists), then the company's first sweep. */
    async function countFor(n: number) {
      await retireCompanies();
      await sweep(T0);
      const c = await company(n);
      await clearLease();
      clearPermissionCache();
      const { count, queries, result } = await countQueries(() => runSpiderSweep(T0));
      expect(result.ran).toBe(true);
      expect(emailedLeads(c.admin.email)).toHaveLength(Math.min(n, 100));
      return { total: count, writes: writes(queries).length };
    }
    const three = await countFor(3);
    const hundred = await countFor(100);
    const backlog = await countFor(250);
    console.info(`[2991 counts] 3 leads ${JSON.stringify(three)}; 100 leads ${JSON.stringify(hundred)}; 250 leads ${JSON.stringify(backlog)}`);
    expect(backlog.total).toBe(hundred.total);
    expect(backlog.writes).toBe(hundred.writes);
    expect(backlog.writes).toBe(three.writes);
  });
});

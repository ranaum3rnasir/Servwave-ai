/* =============================================================================
   #2990: Spider writes a run's alert-log claims, bell and red-frame records, texting-usage count and delivery records
   with one write of each kind, however many leads it alerts.

   1. A fixed number of writes. With the query counter (#2985), a sweep that alerts 3 overdue leads and one that alerts
      30 make exactly the same writes, for per-lead alerts and for the starting summary: one claim insert, one bell
      write (the event rows, then the recipient rows), one usage count and one delivery-record update. Every channel is
      on, so every kind of write happens. The count also lists, by statement kind and table, every query that still
      grows with the leads (reads only), for the build report.
   2. A failed write loses nothing. When the claims cannot be written, nothing is sent, the company's log line carries
      the failure, and the next run alerts every lead once. When the one delivery update fails, every record is still
      written, one by one, the failure is logged, and nothing is sent twice. When the bell write fails after the texts
      went out, the line carries the failure, every sent text is still counted, and nothing is sent again.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend, faults } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    // Built with the query-event log, so the query counter can count it (support/query-counter.ts).
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined,
    resendSend: vi.fn(),
    faults: { executeRaw: null as null | ((sql: string) => Error | null), calls: [] as string[] },
  };
});

// The real client, with raw statements that a test can make fail (support/prisma-faults.ts).
vi.mock('../lib/prisma', async () => ({ prisma: realClient && (await import('./support/prisma-faults.js')).withFaults(realClient, faults) }));
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
  },
}));
vi.mock('../lib/email', async () => vi.importActual('../lib/email'));

import { countQueries, writes, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import * as ctm from '../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The kinds of write a sweep makes, told apart by table and column. */
function classify(queries: CountedQuery[]) {
  const all = writes(queries);
  const alertLog = writes(queries, ['spider_alerts']);
  const usage = alertLog.filter((q) => /^\s*UPDATE/i.test(q.sql) && /texts_sent/.test(q.sql));
  const bell = writes(queries, ['notifications', 'notification_recipients']);
  return {
    all: all.length,
    claims: alertLog.filter((q) => /^\s*INSERT/i.test(q.sql)).length,
    deliveryRecords: alertLog.filter((q) => /^\s*UPDATE/i.test(q.sql) && !/texts_sent/.test(q.sql)).length,
    usage: usage.length,
    bell: bell.length,
  };
}

/** Each query as "<statement kind> <first table>", e.g. "SELECT users", "INSERT notifications", "BEGIN". */
function kindOf(sql: string): string {
  const s = sql.trim();
  const kind = (s.match(/^\w+/)?.[0] ?? '?').toUpperCase();
  const table = s.match(/(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"?(\w+)"?/i)?.[1];
  if (/set_config\(/i.test(s)) return 'SELECT set_config';
  return table ? `${kind} ${table}` : kind;
}

function byKind(queries: CountedQuery[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of queries) out[kindOf(q.sql)] = (out[kindOf(q.sql)] ?? 0) + 1;
  return out;
}

suite('Spider claims and delivery records in one bulk write each (#2990, real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let phoneSeq = 0;

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
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
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
   * A company that passes the Spider gate, may email and text, with `n` overdue New leads and three people Spider
   * tells (two Admins and a dispatcher, each with an email and a phone). Every channel is on.
   */
  async function company(n: number, opts: { trigger?: boolean } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const short = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-bulk-${short}`, email: `org-${short}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: 'SCALE', is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
        ctm_account_id: `acct-${short}`, ctm_sms_ready: true, sms_sending_enabled: true,
      },
    });
    await db.phoneNumber.create({
      data: { organization_id: org, e164: '+16175550000', sms_enabled: true, ctm_number_id: `TPN-${short}`, status: 'active', is_org_default: true },
    });
    const people: { id: string; email: string }[] = [];
    for (const role of ['ADMIN', 'ADMIN', 'DISPATCHER'] as Role[]) {
      const id = randomUUID();
      const email = `p${++phoneSeq}-${tag}@example.test`;
      await db.user.create({
        data: {
          id, organization_id: org, email, first_name: role.toLowerCase(), last_name: 'Tester', role, is_admin: role === 'ADMIN',
          phone: `+1617556${String(1000 + phoneSeq).slice(-4)}`, is_active: true, has_login: true,
        },
      });
      people.push({ id, email });
    }
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${short}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', phone: '+16175559999' },
    });
    const leads: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      await db.lead.create({
        data: { id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW', created_at: at(-DAY - i * HOUR) },
      });
      leads.push(id);
    }
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: at(-60 * DAY),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: true, text: true },
        recipients: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false },
        watch_all_leads: true, selected_lead_ids: [],
        summary_trigger_at: opts.trigger ? at(-HOUR) : null,
        summary_trigger_since: opts.trigger ? at(-HOUR) : null,
        summary_trigger_kind: opts.trigger ? 'SWITCHED_ON' : null,
      },
    });
    return { org, people, leads };
  }

  /** The company's one log line of a run (#2986). */
  const companyLine = (org: string) =>
    (vi.mocked(logger.info).mock.calls as unknown as unknown[][])
      .filter((c) => c[0] === '[spider] company swept' && (c[1] as { orgId?: string })?.orgId === org)
      .map((c) => c[1] as Record<string, unknown>);

  // ─── 1. A fixed number of writes ──────────────────────────────────────────────────────────────

  describe('the writes do not grow with the leads', () => {
    /** One count: the other companies settle first (a sweep before the company exists), then the company's first sweep. */
    async function countFor(n: number, mode: 'alerts' | 'summary') {
      await retireCompanies();
      await clearLease();
      await runSpiderSweep(T0);
      const c = await company(n, { trigger: mode === 'summary' });
      clearPermissionCache();
      _resetCtmSmsDoubleFireGuard();
      await clearLease();
      const { count, queries, result } = await countQueries(() => runSpiderSweep(T0));
      expect(result.ran).toBe(true);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(n);
      if (mode === 'alerts') expect(result.alertsSent).toBeGreaterThanOrEqual(n);
      else expect(result.leadsSummarized).toBeGreaterThanOrEqual(n);
      return { total: count, ...classify(queries), kinds: byKind(queries) };
    }

    /** Every kind of query, 3 leads against 30, and the kinds that differ. */
    function table(three: { kinds: Record<string, number> }, thirty: { kinds: Record<string, number> }) {
      const keys = [...new Set([...Object.keys(three.kinds), ...Object.keys(thirty.kinds)])].sort();
      const rows = keys.map((k) => ({ kind: k, three: three.kinds[k] ?? 0, thirty: thirty.kinds[k] ?? 0 }));
      return { rows, growing: rows.filter((r) => r.three !== r.thirty) };
    }

    it('per-lead alerts: the same writes for 3 overdue leads as for 30, one of each kind', async () => {
      const three = await countFor(3, 'alerts');
      const thirty = await countFor(30, 'alerts');
      const t = table(three, thirty);
      // The numbers, for the build report.
      console.info(`[2990 counts] alerts: 3 leads ${JSON.stringify({ ...three, kinds: undefined })}; 30 leads ${JSON.stringify({ ...thirty, kinds: undefined })}`);
      console.info(`[2990 kinds] alerts: ${JSON.stringify(t.rows)}`);
      expect([three.claims, thirty.claims]).toEqual([1, 1]);
      expect([three.deliveryRecords, thirty.deliveryRecords]).toEqual([1, 1]);
      expect([three.usage, thirty.usage]).toEqual([1, 1]);
      // The bell: the event rows, then the recipient rows.
      expect([three.bell, thirty.bell]).toEqual([2, 2]);
      expect(thirty.all).toBe(three.all);
      // What still grows is reads only.
      for (const r of t.growing) expect(r.kind, JSON.stringify(t.growing)).toMatch(/^SELECT /);
    });

    it('the starting summary: the same number of writes for 3 overdue leads as for 30', async () => {
      const three = await countFor(3, 'summary');
      const thirty = await countFor(30, 'summary');
      const t = table(three, thirty);
      console.info(`[2990 counts] summary: 3 leads ${JSON.stringify({ ...three, kinds: undefined })}; 30 leads ${JSON.stringify({ ...thirty, kinds: undefined })}`);
      console.info(`[2990 kinds] summary: ${JSON.stringify(t.rows)}`);
      expect([three.claims, thirty.claims]).toEqual([1, 1]);
      expect([three.deliveryRecords, thirty.deliveryRecords]).toEqual([1, 1]);
      expect([three.usage, thirty.usage]).toEqual([1, 1]);
      // Nothing else grows either: the summary's messages are per person, not per lead.
      expect(thirty.all).toBe(three.all);
    });
  });

  // ─── 2. A failed write loses nothing ──────────────────────────────────────────────────────────

  describe('a failed bulk write', () => {
    it('claims: nothing is sent, the company line carries the failure, and the next run alerts each lead once', async () => {
      const c = await company(3);
      const realBulk = db.spiderAlert.createManyAndReturn.bind(db.spiderAlert);
      const spy = vi.spyOn(db.spiderAlert, 'createManyAndReturn').mockImplementation(((args: { data: { organization_id: string }[] }) =>
        args.data.some((r) => r.organization_id === c.org) ? Promise.reject(new Error('disk full')) : realBulk(args as never)) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
      const mine = (calls: unknown[][]) => calls.filter(([m]) => c.people.some((p) => p.email === (m as { to: string }).to));
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
      expect(mine(resendSend.mock.calls)).toEqual([]);
      expect(await db.notification.count({ where: { organization_id: c.org, verb: { startsWith: 'spider.' } } })).toBe(0);
      const [line] = companyLine(c.org);
      expect(line).toMatchObject({ claimed: 0, alertsSent: 0, outcome: 'Error' });
      expect(vi.mocked(logger.error).mock.calls.map((x) => String(x[0])).join('\n')).toContain('nothing sent');

      vi.mocked(logger.info).mockClear();
      await clearLease();
      await runSpiderSweep(at(60_000));
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(3);
      expect(mine(resendSend.mock.calls)).toHaveLength(3 * 3);
      expect(companyLine(c.org)[0]).toMatchObject({ claimed: 3, alreadyClaimed: 0, alertsSent: 3 });
      expect(companyLine(c.org)[0]).not.toHaveProperty('outcome');
    });

    it('delivery records: every record is still written, one by one, the failure is logged, and nothing is sent twice', async () => {
      const c = await company(3);
      // The delivery-record write only (the usage count is its own write, #2990).
      const isDeliveryWrite = (sql: string) => /UPDATE spider_alerts/.test(sql) && /SET channels/.test(sql);
      faults.calls = [];
      faults.executeRaw = (sql) => (isDeliveryWrite(sql) ? new Error('connection reset') : null);
      try {
        await runSpiderSweep(T0);
      } finally {
        faults.executeRaw = null;
      }
      expect(faults.calls.filter(isDeliveryWrite)).toHaveLength(1);
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.delivery).toMatchObject({ email: { outcome: 'Email sent' }, text: { outcome: 'Text message sent' }, in_app: { outcome: 'Shown in the app' } });
        expect(r.channels).toMatchObject({ email: { status: 'SENT', sent: 3 }, sms: { status: 'SENT', sent: 3 }, in_app: { status: 'SENT' } });
        expect(r.texts_sent).toBe(3);
      }
      expect(vi.mocked(logger.error).mock.calls.map((x) => String(x[0])).join('\n')).toContain(`could not record 3 delivery records in one write for org ${c.org}`);
      expect(companyLine(c.org)[0]).toMatchObject({ claimed: 3, alertsSent: 3 });

      const sentBefore = resendSend.mock.calls.length;
      await clearLease();
      await runSpiderSweep(at(60_000));
      expect(resendSend.mock.calls.length).toBe(sentBefore);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(3);
    });

    it('bell records, after the texts went out: the line carries the failure, every sent text is counted, nothing is sent again', async () => {
      const c = await company(3);
      const realBell = db.notification.createMany.bind(db.notification);
      const spy = vi.spyOn(db.notification, 'createMany').mockImplementation(((args: { data: { organization_id: string }[] }) =>
        args.data.some((r) => r.organization_id === c.org) ? Promise.reject(new Error('disk full')) : realBell(args as never)) as never);
      try {
        await runSpiderSweep(T0);
      } finally {
        spy.mockRestore();
      }
      const myTexts = () => vi.mocked(ctm.sendSms).mock.calls.filter(([, m]) => (m as { msg: string }).msg.includes('/leads/') && c.leads.some((id) => (m as { msg: string }).msg.includes(id)));
      // The alerts went out on email and text before the end step failed.
      expect(myTexts()).toHaveLength(3 * 3);
      const rows = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
      expect(rows).toHaveLength(3);
      // Every text that went out is counted, though the step threw after: the count is written before the bell.
      for (const r of rows) expect(r.texts_sent).toBe(3);
      // The record says no one was shown it in the app (as an emit that failed always did), never that it was.
      for (const r of rows) expect(r.delivery).toMatchObject({ in_app: { outcome: 'No one to alert in the app' }, email: { outcome: 'Email sent' }, text: { outcome: 'Text message sent' } });
      expect(await db.notification.count({ where: { organization_id: c.org, verb: { startsWith: 'spider.' } } })).toBe(0);
      expect(companyLine(c.org)[0]).toMatchObject({ claimed: 3, alertsSent: 3, outcome: 'Error' });

      const textsBefore = myTexts().length;
      const emailsBefore = resendSend.mock.calls.length;
      await clearLease();
      await runSpiderSweep(at(60_000));
      expect(myTexts().length).toBe(textsBefore);
      expect(resendSend.mock.calls.length).toBe(emailsBefore);
      for (const r of await db.spiderAlert.findMany({ where: { organization_id: c.org } })) expect(r.texts_sent).toBe(3);
    });
  });
});

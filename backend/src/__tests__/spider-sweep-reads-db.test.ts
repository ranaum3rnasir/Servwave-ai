/* =============================================================================
   #2992: the Spider sweep's reads.

   1. Company-level data once per company run. A run's per-lead alerts read the company row, the outbound phone number,
      the email suppression list and the Spider switch once for the whole run, never once per alert, email or text (Ran,
      2026-11-04, "Next run": a change made while a run is sending takes effect from the next run). With the query
      counter (#2985, the counting rule: the other companies retired first, counts one after another), a sweep that
      alerts 3 overdue leads and one that alerts 30 run the same number of every kind of query. The starting summary:
      the same total for 3 as for 30.
   2. The same decisions as before: suppression (address trimmed and lower-cased, a row stored in another case does not
      match, another category does not count), the outbound number (the company default, else the oldest active
      texting number), for every alert of a run, not just the first.
   3. Pages of about 500. A company with 1,201 open leads, all created at the same instant (ties on every time), is
      read in pages: every lead is checked exactly once, the starting summary covers all 1,201 once, and no read of
      leads, alert-log rows or Spider records asks for more than 500 rows or 500 ids. The step that ends finished
      alerts reads 1,201 unread records (2 people each, so recipient rows tie on their record) in pages, ends exactly
      the ones whose lead moved on, and never reads a record's whole `data` JSON.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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

import { countQueries, reads, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import { _setSpiderRunClock } from '../services/spider/runCaps';
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

const PAGE = 500;
const PAGED_TABLES = ['leads', 'spider_alerts', 'notification_recipients', 'notifications'];

/**
 * Why a read is not bounded to a page, or null when it is: a SELECT on a paged table must carry a LIMIT of at most a
 * page, or ask for at most a page of ids in each IN list, or (a lookup by keys, e.g. the bell's dedup read: OR of
 * (company, key) pairs) carry at most two parameters per row of a page. (A unique-key lookup carries LIMIT 1.)
 */
function unboundedBecause(q: CountedQuery): string | null {
  let params: unknown[] = [];
  try {
    params = JSON.parse(q.params) as unknown[];
  } catch {
    params = [];
  }
  const limit = q.sql.match(/\bLIMIT\s+(\$(\d+)|(\d+))/i);
  if (limit) {
    const value = limit[2] ? Number(params[Number(limit[2]) - 1]) : Number(limit[3]);
    return value <= PAGE ? null : `LIMIT ${value}`;
  }
  const lists = [...q.sql.matchAll(/\bIN\s*\(([^)]*)\)/gi)].map((m) => (m[1]!.match(/\$\d+/g) ?? []).length);
  if (lists.length === 0) {
    const byKeys = /\)\s+OR\s+\(/i.test(q.sql);
    return byKeys && params.length <= 2 * PAGE ? null : `no LIMIT and no IN list${byKeys ? `, ${params.length} parameters` : ''}`;
  }
  const biggest = Math.max(...lists);
  return biggest <= PAGE ? null : `an IN list of ${biggest}`;
}

suite('Spider sweep reads (#2992, real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const suppressions: string[] = [];
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
    _setSpiderRunClock(() => 0);
    resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms_1' });
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    _setSpiderRunClock();
    await quietly(retireCompanies());
    await quietly(clearLease());
    await quietly(db.emailSuppression.deleteMany({ where: { address: { in: suppressions } } }));
    for (const org of orgs) {
      for (const table of ['notifications', 'leads', 'phone_numbers', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  interface Person { id: string; email: string; role: Role }

  /**
   * A company that passes the Spider gate and may email and text, with `n` overdue New leads (all created at the same
   * instant when `sameInstant`), the people given (default: two Admins and a dispatcher, each with an email and a phone)
   * and one texting number unless `numbers` says otherwise. Every channel is on.
   */
  async function company(n: number, opts: {
    trigger?: boolean;
    sameInstant?: boolean;
    emails?: string[];
    numbers?: { ctm: string; sms: boolean; isDefault: boolean; createdAt: Date; status?: string }[];
    limitHours?: number;
    /** Adds a salesperson (who opens only their own leads, so Spider asks the database which) owning these leads. */
    salesOwns?: (i: number) => boolean;
  } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const short = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-reads-${short}`, email: `org-${short}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan: 'SCALE', is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
        ctm_account_id: `acct-${short}`, ctm_sms_ready: true, sms_sending_enabled: true,
      },
    });
    const numbers = opts.numbers ?? [{ ctm: `TPN-${short}`, sms: true, isDefault: true, createdAt: at(-DAY) }];
    for (const [i, nb] of numbers.entries()) {
      await db.phoneNumber.create({
        data: {
          organization_id: org, e164: `+1617555${String(2000 + i)}`, sms_enabled: nb.sms, ctm_number_id: nb.ctm,
          status: nb.status ?? 'active', is_org_default: nb.isDefault, created_at: nb.createdAt,
        },
      });
    }
    const roles: Role[] = ['ADMIN', 'ADMIN', 'DISPATCHER'];
    const people: Person[] = [];
    for (const [i, role] of roles.entries()) {
      const id = randomUUID();
      const email = opts.emails?.[i] ?? `p${++seq}-${tag}@example.test`;
      await db.user.create({
        data: {
          id, organization_id: org, email, first_name: role.toLowerCase(), last_name: 'Tester', role, is_admin: role === 'ADMIN',
          phone: `+1617556${String(1000 + ++seq).slice(-4)}`, is_active: true, has_login: true,
        },
      });
      people.push({ id, email, role });
    }
    let sales: Person | null = null;
    if (opts.salesOwns) {
      sales = { id: randomUUID(), email: `s${++seq}-${tag}@example.test`, role: 'SALES' };
      await db.user.create({
        data: {
          id: sales.id, organization_id: org, email: sales.email, first_name: 'sales', last_name: 'Tester', role: 'SALES', is_admin: false,
          phone: `+1617556${String(1000 + ++seq).slice(-4)}`, is_active: true, has_login: true,
        },
      });
    }
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${short}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', phone: '+16175559999' },
    });
    const leads = Array.from({ length: n }, () => randomUUID());
    if (n > 0) {
      await db.lead.createMany({
        data: leads.map((id, i) => ({
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', status: 'NEW' as const,
          created_at: opts.sameInstant ? at(-DAY) : at(-DAY - i * MIN),
          ...(sales && opts.salesOwns?.(i) ? { commission_owner_id: sales.id } : {}),
        })),
      });
    }
    const off = { enabled: false, value: 1, unit: 'DAY' };
    await db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: at(-60 * DAY),
        status_limits: { NEW: { enabled: true, value: opts.limitHours ?? 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: true, text: true },
        recipients: { roles: sales ? ['ADMIN', 'DISPATCHER', 'SALES'] : ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false },
        watch_all_leads: true, selected_lead_ids: [],
        summary_trigger_at: opts.trigger ? at(-HOUR) : null,
        summary_trigger_since: opts.trigger ? at(-HOUR) : null,
        summary_trigger_kind: opts.trigger ? 'SWITCHED_ON' : null,
      },
    });
    return { org, short, people, sales, customer, leads };
  }

  const sweep = async (when: Date) => {
    await clearLease();
    clearPermissionCache();
    _resetCtmSmsDoubleFireGuard();
    vi.mocked(logger.info).mockClear();
    return runSpiderSweep(when);
  };

  /** The company's log lines (#2986), one per run. */
  const companyLines = (org: string) =>
    (vi.mocked(logger.info).mock.calls as unknown as unknown[][])
      .filter((c) => c[0] === '[spider] company swept' && (c[1] as { orgId?: string })?.orgId === org)
      .map((c) => c[1] as Record<string, unknown>);

  // ─── 1. Company-level data once per company run ───────────────────────────────────────────────

  describe('the query count does not grow with the leads', () => {
    /** One count (the counting rule): the other companies retired and settled, then the company's first sweep alone. */
    async function countFor(n: number, mode: 'alerts' | 'summary') {
      await retireCompanies();
      await sweep(T0);
      const c = await company(n, { trigger: mode === 'summary' });
      await clearLease();
      clearPermissionCache();
      _resetCtmSmsDoubleFireGuard();
      const { count, queries, result } = await countQueries(() => runSpiderSweep(T0));
      expect(result.ran).toBe(true);
      expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(n);
      if (mode === 'alerts') {
        // Every lead went out on every channel to every person: the counted run did all the work.
        expect(result.alertsSent).toBe(n);
        expect(resendSend.mock.calls.filter(([m]) => c.people.some((p) => p.email === (m as { to: string }).to))).toHaveLength(3 * n);
      } else {
        expect(result.leadsSummarized).toBe(n);
      }
      resendSend.mockClear();
      return { total: count, kinds: byKind(queries) };
    }

    function table(three: { kinds: Record<string, number> }, thirty: { kinds: Record<string, number> }) {
      const keys = [...new Set([...Object.keys(three.kinds), ...Object.keys(thirty.kinds)])].sort();
      return keys.map((k) => ({ kind: k, three: three.kinds[k] ?? 0, thirty: thirty.kinds[k] ?? 0 }));
    }

    it('per-lead alerts: every kind of query the same for 3 leads as for 30', async () => {
      const three = await countFor(3, 'alerts');
      const thirty = await countFor(30, 'alerts');
      const rows = table(three, thirty);
      console.info(`[2992 counts] alerts: 3 leads ${three.total}; 30 leads ${thirty.total}`);
      console.info(`[2992 kinds] alerts: ${JSON.stringify(rows)}`);
      // The company row, the outbound number and the suppression list: once per company run.
      for (const kind of ['SELECT organizations', 'SELECT phone_numbers', 'SELECT email_suppressions']) {
        const row = rows.find((r) => r.kind === kind);
        expect(row, kind).toBeDefined();
        expect([kind, row!.thirty], JSON.stringify(rows)).toEqual([kind, row!.three]);
      }
      expect(rows.find((r) => r.kind === 'SELECT email_suppressions')!.three).toBe(1);
      // Every kind, the Spider switch check included, is the same: nothing is read once per alert.
      expect(rows.filter((r) => r.three !== r.thirty), JSON.stringify(rows)).toEqual([]);
      expect(thirty.total).toBe(three.total);
    });

    it('the starting summary: the same total for 3 overdue leads as for 30', async () => {
      const three = await countFor(3, 'summary');
      const thirty = await countFor(30, 'summary');
      const rows = table(three, thirty);
      console.info(`[2992 counts] summary: 3 leads ${three.total}; 30 leads ${thirty.total}`);
      console.info(`[2992 kinds] summary: ${JSON.stringify(rows)}`);
      expect(rows.filter((r) => r.three !== r.thirty)).toEqual([]);
      expect(thirty.total).toBe(three.total);
    });
  });

  // ─── 2. The same decisions as before ──────────────────────────────────────────────────────────

  describe('the same decisions, for every alert of a run', () => {
    it('suppression: the address trimmed and lower-cased; a row in another case or another category does not count', async () => {
      const upper = `  Sup.Upper-${tag}@Example.TEST `;
      const caseRow = `case-${tag}@example.test`;
      const otherCategory = `cat-${tag}@example.test`;
      const c = await company(3, { emails: [upper, caseRow, otherCategory] });
      const rows = [
        { address: `sup.upper-${tag}@example.test`, category: 'TRANSACTIONAL' },
        { address: `Case-${tag}@Example.test`, category: 'TRANSACTIONAL' },
        { address: otherCategory, category: 'MARKETING' },
      ];
      suppressions.push(...rows.map((r) => r.address));
      await db.emailSuppression.createMany({ data: rows.map((r) => ({ ...r, kind: 'HARD_BOUNCE' })) });

      await sweep(T0);

      // Every one of the 3 alerts: the first person suppressed, the other two emailed.
      const sentTo = resendSend.mock.calls.map(([m]) => (m as { to: string }).to);
      expect(sentTo.filter((to) => to === caseRow)).toHaveLength(3);
      expect(sentTo.filter((to) => to === otherCategory)).toHaveLength(3);
      expect(sentTo.filter((to) => to.toLowerCase().includes('sup.upper'))).toEqual([]);
      const alerts = await db.spiderAlert.findMany({ where: { organization_id: c.org } });
      expect(alerts).toHaveLength(3);
      for (const a of alerts) {
        const email = (a.delivery as { email: { outcome: string; recipients: { user_id: string; outcome: string }[] } }).email;
        expect(email.outcome).toBe('Email sent (2 of 3)');
        expect(Object.fromEntries(email.recipients.map((r) => [r.user_id, r.outcome]))).toEqual({
          [c.people[0]!.id]: 'Email skipped: address is suppressed',
          [c.people[1]!.id]: 'Email sent',
          [c.people[2]!.id]: 'Email sent',
        });
      }
    });

    it('the outbound number: the company default when there is one, else the oldest active texting number', async () => {
      const withDefault = await company(3, {
        numbers: [
          { ctm: `TPN-old-${tag}`, sms: true, isDefault: false, createdAt: at(-30 * DAY) },
          { ctm: `TPN-default-${tag}`, sms: true, isDefault: true, createdAt: at(-DAY) },
        ],
      });
      const noDefault = await company(3, {
        numbers: [
          { ctm: `TPN-nosms-${tag}`, sms: false, isDefault: false, createdAt: at(-40 * DAY) },
          { ctm: `TPN-gone-${tag}`, sms: true, isDefault: false, createdAt: at(-35 * DAY), status: 'released' },
          { ctm: `TPN-oldest-${tag}`, sms: true, isDefault: false, createdAt: at(-30 * DAY) },
          { ctm: `TPN-newer-${tag}`, sms: true, isDefault: false, createdAt: at(-DAY) },
        ],
      });

      await sweep(T0);

      const fromFor = (accountShort: string) =>
        vi.mocked(ctm.sendSms).mock.calls.filter(([account]) => account === `acct-${accountShort}`).map(([, m]) => (m as { from: string }).from);
      // 3 alerts x 3 people each.
      expect(fromFor(withDefault.short)).toEqual(Array(9).fill(`TPN-default-${tag}`));
      expect(fromFor(noDefault.short)).toEqual(Array(9).fill(`TPN-oldest-${tag}`));
    });
  });

  // ─── 3. Pages of about 500 ────────────────────────────────────────────────────────────────────

  describe('pages of about 500', () => {
    const N = 1201;

    function expectBounded(queries: CountedQuery[]) {
      const paged = reads(queries, PAGED_TABLES);
      expect(paged.length).toBeGreaterThan(0);
      const offenders = paged.flatMap((q) => {
        const why = unboundedBecause(q);
        return why ? [`${why}: ${q.sql.slice(0, 200)}`] : [];
      });
      expect(offenders).toEqual([]);
    }

    it('1,201 open leads that tie on every time: each checked once, read in pages, the per-lead alerts as before', { timeout: 120_000 }, async () => {
      const c = await company(N, { sameInstant: true, salesOwns: (i) => i % 100 === 0 });
      await clearLease();
      const { queries } = await countQueries(() => runSpiderSweep(T0));
      const [line] = companyLines(c.org);
      expect(line).toMatchObject({ leadsChecked: N, overdue: N, alreadyClaimed: 0, claimed: 100, alertsSent: 100, stoppedBy: 'alert_cap' });
      // Tied overdue instants: the first 100 by lead id (#2991's order), none twice.
      const alerted = (await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true } })).map((a) => a.lead_id);
      expect(alerted.sort()).toEqual([...c.leads].sort().slice(0, 100));
      expectBounded(queries);
      // The open-lead read itself went in 3 pages (500, 500, 201).
      const leadPages = reads(queries, ['leads']).filter((q) => /"won_at" IS NULL/.test(q.sql) && /LIMIT/i.test(q.sql));
      expect(leadPages).toHaveLength(3);

      // The next runs reach every lead once: 12 more runs of 100 and the last 1.
      for (let r = 1; r <= 12; r += 1) await sweep(at(r * 2 * MIN));
      const all = await db.spiderAlert.groupBy({ by: ['lead_id'], where: { organization_id: c.org }, _count: true });
      expect(all).toHaveLength(N);
      for (const a of all) expect(a._count).toBe(1);
      expect(companyLines(c.org)[0]).toMatchObject({ leadsChecked: N, overdue: N, alreadyClaimed: N - 1, claimed: 1 });
    });

    it('the starting summary of 1,201 tied leads covers each of them exactly once, every read in pages', { timeout: 120_000 }, async () => {
      // A salesperson owns every 100th lead: who can open which lead is asked of the database, in chunks of leads.
      const owned = (i: number) => i % 100 === 0;
      const c = await company(N, { sameInstant: true, trigger: true, salesOwns: owned });
      await clearLease();
      const { queries } = await countQueries(() => runSpiderSweep(T0));
      const summary = await db.spiderSummary.findFirstOrThrow({ where: { organization_id: c.org, status: 'READY' } });
      expect(summary.lead_count).toBe(N);
      const claims = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true, summary_id: true, kind: true, recipient_ids: true } });
      expect(claims).toHaveLength(N);
      expect(new Set(claims.map((x) => x.lead_id)).size).toBe(N);
      expect(claims.every((x) => x.summary_id === summary.id && x.kind === 'SUMMARIZED')).toBe(true);
      // The salesperson is told about exactly their own 13 leads, wherever they fall in the chunks; everyone else about all.
      const ownedIds = new Set<string>(c.leads.filter((_, i) => owned(i)));
      expect(ownedIds.size).toBe(13);
      for (const x of claims) {
        expect([...x.recipient_ids].sort()).toEqual([...c.people.map((p) => p.id), ...(ownedIds.has(x.lead_id) ? [c.sales!.id] : [])].sort());
      }
      // One summary email per person.
      for (const p of c.people) expect(resendSend.mock.calls.filter(([m]) => (m as { to: string }).to === p.email)).toHaveLength(1);
      expect(companyLines(c.org)[0]).toMatchObject({ leadsChecked: N, overdue: N, claimed: N });
      expectBounded(queries);
    });

    it('ending finished alerts: 1,201 unread records for 2 people each, read in pages; exactly the moved-on ones end', { timeout: 120_000 }, async () => {
      // Every lead is past its 2-hour limit, as every alerted lead is (an alert for a lead not past its limit is not open,
      // #3450), and already alerted in this period (a claim each), so the run alerts nothing and only ends records.
      const c = await company(N, { sameInstant: true });
      const people = c.people.slice(0, 2);
      const enteredAt = at(-DAY).toISOString();
      await db.spiderAlert.createMany({
        data: c.leads.map((leadId) => ({
          organization_id: c.org, lead_id: leadId, status: 'NEW', entered_status_at: at(-DAY), counted_from: at(-DAY),
          limit_value: 2, limit_unit: 'HOUR', alerted_at: at(-DAY + 2 * HOUR), recipient_ids: people.map((p) => p.id), delivery: {},
        })),
      });
      const notifications = c.leads.map((leadId) => ({
        id: randomUUID(), organization_id: c.org, verb: 'spider.alert', category: 'LEAD' as const, priority: 'FEED' as const,
        needs_action: false, object_type: 'LEAD', object_id: leadId, object_label: 'L', title: 't', body: 'b',
        // A big payload the ending step must not read.
        data: { status: 'NEW', entered_status_at: enteredAt, lead_id: leadId, full_message: 'x'.repeat(2000) },
        dedup_key: `spider.alert:${randomUUID()}`,
      }));
      await db.notification.createMany({ data: notifications });
      await db.notificationRecipient.createMany({
        data: notifications.flatMap((n) => people.map((p) => ({ notification_id: n.id, organization_id: c.org, recipient_id: p.id, priority: 'FEED' as const }))),
      });
      // Every other lead moves on to Contacted; one more leaves by being won; one record's stored instant is not the
      // lead's (the same stage entered again later).
      const moved = c.leads.filter((_, i) => i % 2 === 0);
      await db.lead.updateMany({ where: { id: { in: moved } }, data: { status: 'CONTACTED', contacted_at: at(-HOUR) } });
      const won = c.leads[1]!;
      await db.lead.update({ where: { id: won }, data: { status: 'WON', won_at: at(-HOUR) } });
      const reentered = notifications[3]!;
      await db.notification.update({ where: { id: reentered.id }, data: { data: { ...reentered.data, entered_status_at: at(-2 * DAY).toISOString() } } });
      const ending = new Set([...moved, won, reentered.object_id]);

      await clearLease();
      const { queries, result } = await countQueries(() => runSpiderSweep(T0));

      expect(result.alertsEnded).toBe(ending.size * 2);
      const unread = await db.notificationRecipient.findMany({
        where: { organization_id: c.org, read_at: null },
        select: { notification: { select: { object_id: true } } },
      });
      const stillOpen = c.leads.filter((id) => !ending.has(id));
      expect(unread.map((u) => u.notification.object_id).sort()).toEqual([...stillOpen, ...stillOpen].sort());
      expectBounded(queries);
      // The ending step reads two fields of each record's data, never the whole JSON.
      const recordReads = reads(queries, ['notifications']);
      expect(recordReads.length).toBeGreaterThan(0);
      for (const q of recordReads) expect(q.sql, q.sql).not.toMatch(/"data"(?!\s*->)|\bdata\b(?!\s*->)/);
      // More than one page of records (1,201 records = 3 pages).
      expect(recordReads.filter((q) => /LIMIT/i.test(q.sql)).length).toBeGreaterThanOrEqual(3);
    });
  });
});

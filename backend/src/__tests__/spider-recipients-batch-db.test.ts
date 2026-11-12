/* =============================================================================
   #2989: Spider looks up who receives an alert ONCE per company per run, not once per lead.

   1. Same people. Worked examples, written out by hand, over roles, chosen users, the lead's owner, a lead whose owner
      changed, inactive people, people with no login, people who cannot open the lead (not attached, or View leads
      switched off), and people with no phone. For every case the batched rule, asked for all leads at once, and the
      per-lead rule as it was before #2989 (kept below, verbatim, as the oracle) both give exactly the expected list.
   2. Each company alone. Two companies in one sweep (per-lead alerts, and starting summaries): nobody of one company is
      ever told about the other's leads, even when the other's settings or a lead's owner name a person of the first.
   3. A fixed number of queries. With the query counter (#2985), the recipient and access queries of a sweep are the
      same for 3 overdue leads as for 30, for per-lead alerts and for the starting summary.
   4. The journey. An Admin switches Spider on and saves the recipients over the API; the sweep runs; each person's
      unread-alerts list over the API holds exactly the leads Spider's rule names them for.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Prisma, PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // Built with the query-event log, so the query counter can count it (support/query-counter.ts).
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { countQueries, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';
import { resolveSpiderRecipientsForLeads, type SpiderRecipient, type SpiderRecipientType } from '../services/spider/recipients';
import { filterRecipientsByAccess } from '../services/notifications/filterByAccess';
import type { SpiderRecipients } from '../services/spider/config';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearSwitchCacheForUser } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A clock in the future of every lead's creation, so a lead created a day before it is past a 2-hour New limit.
const T0 = new Date(Date.now() + 30 * DAY);
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';

// ─── The rule as it was before #2989, one lead at a time (the oracle) ─────────────────────────────

const OLD_SELECT = { id: true, first_name: true, last_name: true, email: true, phone: true, role: true } as const;
const OLD_CAN_SIGN_IN = { is_active: true, has_login: true } as const;

async function oldRule(
  db: PrismaClient,
  args: { orgId: string; leadId: string; ownerId: string | null; recipients: SpiderRecipients },
): Promise<SpiderRecipient[]> {
  const { orgId, leadId, ownerId, recipients } = args;
  const keep = async (users: SpiderRecipient[]) => {
    if (users.length === 0) return users;
    const kept = new Set(await filterRecipientsByAccess('LEAD', leadId, users.map((u) => u.id), orgId));
    return users.filter((u) => kept.has(u.id));
  };
  const anyOf: Prisma.UserWhereInput[] = [];
  if (recipients.roles.length > 0) anyOf.push({ role: { in: recipients.roles } });
  if (recipients.user_ids.length > 0) anyOf.push({ id: { in: recipients.user_ids } });
  if (recipients.lead_owner && ownerId) anyOf.push({ id: ownerId });
  if (anyOf.length > 0) {
    const users = await db.user.findMany({ where: { organization_id: orgId, ...OLD_CAN_SIGN_IN, OR: anyOf }, select: OLD_SELECT, orderBy: { id: 'asc' } });
    const chosenAs = (id: string): SpiderRecipientType =>
      recipients.lead_owner && ownerId === id ? 'owner' : recipients.user_ids.includes(id) ? 'user' : 'admin';
    const reached = await keep(users.map((u) => ({ ...u, chosen_as: chosenAs(u.id) })));
    if (reached.length > 0) return reached;
  }
  const admins = await db.user.findMany({ where: { organization_id: orgId, ...OLD_CAN_SIGN_IN, is_admin: true }, select: OLD_SELECT, orderBy: { id: 'asc' } });
  return keep(admins.map((u) => ({ ...u, chosen_as: 'admin' as const })));
}

// ─── Telling the recipient and access queries apart from the rest ─────────────────────────────────

const READ = /^\s*(SELECT|WITH)\b/i;

/**
 * The queries that decide who is told: reading the people (the recipient read, the access check's person rows and their
 * switches) and probing which leads they can open. Not the lead's own content (its owner's and first assignee's names,
 * read for the message), the claim, or the delivery. Only this company's: each one names the company or one of its people.
 */
function recipientAndAccessQueries(queries: CountedQuery[], company: { org: string; people: string[] }): CountedQuery[] {
  const namesCompany = (q: CountedQuery) => q.params.includes(company.org);
  const namesPerson = (q: CountedQuery) => company.people.some((id) => q.params.includes(id));
  return queries.filter((q) => {
    if (!READ.test(q.sql)) return false;
    // A person row read for who they are or what they may open (a name-only read, for a message, is neither).
    if (/"users"/.test(q.sql) && /"(has_login|custom_role_id|based_on_role_key)"/.test(q.sql)) return namesCompany(q) || namesPerson(q);
    // Switch values (a person's own, and their role's).
    if (/"(permission_user_switches|permission_role_switches|custom_roles)"/.test(q.sql)) return namesCompany(q) || namesPerson(q);
    // A lead probe: a lead read that asks about people (a lead's own content read names no person).
    if (/"(leads|lead_assignees|visits|visit_assignees)"/.test(q.sql)) return namesPerson(q);
    return false;
  });
}

suite('Spider recipients, looked up once per company per run (#2989, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];

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
    clearPermissionCache();
  });

  afterAll(async () => {
    await retireCompanies().catch(() => undefined);
    await clearLease().catch(() => undefined);
    await fx.cleanup();
  });

  /** A company that passes the Spider gate (Scale, demo). */
  async function spiderCompany() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    return o;
  }

  async function person(org: string, name: string, role: Role, opts: { phone?: string | null; active?: boolean; login?: boolean } = {}) {
    const p = await fx.addUser(org, name, role);
    await db.user.update({
      where: { id: p.id },
      data: { phone: opts.phone === undefined ? '+16175550100' : opts.phone, is_active: opts.active ?? true, has_login: opts.login ?? true },
    });
    return p;
  }

  async function overdueLead(org: string, customer: string, opts: Parameters<typeof fx.addLead>[2] = {}) {
    const { id } = await fx.addLead(org, customer, opts);
    // Created a day before now, so past its limit both at the sweep's clock (T0, 30 days ahead) and at the real clock the
    // unread-alerts read checks an open alert against (#3450).
    await db.lead.update({ where: { id }, data: { created_at: new Date(Date.now() - DAY), status: 'NEW' } });
    return id;
  }

  async function configure(org: string, recipients: Partial<SpiderRecipients>, opts: { trigger?: boolean } = {}) {
    const off = { enabled: false, value: 1, unit: 'DAY' };
    const data = {
      is_active: true,
      activated_at: new Date(T0.getTime() - 60 * DAY),
      status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
      channels: { in_app: true, red_frame: true, email: false, text: false },
      recipients: { roles: [], user_ids: [], lead_owner: false, ...recipients },
      watch_all_leads: true,
      selected_lead_ids: [],
      summary_trigger_at: opts.trigger ? new Date(T0.getTime() - HOUR) : null,
      summary_trigger_since: opts.trigger ? new Date(T0.getTime() - HOUR) : null,
      summary_trigger_kind: opts.trigger ? 'SWITCHED_ON' : null,
    };
    await db.spiderSettings.upsert({ where: { organization_id: org }, create: { organization_id: org, ...data }, update: data });
  }

  const sweep = () => runSpiderSweep(T0);
  const alertOf = async (leadId: string) => db.spiderAlert.findFirst({ where: { lead_id: leadId } });
  const toldInApp = async (leadId: string) =>
    (await db.notificationRecipient.findMany({
      where: { notification: { verb: 'spider.alert', object_id: leadId } },
      select: { recipient_id: true },
    })).map((r) => r.recipient_id).sort();

  // ─── 1. The same people ──────────────────────────────────────────────────────────────────────

  describe('the same people as the per-lead rule, from worked examples', () => {
    let org: string;
    let p: Record<string, Person>;
    let lead: Record<'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6', { id: string; ownerId: string | null }>;

    beforeAll(async () => {
      const o = await spiderCompany();
      org = o.org;
      await db.user.update({ where: { id: o.admin.id }, data: { phone: '+16175550101' } });
      p = {
        admin: o.admin,
        adminNoPhone: await person(org, 'adminb', 'ADMIN', { phone: null }),
        adminInactive: await person(org, 'adminoff', 'ADMIN', { active: false }),
        adminNoLogin: await person(org, 'adminnologin', 'ADMIN', { login: false }),
        sales1: await person(org, 'sales1', 'SALES'),
        sales2: await person(org, 'sales2', 'SALES'),
        sales3: await person(org, 'sales3', 'SALES', { phone: null }),
        salesBlind: await person(org, 'salesblind', 'SALES'),
        salesInactive: await person(org, 'salesgone', 'SALES', { active: false }),
        dispatcher: await person(org, 'disp', 'DISPATCHER'),
        tech: await person(org, 'tech', 'TECHNICIAN'),
        techInactive: await person(org, 'techoff', 'TECHNICIAN', { active: false }),
        techCrew: await person(org, 'techcrew', 'TECHNICIAN'),
      };
      // View leads switched off for this one person: they open no lead at all.
      await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: p.salesBlind.id, switch_key: 'view_leads', value: false } });
      clearSwitchCacheForUser(p.salesBlind.id);

      const L1 = await overdueLead(org, o.customer, { owner: p.sales1.id });
      // L2's owner changed from sales2 to sales3: only the owner now counts, and sales2 no longer opens it.
      const L2 = await overdueLead(org, o.customer, { owner: p.sales2.id });
      await db.lead.update({ where: { id: L2 }, data: { commission_owner_id: p.sales3.id } });
      const L3 = await overdueLead(org, o.customer, { assignees: [p.tech.id, p.techInactive.id] });
      const L4 = await overdueLead(org, o.customer, { owner: p.salesBlind.id });
      const L5 = await overdueLead(org, o.customer, { owner: p.salesInactive.id });
      // Attached through its dispatcher and its walkthrough crew.
      const L6 = await overdueLead(org, o.customer, { dispatcher: p.sales2.id, walkthroughCrew: [p.techCrew.id] });
      const owners = await db.lead.findMany({ where: { id: { in: [L1, L2, L3, L4, L5, L6] } }, select: { id: true, commission_owner_id: true } });
      const ownerOf = (id: string) => owners.find((l) => l.id === id)!.commission_owner_id;
      lead = Object.fromEntries(
        Object.entries({ L1, L2, L3, L4, L5, L6 }).map(([k, id]) => [k, { id, ownerId: ownerOf(id) }]),
      ) as typeof lead;
    });

    type Expect = Record<'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6', [string, SpiderRecipientType][]>;
    const admins = (): [string, SpiderRecipientType][] => [['admin', 'admin'], ['adminNoPhone', 'admin']];
    const all = (x: [string, SpiderRecipientType][]): Expect => ({ L1: x, L2: x, L3: x, L4: x, L5: x, L6: x });

    // Each case: the settings, and for every lead the people told and how each was chosen. Worked out by hand from the rule.
    const CASES: { name: string; recipients: () => SpiderRecipients; expect: () => Expect }[] = [
      {
        name: 'nobody configured: the Admins who can sign in, on every lead (the inactive and the login-less Admin never)',
        recipients: () => ({ roles: [], user_ids: [], lead_owner: false }),
        expect: () => all(admins()),
      },
      {
        name: 'the lead owner only: each lead its own current owner; the Admins where the owner is missing, inactive or cannot open it',
        recipients: () => ({ roles: [], user_ids: [], lead_owner: true }),
        expect: () => ({
          L1: [['sales1', 'owner']], L2: [['sales3', 'owner']], L3: admins(), L4: admins(), L5: admins(), L6: admins(),
        }),
      },
      {
        name: 'a role: each person on it, for the leads they can open (a dispatcher-attached lead included)',
        recipients: () => ({ roles: ['SALES'], user_ids: [], lead_owner: false }),
        expect: () => ({
          L1: [['sales1', 'admin']], L2: [['sales3', 'admin']], L3: admins(), L4: admins(), L5: admins(), L6: [['sales2', 'admin']],
        }),
      },
      {
        name: 'chosen users: everyone chosen who is active and can open the lead; the inactive one never',
        recipients: () => ({ roles: [], user_ids: [p.dispatcher.id, p.tech.id, p.techInactive.id, p.sales2.id], lead_owner: false }),
        expect: () => ({
          L1: [['dispatcher', 'user']], L2: [['dispatcher', 'user']], L3: [['dispatcher', 'user'], ['tech', 'user']],
          L4: [['dispatcher', 'user']], L5: [['dispatcher', 'user']], L6: [['dispatcher', 'user'], ['sales2', 'user']],
        }),
      },
      {
        name: 'roles, a chosen user and the owner together, each once',
        recipients: () => ({ roles: ['ADMIN'], user_ids: [p.tech.id], lead_owner: true }),
        expect: () => ({
          L1: [...admins(), ['sales1', 'owner']], L2: [...admins(), ['sales3', 'owner']], L3: [...admins(), ['tech', 'user']],
          L4: admins(), L5: admins(), L6: admins(),
        }),
      },
      {
        name: 'a chosen user who is also an owner is told as the owner on their own lead, and nowhere they cannot open',
        recipients: () => ({ roles: [], user_ids: [p.sales1.id], lead_owner: true }),
        expect: () => ({
          L1: [['sales1', 'owner']], L2: [['sales3', 'owner']], L3: admins(), L4: admins(), L5: admins(), L6: admins(),
        }),
      },
      {
        name: 'a role whose people are attached through an assignment or a walkthrough crew',
        recipients: () => ({ roles: ['TECHNICIAN'], user_ids: [], lead_owner: false }),
        expect: () => ({
          L1: admins(), L2: admins(), L3: [['tech', 'admin']], L4: admins(), L5: admins(), L6: [['techCrew', 'admin']],
        }),
      },
      {
        name: 'a chosen user with View leads switched off is told nothing; the rest of the configured people still are',
        recipients: () => ({ roles: ['DISPATCHER'], user_ids: [p.salesBlind.id], lead_owner: false }),
        expect: () => all([['dispatcher', 'admin']]),
      },
    ];

    for (const c of CASES) {
      it(c.name, async () => {
        const recipients = c.recipients();
        const expected = c.expect();
        const keys = Object.keys(lead) as (keyof typeof lead)[];
        const shape = (list: SpiderRecipient[]) => list.map((r) => [r.id, r.chosen_as]);
        const want = (k: keyof typeof lead) =>
          expected[k].map(([name, as]) => [p[name].id, as]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        const batched = await resolveSpiderRecipientsForLeads(db, { orgId: org, leads: keys.map((k) => lead[k]), recipients });
        for (const k of keys) {
          const old = await oldRule(db, { orgId: org, leadId: lead[k].id, ownerId: lead[k].ownerId, recipients });
          // The worked example, the rule as it was, and the batched rule all agree, in the same order (by id).
          expect(shape(old), `${k}: the per-lead rule`).toEqual(want(k));
          expect(shape(batched.get(lead[k].id)!), `${k}: the batched rule`).toEqual(want(k));
          // And every field each channel reads (name, email, phone, role) is the same.
          expect(batched.get(lead[k].id), `${k}: the full records`).toEqual(old);
        }
      });
    }

    it('an empty list when nobody at all can be reached, and an entry for every lead asked about', async () => {
      const lonely = await spiderCompany();
      await db.user.update({ where: { id: lonely.admin.id }, data: { is_active: false } });
      const id = await overdueLead(lonely.org, lonely.customer);
      const recipients: SpiderRecipients = { roles: ['TECHNICIAN'], user_ids: [], lead_owner: true };
      const batched = await resolveSpiderRecipientsForLeads(db, { orgId: lonely.org, leads: [{ id, ownerId: null }], recipients });
      expect(batched.get(id)).toEqual([]);
      expect(await oldRule(db, { orgId: lonely.org, leadId: id, ownerId: null, recipients })).toEqual([]);
    });
  });

  // ─── 2. Each company alone ──────────────────────────────────────────────────────────────────

  describe('two companies in one sweep', () => {
    /** Two companies whose settings and data try to reach across: Q names P's dispatcher, and a Q lead names P's salesperson as owner. */
    async function twoCompanies(opts: { trigger?: boolean } = {}) {
      const P = await spiderCompany();
      const pSales = await person(P.org, 'psales', 'SALES');
      const pDisp = await person(P.org, 'pdisp', 'DISPATCHER');
      const Q = await spiderCompany();
      const qSales = await person(Q.org, 'qsales', 'SALES');
      const pLead = await overdueLead(P.org, P.customer, { owner: pSales.id });
      const qCrossOwned = await overdueLead(Q.org, Q.customer);
      // Bad data: a Q lead whose owner is a P person (the column has no company check of its own).
      await db.lead.update({ where: { id: qCrossOwned }, data: { commission_owner_id: pSales.id } });
      const qOwned = await overdueLead(Q.org, Q.customer, { owner: qSales.id });
      await configure(P.org, { roles: ['DISPATCHER'], lead_owner: true }, opts);
      await configure(Q.org, { user_ids: [pDisp.id, qSales.id], lead_owner: true }, opts);
      const peopleOf = async (org: string) => new Set((await db.user.findMany({ where: { organization_id: org }, select: { id: true } })).map((u) => u.id));
      return { P, Q, pSales, pDisp, qSales, pLead, qCrossOwned, qOwned, pPeople: await peopleOf(P.org), qPeople: await peopleOf(Q.org) };
    }

    it('per-lead alerts: each lead reaches its own company\'s people only', async () => {
      const t = await twoCompanies();

      const result = await sweep();
      expect(result.ran).toBe(true);

      expect((await alertOf(t.pLead))?.recipient_ids.slice().sort()).toEqual([t.pDisp.id, t.pSales.id].sort());
      // P's salesperson is not Q's: the owner named on Q's lead is nobody there, and Q's salesperson cannot open it, so Q's Admin.
      expect((await alertOf(t.qCrossOwned))?.recipient_ids).toEqual([t.Q.admin.id]);
      expect((await alertOf(t.qOwned))?.recipient_ids).toEqual([t.qSales.id]);
      expect(await toldInApp(t.pLead)).toEqual([t.pDisp.id, t.pSales.id].sort());
      expect(await toldInApp(t.qCrossOwned)).toEqual([t.Q.admin.id]);
      expect(await toldInApp(t.qOwned)).toEqual([t.qSales.id]);

      // Every alert row and every in-app record of either company names only that company's people.
      for (const [org, people] of [[t.P.org, t.pPeople], [t.Q.org, t.qPeople]] as const) {
        for (const a of await db.spiderAlert.findMany({ where: { organization_id: org } })) {
          for (const id of a.recipient_ids) expect(people.has(id), `alert ${a.id} names ${id}`).toBe(true);
        }
        const rows = await db.notificationRecipient.findMany({ where: { notification: { organization_id: org, verb: { startsWith: 'spider.' } } } });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.organization_id).toBe(org);
          expect(people.has(r.recipient_id), `record names ${r.recipient_id}`).toBe(true);
        }
      }
    });

    it('starting summaries: each company\'s summary reaches its own people, about its own leads', async () => {
      const t = await twoCompanies({ trigger: true });

      const result = await sweep();
      expect(result.leadsSummarized).toBeGreaterThanOrEqual(3);

      const summarized = async (leadId: string) => (await db.spiderAlert.findFirst({ where: { lead_id: leadId, kind: 'SUMMARIZED' } }))?.recipient_ids.slice().sort();
      expect(await summarized(t.pLead)).toEqual([t.pDisp.id, t.pSales.id].sort());
      expect(await summarized(t.qCrossOwned)).toEqual([t.Q.admin.id]);
      expect(await summarized(t.qOwned)).toEqual([t.qSales.id]);

      // The bell's summaries: one per person, each about their own company's summary.
      for (const [org, people, told] of [
        [t.P.org, t.pPeople, [t.pDisp.id, t.pSales.id]],
        [t.Q.org, t.qPeople, [t.Q.admin.id, t.qSales.id]],
      ] as const) {
        const rows = await db.notificationRecipient.findMany({
          where: { notification: { verb: 'spider.starting_summary', organization_id: org } },
          select: { recipient_id: true, organization_id: true },
        });
        expect(rows.map((r) => r.recipient_id).sort()).toEqual([...told].sort());
        for (const r of rows) {
          expect(r.organization_id).toBe(org);
          expect(people.has(r.recipient_id)).toBe(true);
        }
      }
    });
  });

  // ─── 3. A fixed number of queries ─────────────────────────────────────────────────────────────

  describe('the recipient and access queries do not grow with the leads', () => {
    /**
     * A company with `n` overdue leads, each with its own owner (n salespeople), Admins, a dispatcher, and a technician
     * assigned to the first lead. Spider tells the Admins, the dispatchers, the technician and each lead's owner.
     */
    async function busyCompany(n: number, opts: { trigger?: boolean } = {}) {
      const o = await spiderCompany();
      const admin2 = await person(o.org, 'admin2', 'ADMIN');
      const disp = await person(o.org, 'disp', 'DISPATCHER');
      const tech = await person(o.org, 'tech', 'TECHNICIAN');
      const owners: Person[] = [];
      for (let i = 0; i < n; i += 1) owners.push(await person(o.org, `owner${i}`, 'SALES'));
      for (let i = 0; i < n; i += 1) await overdueLead(o.org, o.customer, { owner: owners[i]!.id, assignees: i === 0 ? [tech.id] : [] });
      await configure(o.org, { roles: ['ADMIN', 'DISPATCHER'], user_ids: [tech.id], lead_owner: true }, opts);
      return { org: o.org, people: [o.admin, admin2, disp, tech, ...owners].map((x) => x.id) };
    }

    /** One count: the other companies settle first (a sweep before the company exists), then the company's first sweep. */
    async function countFor(n: number, mode: 'alerts' | 'summary') {
      await retireCompanies();
      await clearLease();
      await sweep();
      const company = await busyCompany(n, { trigger: mode === 'summary' });
      clearPermissionCache();
      await clearLease();
      const { count, queries, result } = await countQueries(() => sweep());
      expect(result.ran).toBe(true);
      if (mode === 'alerts') expect(result.alertsSent).toBeGreaterThanOrEqual(n);
      else expect(result.leadsSummarized).toBeGreaterThanOrEqual(n);
      const told = await db.spiderAlert.count({ where: { organization_id: company.org } });
      expect(told).toBe(n);
      const picked = recipientAndAccessQueries(queries, company);
      return { total: count, recipientAndAccess: picked.length, picked, company };
    }

    for (const mode of ['alerts', 'summary'] as const) {
      it(`${mode === 'alerts' ? 'per-lead alerts' : 'the starting summary'}: the same number for 3 overdue leads as for 30`, async () => {
        const three = await countFor(3, mode);
        const thirty = await countFor(30, mode);
        // The numbers, for the build report.
        console.info(`[2989 counts] ${mode}: recipient+access 3 leads=${three.recipientAndAccess} 30 leads=${thirty.recipientAndAccess}; whole sweep 3 leads=${three.total} 30 leads=${thirty.total}`);
        if (process.env.SPIDER_2989_DUMP) {
          for (const q of thirty.picked) console.info(`[2989 sql] ${q.sql.slice(0, 300)}`);
        }
        // The counter finds the lookup at all (a filter matching nothing would make 0 = 0).
        expect(three.recipientAndAccess).toBeGreaterThan(0);
        expect(thirty.recipientAndAccess).toBe(three.recipientAndAccess);
        // The recipient read (the people who can sign in) asks for this company only.
        const recipientReads = thirty.picked.filter((x) => /"has_login"/.test(x.sql));
        expect(recipientReads.length).toBeGreaterThan(0);
        for (const q of recipientReads) expect(q.params).toContain(thirty.company.org);
      });
    }
  });

  // ─── 4. The journey ─────────────────────────────────────────────────────────────────────────

  describe('the journey over the API', () => {
    it('an Admin switches Spider on and chooses the people; after the sweep each person lists exactly their leads', async () => {
      const o = await spiderCompany();
      const owner = await person(o.org, 'jowner', 'SALES');
      const otherSales = await person(o.org, 'jsales', 'SALES');
      const dispatcher = await person(o.org, 'jdisp', 'DISPATCHER');
      const tech = await person(o.org, 'jtech', 'TECHNICIAN');
      const admin = await fx.signedInAs(o.admin);
      const save = await admin.put(SETTINGS, {
        status_limits: {
          NEW: { enabled: true, value: 2, unit: 'HOUR' },
          CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
          WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
        },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['DISPATCHER'], user_ids: [tech.id], lead_owner: true },
      });
      expect(save.status).toBe(200);
      expect((await admin.put(STATUS, { isActive: true })).status).toBe(200);
      // The switch started a starting summary; this journey is the per-lead alert, so the trigger is not waiting.
      await db.spiderSettings.update({
        where: { organization_id: o.org },
        data: { summary_trigger_at: null, summary_trigger_since: null, summary_trigger_kind: null, activated_at: new Date(T0.getTime() - 60 * DAY) },
      });
      const owned = await overdueLead(o.org, o.customer, { owner: owner.id });
      const techs = await overdueLead(o.org, o.customer, { assignees: [tech.id] });
      const plain = await overdueLead(o.org, o.customer);

      const result = await sweep();
      expect(result.ran).toBe(true);

      const listed = async (who: Person) => {
        const res = await (await fx.signedInAs(who)).get(UNREAD);
        expect(res.status).toBe(200);
        return (res.body.alerts as { lead_id: string }[]).map((a) => a.lead_id).sort();
      };
      expect(await listed(dispatcher)).toEqual([owned, techs, plain].sort());
      expect(await listed(owner)).toEqual([owned]);
      expect(await listed(tech)).toEqual([techs]);
      // Not chosen, and not the owner of anything: nothing.
      expect(await listed(otherSales)).toEqual([]);
      // The Admin was not chosen and every lead reached someone chosen: nothing for the Admin either.
      expect(await listed(o.admin)).toEqual([]);
    });
  });
});

/* =============================================================================
   Roles & Permissions, PRD 9 (scenario pass 2): the home page's read has to be cheap on the hosted database.

   The hosted database sits behind a pooler that gives the service ONE connection (local and CI urls carry five, which
   hides it), so every query of a request runs after the one before and the cost of a dashboard read is its NUMBER of
   queries. Everything here runs on a client created with connection_limit=1 and counts the queries it sends.

   Seam: GET /api/dashboard, called as people on custom roles (never a built-in role name) holding exactly the switch
   values under test, and as a person on the stock Technician preset where the preset's own default is the point.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, sent } = vi.hoisted(() => {
  const sent: string[] = [];
  const dbUrl = process.env.TEST_DATABASE_URL;
  let client: unknown;
  if (dbUrl) {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '30');
    const made = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (made as unknown as { $on: (e: string, f: (q: { query: string }) => void) => void }).$on('query', (q) => sent.push(q.query));
    client = made;
  }
  return { realClient: client as PrismaClient | undefined, sent };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// A tile's loader can be made to fail from outside, the way a database error mid-read would.
const { failing } = vi.hoisted(() => ({ failing: { activity: false, unpaid: false } }));
vi.mock('../services/dashboard/activity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/dashboard/activity')>();
  return { ...real, recentActivity: (ctx: never) => (failing.activity ? Promise.reject(new Error('connection lost near customer 555-0100')) : real.recentActivity(ctx)) };
});
vi.mock('../services/dashboard/moneyTiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/dashboard/moneyTiles')>();
  return { ...real, unpaidBalance: (ctx: never) => (failing.unpaid ? Promise.reject(new Error('timed out')) : real.unpaidBalance(ctx)) };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues, presetValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { defaultLayoutOf, eligibleTiles, type SwitchValues } from '../lib/dashboard/tileCatalog';

const suite = realClient ? describe : describe.skip;

// A Sales-preset person's default home page on an empty company, measured when S09.18 gave it Estimates still to send.
const SALES_QUERIES = 17;

type Answer = {
  tiles: Array<{ id: string; category: string }>;
  categories: Array<{ id: string; label: string }>;
  data: Record<string, any>;
};

suite('GET /api/dashboard on a pool of one connection (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  // Loaded here, not at the top: the module reads the database client at load, and this file must skip cleanly without one.
  let ACTIVITY_LIMITS: typeof import('../services/dashboard/activity').ACTIVITY_LIMITS;
  beforeAll(async () => {
    await import('../app.js');
    ({ ACTIVITY_LIMITS } = await import('../services/dashboard/activity.js'));
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_dashboard_layouts WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM tasks WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visit_assignees WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visits WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    failing.activity = false;
    failing.unpaid = false;
  });

  let sequence = 0;
  const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
    SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
  );
  const ALL_SCOPES = { leads_scope: 'all', jobs_scope: 'all', estimates_scope: 'all', invoices_scope: 'all' };

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role made from blank, holding exactly these switch values. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person> {
    const key = `load-role-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, `p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** The answer, and how many queries the read sent (the person is signed in and warmed up first, so auth is not counted). */
  async function read(person: Person, query: string) {
    const client = await fx.signedInAs(person);
    await client.get('/api/dashboard?tiles=none');
    sent.length = 0;
    const res = await client.get(`/api/dashboard${query}`);
    return { res, answer: res.body as Answer, queries: [...sent] };
  }
  const saveLayout = async (person: Person, layout: Array<{ id: string; visible: boolean }>) => {
    const res = await (await fx.signedInAs(person)).put('/api/dashboard/layout', { layout });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  describe('computes only the tiles that are shown', () => {
    it('answers with data for the shown tiles only, while the picker still gets every eligible tile and category', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      await saveLayout(me, [
        { id: 'kpi.jobs_today', visible: true },
        { id: 'kpi.ar', visible: false },
      ]);
      const { res, answer, queries } = await read(me, '?shown=1');
      expect(res.status).toBe(200);
      expect(Object.keys(answer.data)).toEqual(['kpi.jobs_today']);
      // Eligible but hidden (kpi.ar) and eligible but never added (kpi.avg_ticket) are still offered by the picker.
      const eligible = eligibleTiles({ ...presetValues(null), ...ALL_OFF, view_jobs: true, view_invoices: true, ...ALL_SCOPES } as SwitchValues);
      expect(answer.tiles.map((t) => t.id)).toEqual(eligible.map((t) => t.id));
      expect(answer.tiles.map((t) => t.id)).toEqual(expect.arrayContaining(['kpi.ar', 'kpi.avg_ticket']));
      expect(answer.categories.length).toBeGreaterThan(0);
      // Nothing about invoices or payments was read to answer it.
      expect(queries.filter((q) => /"public"\."(invoices|payments)"/.test(q))).toEqual([]);
    });

    it('answers a person with no saved layout for their role\'s default tiles only', async () => {
      const { org } = await newOrg();
      const stock = await fx.addUser(org, 'stock', 'TECHNICIAN');
      const { answer } = await read(stock, '?shown=1');
      const eligible = new Set(eligibleTiles(presetValues('TECHNICIAN') as SwitchValues).map((t) => t.id));
      const expected = defaultLayoutOf('TECHNICIAN').map((e) => e.id).filter((id) => eligible.has(id));
      expect(expected.length).toBeGreaterThan(0);
      expect(Object.keys(answer.data).sort()).toEqual(expected.sort());
    });

    it('computes a tile asked for by id even when it is not on the page, and never one the person may not have', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { view_jobs: true, ...ALL_SCOPES });
      await saveLayout(me, [{ id: 'kpi.jobs_week', visible: true }]);
      const { answer } = await read(me, '?tiles=kpi.jobs_today,kpi.ar');
      expect(Object.keys(answer.data)).toEqual(['kpi.jobs_today']);
    });

    it('reads a Technician-preset person\'s default home page in a handful of queries', async () => {
      const { org } = await newOrg();
      const stock = await fx.addUser(org, 'stock', 'TECHNICIAN');
      const { res, queries } = await read(stock, '?shown=1');
      expect(res.status).toBe(200);
      // Measured at 7 (the layout, the lead counts, the close rate) until S09.16 gave that default Jobs this month, which is
      // one grouped read of the visits (see below): 8, and S09.17 gave it Completed jobs value, one aggregate of the jobs: 9, and S09.18 gave it Estimates still to send, one count of the draft estimates (the rows are read only when there is a draft): 10. A count, not a time, so it is steady in CI. Before the page computed
      // only its shown tiles it asked for every eligible tile: 16 tiles, about 45 queries.
      expect(queries.length).toBeLessThanOrEqual(10);
    });
  });

  describe('the Missing lead owner reads share one query (S09.11)', () => {
    /** The count of leads with no Owner and the lookup of the oldest one: the two reads the three uses share. */
    const noOwnerCounts = (queries: string[]) => queries.filter((q) => /SELECT COUNT/i.test(q) && /"public"\."leads"/.test(q) && /"commission_owner_id" IS NULL/.test(q));
    const noOwnerOldest = (queries: string[]) => queries.filter((q) => !/COUNT/i.test(q) && /FROM "public"\."leads"/.test(q) && /"commission_owner_id" IS NULL/.test(q));

    const LEADS = { view_leads: true, show_leads_page: true, leads_scope: 'all' };

    it('reads the count once and the oldest lead once for the tile, the Needs Attention item and the Open Leads line together', async () => {
      const { org, customer } = await newOrg();
      await fx.addLead(org, customer);
      await fx.addLead(org, customer);
      const me = await personWith(org, LEADS);
      const { res, answer, queries } = await read(me, '?tiles=kpi.open_leads,missing_lead_owner,needs_attention');
      expect(res.status).toBe(200);
      // The three uses agree, and each is the answer, not a stand-in for one.
      expect(answer.data['kpi.open_leads']).toEqual({ count: 2, no_owner: 2 });
      expect(answer.data.missing_lead_owner).toMatchObject({ count: 2, oldest: { id: expect.any(String) } });
      expect(answer.data.needs_attention.find((i: { type: string }) => i.type === 'missing_lead_owner')).toMatchObject({ title: '2 leads with no owner' });
      expect(noOwnerCounts(queries)).toHaveLength(1);
      expect(noOwnerOldest(queries)).toHaveLength(1);
    });

    it.each([
      ['the tile', 'missing_lead_owner'],
      ['the Needs Attention item', 'needs_attention'],
      ['the Open Leads line', 'kpi.open_leads'],
    ])('reads the count once when only %s is asked for, and the oldest lead only for the two that name it', async (_name, tileId) => {
      const { org, customer } = await newOrg();
      await fx.addLead(org, customer);
      const me = await personWith(org, LEADS);
      const { res, queries } = await read(me, `?tiles=${tileId}`);
      expect(res.status).toBe(200);
      expect(noOwnerCounts(queries)).toHaveLength(1);
      expect(noOwnerOldest(queries)).toHaveLength(tileId === 'kpi.open_leads' ? 0 : 1);
    });

    it('looks for the oldest lead only when there is one to find', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, LEADS);
      const { queries } = await read(me, '?tiles=kpi.open_leads,missing_lead_owner,needs_attention');
      expect(noOwnerCounts(queries)).toHaveLength(1);
      expect(noOwnerOldest(queries)).toHaveLength(0);
    });

    // Measured before and after S09.11 on a company with one lead that has no Owner: a Dispatcher-preset person's default
    // home page took 24 queries before the Missing lead owner tile and 24 after it (the tile joined that page and cost none:
    // it shares the count and the oldest-lead lookup with the Needs Attention item, which replaced the old unassigned count
    // and lookup), and an Admin-preset person's took 45 before and 45 after. A count, not a time; a tile built later that
    // truly needs more queries raises its number here and says why.
    it('reads a Dispatcher-preset person\'s default home page in a bounded number of queries', async () => {
      const { org, customer } = await newOrg();
      await fx.addLead(org, customer);
      const dispatcher = await fx.addUser(org, 'disp', 'DISPATCHER');
      const { res, answer, queries } = await read(dispatcher, '?shown=1');
      expect(res.status).toBe(200);
      expect(answer.data.missing_lead_owner).toMatchObject({ count: 1 });
      expect(queries.length).toBeLessThanOrEqual(24);
    });

    it('reads an Admin-preset person\'s default home page in a bounded number of queries', async () => {
      const { org, customer } = await newOrg();
      await fx.addLead(org, customer);
      const admin = await fx.addUser(org, 'adm', 'ADMIN');
      const { res, queries } = await read(admin, '?shown=1');
      expect(res.status).toBe(200);
      expect(queries.length).toBeLessThanOrEqual(45);
    });
  });

  describe('the payments item reads (P9)', () => {
    // The item's count is the Payments page's own: ONE union query over every kind (so the Admin pin stays 45 - the single
    // unapplied-money count it replaced was one query too, measured 45 before and 45 after). A person holding no payments
    // switch sends none of it. The two checks below read the queries each person sent, by the table the count names.
    const readsPayouts = (queries: string[]) => queries.filter((q) => /\bFROM payouts\b/.test(q));

    it('sends the one count of every payment attention kind for a View payments holder', async () => {
      const { org } = await newOrg();
      const admin = await fx.addUser(org, 'adm', 'ADMIN');
      const { res, queries } = await read(admin, '?shown=1');
      expect(res.status).toBe(200);
      expect(readsPayouts(queries)).toHaveLength(1);
    });

    it('sends none of it, so adds no query, for a person holding no payments switch', async () => {
      const { org } = await newOrg();
      const stock = await fx.addUser(org, 'stock', 'TECHNICIAN');
      const { res, queries } = await read(stock, '?shown=1');
      expect(res.status).toBe(200);
      expect(readsPayouts(queries)).toHaveLength(0);
    });
  });

  describe('the Close Rate reads (S09.15)', () => {
    /** The two grouped Won and Lost counts: the last 30 days and the 30 before. */
    const closeRateReads = (queries: string[]) => queries.filter((q) => /SELECT/i.test(q) && /GROUP BY/i.test(q) && /"public"\."leads"\."status"/.test(q));

    // Measured before and after S09.15 on a company with closed leads in both windows: Close Rate took two lead reads
    // (current window, prior window) before the rule moved to the close date, and two after; with Smart Insights asking for
    // the same figure there are still two, because the two tiles share the read.
    it.each([
      ['Close Rate alone', '?tiles=kpi.close_rate'],
      ['Close Rate and Smart Insights together', '?tiles=kpi.close_rate,smart_insights'],
      ['Smart Insights alone', '?tiles=smart_insights'],
    ])('takes two grouped lead reads for %s', async (_name, query) => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: lead.id }, data: { status: 'WON', won_at: new Date() } });
      const me = await personWith(org, { view_leads: true, view_invoices: true, see_company_figures: true, ...ALL_SCOPES });
      const { res, queries } = await read(me, query);
      expect(res.status).toBe(200);
      expect(closeRateReads(queries)).toHaveLength(2);
    });
  });

  describe('the Missing crew reads share one query (S09.13)', () => {
    /** The count of booked visits nobody is on and the lookup of the soonest one: the two reads the tile and the item share. */
    const crewlessReads = (queries: string[]) => queries.filter((q) => /FROM "public"\."visits"/.test(q) && /"public"\."visit_assignees"/.test(q));
    const crewlessCounts = (queries: string[]) => crewlessReads(queries).filter((q) => /SELECT COUNT/i.test(q));
    const crewlessSoonest = (queries: string[]) => crewlessReads(queries).filter((q) => !/COUNT/i.test(q));

    const JOBS = { view_jobs: true, show_jobs_page: true, access_schedule: true, jobs_scope: 'all' };

    async function orgWithCrewlessVisits(visits: number) {
      const made = await newOrg();
      const job = await fx.addJob(made.org, made.customer);
      for (let seq = 1; seq <= visits; seq += 1) await fx.addVisit(made.org, { jobId: job.id, crew: [], daysFromNow: seq, seq });
      return made;
    }

    it('reads the count once and the soonest visit once for the tile and the Needs Attention item together', async () => {
      const { org } = await orgWithCrewlessVisits(2);
      const me = await personWith(org, JOBS);
      const { res, answer, queries } = await read(me, '?tiles=missing_crew,needs_attention');
      expect(res.status).toBe(200);
      expect(answer.data.missing_crew).toMatchObject({ count: 2, soonest: { id: expect.any(String) } });
      expect(answer.data.needs_attention.find((i: { type: string }) => i.type === 'missing_crew')).toMatchObject({ title: '2 visits with no crew' });
      expect(crewlessCounts(queries)).toHaveLength(1);
      expect(crewlessSoonest(queries)).toHaveLength(1);
    });

    it.each([
      ['the tile', 'missing_crew'],
      ['the Needs Attention item', 'needs_attention'],
    ])('reads the count once and the soonest visit once when only %s is asked for', async (_name, tileId) => {
      const { org } = await orgWithCrewlessVisits(1);
      const me = await personWith(org, JOBS);
      const { res, queries } = await read(me, `?tiles=${tileId}`);
      expect(res.status).toBe(200);
      expect(crewlessCounts(queries)).toHaveLength(1);
      expect(crewlessSoonest(queries)).toHaveLength(1);
    });

    it('looks for the soonest visit only when there is one to find', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS);
      const { queries } = await read(me, '?tiles=missing_crew,needs_attention');
      expect(crewlessCounts(queries)).toHaveLength(1);
      expect(crewlessSoonest(queries)).toHaveLength(0);
    });

    // Measured before and after S09.13 on a company with one lead that has no Owner: a Dispatcher-preset person's default
    // home page took 24 queries before the Missing crew tile and 24 after it, and an Admin-preset person's took 45 before
    // and 45 after. The tile joined the Dispatcher page and cost none: it shares the count with the Needs Attention item,
    // which replaced the old per-visit "no crew" lookup (one query) with the count (one query). A company that does have
    // a booked visit nobody is on pays one more, the lookup of the soonest. A count, not a time; a tile built later that
    // truly needs more queries raises its number here and says why.
    it('reads a Dispatcher-preset person\'s default home page in the same number of queries as before, and the Missing crew count and soonest visit once each', async () => {
      const quiet = await newOrg();
      await fx.addLead(quiet.org, quiet.customer);
      const none = await read(await fx.addUser(quiet.org, 'disp-none', 'DISPATCHER'), '?shown=1');
      expect(none.res.status).toBe(200);
      expect(none.answer.data.missing_crew).toEqual({ count: 0, soonest: null });
      expect(none.queries.length).toBeLessThanOrEqual(24);
      expect(crewlessCounts(none.queries)).toHaveLength(1);
      expect(crewlessSoonest(none.queries)).toHaveLength(0);

      // A company with a booked visit nobody is on pays the one extra read (the soonest visit), on the same page; the tile and
      // the Needs Attention item together still ask for each once.
      const busy = await orgWithCrewlessVisits(1);
      await fx.addLead(busy.org, busy.customer);
      const one = await read(await fx.addUser(busy.org, 'disp-one', 'DISPATCHER'), '?shown=1');
      expect(one.answer.data.missing_crew).toMatchObject({ count: 1 });
      expect(one.answer.data.needs_attention.find((i: { type: string }) => i.type === 'missing_crew')).toBeDefined();
      expect(crewlessCounts(one.queries)).toHaveLength(1);
      expect(crewlessSoonest(one.queries)).toHaveLength(1);
    });
  });

  describe('Jobs this month is one grouped read of the visits (S09.16)', () => {
    /** Reads whose own table is the visits (not a lead read that only looks at them): the tile's three figures come out of one. */
    const visitReads = (queries: string[]) => queries.filter((q) => /^SELECT (?:(?!FROM)[^])*FROM "public"\."visits"/.test(q));

    it('answers the jobs, the finished visits and the still-to-do visits with one query', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const at = new Date(Date.now());
      const noon = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 15, 12));
      for (const [seq, status] of ([[1, 'COMPLETED'], [2, 'SCHEDULED']] as const)) {
        await db.visit.create({ data: { organization_id: org, job_id: job.id, purpose: 'WORK', visit_seq: seq, status, scheduled_at: noon, scheduled_end: noon } });
      }
      const me = await personWith(org, { view_jobs: true, show_jobs_page: true, jobs_scope: 'all' });
      const { res, answer, queries } = await read(me, '?tiles=jobs_this_month');
      expect(res.status).toBe(200);
      expect(answer.data.jobs_this_month).toEqual({ jobs: 1, finished: 1, still_to_do: 1 });
      expect(visitReads(queries)).toHaveLength(1);
    });

    // S09.16 put the tile in the Technician default, so that page gained exactly that one query: 7 before, 8 after (the
    // bound in 'computes only the tiles that are shown' moved with it). S09.17 then added the Completed jobs value tile to
    // that default: 8 before, 9 after (see its own block below). The Dispatcher (24) and Admin (45) defaults do not
    // hold the tile, so their bounds are unchanged.
    it('adds that one query, and no more, to a Technician-preset person\'s default home page', async () => {
      const { org } = await newOrg();
      const stock = await fx.addUser(org, 'tech-month', 'TECHNICIAN');
      const { res, answer, queries } = await read(stock, '?shown=1');
      expect(res.status).toBe(200);
      expect(answer.data.jobs_this_month).toEqual({ jobs: 0, finished: 0, still_to_do: 0 });
      expect(queries.length).toBe(10);
      expect(visitReads(queries)).toHaveLength(1);
    });
  });

  describe('Completed jobs value is one aggregate of the jobs (S09.17)', () => {
    /** The aggregate over the jobs (a count and a sum): the tile's two figures come out of one. */
    const jobReads = (queries: string[]) => queries.filter((q) => /SUM\("amount_invoiced"\)/.test(q) && /FROM "public"\."jobs"/.test(q));

    it('answers the count and the value with one query, for the person\'s own set and for the company alike', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'COMPLETED' });
      await db.job.update({ where: { id: job.id }, data: { completed_at: new Date(), amount_invoiced: 40 } });
      for (const see of [true, false]) {
        const me = await personWith(org, { view_jobs: true, show_jobs_page: true, jobs_scope: 'all', see_company_figures: see });
        const { res, answer, queries } = await read(me, '?tiles=completed_jobs_value');
        expect(res.status).toBe(200);
        expect(answer.data.completed_jobs_value).toEqual({ jobs: see ? 1 : 0, value: see ? 40 : 0 });
        expect(jobReads(queries), `see company figures ${see}`).toHaveLength(1);
      }
    });

    // The Technician default gained this tile in S09.17: 8 queries before, 9 after, one for this tile. The Dispatcher (24) and
    // Admin (45) defaults do not hold the tile, so their bounds are unchanged.
    it('adds that one query, and no more, to a Technician-preset person\'s default home page', async () => {
      const { org } = await newOrg();
      const stock = await fx.addUser(org, 'tech-value', 'TECHNICIAN');
      const { res, answer, queries } = await read(stock, '?shown=1');
      expect(res.status).toBe(200);
      expect(answer.data.completed_jobs_value).toEqual({ jobs: 0, value: 0 });
      expect(queries.length).toBe(10);
      const alone = await read(stock, '?tiles=completed_jobs_value');
      expect(jobReads(alone.queries)).toHaveLength(1);
    });
  });

  describe('Estimates still to send is one count, and one read of the rows only when there is a draft (S09.18)', () => {
    /** Reads whose own table is the estimates: the tile's count, then its rows. */
    const estimateReads = (queries: string[]) => queries.filter((q) => /^SELECT/.test(q) && /FROM "public"\."estimates"/.test(q));

    it('reads the count alone when nothing is waiting, and the count and the rows when something is', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_estimates: true, show_estimates_page: true, estimates_scope: 'all' });
      const none = await read(me, '?tiles=estimates_to_send');
      expect(none.answer.data.estimates_to_send).toEqual({ count: 0, estimates: [] });
      expect(estimateReads(none.queries)).toHaveLength(1);
      await fx.addEstimate(org, customer, admin.id);
      const one = await read(me, '?tiles=estimates_to_send');
      expect(one.answer.data.estimates_to_send.count).toBe(1);
      expect(estimateReads(one.queries)).toHaveLength(2);
    });

    // The Technician default gained this tile in S09.18: 9 queries before, 10 after, the count of an empty tile. The Sales default
    // gained it too, and had no pin before: 17 measured on an empty company, 16 without this tile. The Dispatcher (24) and Admin (45) defaults do not
    // hold the tile, so their bounds are unchanged.
    it('adds that one query, and no more, to a Technician-preset person\'s default home page, and pins a Sales-preset person\'s', async () => {
      const { org } = await newOrg();
      const tech = await fx.addUser(org, 'tech-estimates', 'TECHNICIAN');
      const techRead = await read(tech, '?shown=1');
      expect(techRead.res.status).toBe(200);
      expect(techRead.answer.data.estimates_to_send).toEqual({ count: 0, estimates: [] });
      expect(techRead.queries.length).toBe(10);
      const sales = await fx.addUser(org, 'sales-estimates', 'SALES');
      const salesRead = await read(sales, '?shown=1');
      expect(salesRead.res.status).toBe(200);
      expect(salesRead.answer.data.estimates_to_send).toEqual({ count: 0, estimates: [] });
      expect(salesRead.queries.length).toBe(SALES_QUERIES);
    });
  });

  describe('one tile failing does not fail the page', () => {
    it('answers 200 with an error marker for the tile whose loader threw, and the other tiles intact', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      await saveLayout(me, [
        { id: 'kpi.jobs_today', visible: true },
        { id: 'kpi.ar', visible: true },
      ]);
      failing.unpaid = true;
      const { res, answer } = await read(me, '?shown=1');
      expect(res.status).toBe(200);
      expect(answer.data['kpi.ar']).toEqual({ error: true });
      expect(answer.data['kpi.jobs_today']).toMatchObject({ total: 0 });
      expect(JSON.stringify(answer)).not.toContain('timed out');
    });

    it('survives the company-figures backstop when the failed tile is a list the backstop reads (no See company figures)', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, { view_jobs: true, ...ALL_SCOPES });
      failing.activity = true;
      const { res, answer } = await read(me, '?tiles=recent_activity,kpi.jobs_today');
      expect(res.status).toBe(200);
      expect(answer.data.recent_activity).toEqual({ error: true });
      expect(answer.data['kpi.jobs_today']).toBeDefined();
      expect(JSON.stringify(answer)).not.toContain('555-0100');
    });
  });

  describe('Recent Activity', () => {
    let saved: typeof ACTIVITY_LIMITS;
    beforeAll(() => {
      saved = { ...ACTIVITY_LIMITS };
    });
    afterAll(() => Object.assign(ACTIVITY_LIMITS, saved));

    const feedOf = async (person: Person) => {
      const { res, answer, queries } = await read(person, '?tiles=recent_activity');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { feed: (answer.data.recent_activity as Array<{ description: string }>).map((e) => e.description), queries };
    };
    const note = (org: string, by: string, entity: string, id: string, description: string, metadata?: object, event_type = 'NOTE') =>
      db.timelineEvent.create({ data: { organization_id: org, entity_type: entity, entity_id: id, event_type, description, metadata: metadata as never, created_by: by } });

    // The same rules whichever way the reach is applied: pushed into the events query (a narrow reach), or checked page
    // by page (a reach too wide to list). Both are exercised by moving the line between them.
    describe.each([
      ['a narrow reach is pushed into the events query', 2000],
      ['a reach too wide to list is checked page by page', 0],
    ])('%s', (_name, reachCap) => {
      beforeEach(() => {
        Object.assign(ACTIVITY_LIMITS, saved, { reachCap });
      });

      it('shows events on the records the person is on and none on anyone else\'s, newest first', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' });
        const mine = await fx.addJob(org, customer, { crew: [me.id] });
        const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
        const myLead = await fx.addLead(org, customer, { assignees: [me.id] });
        const theirLead = await fx.addLead(org, customer, { assignees: [admin.id] });
        await note(org, admin.id, 'JOB', mine.id, 'my-job-event');
        await note(org, admin.id, 'JOB', theirs.id, 'their-job-event');
        await note(org, admin.id, 'LEAD', theirLead.id, 'their-lead-event');
        await new Promise((r) => setTimeout(r, 5));
        await note(org, admin.id, 'LEAD', myLead.id, 'my-lead-event');
        expect((await feedOf(me)).feed).toEqual(['my-lead-event', 'my-job-event']);
      });

      it('keeps the invoice mirror rule: a copy on a job reaches only a person who can open the invoice it names', async () => {
        const { org, customer, admin } = await newOrg();
        const jobOnly = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
        const both = await personWith(org, { view_jobs: true, view_invoices: true, jobs_scope: 'attached', invoices_scope: 'all' });
        const job = await fx.addJob(org, customer, { crew: [jobOnly.id, both.id] });
        const made = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
        const tag = { invoice_id: made.id, invoice_number: 'INV-X', invoice_event_type: 'PAYMENT_RECEIVED' };
        await note(org, admin.id, 'JOB', job.id, 'plain-job-note');
        await note(org, admin.id, 'INVOICE', made.id, 'invoice-own-payment', { amount: 90 }, 'PAYMENT_RECEIVED');
        await note(org, admin.id, 'JOB', job.id, 'mirror-payment', { ...tag, amount: 90, method: 'CHECK' }, 'JOB_PAYMENT_RECORDED');

        expect((await feedOf(jobOnly)).feed).toEqual(['plain-job-note']);
        expect((await feedOf(both)).feed.sort()).toEqual(['mirror-payment', 'plain-job-note']);
      });

      it('shows a task event to its assignee and to whoever can open the record it is linked to, and to nobody else', async () => {
        const { org, customer, admin } = await newOrg();
        const assignee = await personWith(org, { view_tasks: true });
        const onTheJob = await personWith(org, { view_tasks: true, view_jobs: true, jobs_scope: 'attached' });
        const stranger = await personWith(org, { view_tasks: true });
        const job = await fx.addJob(org, customer, { crew: [onTheJob.id] });
        const make = (title: string, extra: object) =>
          db.task.create({ data: { organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title, assignee_ids: [], created_by: admin.id, ...extra } });
        const mine = await make('assigned', { assignee_ids: [assignee.id] });
        const linked = await make('linked', { linked_entity_type: 'JOB', linked_entity_id: job.id });
        await note(org, admin.id, 'TASK', mine.id, 'assigned-task-event');
        await note(org, admin.id, 'TASK', linked.id, 'linked-task-event');

        expect((await feedOf(assignee)).feed).toEqual(['assigned-task-event']);
        expect((await feedOf(onTheJob)).feed).toEqual(['linked-task-event']);
        expect((await feedOf(stranger)).feed).toEqual([]);
      });
    });

    it('finds the person\'s events however many newer events sit on other people\'s records', async () => {
      Object.assign(ACTIVITY_LIMITS, saved);
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
      await note(org, admin.id, 'JOB', mine.id, 'my-old-event');
      await new Promise((r) => setTimeout(r, 5));
      await db.$executeRawUnsafe(
        `INSERT INTO timeline_events (id, entity_type, entity_id, event_type, description, organization_id, created_at, created_by)
         SELECT gen_random_uuid(), 'JOB', '${theirs.id}', 'NOTE', 'noise-'||g, '${org}', (now() at time zone 'utc') + (g || ' seconds')::interval, '${admin.id}' FROM generate_series(1, 1200) g`,
      );
      const { feed } = await feedOf(me);
      expect(feed).toEqual(['my-old-event']);
    });

    it('reads a scoped person\'s feed in a fixed, small number of queries', async () => {
      Object.assign(ACTIVITY_LIMITS, saved);
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, view_tasks: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
      for (let i = 0; i < 30; i++) await note(org, admin.id, 'JOB', i % 3 === 0 ? mine.id : theirs.id, `event-${i}`);
      for (let i = 0; i < 15; i++) {
        const task = await db.task.create({ data: { organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title: 't', assignee_ids: [admin.id], created_by: admin.id, linked_entity_type: 'JOB', linked_entity_id: theirs.id } });
        await note(org, admin.id, 'TASK', task.id, `task-event-${i}`);
      }
      const { feed, queries } = await feedOf(me);
      expect(feed.length).toBe(10);
      // The tile's own reads: the timezone, the person's reach per kind of record (two), the events, the tasks and the
      // records they link to, the names. Measured at 7. Not a read per page, and not one per task.
      expect(queries.length).toBeLessThanOrEqual(9);
    });
  });
});

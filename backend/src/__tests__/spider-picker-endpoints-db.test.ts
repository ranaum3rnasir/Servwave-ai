/* =============================================================================
   #3435: Spider's lead picker answered by the server ("Select Contacts for Alert", mockup M2), over HTTP on a real
   migrated database:

     GET   /spider/overview                 open leads watched, open leads excluded
     GET   /spider/customers?q=&cursor=     customers with open leads, 50 a page, searched on the server
     GET   /spider/customers/:id/leads      one customer's open leads, with `excluded`
     GET   /spider/excluded?q=&cursor=      the excluded open leads, 50 a page
     PATCH /spider/exclusions               one Save: { exclude, include }

   1. The refusals: every one of the five answers a non-Admin and a company without Spider exactly as the existing Spider
      settings endpoint does, and stores nothing.
   2. Another company's ids: never counted, listed, opened or stored, one case per endpoint.
   3. The journey: an Admin searches (name, company, lead number, phone; a search also says how many customers match it
      in all), opens a customer, excludes two leads, sees them
      in the counts and the Excluded list, saves the same again (nothing changes, no trigger), includes one again (the
      SCOPE_WIDENED trigger while Active; none while Not active), and a closed lead in a Save is dropped.
   4. Pages at 2,000+ customers: every list returns at most one page of 50 and a cursor, walking the cursors visits each
      customer with open leads exactly once (many share a created_at, so the order must be total), and nothing else.
   5. Query count per request is the same for a company of 3 customers and one of 2,000+.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    // Built with the query-event log, so the query counter can count it (support/query-counter.ts).
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined,
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { countQueries } from './support/query-counter';
import { requireSpider, requireSpiderAdmin } from '../middleware/requireSpider';
import * as pickerController from '../controllers/spider-picker.controller';

const suite = realClient ? describe : describe.skip;

const BASE = '/api/ai-farm/spider';
const SETTINGS = `${BASE}/settings`;
const OVERVIEW = `${BASE}/overview`;
const CUSTOMERS = `${BASE}/customers`;
const EXCLUDED = `${BASE}/excluded`;
const EXCLUSIONS = `${BASE}/exclusions`;
const customerLeads = (id: string) => `${BASE}/customers/${id}/leads`;

const HOUR = 3_600_000;

type Layer = { name: string; handle: unknown; regexp: RegExp; route?: { path: string; methods: Record<string, boolean>; stack: Layer[] } };

function mountPathOf(re: RegExp): string {
  const s = re.source;
  if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)') return '';
  return s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/');
}

/** Every route the app serves, as "METHOD /path" with its steps (the walk of permission-canonical-ids-guard). */
function servedRoutes(stack: Layer[], prefix = ''): { key: string; steps: unknown[] }[] {
  const out: { key: string; steps: unknown[] }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      out.push({ key: `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${prefix}${layer.route.path}`, steps: layer.route.stack.map((l) => l.handle) });
    } else if (layer.name === 'router') {
      out.push(...servedRoutes((layer.handle as { stack: Layer[] }).stack, prefix + mountPathOf(layer.regexp)));
    }
  }
  return out;
}

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;

suite('Spider picker endpoints (#3435, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.spiderSettings.deleteMany({ where: { organization_id: { in: orgs } } }));
    await quietly(db.lead.deleteMany({ where: { organization_id: { in: orgs } } }));
    await quietly(db.customerPhone.deleteMany({ where: { customer: { organization_id: { in: orgs } } } }));
    await quietly(db.serviceLocation.deleteMany({ where: { customer: { organization_id: { in: orgs } } } }));
    await fx.cleanup();
  }, 300_000);

  interface Company { org: string; admin: Person; customer: string }

  /** A Scale demo company (Spider's gate is open), with the fixture's customer Pat Payer. */
  async function company(): Promise<Company> {
    const { org, admin, customer } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { is_demo: true } });
    return { org, admin, customer };
  }

  /** A customer with the given names; its id. */
  async function addCustomer(org: string, data: { first_name?: string; last_name?: string; company_name?: string; phone?: string; email?: string }) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', ...data },
    });
    return id;
  }

  /** A service location of the customer; its id. */
  async function addLocation(customer: string, address_line1: string, city: string) {
    const loc = await db.serviceLocation.create({ data: { customer_id: customer, address_line1, city, state: 'MA', zip: '01101' } });
    return loc.id;
  }

  /** A lead on the customer; open (New, created `ago` ms ago) unless `closed`. Its id. */
  async function addLead(org: string, customer: string, opts: { closed?: boolean; ago?: number; owner?: string; number?: string; location?: string } = {}) {
    const id = randomUUID();
    const created = new Date(Date.now() - (opts.ago ?? HOUR));
    await db.lead.create({
      data: {
        id, organization_id: org, customer_id: customer, lead_number: opts.number ?? `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        created_at: created, commission_owner_id: opts.owner ?? null, service_location_id: opts.location ?? null,
        ...(opts.closed ? { status: 'WON' as const, won_at: new Date() } : {}),
      },
    });
    return id;
  }

  const stored = (org: string) =>
    db.spiderSettings.findUnique({ where: { organization_id: org }, select: { excluded_lead_ids: true, summary_trigger_kind: true, is_active: true } });

  /** Every page of a list, following the cursors. */
  async function walk(api: Api, path: string, key: 'customers' | 'leads', q = '') {
    const rows: { id: string }[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const params = new URLSearchParams({ ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
      const res = await api.get(`${path}?${params}`);
      expect(res.status).toBe(200);
      sizes.push(res.body[key].length);
      rows.push(...res.body[key]);
      cursor = res.body.next_cursor;
      if (!cursor) return { rows, sizes };
    }
    throw new Error('more than 200 pages');
  }

  // ─── 1. Refusals ─────────────────────────────────────────────────────────────────────────────────

  describe('refusals match the existing Spider endpoints exactly', () => {
    const TABLE = ['GET /spider/overview', 'GET /spider/customers', 'GET /spider/customers/:id/leads', 'GET /spider/excluded', 'PATCH /spider/exclusions'];

    it('the table below names every route the picker controller serves, each behind the Spider gate and the Admin gate', async () => {
      const app = (await import('../app.js')).default as unknown as { _router: { stack: Layer[] } };
      const handlers = new Set(Object.values(pickerController).filter((v) => typeof v === 'function'));
      const picker = servedRoutes(app._router.stack).filter((r) => r.steps.some((s) => handlers.has(s as never)));
      expect(picker.map((r) => r.key.replace('/api/ai-farm', '')).sort()).toEqual([...TABLE].sort());
      for (const r of picker) {
        const at = (step: unknown) => r.steps.indexOf(step);
        const handler = r.steps.findIndex((s) => handlers.has(s as never));
        expect(at(requireSpider), r.key).toBeGreaterThanOrEqual(0);
        expect(at(requireSpiderAdmin), r.key).toBeGreaterThan(at(requireSpider));
        expect(handler, r.key).toBeGreaterThan(at(requireSpiderAdmin));
      }
    });

    const fiveEndpoints = (customerId: string) => [
      ['GET /spider/overview', (api: Api) => api.get(OVERVIEW)],
      ['GET /spider/customers', (api: Api) => api.get(`${CUSTOMERS}?q=Pat`)],
      ['GET /spider/customers/:id/leads', (api: Api) => api.get(customerLeads(customerId))],
      ['GET /spider/excluded', (api: Api) => api.get(EXCLUDED)],
      ['PATCH /spider/exclusions', (api: Api) => api.patch(EXCLUSIONS, { exclude: [randomUUID()], include: [] })],
    ] as const;

    it('a non-Admin, and a company without Spider, get what GET /spider/settings answers them, and nothing is stored', async () => {
      const c = await company();
      const lead = await addLead(c.org, c.customer);
      const sales = await fx.addUser(c.org, 'sales', 'SALES');
      const dispatcher = await fx.addUser(c.org, 'disp', 'DISPATCHER');
      const tech = await fx.addUser(c.org, 'tech', 'TECHNICIAN');

      // A Scale company that is not a demo company and not on the pilot list: no Spider.
      const { org: noSpider, admin: noSpiderAdmin, customer: noSpiderCustomer } = await fx.newOrg();
      orgs.push(noSpider);
      await addLead(noSpider, noSpiderCustomer);
      // A demo company whose spider feature is switched off.
      const off = await company();
      await db.organization.update({ where: { id: off.org }, data: { feature_overrides: { spider: false } } });

      const callers: [string, Person, string][] = [
        ['Sales', sales, c.customer],
        ['Dispatcher', dispatcher, c.customer],
        ['Technician', tech, c.customer],
        ['Admin of a company without Spider', noSpiderAdmin, noSpiderCustomer],
        ['Admin of a company with Spider switched off', off.admin, off.customer],
      ];
      expect(fiveEndpoints(c.customer).map(([name]) => name)).toEqual(TABLE);
      const seen: string[] = [];
      for (const [who, person, customerId] of callers) {
        const api = await fx.signedInAs(person);
        const reference = await api.get(SETTINGS);
        expect(reference.status, who).not.toBe(200);
        for (const [name, call] of fiveEndpoints(customerId)) {
          const res = await call(api);
          seen.push(`${who} ${name} ${res.status}`);
          expect({ status: res.status, body: res.body }, `${who} ${name}`).toEqual({ status: reference.status, body: reference.body });
        }
      }
      // The table really ran every caller on every endpoint: 403s for the three roles, 404s for the two companies.
      expect(seen).toHaveLength(25);
      expect(seen.filter((s) => s.endsWith(' 403'))).toHaveLength(15);
      expect(seen.filter((s) => s.endsWith(' 404'))).toHaveLength(10);
      // No refused Save stored anything.
      for (const org of [c.org, noSpider, off.org]) expect(await stored(org)).toBeNull();
      expect(lead).toBeTruthy();
    }, 120_000);

    it('a malformed cursor, search or Save body is refused with 400 and stores nothing', async () => {
      const c = await company();
      const api = await fx.signedInAs(c.admin);
      expect((await api.get(`${CUSTOMERS}?cursor=not-a-cursor`)).status).toBe(400);
      expect((await api.get(`${EXCLUDED}?cursor=${Buffer.from('["x","y"]').toString('base64url')}`)).status).toBe(400);
      const tooLong = await api.get(`${CUSTOMERS}?q=${'a'.repeat(101)}`);
      expect(tooLong.status).toBe(400);
      // A refused search counts nothing: no total, no rows.
      expect(tooLong.body).not.toHaveProperty('total');
      expect(tooLong.body).not.toHaveProperty('customers');
      const badCursorSearch = await api.get(`${CUSTOMERS}?q=Pat&cursor=not-a-cursor`);
      expect(badCursorSearch.status).toBe(400);
      expect(badCursorSearch.body).not.toHaveProperty('total');
      expect((await api.get(`${customerLeads(c.customer)}?cursor=%5B`)).status).toBe(400);
      const same = randomUUID();
      expect((await api.patch(EXCLUSIONS, { exclude: [same], include: [same] })).status).toBe(400);
      expect((await api.patch(EXCLUSIONS, { exclude: ['nope'], include: [] })).status).toBe(400);
      expect((await api.patch(EXCLUSIONS, { exclude: [] })).status).toBe(400);
      expect(await stored(c.org)).toBeNull();
    }, 60_000);
  });

  // ─── 2. Another company's ids ────────────────────────────────────────────────────────────────────

  describe("another company's ids are never returned or stored", () => {
    let mine: Company;
    let theirs: Company;
    let api: Api;
    let myLead: string;
    let theirLead: string;
    let theirOtherLead: string;

    beforeAll(async () => {
      mine = await company();
      theirs = await company();
      api = await fx.signedInAs(mine.admin);
      myLead = await addLead(mine.org, mine.customer);
      // Their customer shares my customer's name, so a search for it would find theirs if the company were not checked.
      theirLead = await addLead(theirs.org, theirs.customer);
      theirOtherLead = await addLead(theirs.org, theirs.customer);
      // Their leads on MY exclusion list (as a broken write could leave them), and excluded in their own company too.
      await db.spiderSettings.create({ data: { organization_id: mine.org, excluded_lead_ids: [theirLead] } });
      await db.spiderSettings.create({ data: { organization_id: theirs.org, excluded_lead_ids: [theirLead, theirOtherLead] } });
    }, 60_000);

    it('GET /spider/overview counts only my open leads', async () => {
      const res = await api.get(OVERVIEW);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ watched: 1, excluded: 0 });
    });

    it('GET /spider/customers lists only my customers, whatever the search', async () => {
      for (const q of ['', 'Pat', 'Payer', theirLead.slice(0, 8)]) {
        const res = await api.get(`${CUSTOMERS}?q=${encodeURIComponent(q)}`);
        expect(res.status).toBe(200);
        expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual(q === theirLead.slice(0, 8) ? [] : [mine.customer]);
        // A search's total counts only my customers too; no search, no total.
        if (q) expect(res.body.total, q).toBe(res.body.customers.length);
        else expect(res.body).not.toHaveProperty('total');
      }
    });

    it("GET /spider/customers/:id/leads answers their customer, and an id that is no uuid, exactly like one that does not exist", async () => {
      const theirsRes = await api.get(customerLeads(theirs.customer));
      const missing = await api.get(customerLeads(randomUUID()));
      expect(missing.status).toBe(404);
      expect({ status: theirsRes.status, body: theirsRes.body }).toEqual({ status: missing.status, body: missing.body });
      for (const notAnId of ['not-a-uuid', '123', `${mine.customer}x`]) {
        const res = await api.get(customerLeads(notAnId));
        expect({ status: res.status, body: res.body }, notAnId).toEqual({ status: missing.status, body: missing.body });
      }
      const own = await api.get(customerLeads(mine.customer));
      expect(own.body.leads.map((l: { id: string }) => l.id)).toEqual([myLead]);
    });

    it('GET /spider/excluded never lists their lead, even when its id sits on my list', async () => {
      const res = await api.get(EXCLUDED);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ leads: [], next_cursor: null });
      expect((await api.get(`${EXCLUDED}?q=Pat`)).body.leads).toEqual([]);
    });

    it('PATCH /spider/exclusions drops their ids, in exclude and in include, and never touches their list', async () => {
      const res = await api.patch(EXCLUSIONS, { exclude: [theirOtherLead, myLead], include: [theirLead] });
      expect(res.status).toBe(200);
      // The Save adds none of theirs, and writing the list drops their id that was planted on it beforehand.
      expect((await stored(mine.org))!.excluded_lead_ids).toEqual([myLead]);
      expect((await stored(theirs.org))!.excluded_lead_ids.sort()).toEqual([theirLead, theirOtherLead].sort());
      expect(res.body).toEqual({ watched: 0, excluded: 1 });
    });
  });

  // ─── 3. The journey ──────────────────────────────────────────────────────────────────────────────

  it('search, open a customer, exclude, save again, include again: the counts, the Excluded list and the trigger follow', async () => {
    const c = await company();
    const api = await fx.signedInAs(c.admin);
    const owner = await fx.addUser(c.org, 'owner', 'SALES');
    const brook = await addCustomer(c.org, {
      first_name: 'Dana', last_name: 'Cole', company_name: 'Brookline Plumbing', phone: '(617) 555-0142', email: 'office@brooklineplumbing.example',
    });
    const elm = await addLocation(brook, '48 Elm Street', 'Springfield');
    const other = await addCustomer(c.org, { first_name: 'Sam', last_name: 'Rivera' });
    await db.customerPhone.create({ data: { customer_id: other, phone: '6175550199', is_primary: true } });
    const closedOnly = await addCustomer(c.org, { company_name: 'Brook Closed Co' });
    await addCustomer(c.org, { company_name: 'Brook No Leads' });
    const [b1, b2, b3] = [
      await addLead(c.org, brook, { ago: 3 * HOUR, owner: owner.id, number: 'L24113', location: elm }),
      await addLead(c.org, brook, { ago: 2 * HOUR, number: 'L24090' }),
      await addLead(c.org, brook, { ago: 1 * HOUR, number: 'L23977' }),
    ];
    const bClosed = await addLead(c.org, brook, { closed: true });
    const o1 = await addLead(c.org, other, { number: 'L55501' });
    await addLead(c.org, closedOnly, { closed: true });
    const pat = await addLead(c.org, c.customer);

    expect((await api.get(OVERVIEW)).body).toEqual({ watched: 5, excluded: 0 });

    // Server search: name, company, lead number, phone (either punctuation), several words; never a customer whose
    // leads are all closed, nor one with none.
    const ids = async (q: string) => (await api.get(`${CUSTOMERS}?q=${encodeURIComponent(q)}`)).body.customers.map((x: { id: string }) => x.id);
    expect(await ids('brook')).toEqual([brook]);
    expect(await ids('dana cole')).toEqual([brook]);
    expect(await ids('Rivera')).toEqual([other]);
    expect(await ids('L24090')).toEqual([brook]);
    expect(await ids('l5550')).toEqual([other]);
    expect(await ids('6175550142')).toEqual([brook]);
    expect(await ids('(617) 555-0199')).toEqual([other]);
    expect(await ids('nobody-matches')).toEqual([]);
    expect((await ids('')).sort()).toEqual([brook, other, c.customer].sort());
    // A search says how many customers with open leads match it in all (mockup M2: 38 customers with open leads match
    // "bro"); a list without a search has no total.
    const total = async (q: string) => (await api.get(`${CUSTOMERS}?q=${encodeURIComponent(q)}`)).body.total;
    expect(await total('brook')).toBe(1);
    expect(await total('l5550')).toBe(1);
    expect(await total('nobody-matches')).toBe(0);
    expect((await api.get(CUSTOMERS)).body).not.toHaveProperty('total');

    const list = (await api.get(`${CUSTOMERS}?q=brook`)).body;
    expect(list).toEqual({
      customers: [{
        id: brook, name: 'Dana Cole', company_name: 'Brookline Plumbing', email: 'office@brooklineplumbing.example', open_leads: 3, excluded_leads: 0,
      }],
      next_cursor: null,
      total: 1,
    });

    // A customer with no email: null.
    expect((await api.get(`${CUSTOMERS}?q=Rivera`)).body.customers[0].email).toBeNull();

    // Open the customer: its open leads, newest first, with stage, time in stage, owner and the lead's own address.
    const opened = await api.get(customerLeads(brook));
    expect(opened.status).toBe(200);
    expect(opened.body.next_cursor).toBeNull();
    expect(opened.body.leads.map((l: { id: string }) => l.id)).toEqual([b3, b2, b1]);
    const first = opened.body.leads.find((l: { id: string }) => l.id === b1);
    expect(first).toEqual({
      id: b1, lead_number: 'L24113', status: 'NEW', stage: 'NEW', stage_entered_at: expect.any(String),
      owner_name: 'owner Tester', address: '48 Elm Street, Springfield', excluded: false,
    });
    // A lead with no service location of its own shows no address.
    expect(opened.body.leads.filter((l: { id: string }) => l.id !== b1).map((l: { address: unknown }) => l.address)).toEqual([null, null]);
    expect(Date.now() - new Date(first.stage_entered_at).getTime()).toBeGreaterThanOrEqual(3 * HOUR - 60_000);
    // Only what the picker shows (mockup M2): never a phone.
    for (const l of opened.body.leads) {
      expect(Object.keys(l).sort()).toEqual(['address', 'excluded', 'id', 'lead_number', 'owner_name', 'stage', 'stage_entered_at', 'status']);
    }
    expect(Object.keys(list.customers[0]).sort()).toEqual(['company_name', 'email', 'excluded_leads', 'id', 'name', 'open_leads']);
    expect(opened.body.leads.map((l: { id: string }) => l.id)).not.toContain(bClosed);

    // Spider Active, then one Save excludes two leads (and a closed lead, which is dropped).
    await db.spiderSettings.create({ data: { organization_id: c.org, is_active: true, activated_at: new Date() } });
    const saved = await api.patch(EXCLUSIONS, { exclude: [b1, b2, bClosed], include: [] });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ watched: 3, excluded: 2 });
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [b1, b2].sort(), summary_trigger_kind: null, is_active: true });
    expect((await api.get(OVERVIEW)).body).toEqual({ watched: 3, excluded: 2 });
    expect((await api.get(`${CUSTOMERS}?q=brook`)).body.customers[0]).toMatchObject({ open_leads: 3, excluded_leads: 2 });
    expect((await api.get(customerLeads(brook))).body.leads.map((l: { excluded: boolean }) => l.excluded)).toEqual([false, true, true]);
    const excludedList = (await api.get(EXCLUDED)).body;
    expect(excludedList.next_cursor).toBeNull();
    expect(excludedList.leads.map((l: { id: string }) => l.id)).toEqual([b2, b1]);
    expect(excludedList.leads[0]).toEqual({
      id: b2, lead_number: 'L24090', status: 'NEW', stage: 'NEW', stage_entered_at: expect.any(String),
      customer_id: brook, customer_name: 'Dana Cole', customer_company_name: 'Brookline Plumbing',
    });
    // The Excluded tab shows no email, no address and no owner (mockup M2 v3).
    for (const l of excludedList.leads) {
      expect(Object.keys(l).sort()).toEqual(['customer_company_name', 'customer_id', 'customer_name', 'id', 'lead_number', 'stage', 'stage_entered_at', 'status']);
      expect(l.customer_id).toBe(brook);
    }
    expect((await api.get(`${EXCLUDED}?q=L24113`)).body.leads.map((l: { id: string }) => l.id)).toEqual([b1]);
    expect((await api.get(`${EXCLUDED}?q=rivera`)).body.leads).toEqual([]);
    expect((await api.get(`${EXCLUDED}?q=617-555-0142`)).body.leads).toHaveLength(2);

    // The same Save again: the same list, still no trigger.
    expect((await api.patch(EXCLUSIONS, { exclude: [b1, b2], include: [] })).body).toEqual({ watched: 3, excluded: 2 });
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [b1, b2].sort(), summary_trigger_kind: null, is_active: true });
    // Including a lead that is not excluded widens nothing.
    expect((await api.patch(EXCLUSIONS, { exclude: [], include: [o1, pat] })).status).toBe(200);
    expect((await stored(c.org))!.summary_trigger_kind).toBeNull();

    // Include one again while Active: SCOPE_WIDENED.
    expect((await api.patch(EXCLUSIONS, { exclude: [], include: [b1] })).body).toEqual({ watched: 4, excluded: 1 });
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [b2], summary_trigger_kind: 'SCOPE_WIDENED', is_active: true });

    // A closed excluded lead stays on the list (it reopens excluded), out of every count and list meanwhile.
    await db.lead.update({ where: { id: b2 }, data: { status: 'WON', won_at: new Date() } });
    expect((await api.get(OVERVIEW)).body).toEqual({ watched: 4, excluded: 0 });
    expect((await api.get(EXCLUDED)).body.leads).toEqual([]);
    // ...and a Save cannot include it while it is closed: dropped like any closed lead.
    await api.patch(EXCLUSIONS, { exclude: [], include: [b2] });
    expect((await stored(c.org))!.excluded_lead_ids).toEqual([b2]);

    // Not active: a Save that includes a lead again records no trigger.
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { is_active: false, summary_trigger_kind: null, summary_trigger_at: null, summary_trigger_since: null } });
    await api.patch(EXCLUSIONS, { exclude: [b3], include: [] });
    await api.patch(EXCLUSIONS, { exclude: [], include: [b3] });
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [b2], summary_trigger_kind: null, is_active: false });
  }, 120_000);

  it('search is literal: % and _ match only themselves, on the customer list and the Excluded list', async () => {
    const c = await company();
    const api = await fx.signedInAs(c.admin);
    const plain = await addCustomer(c.org, { company_name: 'Plain Co', phone: '(413) 555-0100' });
    const percent = await addCustomer(c.org, { company_name: '100% Doors' });
    const under = await addCustomer(c.org, { company_name: 'Under_Score Ltd' });
    const leads = {
      plain: await addLead(c.org, plain, { number: 'L177' }),
      percent: await addLead(c.org, percent, { number: 'L200' }),
      under: await addLead(c.org, under, { number: 'L_77' }),
    };
    expect((await api.patch(EXCLUSIONS, { exclude: Object.values(leads), include: [] })).status).toBe(200);
    const customers = async (q: string) => {
      const body = (await api.get(`${CUSTOMERS}?q=${encodeURIComponent(q)}`)).body;
      // The total counts with the same literal search as the list.
      expect(body.total, `/customers total ${q}`).toBe(body.customers.length);
      return body.customers.map((x: { id: string }) => x.id);
    };
    const excluded = async (q: string) =>
      (await api.get(`${EXCLUDED}?q=${encodeURIComponent(q)}`)).body.leads.map((x: { id: string }) => x.id);
    const cases: [string, string[], string[]][] = [
      ['%', [percent], [leads.percent]],
      ['%%', [], []],
      ['_', [under], [leads.under]],
      ['P_ain', [], []],
      ['Pl%n', [], []],
      ['L_77', [under], [leads.under]],
      // A phone-shaped search keeps the term as typed among its candidates: '4_3' must not match 413.
      ['4_3', [], []],
      ['\\', [], []],
    ];
    for (const [q, wantCustomers, wantExcluded] of cases) {
      expect(await customers(q), `/customers ${q}`).toEqual(wantCustomers);
      expect(await excluded(q), `/excluded ${q}`).toEqual(wantExcluded);
    }
    // The plain words still match.
    expect(await customers('plain')).toEqual([plain]);
    expect(await excluded('L177')).toEqual([leads.plain]);
  }, 60_000);

  it('a company that never set Spider up can save exclusions: its row is made Not active, with no trigger', async () => {
    const c = await company();
    const api = await fx.signedInAs(c.admin);
    const lead = await addLead(c.org, c.customer);
    expect(await stored(c.org)).toBeNull();
    const res = await api.patch(EXCLUSIONS, { exclude: [lead], include: [] });
    expect(res.status).toBe(200);
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [lead], summary_trigger_kind: null, is_active: false });
  }, 60_000);

  it("writing the list drops any id that is not this company's lead, keeps its own closed exclusions, and widens nothing", async () => {
    const c = await company();
    const other = await company();
    const api = await fx.signedInAs(c.admin);
    const [open1, open2] = [await addLead(c.org, c.customer), await addLead(c.org, c.customer)];
    const ownClosed = await addLead(c.org, c.customer, { closed: true });
    const foreign = await addLead(other.org, other.customer);
    const ghost = randomUUID();
    await db.spiderSettings.create({
      data: { organization_id: c.org, is_active: true, activated_at: new Date(), excluded_lead_ids: [open1, ownClosed, foreign, ghost] },
    });
    const res = await api.patch(EXCLUSIONS, { exclude: [open2], include: [] });
    expect(res.status).toBe(200);
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [open1, open2, ownClosed].sort(), summary_trigger_kind: null, is_active: true });
    expect(res.body).toEqual({ watched: 0, excluded: 2 });
  }, 60_000);

  it('two Saves at once both land: neither loses the other\'s exclusion', async () => {
    const c = await company();
    const api = await fx.signedInAs(c.admin);
    const leads = await Promise.all(Array.from({ length: 6 }, () => addLead(c.org, c.customer)));
    await api.patch(EXCLUSIONS, { exclude: [], include: [] }); // the row exists
    await Promise.all(leads.map((id) => api.patch(EXCLUSIONS, { exclude: [id], include: [] })));
    expect((await stored(c.org))!.excluded_lead_ids).toEqual([...leads].sort());
  }, 60_000);

  // ─── 4 + 5. Pages at 2,000+ customers, and the query count ───────────────────────────────────────

  describe('at 2,000+ customers', () => {
    const BIG = 2_050;
    let big: Company;
    let small: Company;
    // The fixture's sign-in mock answers for the person signed in last, so sign in again before each use.
    const bigApi = () => fx.signedInAs(big.admin);
    const smallApi = () => fx.signedInAs(small.admin);
    let withOpen: Set<string>;
    let busyCustomer: string;
    let busyLeads: string[];
    let bigExcluded: string[];
    let s1: string;

    /** `n` customers in one insert, each with the given created_at; their ids. */
    async function bulkCustomers(org: string, n: number, createdAt: (i: number) => Date, name: (i: number) => string) {
      const rows = Array.from({ length: n }, (_, i) => ({
        id: randomUUID(), organization_id: org, customer_number: `${name(0).replace(/\d+$/, '')}${String(i).padStart(6, '0')}`, kind: 'PERSON' as const,
        segment: 'RESIDENTIAL' as const, first_name: name(i), last_name: 'Bulk', created_at: createdAt(i), email: `${name(i)}@bulk.example`,
      }));
      await db.customer.createMany({ data: rows });
      return rows.map((r) => r.id);
    }
    async function bulkLeads(org: string, customers: string[], opts: { closed?: boolean } = {}) {
      const rows = customers.map((customer) => {
        const id = randomUUID();
        return {
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 12)}`, service_request: 'Fix the door',
          ...(opts.closed ? { status: 'LOST' as const, lost_at: new Date() } : {}),
        };
      });
      for (let i = 0; i < rows.length; i += 1000) await db.lead.createMany({ data: rows.slice(i, i + 1000) });
      return rows.map((r) => r.id);
    }

    beforeAll(async () => {
      big = await company();
      small = await company();

      // 2,050 customers with open leads, in groups of 25 sharing one created_at (ties the keyset must break by id).
      const t0 = Date.now() - 100 * HOUR;
      const open = await bulkCustomers(big.org, BIG, (i) => new Date(t0 + Math.floor(i / 25) * 1000), (i) => `Open${i}`);
      const openLeads = await bulkLeads(big.org, open);
      // Customers with only a closed lead, and with no lead: never listed.
      const closedOnly = await bulkCustomers(big.org, 40, () => new Date(t0), (i) => `Closed${i}`);
      await bulkLeads(big.org, closedOnly, { closed: true });
      await bulkCustomers(big.org, 40, () => new Date(t0), (i) => `Bare${i}`);
      // One customer with 120 open leads (its own pages) and some closed ones.
      busyCustomer = await addCustomer(big.org, { first_name: 'Busy', last_name: 'Owner' });
      busyLeads = await bulkLeads(big.org, Array.from({ length: 120 }, () => busyCustomer));
      // Every busy lead at its own service address (each row's address loads with the page, never one lookup a row).
      const busyLoc = await addLocation(busyCustomer, '1 Busy Road', 'Springfield');
      await db.lead.updateMany({ where: { id: { in: busyLeads } }, data: { service_location_id: busyLoc } });
      await bulkLeads(big.org, Array.from({ length: 5 }, () => busyCustomer), { closed: true });
      withOpen = new Set([...open, busyCustomer, big.customer]);
      await addLead(big.org, big.customer);
      // 130 excluded open leads, spread over customers, so the Excluded list has three pages.
      bigExcluded = [...openLeads.slice(0, 100), ...busyLeads.slice(0, 30)];
      await db.spiderSettings.create({ data: { organization_id: big.org, excluded_lead_ids: bigExcluded } });

      // The small company: 3 customers with open leads, one excluded lead, one owner.
      s1 = await addCustomer(small.org, { first_name: 'Small', last_name: 'One', email: 'one@small.example' });
      const s2 = await addCustomer(small.org, { first_name: 'Small', last_name: 'Two', email: 'two@small.example' });
      const sLead = await addLead(small.org, s1, { location: await addLocation(s1, '2 Small Lane', 'Springfield') });
      await addLead(small.org, s2);
      await addLead(small.org, small.customer);
      await db.spiderSettings.create({ data: { organization_id: small.org, excluded_lead_ids: [sLead] } });
    }, 300_000);

    it('GET /spider/customers: pages of at most 50 with a cursor, visiting every customer with open leads exactly once', async () => {
      const { rows, sizes } = await walk(await bigApi(), CUSTOMERS, 'customers');
      expect(sizes.every((n) => n <= 50)).toBe(true);
      expect(sizes.slice(0, -1).every((n) => n === 50)).toBe(true);
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids)).toEqual(withOpen);
      expect(ids.length).toBeGreaterThan(2000);
      // A search pages too, over the matches only.
      const searched = await walk(await bigApi(), CUSTOMERS, 'customers', 'Open1');
      expect(searched.sizes.every((n) => n <= 50)).toBe(true);
      // Open1, Open10-19, Open100-199, Open1000-1999: 1 + 10 + 100 + 1000.
      expect(searched.rows).toHaveLength(1111);
      // Every page of a search carries the same total of all its matches.
      const firstPage = (await (await bigApi()).get(`${CUSTOMERS}?q=Open1`)).body;
      expect(firstPage.total).toBe(1111);
      const nextPage = (await (await bigApi()).get(`${CUSTOMERS}?q=Open1&cursor=${encodeURIComponent(firstPage.next_cursor)}`)).body;
      expect(nextPage.total).toBe(1111);
    }, 300_000);

    it('GET /spider/customers/:id/leads and GET /spider/excluded page the same way', async () => {
      const busy = await walk(await bigApi(), customerLeads(busyCustomer), 'leads');
      expect(busy.sizes).toEqual([50, 50, 20]);
      expect(new Set(busy.rows.map((r) => r.id))).toEqual(new Set(busyLeads));
      const excl = await walk(await bigApi(), EXCLUDED, 'leads');
      expect(excl.sizes).toEqual([50, 50, 30]);
      expect(new Set(excl.rows.map((r) => r.id))).toEqual(new Set(bigExcluded));
      expect((await (await bigApi()).get(OVERVIEW)).body).toEqual({ watched: 2050 + 120 + 1 - 130, excluded: 130 });
      // A busy customer's row counts its open leads and its excluded ones.
      const row = (await (await bigApi()).get(`${CUSTOMERS}?q=Busy`)).body.customers[0];
      expect(row).toMatchObject({ id: busyCustomer, open_leads: 120, excluded_leads: 30 });
    }, 300_000);

    it('every endpoint runs the same number of queries for 3 customers as for 2,000+', async () => {
      const [bigLead, smallLead] = await Promise.all([
        db.lead.findFirstOrThrow({ where: { organization_id: big.org, customer_id: big.customer } }),
        db.lead.findFirstOrThrow({ where: { organization_id: small.org, customer_id: small.customer } }),
      ]);
      const requests: [string, (api: Api, c: Company, lead: string) => Promise<unknown>][] = [
        ['overview', (api) => api.get(OVERVIEW)],
        ['customers', (api) => api.get(CUSTOMERS)],
        ['customers searched', (api) => api.get(`${CUSTOMERS}?q=Pat`)],
        // A search that matches many customers in the big company (its total counts them all) against few.
        ['customers searched widely', (api) => api.get(`${CUSTOMERS}?q=e`)],
        // The busy customer's first page (50 leads, each with an address) against the small company's one lead.
        ['customer leads', (api, c) => api.get(customerLeads(c === big ? busyCustomer : s1))],
        ['excluded', (api) => api.get(EXCLUDED)],
        ['excluded searched', (api) => api.get(`${EXCLUDED}?q=a`)],
        ['save', (api, _c, lead) => api.patch(EXCLUSIONS, { exclude: [lead], include: [] })],
      ];
      const counts: Record<string, [number, number]> = {};
      for (const [name, call] of requests) {
        // Once each first, so anything the sign-in caches is warm for both.
        await call(await smallApi(), small, smallLead.id);
        await call(await bigApi(), big, bigLead.id);
        const asSmall = await smallApi();
        const s = await countQueries(() => call(asSmall, small, smallLead.id));
        const asBig = await bigApi();
        const b = await countQueries(() => call(asBig, big, bigLead.id));
        counts[name] = [s.count, b.count];
      }
      console.log('[3435 query counts] small vs 2,000+ customers', JSON.stringify(counts));
      for (const [name, [s, b]] of Object.entries(counts)) expect(b, name).toBe(s);
    }, 300_000);
  });
});

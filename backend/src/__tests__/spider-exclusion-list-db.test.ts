/* =============================================================================
   #3434: Spider watches every open lead minus an exclusion list (Ran, 3 Nov: every open lead is watched by default, new
   ones included; any lead can be excluded). #3436: the picker changes the list through PATCH /spider/exclusions alone;
   the settings save (PUT /spider/settings) never writes it.

   1. The real journey, over HTTP on a real migrated database. An Admin saves the settings, excludes one lead with the
      picker's Save (PATCH /spider/exclusions) and activates. Then:
        - the starting summary holds every overdue lead but the excluded one;
        - a lead created after the exclusion is watched: a settings save afterwards keeps it watched, and it alerts once
          it is overdue (the bug #3434 fixed: the old selection quietly stopped new leads being watched);
        - the excluded lead never alerts and never appears in a summary; closed, saved over and reopened, it is still
          excluded;
        - including it again records SCOPE_WIDENED; excluding records no trigger.
   2. The settings save never touches the exclusion list (#3436): a save from an older screen that still sends its lead
      selection is refused (409) and stores nothing, and a save racing the picker's Save never undoes the exclusion.
   3. The query count of a sweep does not grow with the exclusion list (the counting rule of #2985: the other companies
      retired and settled, then one company's first sweep alone): 1 excluded lead and 550 excluded leads run the same
      number of every kind of query, no query carries the excluded leads' ids, and the excluded overdue lead gets no alert.

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
import { countQueries, type CountedQuery } from './support/query-counter';
import { runSpiderSweep } from '../services/spider/sweep';
import { SPIDER_SWEEP_LEASE } from '../services/spider/sweepLease';

const suite = realClient ? describe : describe.skip;

const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const SUMMARY = '/api/ai-farm/spider/summary';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Each query as "<statement kind> <first table>", e.g. "SELECT leads", "INSERT notifications", "BEGIN". */
function kindOf(sql: string): string {
  const s = sql.trim();
  if (/set_config\(/i.test(s)) return 'SELECT set_config';
  const kind = (s.match(/^\w+/)?.[0] ?? '?').toUpperCase();
  const table = s.match(/(?:FROM|INTO|UPDATE)\s+(?:"public"\.)?"?(\w+)"?/i)?.[1];
  return table ? `${kind} ${table}` : kind;
}
function byKind(queries: CountedQuery[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of queries) out[kindOf(q.sql)] = (out[kindOf(q.sql)] ?? 0) + 1;
  return out;
}

/** A settings save: New watched at 2 hours, in-app alerts to the Admins. `extra` adds the fields an older screen sends. */
function settingsSave(extra: Record<string, unknown> = {}) {
  return {
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
    ...extra,
  };
}

suite('Spider exclusion list (#3434, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const clearLease = () => db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = $1`, SPIDER_SWEEP_LEASE);
  const orgs: string[] = [];

  /** This file's companies leave the sweep: their Spider settings, alerts, summaries and records go. */
  async function retireCompanies() {
    if (!orgs.length) return;
    await db.notification.deleteMany({ where: { organization_id: { in: orgs }, verb: { startsWith: 'spider.' } } });
    await db.spiderAlert.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.spiderSummary.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.spiderSettings.deleteMany({ where: { organization_id: { in: orgs } } });
  }

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(retireCompanies());
    await quietly(clearLease());
    await fx.cleanup();
  }, 180_000);

  interface Company { org: string; admin: Person; customer: string }

  /** A Scale demo company. */
  async function company(): Promise<Company> {
    const { org, admin, customer } = await fx.newOrg();
    orgs.push(org);
    await db.organization.update({ where: { id: org }, data: { is_demo: true } });
    return { org, admin, customer };
  }

  /** `n` New leads created `ago` ms before `now`; their ids, in creation order. */
  async function addLeads(c: Company, n: number, ago: number, now: Date = new Date()): Promise<string[]> {
    const ids = Array.from({ length: n }, () => randomUUID());
    await db.lead.createMany({
      data: ids.map((id) => ({
        id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        status: 'NEW' as const, created_at: new Date(now.getTime() - ago),
      })),
    });
    return ids;
  }

  const sweepAt = async (when: Date) => {
    await clearLease();
    const r = await runSpiderSweep(when);
    expect(r.ran).toBe(true);
    return r;
  };
  const stored = (org: string) =>
    db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org }, select: { excluded_lead_ids: true, summary_trigger_kind: true } });
  const alertedLeads = async (org: string) =>
    (await db.spiderAlert.findMany({ where: { organization_id: org }, select: { lead_id: true, kind: true } }));

  // ─── 1. The journey ──────────────────────────────────────────────────────────────────────────────

  it('an excluded lead never alerts nor appears in the summary, a lead created afterwards is watched, and including it again widens', async () => {
    const c = await company();
    const api = await fx.signedInAs(c.admin);
    const t0 = new Date();
    const [excluded, watched] = await addLeads(c, 2, 5 * HOUR, t0);
    const [won] = await addLeads(c, 1, 5 * HOUR, t0);
    await db.lead.update({ where: { id: won! }, data: { status: 'WON', won_at: t0 } });

    // Saved while Not active, one lead excluded with the picker's Save, then activated (#3431).
    expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
    const picked = await api.patch(EXCLUSIONS, { exclude: [excluded!], include: [] });
    expect(picked.status).toBe(200);
    expect(picked.body).toEqual({ watched: 1, excluded: 1 });
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    expect((await stored(c.org)).excluded_lead_ids).toEqual([excluded]);

    // The starting summary, once the settings are quiet: every overdue lead but the excluded one.
    await sweepAt(new Date(t0.getTime() + 15 * MIN));
    const summary = await api.get(SUMMARY);
    expect(summary.status).toBe(200);
    expect(summary.body.summary.leads.map((l: { lead_id: string }) => l.lead_id)).toEqual([watched]);

    // A lead created after the exclusion is watched, and a settings save afterwards keeps it so.
    const [later] = await addLeads(c, 1, 5 * HOUR, new Date(t0.getTime() + 16 * MIN));
    expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [excluded], summary_trigger_kind: null });

    await sweepAt(new Date(t0.getTime() + 20 * MIN));
    expect(await alertedLeads(c.org)).toEqual(expect.arrayContaining([
      { lead_id: watched, kind: 'SUMMARIZED' },
      { lead_id: later, kind: 'ALERTED' },
    ]));
    expect((await alertedLeads(c.org)).filter((a) => a.lead_id === excluded)).toEqual([]);

    // Closed, saved over and reopened: still excluded.
    await db.lead.update({ where: { id: excluded! }, data: { status: 'WON', won_at: new Date() } });
    expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
    expect((await stored(c.org)).excluded_lead_ids).toEqual([excluded]);
    await db.lead.update({ where: { id: excluded! }, data: { status: 'NEW', won_at: null } });
    await sweepAt(new Date(t0.getTime() + 25 * MIN));
    expect((await alertedLeads(c.org)).filter((a) => a.lead_id === excluded)).toEqual([]);

    // Included again: more leads under watch.
    expect((await api.patch(EXCLUSIONS, { exclude: [], include: [excluded!] })).status).toBe(200);
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [], summary_trigger_kind: 'SCOPE_WIDENED' });
  }, 120_000);

  it("excluding a lead records no trigger, and another company's lead is never stored", async () => {
    const c = await company();
    const other = await company();
    const api = await fx.signedInAs(c.admin);
    const [a, b] = await addLeads(c, 2, 0);
    const [theirs] = await addLeads(other, 1, 0);
    expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    await db.spiderSettings.update({
      where: { organization_id: c.org },
      data: { summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
    });

    expect((await api.patch(EXCLUSIONS, { exclude: [b!, theirs!], include: [] })).status).toBe(200);
    expect(await stored(c.org)).toEqual({ excluded_lead_ids: [b], summary_trigger_kind: null });
    expect((await api.patch(EXCLUSIONS, { exclude: [a!], include: [] })).status).toBe(200);
    expect([...(await stored(c.org)).excluded_lead_ids].sort()).toEqual([a, b].sort());
    expect((await stored(c.org)).summary_trigger_kind).toBeNull();
  }, 60_000);

  // ─── 2. The settings save never writes the list (#3436) ─────────────────────────────────────────

  describe('the settings save never touches the exclusion list', () => {
    it("refuses an older screen's save (409, its sentence, nothing stored), sends no lead list back, and keeps a lead created after the page loaded watched", async () => {
      const c = await company();
      const api = await fx.signedInAs(c.admin);
      const [kept, excluded] = await addLeads(c, 2, 0);
      expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
      expect((await api.patch(EXCLUSIONS, { exclude: [excluded!], include: [] })).status).toBe(200);
      // A lead created after the page loaded: the old translation excluded it, as it was not among the ids sent.
      await addLeads(c, 1, 0);
      const row = () =>
        db.spiderSettings.findUniqueOrThrow({
          where: { organization_id: c.org },
          select: { status_limits: true, channels: true, recipients: true, excluded_lead_ids: true, summary_trigger_kind: true, updated_at: true },
        });
      const before = await row();

      // A screen from before #3436 still sends its lead selection: refused, and nothing it carries is stored, not even
      // its other settings (here a channel switched on), so it never says "Saved".
      for (const extra of [
        { watch_all_leads: false, selected_lead_ids: [kept!] },
        { watch_all_leads: true, selected_lead_ids: [] },
        { watch_all_leads: true },
        { selected_lead_ids: [] },
      ]) {
        const res = await api.put(SETTINGS, { ...settingsSave(extra), channels: { in_app: true, red_frame: true, email: true, text: false } });
        expect(res.status, JSON.stringify(extra)).toBe(409);
        expect(res.body).toEqual({ error: 'This page is out of date. Reload it and save again.' });
        expect(await row(), JSON.stringify(extra)).toEqual(before);
      }

      // Today's screen saves; the list stays as the picker left it, and no lead list comes back.
      const res = await api.put(SETTINGS, settingsSave());
      expect(res.status).toBe(200);
      expect((await stored(c.org)).excluded_lead_ids).toEqual([excluded]);
      expect(res.body.selected_leads).toBeUndefined();
      expect(res.body.settings).not.toHaveProperty('selected_lead_ids');
      expect(res.body.settings).not.toHaveProperty('watch_all_leads');
      const read = await api.get(SETTINGS);
      expect(read.body.selected_leads).toBeUndefined();
      expect(read.body.settings).not.toHaveProperty('selected_lead_ids');
      // Watched: the kept lead and the one created after the page loaded.
      expect((await api.get('/api/ai-farm/spider/overview')).body).toEqual({ watched: 2, excluded: 1 });
    }, 60_000);

    it("a settings save that read the list before the picker's Save landed never writes it back", async () => {
      const c = await company();
      const api = await fx.signedInAs(c.admin);
      const [lead] = await addLeads(c, 1, 0);
      expect((await api.put(SETTINGS, settingsSave())).status).toBe(200);
      // The race made certain, not left to timing: the settings save is held just before its write, after it has read
      // the row (with the list still empty); the picker's Save excludes the lead meanwhile; then the settings save
      // writes. A settings save that wrote the list it read would put the lead back under watch.
      const client = realClient!;
      const write = client.spiderSettings.updateMany.bind(client.spiderSettings);
      let atWrite!: () => void;
      const reachedWrite = new Promise<void>((r) => (atWrite = r));
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const hold = vi.spyOn(client.spiderSettings, 'updateMany').mockImplementation((async (args: { data?: object }) => {
        if (args?.data && 'status_limits' in args.data) {
          atWrite();
          await released;
        }
        return write(args as never);
      }) as never);
      try {
        const put = api.put(SETTINGS, settingsSave()).then((r) => r);
        await reachedWrite;
        const patch = await api.patch(EXCLUSIONS, { exclude: [lead!], include: [] });
        expect(patch.status).toBe(200);
        expect((await stored(c.org)).excluded_lead_ids).toEqual([lead]);
        release();
        expect((await put).status).toBe(200);
      } finally {
        release();
        hold.mockRestore();
      }
      expect((await stored(c.org)).excluded_lead_ids).toEqual([lead]);
    }, 60_000);
  });

  // ─── 3. The query count ──────────────────────────────────────────────────────────────────────────

  describe('the query count does not grow with the exclusion list', () => {
    const OPEN = 600; // two pages of open leads

    /** One count: the other companies retired and settled, then this company's first sweep alone. */
    async function countFor(excludedCount: number) {
      await retireCompanies();
      const T = new Date();
      await sweepAt(T);
      const c = await company();
      const quiet = await addLeads(c, OPEN, 0, T);
      const [overdueWatched, overdueExcluded] = await addLeads(c, 2, 5 * HOUR, T);
      const excluded = [overdueExcluded!, ...quiet.slice(0, excludedCount - 1)];
      const off = { enabled: false, value: 1, unit: 'DAY' };
      await db.spiderSettings.create({
        data: {
          organization_id: c.org, is_active: true, activated_at: new Date(T.getTime() - 24 * HOUR),
          status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
          channels: { in_app: true, red_frame: true, email: false, text: false },
          recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
          excluded_lead_ids: excluded,
        },
      });
      await clearLease();
      const { count, queries, result } = await countQueries(() => runSpiderSweep(T));
      expect(result.ran).toBe(true);
      // The counted run did the work: the watched overdue lead alerted, the excluded one did not.
      expect(await alertedLeads(c.org)).toEqual([{ lead_id: overdueWatched, kind: 'ALERTED' }]);
      // The list is left out in memory: no statement carries the excluded leads' ids (one id at most: a page's keyset
      // cursor is the last lead of the page before, which may be an excluded one).
      const carrying = queries.filter((q) => excluded.filter((id) => q.params.includes(id)).length > 1);
      expect(carrying.map((q) => q.sql)).toEqual([]);
      return { total: count, kinds: byKind(queries) };
    }

    it('1 excluded lead and 550 run the same number of every kind of query', async () => {
      const one = await countFor(1);
      const many = await countFor(550);
      console.info(`[3434 counts] 1 excluded: ${one.total}; 550 excluded: ${many.total}`);
      expect(many.kinds).toEqual(one.kinds);
      expect(many.total).toBe(one.total);
    }, 180_000);
  });
});

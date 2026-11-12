/* =============================================================================
   Spider activation (#3431): Spider works like an integration (Ran, 10 Nov). Its settings are saved while Not active
   and that starts nothing; Activate, after the review, starts it; the review's numbers come from the server.

   The journey, over HTTP on the real app and a real migrated database: an Admin saves the settings while Spider is Not
   active (nothing is sent), reads the activation preview, presses Activate, and the sweep's starting summary covers
   exactly the leads and people the preview counted. Activate with Skip sends nothing for the backlog. Then the refusals: Activate with no time limit, the preview for
   someone who is not an Admin, for a company without Spider, and never another company's numbers.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The app's database URL points at the same test database as the client above (the sweep's lease is one row for the
// whole database, so the DB test files run one at a time, as CI runs them).
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { runSpiderSweep } from '../services/spider/sweep';
import { clearLease, onlyThisCompany } from './support/spider-summary-world';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const PREVIEW = '/api/ai-farm/spider/activation-preview';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** New at two hours and Contacted at one day watched; Walkthrough Completed not. Admins and each lead's owner told. */
const SETTINGS_BODY = {
  status_limits: {
    NEW: { enabled: true, value: 2, unit: 'HOUR' },
    CONTACTED: { enabled: true, value: 1, unit: 'DAY' },
    WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
  },
  channels: { in_app: true, red_frame: true, email: false, text: false },
  recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true },
};

suite('Spider activation (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  async function spiderOrg() {
    const o = await fx.newOrg();
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    return o;
  }

  /** A lead whose times put it where a test needs it. */
  async function lead(org: string, customer: string, data: Record<string, unknown>, owner?: string) {
    const l = await fx.addLead(org, customer, owner ? { owner } : {});
    await db.lead.update({ where: { id: l.id }, data });
    return l.id;
  }

  /**
   * A company with leads in several statuses: what the sweep watches and what is already past its limit.
   *   watched, past the limit:   a New lead 5 h old; a Contacted lead contacted 3 days ago; a New lead 5 h old owned by Sales
   *   watched, within the limit: a New lead made just now
   *   not watched:               a Walkthrough Completed lead (its limit is off), an Estimate Sent lead (no Spider stage),
   *                              a Won lead and a cancelled New lead (not open)
   */
  async function companyWithLeads() {
    const o = await spiderOrg();
    const sales = await fx.addUser(o.org, 'owner', 'SALES');
    const ago = (ms: number) => new Date(Date.now() - ms);
    const newLeads = [
      await lead(o.org, o.customer, { created_at: ago(5 * HOUR) }),
      await lead(o.org, o.customer, { created_at: ago(5 * HOUR) }, sales.id),
    ];
    const contactedLead = await lead(o.org, o.customer, { status: 'CONTACTED', created_at: ago(4 * DAY), contacted_at: ago(3 * DAY) });
    const pastLimit = [...newLeads, contactedLead].sort();
    const fresh = await lead(o.org, o.customer, {});
    const walkthrough = await lead(o.org, o.customer, { status: 'WALKTHROUGH_COMPLETED', created_at: ago(9 * DAY), contacted_at: ago(8 * DAY), walkthrough_first_booked_at: ago(7 * DAY), last_visit_completed_at: ago(6 * DAY) });
    await lead(o.org, o.customer, { status: 'ESTIMATED', created_at: ago(9 * DAY), first_estimate_sent_at: ago(5 * DAY) });
    await lead(o.org, o.customer, { status: 'WON', created_at: ago(9 * DAY), won_at: ago(2 * DAY) });
    await lead(o.org, o.customer, { created_at: ago(5 * HOUR), cancelled_at: ago(HOUR) });
    return { ...o, sales, pastLimit, newLeads: newLeads.sort(), contactedLead, fresh, walkthrough };
  }

  it('an Admin saves while Not active (nothing is sent), reads the review, activates, and the starting summary is what the review counted', async () => {
    const c = await companyWithLeads();
    const api = await fx.signedInAs(c.admin);
    const later = () => new Date(Date.now() + 15 * 60_000);

    // Saved while Not active: stored, no trigger, and the sweep sends nothing for the company.
    expect((await api.put(SETTINGS, SETTINGS_BODY)).status).toBe(200);
    expect(await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).toMatchObject({
      is_active: false, activated_at: null, summary_trigger_at: null,
    });
    await onlyThisCompany(db, c.org);
    await clearLease(db);
    expect((await runSpiderSweep(later())).ran).toBe(true);
    expect(await db.spiderAlert.count({ where: { organization_id: c.org } })).toBe(0);
    expect(await db.spiderSummary.count({ where: { organization_id: c.org } })).toBe(0);

    // The review's numbers: counts only.
    const preview = await api.get(PREVIEW);
    expect(preview.status).toBe(200);
    // Six open leads (Won and cancelled are not), none excluded; three past their limit, for two people.
    expect(preview.body).toEqual({ watchedLeads: 6, excludedLeads: 0, pastLimitLeads: 3, summaryRecipients: 2 });

    // Activate (startingSummary left out reads as send): the sweep's starting summary covers those leads and people.
    expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
    await clearLease(db);
    const swept = await runSpiderSweep(later());
    expect(swept.ran).toBe(true);
    const claims = await db.spiderAlert.findMany({ where: { organization_id: c.org }, select: { lead_id: true, kind: true, recipient_ids: true } });
    expect(claims.every((r) => r.kind === 'SUMMARIZED')).toBe(true);
    expect(claims.map((r) => r.lead_id).sort()).toEqual(c.pastLimit);
    expect(claims).toHaveLength(preview.body.pastLimitLeads);
    const people = new Set(claims.flatMap((r) => r.recipient_ids));
    expect([...people].sort()).toEqual([c.admin.id, c.sales.id].sort());
    expect(people.size).toBe(preview.body.summaryRecipients);
  }, 120_000);

  it('the preview follows the saved settings: every open lead minus the excluded ones, past-limit only with a time limit on', async () => {
    const c = await companyWithLeads();
    const api = await fx.signedInAs(c.admin);
    // No settings yet: every open lead would be watched, none is past a limit (no limit is on).
    expect((await api.get(PREVIEW)).body).toEqual({ watchedLeads: 6, excludedLeads: 0, pastLimitLeads: 0, summaryRecipients: 0 });

    // Only one lead kept (the picker's Save excludes the other five open leads).
    const kept = c.pastLimit[0]!;
    const others = (await db.lead.findMany({ where: { organization_id: c.org, id: { not: kept } }, select: { id: true } })).map((l) => l.id);
    expect((await api.put(SETTINGS, SETTINGS_BODY)).status).toBe(200);
    expect((await api.patch(EXCLUSIONS, { exclude: others, include: [] })).status).toBe(200);
    const one = (await api.get(PREVIEW)).body;
    expect(one).toMatchObject({ watchedLeads: 1, excludedLeads: 5, pastLimitLeads: 1 });
    expect(one.summaryRecipients).toBeGreaterThanOrEqual(1);

    // An excluded lead that closes stays on the list (#3434) but is no longer counted, as in the picker header:
    // watched + excluded is always the open leads.
    const closing = (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).excluded_lead_ids[0]!;
    await db.lead.update({ where: { id: closing }, data: { status: 'WON', won_at: new Date() } });
    expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).excluded_lead_ids).toContain(closing);
    expect((await api.get(PREVIEW)).body).toMatchObject({ watchedLeads: 1, excludedLeads: 4 });

    // A row with every limit off (stored before the save rules): leads are watched, none is past a limit.
    await db.spiderSettings.update({ where: { organization_id: c.org }, data: { status_limits: {}, excluded_lead_ids: [] } });
    expect((await api.get(PREVIEW)).body).toEqual({ watchedLeads: 5, excludedLeads: 0, pastLimitLeads: 0, summaryRecipients: 0 });
  });

  // Ran, 10 Nov (M1 Q1 A, and the ruling after verifier r1): "Skip them" covers ONLY the stays already past their limit at the
  // moment of Activate. Anything that goes past its limit later, for any reason, is alerted (or summarized) as normal.
  describe('Activate with Skip', () => {
    const MIN = 60_000;
    const at = (ms: number) => new Date(Date.now() + ms);
    const row = (org: string) => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
    const rows = (org: string) => db.spiderAlert.findMany({ where: { organization_id: org }, select: { lead_id: true, kind: true } });
    const sweep = async (org: string, when: Date) => {
      await onlyThisCompany(db, org);
      await clearLease(db);
      expect((await runSpiderSweep(when)).ran).toBe(true);
    };
    const save = async (api: Awaited<ReturnType<typeof fx.signedInAs>>, limits: Record<string, unknown>) =>
      expect((await api.put(SETTINGS, { ...SETTINGS_BODY, status_limits: { ...SETTINGS_BODY.status_limits, ...limits } })).status).toBe(200);

    it('sends nothing for the stays past their limit at Activate, and alerts a lead that passes its limit afterwards', async () => {
      const c = await companyWithLeads();
      const api = await fx.signedInAs(c.admin);
      // Passes its two-hour New limit ten minutes after the Activate below.
      const soon = await lead(c.org, c.customer, { created_at: new Date(Date.now() - 2 * HOUR + 10 * MIN) });
      await save(api, {});

      const res = await api.put(STATUS, { isActive: true, startingSummary: 'skip' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: true, isSetUp: true });
      const activated = await row(c.org);
      expect(activated).toMatchObject({ is_active: true, summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null });
      expect(activated.backlog_skipped_at).toEqual(activated.activated_at);
      expect(activated.backlog_skipped_stays.map((k) => k.split('|')[0]).sort()).toEqual(c.pastLimit);

      await sweep(c.org, at(15 * MIN));
      expect(await db.spiderSummary.count({ where: { organization_id: c.org } })).toBe(0);
      expect(await rows(c.org)).toEqual([{ lead_id: soon, kind: 'ALERTED' }]);
    }, 120_000);

    it('a status switched on, a shortened limit and a lead included again after Skip bring their overdue leads in; the skipped stays never come back', async () => {
      const c = await companyWithLeads();
      const api = await fx.signedInAs(c.admin);
      // Contacted 3 days ago: within a 5-day limit at Activate, past a 1-day one.
      const contacted = await lead(c.org, c.customer, { status: 'CONTACTED', created_at: new Date(Date.now() - 4 * DAY), contacted_at: new Date(Date.now() - 3 * DAY) });
      // Past its New limit at Activate, but excluded then.
      const excluded = await lead(c.org, c.customer, { created_at: new Date(Date.now() - 5 * HOUR) });
      await save(api, { CONTACTED: { enabled: true, value: 5, unit: 'DAY' } });
      expect((await api.patch(EXCLUSIONS, { exclude: [excluded], include: [] })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      // Skipped: only the two New leads past their limit. Both Contacted leads are within five days, the Walkthrough
      // Completed lead's status is off and the excluded lead is not watched.
      const skippedLeads = (await row(c.org)).backlog_skipped_stays.map((k) => k.split('|')[0]).sort();
      expect(skippedLeads).toEqual(c.newLeads);

      // 1. A status switched on: its overdue lead is summarized (STAGE_ADDED).
      await save(api, { CONTACTED: { enabled: true, value: 5, unit: 'DAY' }, WALKTHROUGH_COMPLETED: { enabled: true, value: 1, unit: 'DAY' } });
      expect((await row(c.org)).summary_trigger_kind).toBe('STAGE_ADDED');
      await sweep(c.org, at(15 * MIN));
      expect(await rows(c.org)).toEqual([{ lead_id: c.walkthrough, kind: 'SUMMARIZED' }]);

      // 2. A shortened limit: both Contacted leads, now past it, are summarized (LIMIT_SHORTENED).
      await save(api, { CONTACTED: { enabled: true, value: 1, unit: 'DAY' }, WALKTHROUGH_COMPLETED: { enabled: true, value: 1, unit: 'DAY' } });
      expect((await row(c.org)).summary_trigger_kind).toBe('LIMIT_SHORTENED');
      await sweep(c.org, at(30 * MIN));
      expect((await rows(c.org)).filter((r) => r.kind === 'SUMMARIZED').map((r) => r.lead_id).sort()).toEqual([c.walkthrough, contacted, c.contactedLead].sort());

      // 3. A lead included again: it is summarized (SCOPE_WIDENED).
      expect((await api.patch(EXCLUSIONS, { exclude: [], include: [excluded] })).status).toBe(200);
      expect((await row(c.org)).summary_trigger_kind).toBe('SCOPE_WIDENED');
      await sweep(c.org, at(45 * MIN));
      const all = await rows(c.org);
      expect(all.map((r) => r.lead_id).sort()).toEqual([c.walkthrough, contacted, c.contactedLead, excluded].sort());
      // The stays skipped at Activate (the two New leads) were never reported.
      for (const id of skippedLeads) expect(all.map((r) => r.lead_id)).not.toContain(id);
    }, 180_000);

    it('a skipped lead that leaves its stage and comes back is alerted for the new stay', async () => {
      const c = await companyWithLeads();
      const api = await fx.signedInAs(c.admin);
      await save(api, {});
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      const back = c.pastLimit[0]!;
      expect((await row(c.org)).backlog_skipped_stays.map((k) => k.split('|')[0])).toContain(back);
      // Contacted after the Activate, then back to New: a new New stay, from the moment it came back.
      const cameBack = at(MIN);
      await db.lead.update({ where: { id: back }, data: { status: 'NEW', contacted_at: null, returned_to_new_at: cameBack } });

      // Two hours past its return: the new stay is overdue and alerted; so is the lead made fresh at the start.
      await sweep(c.org, at(2 * HOUR + 5 * MIN));
      const alerted = await rows(c.org);
      expect(alerted.every((r) => r.kind === 'ALERTED')).toBe(true);
      expect(alerted.map((r) => r.lead_id).sort()).toEqual([back, c.fresh].sort());
    }, 120_000);

    it('Skip, Deactivate, a lead goes past its limit while Not active, Activate with Skip again: nothing is sent', async () => {
      const c = await companyWithLeads();
      const api = await fx.signedInAs(c.admin);
      await save(api, {});
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      // While Not active, the fresh lead goes past its two-hour limit (its stay moved back in time).
      await db.lead.update({ where: { id: c.fresh }, data: { created_at: new Date(Date.now() - 3 * HOUR) } });
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      expect((await row(c.org)).backlog_skipped_stays.map((k) => k.split('|')[0]).sort()).toEqual([...c.pastLimit, c.fresh].sort());
      await sweep(c.org, at(15 * MIN));
      expect(await rows(c.org)).toEqual([]);
      expect(await db.spiderSummary.count({ where: { organization_id: c.org } })).toBe(0);
    }, 120_000);

    it('Deactivate, then Activate with Send, clears the skip: the starting summary reports the leads past their limit', async () => {
      const c = await companyWithLeads();
      const api = await fx.signedInAs(c.admin);
      await save(api, {});
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'skip' })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: true, startingSummary: 'send' })).status).toBe(200);
      expect(await row(c.org)).toMatchObject({ backlog_skipped_at: null, backlog_skipped_stays: [], summary_trigger_kind: 'SWITCHED_ON' });

      await sweep(c.org, at(15 * MIN));
      const claims = await rows(c.org);
      expect(claims.map((r) => r.lead_id).sort()).toEqual(c.pastLimit);
      expect(claims.every((r) => r.kind === 'SUMMARIZED')).toBe(true);
    }, 120_000);

    it('Activate checks the limit against the settings it writes: a save switching every limit off in between is refused', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      await save(api, {});
      // Between Activate's read and its write, another Admin's change leaves no limit on (stored before the save rules).
      const update = db.spiderSettings.updateMany.bind(db.spiderSettings);
      const spy = vi.spyOn(db.spiderSettings, 'updateMany').mockImplementationOnce((async (args: Parameters<typeof update>[0]) => {
        await update({ where: { organization_id: org }, data: { status_limits: {} } });
        return update(args);
      }) as never);
      try {
        const res = await api.put(STATUS, { isActive: true });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'Switch on a time limit for at least one status before activating Spider.' });
      } finally {
        spy.mockRestore();
      }
      expect(await row(org)).toMatchObject({ is_active: false, activated_at: null, summary_trigger_at: null });
    });

    // Ran, 10 Nov (final review M3): activation only after the review. A save landing between Activate's read and its
    // write is answered 409 at once; Activate never reads again and goes live on settings the review did not show.
    it.each([
      ['a shorter Contacted limit (the limit stays on)', { status_limits: { ...SETTINGS_BODY.status_limits, CONTACTED: { enabled: true, value: 2, unit: 'HOUR' } } }],
      ['one more excluded lead', { excluded_lead_ids: [randomUUID()] }],
    ])('a change landing during Activate (%s) is 409 "settings changed" on the first try and leaves Spider Not active', async (_what, change) => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      await save(api, {});
      const update = db.spiderSettings.updateMany.bind(db.spiderSettings);
      let writes = 0;
      let changed = false;
      const spy = vi.spyOn(db.spiderSettings, 'updateMany').mockImplementation((async (args: Parameters<typeof update>[0]) => {
        writes += 1;
        // Another Admin's save, once, between the read and the conditional write.
        if (!changed) {
          changed = true;
          await update({ where: { organization_id: org }, data: change });
        }
        return update(args);
      }) as never);
      let res;
      try {
        res = await api.put(STATUS, { isActive: true, startingSummary: 'send' });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Spider's settings changed while you were activating. Check them and activate again." });
      expect(writes).toBe(1);
      expect(await row(org)).toMatchObject({
        is_active: false, activated_at: null, summary_trigger_at: null, summary_trigger_kind: null, backlog_skipped_at: null,
      });
    });

    it('another Admin activating between the read and the write is not a change: 200 Active, activated once', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      await save(api, {});
      const update = db.spiderSettings.updateMany.bind(db.spiderSettings);
      const first = new Date(Date.now() - 60_000);
      const spy = vi.spyOn(db.spiderSettings, 'updateMany').mockImplementationOnce((async (args: Parameters<typeof update>[0]) => {
        await update({ where: { organization_id: org }, data: { is_active: true, activated_at: first } });
        return update(args);
      }) as never);
      let res;
      try {
        res = await api.put(STATUS, { isActive: true, startingSummary: 'send' });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: true, isSetUp: true });
      // The other Admin's activation stands; this one wrote nothing.
      expect(await row(org)).toMatchObject({ is_active: true, activated_at: first });
    });

    // Ran, 10 Nov (final review): a failed Activate or Deactivate says which was tried.
    it.each([
      [true, 'Could not activate Spider. Try again later.'],
      [false, 'Could not deactivate Spider. Try again later.'],
    ])('a failed write when isActive is %s answers 500 "%s"', async (isActive, words) => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      await save(api, {});
      if (!isActive) expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      const spy = vi.spyOn(db.spiderSettings, 'updateMany').mockRejectedValueOnce(new Error('database went away'));
      let res;
      try {
        res = await api.put(STATUS, { isActive });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: words });
      expect((await row(org)).is_active).toBe(!isActive);
    });
  });

  describe('refusals', () => {
    it('Activate with no time limit switched on is 409 in plain words and changes nothing', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const res = await api.put(STATUS, { isActive: true, startingSummary: 'send' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Switch on a time limit for at least one status before activating Spider.' });
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);
    });

    it('only an Admin saves, activates or reads the preview: 403 for Sales, Dispatcher and Technician, changing nothing', async () => {
      const c = await companyWithLeads();
      expect((await (await fx.signedInAs(c.admin)).put(SETTINGS, SETTINGS_BODY)).status).toBe(200);
      const before = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } });
      const people: Person[] = [c.sales, await fx.addUser(c.org, 'dispatcher', 'DISPATCHER'), await fx.addUser(c.org, 'technician', 'TECHNICIAN')];
      for (const person of people) {
        const api = await fx.signedInAs(person);
        for (const res of [await api.get(PREVIEW), await api.put(SETTINGS, SETTINGS_BODY), await api.put(STATUS, { isActive: true })]) {
          expect(res.status, person.email).toBe(403);
          expect(res.body).toEqual({ error: 'Only Admins can manage Spider' });
        }
      }
      expect(await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: c.org } })).toEqual(before);
    });

    it('a company without Spider gets 404 from the preview, a save and Activate, and nothing is created', async () => {
      const { org, admin } = await fx.newOrg(); // Scale, but not a demo company and not on the pilot list
      const api = await fx.signedInAs(admin);
      for (const res of [await api.get(PREVIEW), await api.put(SETTINGS, SETTINGS_BODY), await api.put(STATUS, { isActive: true })]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
      }
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);
    });

    it("the preview counts only the caller's own company", async () => {
      const a = await companyWithLeads();
      const b = await companyWithLeads();
      // B has twice the backlog; A's Admin never sees it.
      await lead(b.org, b.customer, { created_at: new Date(Date.now() - 5 * HOUR) });
      await lead(b.org, b.customer, { created_at: new Date(Date.now() - 5 * HOUR) });
      for (const c of [a, b]) expect((await (await fx.signedInAs(c.admin)).put(SETTINGS, SETTINGS_BODY)).status).toBe(200);
      expect((await (await fx.signedInAs(a.admin)).get(PREVIEW)).body).toEqual({ watchedLeads: 6, excludedLeads: 0, pastLimitLeads: 3, summaryRecipients: 2 });
      expect((await (await fx.signedInAs(b.admin)).get(PREVIEW)).body).toEqual({ watchedLeads: 8, excludedLeads: 0, pastLimitLeads: 5, summaryRecipients: 2 });
    });
  });
});

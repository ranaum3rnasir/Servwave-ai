/* =============================================================================
   Spider lead watcher (#2619) - Seam D: the API over HTTP, real app, real migrated database.

   Every Spider endpoint sits behind the Spider gate (the `spider` feature AND, while the launch is
   demo-only, a demo company), answering 404 otherwise. Settings, History and switching Spider on
   or off are Admin-only (403 for Sales, Dispatcher and Technician); reading the status is open to
   every role; the unread-alerts list is every recipient's own.

   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

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

import { switchFixture, type Person } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const STATUS = '/api/ai-farm/spider/status';

type Limit = { enabled: boolean; value: number; unit: string };

/** A settings save. No `is_active`: the save ignores it (the switch is PUT /spider/status alone). */
function body(overrides: Record<string, unknown> = {}, limits: Record<string, Limit> = {}) {
  return {
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_SCHEDULED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
      ESTIMATED: { enabled: false, value: 3, unit: 'DAY' },
      ...limits,
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients: { roles: [], user_ids: [], lead_owner: true },
    watch_all_leads: true,
    selected_lead_ids: [],
    ...overrides,
  };
}

suite('Spider API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** A company that passes the Spider gate: Scale (the fixture's plan) and a demo company. */
  async function spiderOrg() {
    const o = await fx.newOrg();
    await db.organization.update({ where: { id: o.org }, data: { is_demo: true } });
    return o;
  }

  /** Switches Spider on the only way there is: the switch (PUT /spider/status). */
  async function switchOn(person: Person) {
    const res = await (await fx.signedInAs(person)).put(STATUS, { isActive: true });
    expect(res.status).toBe(200);
  }

  /** A Spider company whose Admin has switched Spider on (its settings open only while on). */
  async function onOrg() {
    const o = await spiderOrg();
    await switchOn(o.admin);
    return o;
  }

  async function staff(org: string) {
    return {
      sales: await fx.addUser(org, 'sales', 'SALES'),
      dispatcher: await fx.addUser(org, 'dispatcher', 'DISPATCHER'),
      technician: await fx.addUser(org, 'technician', 'TECHNICIAN'),
    };
  }

  async function unreadSpiderAlert(org: string, recipient: string, leadId: string, extra: Record<string, unknown> = {}) {
    const n = await db.notification.create({
      data: {
        organization_id: org, verb: 'spider.alert', category: 'LEAD', priority: 'FEED',
        object_type: 'LEAD', object_id: leadId, object_label: 'L-1', title: 'Spider',
        data: { lead_number: 'L-1', customer_name: 'Pat Payer', status: 'NEW', status_label: 'New', ...extra },
      },
    });
    return db.notificationRecipient.create({
      data: { notification_id: n.id, organization_id: org, recipient_id: recipient, priority: 'FEED' },
    });
  }

  async function alertRow(org: string, leadId: string, recipientIds: string[], at: Date, delivery: object = {}) {
    return db.spiderAlert.create({
      data: {
        organization_id: org, lead_id: leadId, status: 'NEW', entered_status_at: at, counted_from: at,
        limit_value: 1, limit_unit: 'HOUR', alerted_at: at, recipient_ids: recipientIds, delivery,
      },
    });
  }

  describe('the gate', () => {
    it('answers 404 on every Spider endpoint for a Scale company that is not a demo company, whatever the role', async () => {
      const { org, admin } = await fx.newOrg();
      const { sales } = await staff(org);
      for (const person of [admin, sales]) {
        const api = await fx.signedInAs(person);
        for (const res of [await api.get(SETTINGS), await api.put(SETTINGS, body()), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: true })]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
        }
      }
    });

    it('answers 404 for a demo company without the spider feature (below Scale)', async () => {
      const { org, admin } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { is_demo: true, plan: 'PRO' } });
      const api = await fx.signedInAs(admin);
      for (const res of [await api.get(SETTINGS), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: false })]) {
        expect(res.status).toBe(404);
      }
      // Nothing was created behind the gate.
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);
    });

    it('answers 404 when the feature is switched off for a Scale demo company', async () => {
      const { org, admin } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { is_demo: true, feature_overrides: { spider: false } } });
      expect((await (await fx.signedInAs(admin)).get(SETTINGS)).status).toBe(404);
    });
  });

  describe('settings', () => {
    it('are 403 for Sales, Dispatcher and Technician, and 200 for an Admin', async () => {
      const { org, admin } = await onOrg();
      const people = await staff(org);
      for (const person of Object.values(people) as Person[]) {
        const api = await fx.signedInAs(person);
        expect((await api.get(SETTINGS)).status).toBe(403);
        expect((await api.put(SETTINGS, body())).status).toBe(403);
      }
      const api = await fx.signedInAs(admin);
      const res = await api.get(SETTINGS);
      expect(res.status).toBe(200);
      // Switched on, nothing set up yet, watching all open leads.
      expect(res.body.settings.is_active).toBe(true);
      expect(res.body.settings.watch_all_leads).toBe(true);
      // The screen draws its unit list from here: Minute, Hour and Day, no Second.
      expect(res.body.options.units.map((u: { value: string }) => u.value)).toEqual(['MINUTE', 'HOUR', 'DAY']);
      expect(res.body.options.statuses.map((s: { value: string }) => s.value)).toEqual([
        'NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED',
      ]);
      expect((await api.put(SETTINGS, body())).status).toBe(200);
    });

    it('rejects unknown statuses, unknown units, and zero or negative limits', async () => {
      const { admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const bad = [
        body({}, { WON: { enabled: true, value: 1, unit: 'DAY' } }),
        body({}, { NEW: { enabled: true, value: 1, unit: 'SECOND' } }),
        body({}, { NEW: { enabled: true, value: 0, unit: 'DAY' } }),
        body({}, { NEW: { enabled: true, value: -3, unit: 'HOUR' } }),
      ];
      for (const b of bad) {
        const res = await api.put(SETTINGS, b);
        expect(res.status, JSON.stringify(b.status_limits)).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      }
      // Nothing was stored by any of them: the settings are still the defaults the switch created.
      const { status_limits } = (await api.get(SETTINGS)).body.settings;
      expect(Object.values(status_limits as Record<string, Limit>).every((l) => !l.enabled && l.value === 1 && l.unit === 'DAY')).toBe(true);
    });

    // Ran, 14 Oct: the switch first, then the setup. Spider may be saved on before any status is.
    it('saves while on with no status switched on, and it reads on and not set up', async () => {
      const { org, admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const res = await api.put(SETTINGS, body({}, { NEW: { enabled: false, value: 2, unit: 'HOUR' } }));
      expect(res.status).toBe(200);
      expect(res.body.settings.is_active).toBe(true);
      expect(res.body.settings.activated_at).toBeTruthy();
      expect(Object.values(res.body.settings.status_limits as Record<string, Limit>).some((l) => l.enabled)).toBe(false);
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: false });
      const { sales } = await staff(org);
      expect((await (await fx.signedInAs(sales)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: false });
    });

    // The burst guard: while Spider was on with nothing switched on it watched nothing, so the
    // first status it is given starts its clock again. Otherwise every lead that sat in that
    // status since Spider was switched on would alert on the next sweep, all at once.
    it('moves activated_at to now when an on Spider is given its first status, and only then', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const row = () => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      const noStatus = { NEW: { enabled: false, value: 2, unit: 'HOUR' } };

      // On from the AI Agentic Farm, before any setup.
      expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      const switchedOn = (await row()).activated_at!;
      expect(switchedOn).not.toBeNull();

      // Saved on again with still nothing switched on: nothing moves.
      await new Promise((r) => setTimeout(r, 15));
      expect((await api.put(SETTINGS, body({}, noStatus))).status).toBe(200);
      expect((await row()).activated_at).toEqual(switchedOn);

      // The first status: the clock starts again from now.
      await new Promise((r) => setTimeout(r, 15));
      const before = Date.now();
      const first = await api.put(SETTINGS, body());
      expect(first.status).toBe(200);
      const restarted = (await row()).activated_at!;
      expect(restarted.getTime()).toBeGreaterThan(switchedOn.getTime());
      expect(restarted.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(new Date(first.body.settings.activated_at).getTime()).toBe(restarted.getTime());

      // A second status, or saving again, while already watching: nothing moves.
      await new Promise((r) => setTimeout(r, 15));
      expect((await api.put(SETTINGS, body({}, { CONTACTED: { enabled: true, value: 1, unit: 'DAY' } }))).status).toBe(200);
      expect((await row()).activated_at).toEqual(restarted);
    });

    // Ran, 14 Oct, layer 3: Spider's settings open only while it is on, and the switch is the only
    // way to turn it on or off.
    it('refuse a save while Spider is off, or before it was ever switched on, with 409, storing nothing', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      // Never switched on: no row, and the save creates none.
      const never = await api.put(SETTINGS, body());
      expect(never.status).toBe(409);
      expect(never.body).toEqual({ error: 'Spider is off. Turn it on to change its settings.' });
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);

      // Switched on, saved, switched off: the save is refused and the stored settings are kept.
      await switchOn(admin);
      expect((await api.put(SETTINGS, body())).status).toBe(200);
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      const before = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      const off = await api.put(SETTINGS, body({ watch_all_leads: false }, { ESTIMATED: { enabled: true, value: 9, unit: 'DAY' } }));
      expect(off.status).toBe(409);
      expect(off.body).toEqual({ error: 'Spider is off. Turn it on to change its settings.' });
      expect(await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).toEqual(before);
    });

    // The frontend and backend deploy separately: a frontend from before the switch moved still
    // sends is_active. It is accepted and ignored, never a 400 and never a switch.
    it('ignores is_active in a save, whichever way it points', async () => {
      const { org, admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const row = () => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });

      const sentOff = await api.put(SETTINGS, { ...body(), is_active: false });
      expect(sentOff.status).toBe(200);
      expect(sentOff.body.settings.is_active).toBe(true);
      expect((await row()).is_active).toBe(true);
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
      const activatedAt = (await row()).activated_at;
      expect(activatedAt).not.toBeNull();

      // is_active true on an on Spider is not "switching on": the clock does not move.
      await new Promise((r) => setTimeout(r, 15));
      const sentOn = await api.put(SETTINGS, { ...body(), is_active: true });
      expect(sentOn.status).toBe(200);
      expect((await row()).activated_at).toEqual(activatedAt);
      expect((await row()).is_active).toBe(true);

      // Off: is_active true in a save never switches it back on.
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await api.put(SETTINGS, { ...body(), is_active: true })).status).toBe(409);
      expect((await row()).is_active).toBe(false);

      // Anything that is not a boolean is still refused.
      expect((await api.put(SETTINGS, { ...body(), is_active: 'yes' })).status).toBe(400);
    });

    it('a second Admin reads the same settings', async () => {
      const { org, admin } = await onOrg();
      const secondAdmin = await fx.addUser(org, 'second-admin', 'ADMIN');
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, body())).status).toBe(200);
      const mine = (await api.get(SETTINGS)).body.settings;
      const theirs = (await (await fx.signedInAs(secondAdmin)).get(SETTINGS)).body.settings;
      expect(theirs).toEqual(mine);
    });

    it("stores only this company's users and leads", async () => {
      const a = await onOrg();
      const b = await spiderOrg();
      const ownLead = await fx.addLead(a.org, a.customer);
      const otherLead = await fx.addLead(b.org, b.customer);
      const api = await fx.signedInAs(a.admin);
      const res = await api.put(SETTINGS, body({
        recipients: { roles: ['SALES'], user_ids: [a.admin.id, b.admin.id], lead_owner: false },
        watch_all_leads: false,
        selected_lead_ids: [ownLead.id, otherLead.id],
      }));
      expect(res.status).toBe(200);
      expect(res.body.settings.recipients.user_ids).toEqual([a.admin.id]);
      expect(res.body.settings.selected_lead_ids).toEqual([ownLead.id]);
      expect(res.body.selected_leads).toEqual([{ id: ownLead.id, lead_number: `L-${ownLead.id.slice(0, 8)}`, customer_name: 'Pat Payer' }]);
    });
  });

  describe('status', () => {
    it('is 200 for every role and reads Off while there is no settings row', async () => {
      const { org, admin } = await spiderOrg();
      const people = await staff(org);
      for (const [label, person] of [['admin', admin], ...Object.entries(people)] as [string, Person][]) {
        const res = await (await fx.signedInAs(person)).get(STATUS);
        expect(res.status, label).toBe(200);
        expect(res.body).toEqual({ isActive: false, isSetUp: false });
      }
    });

    it('follows the switch an Admin sets and the settings an Admin saves, for every role', async () => {
      const { org, admin } = await onOrg();
      const { sales, technician } = await staff(org);
      const adminApi = await fx.signedInAs(admin);
      expect((await adminApi.put(SETTINGS, body())).status).toBe(200);
      for (const person of [admin, sales, technician]) {
        expect((await (await fx.signedInAs(person)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
      }
      expect((await adminApi.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await (await fx.signedInAs(sales)).get(STATUS)).body).toEqual({ isActive: false, isSetUp: true });
    });

    it("reads only the caller's own company", async () => {
      const on = await onOrg();
      const off = await spiderOrg();
      expect((await (await fx.signedInAs(on.admin)).put(SETTINGS, body())).status).toBe(200);
      // No row of its own: another company's switch never reaches it.
      expect((await (await fx.signedInAs(off.admin)).get(STATUS)).body).toEqual({ isActive: false, isSetUp: false });
      expect((await (await fx.signedInAs(on.admin)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });

      // A row of its own that is off reads Off while the other company's is on.
      await db.spiderSettings.create({ data: { organization_id: off.org, is_active: false } });
      expect((await (await fx.signedInAs(off.admin)).get(STATUS)).body).toEqual({ isActive: false, isSetUp: false });
      expect((await (await fx.signedInAs(on.admin)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });

    it('reads set up only while at least one stored status limit is switched on', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      // A row whose limits are all off (or unreadable) is not set up.
      await db.spiderSettings.create({
        data: { organization_id: org, is_active: true, activated_at: new Date(), status_limits: { NEW: { enabled: false, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 0, unit: 'DAY' } } },
      });
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: false });
      expect((await api.put(SETTINGS, body())).status).toBe(200);
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });
  });

  describe('switching Spider on or off (PUT status)', () => {
    const row = (org: string) => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });

    it('is 403 for Sales, Dispatcher and Technician, and changes nothing', async () => {
      const { org, admin } = await onOrg();
      expect((await (await fx.signedInAs(admin)).put(SETTINGS, body())).status).toBe(200);
      const before = await row(org);
      for (const person of Object.values(await staff(org)) as Person[]) {
        for (const isActive of [false, true]) {
          const res = await (await fx.signedInAs(person)).put(STATUS, { isActive });
          expect(res.status).toBe(403);
        }
      }
      expect(await row(org)).toEqual(before);
    });

    // Ran, 14 Oct: the switch always works for an Admin; Spider watches nothing until it is set up.
    it('switches on a company that never set Spider up, creating its row with the default settings', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const before = Date.now();
      const res = await api.put(STATUS, { isActive: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: true, isSetUp: false });
      const created = await row(org);
      expect(created.is_active).toBe(true);
      expect(created.activated_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: false });
      // The settings read as the defaults: every status off, the default channels, nobody chosen.
      const { settings } = (await api.get(SETTINGS)).body;
      expect(settings.is_active).toBe(true);
      expect(Object.values(settings.status_limits as Record<string, Limit>).every((l) => !l.enabled)).toBe(true);
      expect(settings.channels).toEqual({ in_app: true, red_frame: true, email: false, text: false });
      expect(settings.recipients).toEqual({ roles: [], user_ids: [], lead_owner: false });
      expect(settings.watch_all_leads).toBe(true);

      // Off again with nothing set up: straight off.
      expect((await api.put(STATUS, { isActive: false })).body).toEqual({ isActive: false, isSetUp: false });
      expect((await row(org)).is_active).toBe(false);
    });

    it('switches on a company whose stored statuses are all off', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      await db.spiderSettings.create({ data: { organization_id: org, is_active: false, status_limits: { NEW: { enabled: false, value: 2, unit: 'HOUR' } } } });
      const res = await api.put(STATUS, { isActive: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: true, isSetUp: false });
      expect((await row(org)).is_active).toBe(true);
    });

    it('two Admins switching on a company with no row at once leave one row, switched on once', async () => {
      const { org, admin } = await spiderOrg();
      const second = await fx.addUser(org, 'second-admin', 'ADMIN');
      const [a, b] = await Promise.all([fx.signedInAs(admin), fx.signedInAs(second)]);
      const [ra, rb] = await Promise.all([a.put(STATUS, { isActive: true }), b.put(STATUS, { isActive: true })]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(1);
      expect((await row(org)).is_active).toBe(true);
    });

    it('switching off a company with no row answers off and creates nothing', async () => {
      const { org, admin } = await spiderOrg();
      const res = await (await fx.signedInAs(admin)).put(STATUS, { isActive: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: false, isSetUp: false });
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);
    });

    it('rejects a body that is not exactly { isActive: boolean }', async () => {
      const { admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      for (const b of [{}, { isActive: 'yes' }, { isActive: true, status_limits: {} }, { is_active: true }]) {
        const res = await api.put(STATUS, b);
        expect(res.status, JSON.stringify(b)).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      }
    });

    it('switches on and off, moving activated_at only when it goes from off to on, and touches nothing else', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const api = await fx.signedInAs(admin);
      const saved = body(
        {
          channels: { in_app: true, red_frame: false, email: true, text: false },
          recipients: { roles: ['SALES'], user_ids: [admin.id], lead_owner: false },
          watch_all_leads: false,
          selected_lead_ids: [lead.id],
        },
        { ESTIMATED: { enabled: true, value: 5, unit: 'DAY' } },
      );
      // Stored while off, as an earlier settings save left it.
      await db.spiderSettings.create({ data: { organization_id: org, is_active: false, ...saved } });
      const start = await row(org);
      expect(start.activated_at).toBeNull();
      const kept = ({ status_limits, channels, recipients, watch_all_leads, selected_lead_ids }: typeof start) =>
        ({ status_limits, channels, recipients, watch_all_leads, selected_lead_ids });

      const on = await api.put(STATUS, { isActive: true });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ isActive: true, isSetUp: true });
      const afterOn = await row(org);
      expect(afterOn.is_active).toBe(true);
      expect(afterOn.activated_at).not.toBeNull();
      expect(kept(afterOn)).toEqual(kept(start));

      // On again: nothing moves.
      await new Promise((r) => setTimeout(r, 15));
      expect((await api.put(STATUS, { isActive: true })).body).toEqual({ isActive: true, isSetUp: true });
      expect((await row(org)).activated_at).toEqual(afterOn.activated_at);

      // Off: the switch goes off, activated_at and everything else stay.
      const off = await api.put(STATUS, { isActive: false });
      expect(off.body).toEqual({ isActive: false, isSetUp: true });
      const afterOff = await row(org);
      expect(afterOff.is_active).toBe(false);
      expect(afterOff.activated_at).toEqual(afterOn.activated_at);
      expect(kept(afterOff)).toEqual(kept(start));

      // Off again changes nothing; back on moves activated_at forward.
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await row(org)).activated_at).toEqual(afterOn.activated_at);
      await new Promise((r) => setTimeout(r, 15));
      expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      const backOn = await row(org);
      expect(backOn.activated_at!.getTime()).toBeGreaterThan(afterOn.activated_at!.getTime());
      expect(kept(backOn)).toEqual(kept(start));

      // Every role reads the switch the Admin set.
      const { sales } = await staff(org);
      expect((await (await fx.signedInAs(sales)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });

    it("switches only the caller's own company", async () => {
      const a = await spiderOrg();
      const b = await onOrg();
      expect((await (await fx.signedInAs(b.admin)).put(SETTINGS, body())).status).toBe(200);
      const bBefore = await row(b.org);

      expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: true })).status).toBe(200);
      expect((await row(a.org)).is_active).toBe(true);
      expect(await row(b.org)).toEqual(bBefore);

      // Switching a off leaves b on.
      expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: false })).status).toBe(200);
      expect(await row(b.org)).toEqual(bBefore);
      expect((await (await fx.signedInAs(b.admin)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });
  });

  describe('unread alerts', () => {
    it("returns only the caller's own unread Spider alerts, bounded, and the red-frame switch", async () => {
      const { org, admin, customer } = await spiderOrg();
      const { sales } = await staff(org);
      const other = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const otherLead = await fx.addLead(other.org, other.customer);

      const mine = await unreadSpiderAlert(org, sales.id, lead.id, { address: '1 Test Way' });
      await unreadSpiderAlert(org, admin.id, lead.id);
      await unreadSpiderAlert(other.org, other.admin.id, otherLead.id);
      const read = await unreadSpiderAlert(org, sales.id, lead.id);
      await db.notificationRecipient.update({ where: { id: read.id }, data: { read_at: new Date() } });
      // A different verb for the same person and lead is not a Spider alert.
      const bell = await db.notification.create({
        data: { organization_id: org, verb: 'lead.assigned', category: 'LEAD', priority: 'INTERRUPT', object_type: 'LEAD', object_id: lead.id, title: 'x' },
      });
      await db.notificationRecipient.create({ data: { notification_id: bell.id, organization_id: org, recipient_id: sales.id, priority: 'INTERRUPT' } });

      const res = await (await fx.signedInAs(sales)).get(UNREAD);
      expect(res.status).toBe(200);
      expect(res.body.alerts.map((a: { id: string }) => a.id)).toEqual([mine.id]);
      expect(res.body.alerts[0]).toMatchObject({ lead_id: lead.id, customer_name: 'Pat Payer', status_label: 'New', address: '1 Test Way' });
      // No settings row yet: the red frame is off.
      expect(res.body.red_frame).toBe(false);

      await switchOn(admin);
      await (await fx.signedInAs(admin)).put(SETTINGS, body({ channels: { in_app: true, red_frame: true, email: false, text: false } }));
      expect((await (await fx.signedInAs(sales)).get(UNREAD)).body.red_frame).toBe(true);
      // The frame marks an unread in-app alert: with in-app alerts off there is no frame.
      await (await fx.signedInAs(admin)).put(SETTINGS, body({ channels: { in_app: false, red_frame: true, email: false, text: false } }));
      expect((await (await fx.signedInAs(sales)).get(UNREAD)).body.red_frame).toBe(false);
    });

    it('is bounded to 50 alerts', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      for (let i = 0; i < 55; i++) await unreadSpiderAlert(org, admin.id, lead.id);
      const res = await (await fx.signedInAs(admin)).get(UNREAD);
      expect(res.body.alerts).toHaveLength(50);
    });

    it('marking one read through the existing notification endpoint removes it from the list', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const alert = await unreadSpiderAlert(org, admin.id, lead.id);
      const api = await fx.signedInAs(admin);
      expect((await api.patch(`/api/notifications/${alert.id}/read`)).status).toBe(200);
      expect((await api.get(UNREAD)).body.alerts).toEqual([]);
    });
  });

  describe('history', () => {
    it('is 403 for Sales, Dispatcher and Technician, and 200 for an Admin', async () => {
      const { org, admin } = await spiderOrg();
      for (const person of Object.values(await staff(org)) as Person[]) {
        expect((await (await fx.signedInAs(person)).get(HISTORY)).status).toBe(403);
      }
      expect((await (await fx.signedInAs(admin)).get(HISTORY)).status).toBe(200);
    });

    it('paginates newest first, clamps the page size to 100, and returns only this company', async () => {
      const { org, admin, customer } = await spiderOrg();
      const other = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const otherLead = await fx.addLead(other.org, other.customer);
      const t = Date.now();
      const oldest = await alertRow(org, lead.id, [admin.id], new Date(t - 3_000));
      const middle = await alertRow(org, lead.id, [admin.id], new Date(t - 2_000));
      const newest = await alertRow(org, lead.id, [admin.id], new Date(t - 1_000));
      await alertRow(other.org, otherLead.id, [other.admin.id], new Date(t));

      const api = await fx.signedInAs(admin);
      const p1 = await api.get(`${HISTORY}?page=1&page_size=2`);
      expect(p1.status).toBe(200);
      expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual([newest.id, middle.id]);
      expect(p1.body).toMatchObject({ total: 3, page: 1, page_size: 2, total_pages: 2 });
      const p2 = await api.get(`${HISTORY}?page=2&page_size=2`);
      expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual([oldest.id]);

      const big = await api.get(`${HISTORY}?page_size=500`);
      expect(big.status).toBe(200);
      expect(big.body.page_size).toBe(100);
      expect(big.body.items).toHaveLength(3);

      expect((await api.get(`${HISTORY}?page=zero`)).status).toBe(400);
    });

    it('shows delivery outcomes in plain words and never an email address or phone number', async () => {
      const { org, admin, customer } = await spiderOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      await db.user.update({ where: { id: tech.id }, data: { phone: '+16175550123' } });
      await db.user.update({ where: { id: admin.id }, data: { phone: '(617) 555-0199' } });
      const lead = await fx.addLead(org, customer);
      await alertRow(org, lead.id, [admin.id, tech.id], new Date(), {
        in_app: { outcome: 'Shown in the app' },
        email: { outcome: 'Email sent (1 of 2)', recipients: [
          { user_id: admin.id, outcome: 'Email sent' },
          { user_id: tech.id, outcome: 'Email skipped: address is suppressed' },
        ] },
        text: { outcome: 'Text message could not be delivered', recipients: [
          { user_id: admin.id, outcome: 'Text message could not be delivered' },
          { user_id: tech.id, outcome: 'Text message could not be delivered' },
        ] },
      });

      const res = await (await fx.signedInAs(admin)).get(HISTORY);
      const [row] = res.body.items;
      expect(row).toMatchObject({
        lead_id: lead.id,
        customer_name: 'Pat Payer',
        status_label: 'New',
        channels: { in_app: 'Shown in the app', email: 'Email sent (1 of 2)', text: 'Text message could not be delivered' },
      });
      expect(row.recipients).toEqual(expect.arrayContaining([
        { name: 'Test Admin', email_outcome: 'Email sent', text_outcome: 'Text message could not be delivered' },
        { name: 'tech Tester', email_outcome: 'Email skipped: address is suppressed', text_outcome: 'Text message could not be delivered' },
      ]));
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('@');
      expect(json).not.toMatch(/555/);
    });

    it('still returns earlier alerts after Spider is switched off', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const api = await fx.signedInAs(admin);
      await api.put(STATUS, { isActive: true });
      const row = await alertRow(org, lead.id, [admin.id], new Date());
      await api.put(STATUS, { isActive: false });
      const res = await api.get(HISTORY);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([row.id]);
    });
  });
});

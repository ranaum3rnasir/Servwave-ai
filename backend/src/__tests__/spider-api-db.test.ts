/* =============================================================================
   Spider lead watcher (#2619) - Seam D: the API over HTTP, real app, real migrated database.

   Every Spider endpoint sits behind the Spider gate (the `spider` feature AND, while the launch is
   limited, a demo company or a company on the pilot list), answering 404 otherwise. Settings, History and switching Spider on
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

// The app's database URL points at the same test database as the client above. Every other value is
// the shared test env from setup.ts, because this suite boots the whole app. The sweep's lease is one
// row for the whole database, so this assumes the DB test files run one at a time against the test
// database (CI runs them with --no-file-parallelism).
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { randomUUID as randomUUIDv4 } from 'crypto';
import { switchFixture, type Person } from './permission-switches-fixture';
import { recordLeadOutboundContact } from '../services/lead-contact.service';
import { runSpiderSweep } from '../services/spider/sweep';
// The mocked env above (the same object the app reads), so the pilot-list tests can set SPIDER_PILOT_ORG_IDS.
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const STATUS = '/api/ai-farm/spider/status';
const PREVIEW = '/api/ai-farm/spider/activation-preview';
const EXCLUSIONS = '/api/ai-farm/spider/exclusions';

type Limit = { enabled: boolean; value: number; unit: string };

/** A settings save. No `is_active`: the save ignores it (the switch is PUT /spider/status alone). */
function body(overrides: Record<string, unknown> = {}, limits: Record<string, Limit> = {}) {
  return {
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
      ...limits,
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    // Everyone the contractor's defaults choose (config.ts DEFAULT_RECIPIENTS): the people these cases seed alerts for are
    // recipients, as #3462 requires of anyone who keeps a card.
    recipients: { roles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'], user_ids: [], lead_owner: true },
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

  /**
   * The settings an Admin saves before activating (#3431: Activate needs a status with a time limit): Contacted at one
   * day, so a test's own save of `body()` (New at two hours) is a stage switched on.
   */
  const SETUP = body({}, { NEW: { enabled: false, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' } });

  /**
   * Activates Spider the only way there is (PUT /spider/status), after saving SETUP while Not active when nothing with a
   * time limit is stored yet.
   */
  async function switchOn(person: Person) {
    const api = await fx.signedInAs(person);
    if (!(await api.get(STATUS)).body.isSetUp) expect((await api.put(SETTINGS, SETUP)).status).toBe(200);
    const res = await api.put(STATUS, { isActive: true });
    expect(res.status).toBe(200);
  }

  /** A Spider company whose Admin has set Spider up and activated it. */
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

  /**
   * An unread alert for the lead's current stage visit (a NEW lead, from its creation). `priority`
   * lets a test store a row as older code did (#2803 wrote Spider alerts as INTERRUPT).
   * A lead created in the last 10 minutes (just added by the test) is first moved 30 days back, once, so its New stay is past any limit a test sets, as
   * every real alert's lead is: an alert whose lead is not past its stage's limit is not open (#3450).
   */
  async function unreadSpiderAlert(
    org: string, recipient: string, leadId: string, extra: Record<string, unknown> = {}, verb = 'spider.alert',
    priority: 'FEED' | 'INTERRUPT' = 'FEED',
  ) {
    let { created_at } = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { created_at: true } });
    if (created_at.getTime() > Date.now() - 10 * 60_000) {
      created_at = new Date(Date.now() - 30 * 86_400_000);
      await db.lead.update({ where: { id: leadId }, data: { created_at } });
    }
    const n = await db.notification.create({
      data: {
        organization_id: org, verb, category: 'LEAD', priority,
        object_type: 'LEAD', object_id: leadId, object_label: 'L-1', title: 'Spider',
        data: {
          lead_number: 'L-1', customer_name: 'Pat Payer', status: 'NEW', status_label: 'New',
          entered_status_at: created_at.toISOString(), ...extra,
        },
      },
    });
    return db.notificationRecipient.create({
      data: { notification_id: n.id, organization_id: org, recipient_id: recipient, priority },
    });
  }

  /** An alert raised at `at`; by default for a stage visit entered then, in a period it counts from. */
  async function alertRow(
    org: string, leadId: string, recipientIds: string[], at: Date, delivery: object = {},
    visit: { enteredAt?: Date; countedFrom?: Date } = {},
  ) {
    return db.spiderAlert.create({
      data: {
        organization_id: org, lead_id: leadId, status: 'NEW', entered_status_at: visit.enteredAt ?? at, counted_from: visit.countedFrom ?? visit.enteredAt ?? at,
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
        for (const res of [await api.get(SETTINGS), await api.put(SETTINGS, body()), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: true }), await api.get(PREVIEW)]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
        }
      }
    });

    it('answers 404 for a demo company without the spider feature (below Scale)', async () => {
      const { org, admin } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data: { is_demo: true, plan: 'PRO' } });
      const api = await fx.signedInAs(admin);
      for (const res of [await api.get(SETTINGS), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: false }), await api.get(PREVIEW)]) {
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

    // SPEC-5: demo companies plus the companies on the Spider pilot list (SPIDER_PILOT_ORG_IDS). The ids
    // here are made up or the fixture's random ones. Set the list before signing in: the auth layer
    // caches the resolved user by token.
    const pilotEnv = env as { SPIDER_PILOT_ORG_IDS?: string };
    async function withPilotList<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
      const before = pilotEnv.SPIDER_PILOT_ORG_IDS;
      pilotEnv.SPIDER_PILOT_ORG_IDS = value;
      try {
        return await fn();
      } finally {
        pilotEnv.SPIDER_PILOT_ORG_IDS = before;
      }
    }
    const SUMMARY = '/api/ai-farm/spider/history/summary';

    it('still answers 404 everywhere for a non-demo company when the pilot list holds another id', async () => {
      const { org, admin } = await fx.newOrg();
      const { sales } = await staff(org);
      await withPilotList('00000000-0000-4000-8000-0000000000b2', async () => {
        for (const person of [admin, sales]) {
          const api = await fx.signedInAs(person);
          for (const res of [await api.get(SETTINGS), await api.put(SETTINGS, body()), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: true }), await api.get(PREVIEW)]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
          }
        }
      });
    });

    it('opens for a non-demo Scale company on the pilot list: everything for its Admin, status and unread for Sales', async () => {
      const { org, admin } = await fx.newOrg();
      const { sales } = await staff(org);
      await withPilotList(org, async () => {
        const asAdmin = await fx.signedInAs(admin);
        expect((await asAdmin.get(STATUS)).status).toBe(200);
        expect((await asAdmin.get(SETTINGS)).status).toBe(200);
        expect((await asAdmin.put(SETTINGS, body())).status).toBe(200);
        expect((await asAdmin.get(PREVIEW)).status).toBe(200);
        expect((await asAdmin.put(STATUS, { isActive: true })).status).toBe(200);
        expect((await asAdmin.get(HISTORY)).status).toBe(200);
        expect((await asAdmin.get(SUMMARY)).status).toBe(200);
        expect((await asAdmin.get(UNREAD)).status).toBe(200);

        const asSales = await fx.signedInAs(sales);
        expect((await asSales.get(SETTINGS)).status).toBe(403);
        expect((await asSales.get(HISTORY)).status).toBe(403);
        expect((await asSales.get(PREVIEW)).status).toBe(403);
        expect((await asSales.get(STATUS)).status).toBe(200);
        expect((await asSales.get(UNREAD)).status).toBe(200);
      });
      // Still a real company: the list never makes it a demo company.
      expect((await db.organization.findUniqueOrThrow({ where: { id: org } })).is_demo).toBe(false);
    });

    it.each([
      ['below Scale', { plan: 'PRO' as const }],
      ['with the feature switched off for it', { feature_overrides: { spider: false } }],
    ])('answers 404 everywhere for a listed company %s, and creates nothing', async (_label, data) => {
      const { org, admin } = await fx.newOrg();
      await db.organization.update({ where: { id: org }, data });
      await withPilotList(org, async () => {
        const api = await fx.signedInAs(admin);
        for (const res of [await api.get(SETTINGS), await api.put(SETTINGS, body()), await api.get(HISTORY), await api.get(UNREAD), await api.get(STATUS), await api.put(STATUS, { isActive: true }), await api.get(PREVIEW)]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
        }
      });
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);
    });

    it('/api/auth/me says org_is_spider_pilot for a listed company only (never for an unlisted or a demo company)', async () => {
      const listed = await fx.newOrg();
      const unlisted = await fx.newOrg();
      const demo = await spiderOrg();
      await withPilotList(listed.org, async () => {
        const me = async (person: Person) => (await (await fx.signedInAs(person)).get('/api/auth/me')).body.user;
        const listedMe = await me(listed.admin);
        expect(listedMe.org_is_spider_pilot).toBe(true);
        expect(listedMe.org_is_demo).toBe(false);
        expect((await me(unlisted.admin)).org_is_spider_pilot).toBe(false);
        const demoMe = await me(demo.admin);
        expect(demoMe.org_is_spider_pilot).toBe(false);
        expect(demoMe.org_is_demo).toBe(true);
      });
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
      // Active. The leads it watches are not part of the settings (#3436): the picker reads them a page at a time.
      expect(res.body.settings.is_active).toBe(true);
      expect(res.body.settings).not.toHaveProperty('selected_lead_ids');
      // The screen draws its unit list from here: Minute, Hour and Day, no Second.
      expect(res.body.options.units.map((u: { value: string }) => u.value)).toEqual(['MINUTE', 'HOUR', 'DAY']);
      // The three stages Spider acts on (Ran, 15 Oct, D2).
      expect(res.body.options.statuses.map((s: { value: string }) => s.value)).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_COMPLETED']);
      expect((await api.put(SETTINGS, body())).status).toBe(200);
    });

    it('rejects unknown statuses, unknown units, and zero or negative limits', async () => {
      const { admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const before = (await api.get(SETTINGS)).body.settings;
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
      // Nothing was stored by any of them: the settings are still the ones saved before activating.
      expect((await api.get(SETTINGS)).body.settings).toEqual(before);
    });

    // Ran, 15 Oct (D3): the contractor's three required checks, on the server too, in his words.
    it('refuses a save with no channel, no recipient or no stage switched on, in the contractor\'s words, storing nothing', async () => {
      const { org, admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const row = () => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      const before = await row();
      const noChannel = { channels: { in_app: false, red_frame: false, email: false, text: false } };
      const noRecipient = { recipients: { roles: [], user_ids: [], lead_owner: false } };
      const noStage = { NEW: { enabled: false, value: 2, unit: 'HOUR' } };
      const cases: [Record<string, unknown>, Record<string, Limit>, string[]][] = [
        [noChannel, {}, ['Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).']],
        [noRecipient, {}, ['Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).']],
        [{}, noStage, ['Please set at least one stage duration threshold greater than 0.']],
        [{ ...noChannel, ...noRecipient }, noStage, [
          'Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).',
          'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
          'Please set at least one stage duration threshold greater than 0.',
        ]],
      ];
      for (const [overrides, limits, messages] of cases) {
        const res = await api.put(SETTINGS, body(overrides, limits));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.details.map((d: { message: string }) => d.message)).toEqual(messages);
      }
      // Only another company's people chosen: nobody would be stored, so it is refused too.
      const other = await spiderOrg();
      const res = await api.put(SETTINGS, body({ recipients: { roles: [], user_ids: [other.admin.id], lead_owner: false } }));
      expect(res.status).toBe(400);
      expect(res.body.details.map((d: { message: string }) => d.message)).toEqual([
        'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
      ]);
      expect(await row()).toEqual(before);
      expect((await api.get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });

    // The frontend and backend deploy separately: the screen from before 15 Oct still sends the five
    // statuses. Accepted, and the two that are no longer watched are dropped.
    it('accepts a save carrying the retired Walkthrough Scheduled and Estimate Sent limits, and drops them', async () => {
      const { org, admin } = await onOrg();
      const api = await fx.signedInAs(admin);
      const res = await api.put(SETTINGS, body({}, {
        WALKTHROUGH_SCHEDULED: { enabled: true, value: 1, unit: 'DAY' },
        ESTIMATED: { enabled: true, value: 3, unit: 'DAY' },
      }));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.settings.status_limits)).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_COMPLETED']);
      const stored = (await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } })).status_limits as Record<string, Limit>;
      expect(Object.keys(stored).sort()).toEqual(['CONTACTED', 'NEW', 'WALKTHROUGH_COMPLETED']);
    });

    // #2794: no clock restart. Time in a stage counts from when the lead entered it; a save that
    // starts watching something new records a starting trigger instead, so the backlog arrives as one
    // starting summary.
    it('never moves activated_at on a save, not even for the first status', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const row = () => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      await switchOn(admin);
      const switchedOn = (await row()).activated_at!;
      await new Promise((r) => setTimeout(r, 15));
      expect((await api.put(SETTINGS, body())).status).toBe(200);
      expect((await row()).activated_at).toEqual(switchedOn);
    });

    describe('the starting trigger (#2794)', () => {
      const row = (org: string) => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      const trigger = async (org: string) => {
        const r = await row(org);
        return { at: r.summary_trigger_at, kind: r.summary_trigger_kind };
      };
      const clear = (org: string) =>
        db.spiderSettings.update({
          where: { organization_id: org },
          data: { summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null },
        });

      it('switching on records one; switching off, or on again while on, records none', async () => {
        const { org, admin } = await spiderOrg();
        const api = await fx.signedInAs(admin);
        expect((await api.put(SETTINGS, SETUP)).status).toBe(200);
        const before = Date.now();
        expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
        const first = await trigger(org);
        expect(first.kind).toBe('SWITCHED_ON');
        expect(first.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

        await clear(org);
        expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
        expect(await trigger(org)).toEqual({ at: null, kind: null });
        expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
        expect(await trigger(org)).toEqual({ at: null, kind: null });

        // Back on after a pause.
        expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
        expect((await trigger(org)).kind).toBe('SWITCHED_ON');
      });

      it('a save records one for a stage switched on, a limit shortened, or a lead included again, and none otherwise', async () => {
        const { org, admin, customer } = await onOrg();
        const api = await fx.signedInAs(admin);
        await fx.addLead(org, customer);
        const other = await fx.addLead(org, customer);
        await clear(org);

        // First stage switched on.
        expect((await api.put(SETTINGS, body())).status).toBe(200);
        expect((await trigger(org)).kind).toBe('STAGE_ADDED');
        await clear(org);

        // Recipients, channels, a longer limit, a stage switched off: none.
        const quiet = [
          body({ recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false } }),
          body({ channels: { in_app: true, red_frame: false, email: true, text: true } }),
          body({}, { NEW: { enabled: true, value: 5, unit: 'HOUR' } }),
        ];
        for (const b of quiet) {
          expect((await api.put(SETTINGS, b)).status).toBe(200);
          expect(await trigger(org), JSON.stringify(b)).toEqual({ at: null, kind: null });
        }
        // A lead excluded with the picker's Save: none.
        expect((await api.patch(EXCLUSIONS, { exclude: [other.id], include: [] })).status).toBe(200);
        expect(await trigger(org)).toEqual({ at: null, kind: null });

        // A shorter limit.
        expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 1, unit: 'HOUR' } }))).status).toBe(200);
        expect((await trigger(org)).kind).toBe('LIMIT_SHORTENED');
        await clear(org);

        // The excluded lead included again (#3434: taken off the exclusion list), then excluded and included again; a
        // settings save never widens what is watched (#3436: it never touches the list).
        expect((await api.patch(EXCLUSIONS, { exclude: [], include: [other.id] })).status).toBe(200);
        expect((await trigger(org)).kind).toBe('SCOPE_WIDENED');
        await clear(org);
        expect((await api.patch(EXCLUSIONS, { exclude: [other.id], include: [] })).status).toBe(200);
        expect(await trigger(org)).toEqual({ at: null, kind: null });
        expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 1, unit: 'HOUR' } }))).status).toBe(200);
        expect(await trigger(org)).toEqual({ at: null, kind: null });
        // An older page's "watch every lead" is refused (409) and records nothing either.
        expect((await api.put(SETTINGS, body({ watch_all_leads: true, selected_lead_ids: [] }, { NEW: { enabled: true, value: 1, unit: 'HOUR' } }))).status).toBe(409);
        expect(await trigger(org)).toEqual({ at: null, kind: null });
        expect((await api.patch(EXCLUSIONS, { exclude: [], include: [other.id] })).status).toBe(200);
        expect((await trigger(org)).kind).toBe('SCOPE_WIDENED');

        // A refused save records nothing, even one that would have started watching a new stage.
        await clear(org);
        const refused = body(
          { channels: { in_app: false, red_frame: false, email: false, text: false } },
          { CONTACTED: { enabled: true, value: 1, unit: 'DAY' } },
        );
        expect((await api.put(SETTINGS, refused)).status).toBe(400);
        expect(await trigger(org)).toEqual({ at: null, kind: null });
      });

      it('folds a save into a trigger still waiting: switching on keeps its name, two kinds read as settings changed', async () => {
        const { org, admin } = await spiderOrg();
        const api = await fx.signedInAs(admin);
        await switchOn(admin);
        const switched = await trigger(org);
        await new Promise((r) => setTimeout(r, 15));
        expect((await api.put(SETTINGS, body())).status).toBe(200);
        const folded = await trigger(org);
        expect(folded.kind).toBe('SWITCHED_ON');
        // The quiet period starts again from the latest save; the wait's bound still counts from the first.
        expect(folded.at!.getTime()).toBeGreaterThan(switched.at!.getTime());
        expect((await row(org)).summary_trigger_since).toEqual(switched.at);

        await clear(org);
        expect((await api.put(SETTINGS, body({}, { CONTACTED: { enabled: true, value: 1, unit: 'DAY' } }))).status).toBe(200);
        // Nothing was waiting: a fresh wait starts at this save.
        const fresh = await row(org);
        expect(fresh.summary_trigger_since).toEqual(fresh.summary_trigger_at);
        expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 1, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 1, unit: 'DAY' } }))).status).toBe(200);
        expect((await trigger(org)).kind).toBe('SETTINGS_CHANGED');
      });

    });

    // #3431 (Ran, 10 Nov): Spider works like an integration. Its settings are saved while Not active, and that save
    // starts nothing: no starting trigger, and the sweep sends nothing.
    it('saves while Not active, before it was ever activated or after a Deactivate, recording no trigger', async () => {
      const { org, admin, customer } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const row = () => db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      const backlog = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: backlog.id }, data: { created_at: new Date(Date.now() - 5 * 3_600_000) } });

      // Never activated: the save makes the row, Not active, with what was saved.
      const first = await api.put(SETTINGS, body());
      expect(first.status).toBe(200);
      expect(first.body.settings).toMatchObject({ is_active: false, activated_at: null });
      expect(first.body.settings.status_limits.NEW).toEqual({ enabled: true, value: 2, unit: 'HOUR' });
      expect(await row()).toMatchObject({ is_active: false, activated_at: null, summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null });
      expect((await api.get(STATUS)).body).toEqual({ isActive: false, isSetUp: true });

      // A save that would be a trigger while Active (a stage switched on, more leads) records none while Not active.
      const widened = await api.put(SETTINGS, body({}, { CONTACTED: { enabled: true, value: 1, unit: 'DAY' } }));
      expect(widened.status).toBe(200);
      expect(await row()).toMatchObject({ is_active: false, summary_trigger_at: null, summary_trigger_kind: null });
      // The sweep sends nothing for the company, long after the backlog went past its limit.
      await runSpiderSweep(new Date(Date.now() + 15 * 60_000));
      expect(await db.spiderAlert.count({ where: { organization_id: org } })).toBe(0);
      expect(await db.spiderSummary.count({ where: { organization_id: org } })).toBe(0);

      // Activated, then deactivated with its trigger cleared: a save is stored and records nothing.
      expect((await api.put(STATUS, { isActive: true })).status).toBe(200);
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      await db.spiderSettings.update({ where: { organization_id: org }, data: { summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null } });
      const activatedAt = (await row()).activated_at;
      const off = await api.put(SETTINGS, body({}, { WALKTHROUGH_COMPLETED: { enabled: true, value: 9, unit: 'DAY' } }));
      expect(off.status).toBe(200);
      expect(off.body.settings.status_limits.WALKTHROUGH_COMPLETED).toEqual({ enabled: true, value: 9, unit: 'DAY' });
      expect(await row()).toMatchObject({ is_active: false, activated_at: activatedAt, summary_trigger_at: null, summary_trigger_kind: null });
    });

    it('a save racing an Activate stores nothing and answers 409', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, SETUP)).status).toBe(200);
      const before = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      // Activated by another Admin between the save's read and its write: the write is conditional on Not active.
      const update = db.spiderSettings.updateMany.bind(db.spiderSettings);
      const spy = vi.spyOn(db.spiderSettings, 'updateMany').mockImplementationOnce((async (args: Parameters<typeof update>[0]) => {
        await update({ where: { organization_id: org }, data: { is_active: true } });
        return update(args);
      }) as never);
      try {
        const res = await api.put(SETTINGS, body());
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'Spider was activated or deactivated while you were saving. Save again.' });
      } finally {
        spy.mockRestore();
      }
      const after = await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: org } });
      expect(after.status_limits).toEqual(before.status_limits);
      expect(after.summary_trigger_at).toBeNull();
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

      // Not active: is_active true in a save is stored as a save and never activates.
      expect((await api.put(STATUS, { isActive: false })).status).toBe(200);
      expect((await api.put(SETTINGS, { ...body(), is_active: true })).status).toBe(200);
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
      }));
      expect(res.status).toBe(200);
      expect(res.body.settings.recipients.user_ids).toEqual([a.admin.id]);
      // Leads go through the picker's Save, which keeps only this company's (#3435).
      expect((await api.patch(EXCLUSIONS, { exclude: [ownLead.id, otherLead.id], include: [] })).status).toBe(200);
      expect((await db.spiderSettings.findUniqueOrThrow({ where: { organization_id: a.org } })).excluded_lead_ids).toEqual([ownLead.id]);
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

    // #3431: Activate is refused while no status has a time limit switched on, and changes nothing.
    it('refuses Activate with 409 while no status has a time limit, creating and changing nothing', async () => {
      const { org, admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const refused = { error: 'Switch on a time limit for at least one status before activating Spider.' };

      // No settings row: refused, and none is made.
      const none = await api.put(STATUS, { isActive: true, startingSummary: 'send' });
      expect(none.status).toBe(409);
      expect(none.body).toEqual(refused);
      expect(await db.spiderSettings.count({ where: { organization_id: org } })).toBe(0);

      // A row whose statuses are all off (or unreadable): refused, and the row is unchanged.
      await db.spiderSettings.create({
        data: { organization_id: org, is_active: false, status_limits: { NEW: { enabled: false, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: true, value: 0, unit: 'DAY' } } },
      });
      const before = await row(org);
      const off = await api.put(STATUS, { isActive: true });
      expect(off.status).toBe(409);
      expect(off.body).toEqual(refused);
      expect(await row(org)).toEqual(before);
      expect((await api.get(STATUS)).body).toEqual({ isActive: false, isSetUp: false });

      // Active from before this rule, with nothing set up: Activate again is refused too, and changes nothing.
      await db.spiderSettings.update({ where: { organization_id: org }, data: { is_active: true, activated_at: new Date() } });
      const activeBefore = await row(org);
      expect((await api.put(STATUS, { isActive: true })).status).toBe(409);
      expect(await row(org)).toEqual(activeBefore);
    });

    it('Activate takes startingSummary send, or reads a missing one as send: either records the starting trigger', async () => {
      for (const extra of [{ startingSummary: 'send' }, {}]) {
        const { org, admin } = await spiderOrg();
        const api = await fx.signedInAs(admin);
        expect((await api.put(SETTINGS, SETUP)).status).toBe(200);
        const before = Date.now();
        const res = await api.put(STATUS, { isActive: true, ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(200);
        expect(res.body).toEqual({ isActive: true, isSetUp: true });
        const r = await row(org);
        expect(r.is_active).toBe(true);
        expect(r.activated_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(r.summary_trigger_kind).toBe('SWITCHED_ON');
        expect(r.summary_trigger_at).toEqual(r.activated_at);
      }
    });

    it('two Admins activating at once leave one row, activated once', async () => {
      const { org, admin } = await spiderOrg();
      const second = await fx.addUser(org, 'second-admin', 'ADMIN');
      const [a, b] = await Promise.all([fx.signedInAs(admin), fx.signedInAs(second)]);
      expect((await a.put(SETTINGS, SETUP)).status).toBe(200);
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

    it('rejects a body that is not exactly { isActive: boolean, startingSummary?: send | skip }', async () => {
      const { admin } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      expect((await api.put(SETTINGS, SETUP)).status).toBe(200);
      const bodies = [{}, { isActive: 'yes' }, { isActive: true, status_limits: {} }, { is_active: true },
        { isActive: true, startingSummary: 'later' }, { isActive: true, startingSummary: true }];
      for (const b of bodies) {
        const res = await api.put(STATUS, b);
        expect(res.status, JSON.stringify(b)).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      }
    });

    it('switches on and off, moving activated_at only when it goes from off to on, and changes no other setting', async () => {
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
        { WALKTHROUGH_COMPLETED: { enabled: true, value: 5, unit: 'DAY' } },
      );
      // Stored while off, as an earlier settings save left it.
      await db.spiderSettings.create({ data: { organization_id: org, is_active: false, ...saved, excluded_lead_ids: [lead.id] } });
      const start = await row(org);
      expect(start.activated_at).toBeNull();
      const kept = ({ status_limits, channels, recipients, watch_all_leads, selected_lead_ids, excluded_lead_ids }: typeof start) =>
        ({ status_limits, channels, recipients, watch_all_leads, selected_lead_ids, excluded_lead_ids });

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

    // Ran, 20 Oct (D4): turning Spider off ends every open Spider alert in the company, for every
    // person who got it. History keeps the record; nothing is deleted.
    it('switching off ends every open Spider alert in this company, for every person, and keeps History', async () => {
      const { org, admin, customer } = await onOrg();
      const { sales } = await staff(org);
      const lead = await fx.addLead(org, customer);
      const adminAlert = await unreadSpiderAlert(org, admin.id, lead.id);
      const salesAlert = await unreadSpiderAlert(org, sales.id, lead.id);
      const salesFrame = await unreadSpiderAlert(org, sales.id, lead.id, {}, 'spider.frame');
      const logged = await alertRow(org, lead.id, [admin.id, sales.id], new Date(), { in_app: { outcome: 'Shown in the app' } });
      const bellRow = await db.notification.create({
        data: { organization_id: org, verb: 'lead.assigned', category: 'LEAD', priority: 'INTERRUPT', object_type: 'LEAD', object_id: lead.id, title: 'x' },
      });
      const bell = await db.notificationRecipient.create({
        data: { notification_id: bellRow.id, organization_id: org, recipient_id: sales.id, priority: 'INTERRUPT' },
      });
      const api = await fx.signedInAs(admin);
      const historyBefore = (await api.get(HISTORY)).body.items;
      expect(historyBefore.map((i: { id: string }) => i.id)).toEqual([logged.id]);

      const res = await api.put(STATUS, { isActive: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: false, isSetUp: true });

      for (const r of [adminAlert, salesAlert, salesFrame]) {
        const stored = await db.notificationRecipient.findUnique({ where: { id: r.id } });
        expect(stored, r.id).not.toBeNull();
        expect(stored!.read_at, r.id).not.toBeNull();
        expect(stored!.dismissed_at, r.id).toBeNull();
      }
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: bell.id } })).read_at).toBeNull();
      expect((await api.get(HISTORY)).body.items).toEqual(historyBefore);
      for (const person of [admin, sales]) {
        const unread = (await (await fx.signedInAs(person)).get(UNREAD)).body;
        expect(unread).toMatchObject({ alerts: [], frame: false });
      }
    });

    it("switching off leaves another company's alerts and settings alone", async () => {
      const a = await onOrg();
      const b = await onOrg();
      const aLead = await fx.addLead(a.org, a.customer);
      const bLead = await fx.addLead(b.org, b.customer);
      await unreadSpiderAlert(a.org, a.admin.id, aLead.id);
      const bAlert = await unreadSpiderAlert(b.org, b.admin.id, bLead.id);
      const bFrame = await unreadSpiderAlert(b.org, b.admin.id, bLead.id, {}, 'spider.frame');
      // B watches New (2 hours), so its alert is an open one (#3450).
      expect((await (await fx.signedInAs(b.admin)).put(SETTINGS, body())).status).toBe(200);
      const bBefore = await row(b.org);

      expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: false })).status).toBe(200);

      for (const r of [bAlert, bFrame]) {
        expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: r.id } })).read_at).toBeNull();
      }
      expect(await row(b.org)).toEqual(bBefore);
      expect((await (await fx.signedInAs(b.admin)).get(UNREAD)).body.alerts.map((x: { id: string }) => x.id)).toEqual([bAlert.id]);
    });

    it('switching off when already off ends anything still open', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const activatedAt = new Date(Date.now() - 3_600_000);
      await db.spiderSettings.create({ data: { organization_id: org, is_active: false, activated_at: activatedAt } });
      const leftover = await unreadSpiderAlert(org, admin.id, lead.id);

      const res = await (await fx.signedInAs(admin)).put(STATUS, { isActive: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isActive: false, isSetUp: false });

      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: leftover.id } })).read_at).not.toBeNull();
      const after = await row(org);
      expect(after.is_active).toBe(false);
      expect(after.activated_at).toEqual(activatedAt);
    });

    it("switches only the caller's own company", async () => {
      const a = await spiderOrg();
      const b = await onOrg();
      expect((await (await fx.signedInAs(b.admin)).put(SETTINGS, body())).status).toBe(200);
      const bBefore = await row(b.org);

      await switchOn(a.admin);
      expect((await row(a.org)).is_active).toBe(true);
      expect(await row(b.org)).toEqual(bBefore);

      // Switching a off leaves b on.
      expect((await (await fx.signedInAs(a.admin)).put(STATUS, { isActive: false })).status).toBe(200);
      expect(await row(b.org)).toEqual(bBefore);
      expect((await (await fx.signedInAs(b.admin)).get(STATUS)).body).toEqual({ isActive: true, isSetUp: true });
    });
  });

  describe('unread alerts', () => {
    it("returns only the caller's own unread Spider alerts, and the in-app and red-frame switches", async () => {
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
      // An alert raised before the contractor's fields were stored still fills his card.
      expect(res.body.alerts[0]).toMatchObject({
        lead_id: lead.id, customer_name: 'Pat Payer', stage_name: 'New', current_stage: 'New', service_location: '1 Test Way',
      });
      // No settings row yet: the red frame is off.
      expect(res.body.red_frame).toBe(false);

      await switchOn(admin);
      await (await fx.signedInAs(admin)).put(SETTINGS, body({ channels: { in_app: true, red_frame: true, email: false, text: false } }));
      expect((await (await fx.signedInAs(sales)).get(UNREAD)).body).toMatchObject({ in_app: true, red_frame: true });
      // In-app switched off: the alerts already raised stay listed (his "currently disabled" panel),
      // and the red frame follows its own switch.
      await (await fx.signedInAs(admin)).put(SETTINGS, body({ channels: { in_app: false, red_frame: true, email: false, text: false } }));
      const off = (await (await fx.signedInAs(sales)).get(UNREAD)).body;
      expect(off).toMatchObject({ in_app: false, red_frame: true });
      expect(off.alerts).toHaveLength(1);
      await (await fx.signedInAs(admin)).put(SETTINGS, body({ channels: { in_app: true, red_frame: false, email: false, text: false } }));
      expect((await (await fx.signedInAs(sales)).get(UNREAD)).body.red_frame).toBe(false);
    });

    it("returns the contractor's card fields as stored at alert time", async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      await unreadSpiderAlert(org, admin.id, lead.id, {
        company_name: 'Payer Homes', stage_name: 'New', service_location: '12 Elm Street, Testville, MA, 02108',
        service_request: 'Fix the door', assigned_to: 'Rita Rep', stage_entered_at: '2026-10-01T09:00:00.000Z',
        lead_created_at: '2026-09-28T09:00:00.000Z',
        body: 'This lead was created 3 hours ago and has not yet been contacted.',
      });
      const [card] = (await (await fx.signedInAs(admin)).get(UNREAD)).body.alerts;
      expect(card).toMatchObject({
        lead_id: lead.id, lead_number: 'L-1', customer_name: 'Pat Payer', company_name: 'Payer Homes',
        stage_name: 'New', current_stage: 'New', service_location: '12 Elm Street, Testville, MA, 02108',
        service_request: 'Fix the door', assigned_to: 'Rita Rep', stage_entered_at: '2026-10-01T09:00:00.000Z',
        lead_created_at: '2026-09-28T09:00:00.000Z',
        message: 'This lead was created 3 hours ago and has not yet been contacted.',
      });
      expect(typeof card.created_at).toBe('string');
    });

    it('leaves out an alert whose lead left the stage, at once and without marking anything read', async () => {
      const { org, admin, customer } = await spiderOrg();
      const moved = await fx.addLead(org, customer);
      const still = await fx.addLead(org, customer);
      const movedAlert = await unreadSpiderAlert(org, admin.id, moved.id);
      const stillAlert = await unreadSpiderAlert(org, admin.id, still.id);
      const api = await fx.signedInAs(admin);
      expect((await api.get(UNREAD)).body.alerts).toHaveLength(2);

      await db.lead.update({ where: { id: moved.id }, data: { status: 'CONTACTED', contacted_at: new Date() } });
      const res = await api.get(UNREAD);
      expect(res.body.alerts.map((a: { id: string }) => a.id)).toEqual([stillAlert.id]);
      // A read request writes nothing: the sweep marks the ended alert read.
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: movedAlert.id } })).read_at).toBeNull();
    });

    // SPEC-6 (D1): the lead page no longer marks an alert read, so this is the whole of how a text
    // ends one. The send door calls the release writer only for a text that went out; a text that
    // was recorded but not sent leaves the lead New, and a text never ends a Contacted visit.
    it('only a contact the server records ends an alert; a text that did not go out leaves it open', async () => {
      const { org, admin, customer } = await onOrg();
      // New watched at 2 hours, Contacted at 1 day: every alert below is for a lead past its limit, so open (#3450).
      await (await fx.signedInAs(admin)).put(SETTINGS, body({}, { CONTACTED: { enabled: true, value: 1, unit: 'DAY' } }));
      const a = await fx.addLead(org, customer);
      const b = await fx.addLead(org, customer);
      const c = await fx.addLead(org, customer);
      const contactedAt = new Date(Date.now() - 2 * 86_400_000);
      await db.lead.update({ where: { id: c.id }, data: { status: 'CONTACTED', contacted_at: contactedAt } });
      const alertA = await unreadSpiderAlert(org, admin.id, a.id);
      const alertB = await unreadSpiderAlert(org, admin.id, b.id);
      const alertC = await unreadSpiderAlert(org, admin.id, c.id, {
        status: 'CONTACTED', status_label: 'Contacted', entered_status_at: contactedAt.toISOString(),
      });
      // B: the text the send door recorded but did not send (the phone system is not connected).
      const thread = await db.messageThread.create({
        data: { organization_id: org, customer_id: customer, channel: 'sms', campaign_type: 'conversational' },
      });
      try {
        await db.message.create({
          data: {
            organization_id: org, thread_id: thread.id, direction: 'out', body: 'Hello', ts: new Date(),
            status: 'skipped', status_reason: 'NOT_CONNECTED', lead_id: b.id, sent_by_user_id: admin.id,
          },
        });
        // A and C: what the send door does once a text has gone out.
        for (const lead of [a, c]) {
          await recordLeadOutboundContact({ client: db }, {
            leadId: lead.id, orgId: org, channel: 'text', direction: 'out', automated: false, at: new Date(), actorId: admin.id,
          });
        }

        const listed = (await (await fx.signedInAs(admin)).get(UNREAD)).body.alerts.map((x: { id: string }) => x.id);
        expect(listed.sort()).toEqual([alertB.id, alertC.id].sort());
        // Reading the list writes nothing.
        expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: alertA.id } })).read_at).toBeNull();

        const result = await runSpiderSweep();
        expect(result.ran).toBe(true);
        expect(result.alertsEnded).toBeGreaterThanOrEqual(1);
        const readAt = async (id: string) => (await db.notificationRecipient.findUniqueOrThrow({ where: { id } })).read_at;
        expect(await readAt(alertA.id)).not.toBeNull();
        expect(await readAt(alertB.id)).toBeNull();
        expect(await readAt(alertC.id)).toBeNull();
        expect((await db.lead.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('NEW');
      } finally {
        await db.message.deleteMany({ where: { thread_id: thread.id } });
        await db.messageThread.delete({ where: { id: thread.id } });
      }
    });

    it("follows the Contacted rule (status New or Contacted only): a Contacted alert ends once the lead's status moves on", async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const contactedAt = new Date(Date.now() - 3_600_000);
      await db.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED', contacted_at: contactedAt } });
      await unreadSpiderAlert(org, admin.id, lead.id, { status: 'CONTACTED', status_label: 'Contacted', entered_status_at: contactedAt.toISOString() });
      const api = await fx.signedInAs(admin);
      expect((await api.get(UNREAD)).body.alerts).toHaveLength(1);
      // Walkthrough Scheduled with no booking timestamp: no longer "contacted, walkthrough not scheduled".
      await db.lead.update({ where: { id: lead.id }, data: { status: 'WALKTHROUGH_SCHEDULED' } });
      expect((await api.get(UNREAD)).body.alerts).toEqual([]);
    });

    it('names the current stage "Estimate" once the lead is Estimate Sent but still in Walkthrough Completed', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const done = new Date(Date.now() - 3_600_000);
      await db.lead.update({
        where: { id: lead.id },
        data: { status: 'ESTIMATED', contacted_at: done, walkthrough_first_booked_at: done, last_visit_completed_at: done },
      });
      await unreadSpiderAlert(org, admin.id, lead.id, {
        status: 'WALKTHROUGH_COMPLETED', status_label: 'Walkthrough Completed', entered_status_at: done.toISOString(),
      });
      const [card] = (await (await fx.signedInAs(admin)).get(UNREAD)).body.alerts;
      expect(card).toMatchObject({ stage_name: 'Walkthrough Completed', current_stage: 'Estimate' });
    });

    it('Red Frame on its own (in-app off): a red-frame-only record shows the frame, never a card, and never reaches the bell', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      await switchOn(admin);
      const api = await fx.signedInAs(admin);
      await api.put(SETTINGS, body({ channels: { in_app: false, red_frame: true, email: true, text: false } }));
      const frameOnly = await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.frame');

      const res = (await api.get(UNREAD)).body;
      expect(res).toMatchObject({ alerts: [], in_app: false, red_frame: true, frame: true });

      // The bell: not listed, not counted, and "mark all read" leaves it alone.
      const bell = (await api.get('/api/notifications')).body;
      expect(bell.items.map((i: { id: string }) => i.id)).not.toContain(frameOnly.id);
      expect((await api.get('/api/notifications/unread-count')).body.unseen).toBe(0);
      // Marking everything seen in the bell leaves it alone too.
      expect((await api.patch('/api/notifications/seen', {})).status).toBe(200);
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: frameOnly.id } })).seen_at).toBeNull();
      await api.post('/api/notifications/read-all', {});
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: frameOnly.id } })).read_at).toBeNull();

      // The lead leaves the stage: the frame goes at once (nothing written by the read).
      await db.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED', contacted_at: new Date() } });
      expect((await api.get(UNREAD)).body.frame).toBe(false);
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: frameOnly.id } })).read_at).toBeNull();
    });

    it('an in-app Spider alert never reaches the bell: not listed, not counted, not seen and not read by it', async () => {
      const { org, admin, customer } = await onOrg();
      // New watched (2 hours), so the alert below is an open one (#3450).
      expect((await (await fx.signedInAs(admin)).put(SETTINGS, body())).status).toBe(200);
      const lead = await fx.addLead(org, customer);
      // Stored as #2803 wrote it (INTERRUPT), so the hide must not depend on the priority.
      const spider = await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.alert', 'INTERRUPT');
      // An ordinary bell notification for the same person: the control, which the bell still handles.
      const n = await db.notification.create({
        data: { organization_id: org, verb: 'lead.assigned', category: 'LEAD', priority: 'INTERRUPT', object_type: 'LEAD', object_id: lead.id, title: 'x' },
      });
      const control = await db.notificationRecipient.create({
        data: { notification_id: n.id, organization_id: org, recipient_id: admin.id, priority: 'INTERRUPT' },
      });
      const api = await fx.signedInAs(admin);

      const ids = (body: { items: { id: string }[] }) => body.items.map(i => i.id);
      expect(ids((await api.get('/api/notifications')).body)).toEqual([control.id]);
      expect(ids((await api.get('/api/notifications?needs_action=true')).body)).not.toContain(spider.id);
      expect((await api.get('/api/notifications/unread-count')).body.unseen).toBe(1);

      // Opening the bell marks the control seen and leaves the Spider alert alone.
      expect((await api.patch('/api/notifications/seen', {})).status).toBe(200);
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: spider.id } })).seen_at).toBeNull();
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: control.id } })).seen_at).not.toBeNull();

      // "Mark all read" reads the control and leaves the Spider alert alone.
      expect((await api.post('/api/notifications/read-all', {})).status).toBe(200);
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: spider.id } })).read_at).toBeNull();
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: control.id } })).read_at).not.toBeNull();

      // Spider's own surfaces still have it: the card, and the red frame (on by default).
      const unread = (await api.get(UNREAD)).body;
      expect(unread.alerts.map((a: { id: string }) => a.id)).toEqual([spider.id]);
      expect(unread).toMatchObject({ red_frame: true, frame: true });
    });

    it("Spider's own mark still works: PATCH /api/notifications/:id/read marks a Spider alert read", async () => {
      const { org, admin, customer } = await onOrg();
      const lead = await fx.addLead(org, customer);
      const spider = await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.alert', 'INTERRUPT');
      const api = await fx.signedInAs(admin);
      expect((await api.patch(`/api/notifications/${spider.id}/read`)).status).toBe(200);
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: spider.id } })).read_at).not.toBeNull();
      expect((await api.get(UNREAD)).body.alerts).toEqual([]);
    });

    it('older, already-read Spider alerts are not listed in the bell either', async () => {
      const { org, admin, customer } = await onOrg();
      const lead = await fx.addLead(org, customer);
      const old = await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.alert', 'INTERRUPT');
      await db.notificationRecipient.update({ where: { id: old.id }, data: { read_at: new Date(), seen_at: new Date() } });
      const bell = (await (await fx.signedInAs(admin)).get('/api/notifications')).body;
      expect(bell.items.map((i: { id: string }) => i.id)).not.toContain(old.id);
    });

    // D4: while Spider is off nothing of it shows, whatever is stored (a failed clear, or a company
    // that was already off). Display only: the read writes nothing.
    it('returns no alerts and no frame while Spider is off, without writing anything', async () => {
      const { org, admin, customer } = await onOrg();
      const lead = await fx.addLead(org, customer);
      const api = await fx.signedInAs(admin);
      await api.put(SETTINGS, body({ channels: { in_app: true, red_frame: true, email: false, text: false } }));
      const alert = await unreadSpiderAlert(org, admin.id, lead.id);
      const frame = await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.frame');
      expect((await api.get(UNREAD)).body).toMatchObject({ frame: true });
      expect((await api.get(UNREAD)).body.alerts).toHaveLength(1);

      // Off as a leftover would be: straight in the database, past the switch and its clear.
      await db.spiderSettings.update({ where: { organization_id: org }, data: { is_active: false } });
      const res = await api.get(UNREAD);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ alerts: [], in_app: true, red_frame: true, frame: false, frame_ids: [] });
      for (const r of [alert, frame]) {
        expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: r.id } })).read_at).toBeNull();
      }
    });

    it('shows no frame with the Red Frame switched off, whatever is recorded', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      await switchOn(admin);
      const api = await fx.signedInAs(admin);
      await api.put(SETTINGS, body({ channels: { in_app: true, red_frame: false, email: false, text: false } }));
      await unreadSpiderAlert(org, admin.id, lead.id);
      await unreadSpiderAlert(org, admin.id, lead.id, {}, 'spider.frame');
      const res = (await api.get(UNREAD)).body;
      expect(res.alerts).toHaveLength(1);
      expect(res).toMatchObject({ red_frame: false, frame: false });
    });

    it('is bounded to 100 alerts', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      for (let i = 0; i < 105; i++) await unreadSpiderAlert(org, admin.id, lead.id);
      const res = await (await fx.signedInAs(admin)).get(UNREAD);
      expect(res.body.alerts).toHaveLength(100);
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

  // #3450 (Ran, 11 Nov): an open alert follows the settings saved now. Excluding its lead, switching its stage's limit
  // off, or lengthening the limit past where the lead is clears its card and red frame on the next read. A shorter limit
  // or more recipients clears nothing. Since #3456 (#3469) the save itself also ends those records, so reversing it
  // cannot bring them back.
  describe('an open alert follows the saved settings (#3450)', () => {
    const NEW_2H: Limit = { enabled: true, value: 2, unit: 'HOUR' };
    const CONTACTED_ON: Limit = { enabled: true, value: 1, unit: 'DAY' };

    /** An active company watching New at 2 hours, with a Sales person who has an in-app alert and a red-frame-only record. */
    async function alertedCompany() {
      const o = await onOrg();
      const { sales } = await staff(o.org);
      const api = await fx.signedInAs(o.admin);
      expect((await api.put(SETTINGS, body({}, { NEW: NEW_2H, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      return { ...o, sales, api };
    }

    /** A New lead `hoursIn` hours into its stay, with an open in-app alert and a red-frame-only record for `person`. */
    async function alertedLead(org: string, customer: string, person: Person, hoursIn: number) {
      const lead = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: lead.id }, data: { created_at: new Date(Date.now() - hoursIn * 3_600_000) } });
      const alert = await unreadSpiderAlert(org, person.id, lead.id);
      const frame = await unreadSpiderAlert(org, person.id, lead.id, {}, 'spider.frame');
      return { lead, alert, frame };
    }

    const listed = async (person: Person) => (await (await fx.signedInAs(person)).get(UNREAD)).body;
    const ids = (b: { alerts: { id: string }[] }) => b.alerts.map((a) => a.id).sort();
    /** What a person's frame shows when only red-frame-only records are open (the in-app alerts read). */
    async function frameOnlyShows(person: Person, alerts: { id: string }[]) {
      await db.notificationRecipient.updateMany({ where: { id: { in: alerts.map((a) => a.id) } }, data: { read_at: new Date() } });
      return (await listed(person)).frame as boolean;
    }

    it('excluding a lead clears its card at once, and its red frame once nothing else is open; the read writes nothing', async () => {
      const { org, customer, sales, api } = await alertedCompany();
      const a = await alertedLead(org, customer, sales, 3);
      const b = await alertedLead(org, customer, sales, 3);
      expect(ids(await listed(sales))).toEqual([a.alert.id, b.alert.id].sort());

      expect((await api.patch(EXCLUSIONS, { exclude: [a.lead.id], include: [] })).status).toBe(200);
      // #3456: the save ended the excluded lead's records itself; the other lead's stay open.
      const readAt = async (id: string) => (await db.notificationRecipient.findUniqueOrThrow({ where: { id } })).read_at;
      const endedAt = await readAt(a.alert.id);
      expect(endedAt).not.toBeNull();
      expect(await readAt(b.alert.id)).toBeNull();
      const after = await listed(sales);
      expect(ids(after)).toEqual([b.alert.id]);
      expect(after.frame).toBe(true);
      // The read writes nothing.
      expect(await readAt(a.alert.id)).toEqual(endedAt);
      expect(await readAt(b.alert.id)).toBeNull();

      // Excluding the other one too: nothing open, so no card and no frame - the red-frame-only records included.
      expect((await api.patch(EXCLUSIONS, { exclude: [b.lead.id], include: [] })).status).toBe(200);
      expect(await listed(sales)).toMatchObject({ alerts: [], frame: false });
      // Only the red-frame-only records left open: the frame stays off for excluded leads.
      expect(await frameOnlyShows(sales, [a.alert, b.alert])).toBe(false);
    });

    it("switching a stage's limit off clears every open alert of that stage, red-frame-only records included", async () => {
      const { org, customer, sales, api } = await alertedCompany();
      const a = await alertedLead(org, customer, sales, 3);
      const contactedAt = new Date(Date.now() - 2 * 86_400_000);
      const c = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: c.id }, data: { status: 'CONTACTED', contacted_at: contactedAt } });
      const cAlert = await unreadSpiderAlert(org, sales.id, c.id, { status: 'CONTACTED', status_label: 'Contacted', entered_status_at: contactedAt.toISOString() });
      expect(ids(await listed(sales))).toEqual([a.alert.id, cAlert.id].sort());

      const off: Limit = { enabled: false, value: 2, unit: 'HOUR' };
      expect((await api.put(SETTINGS, body({}, { NEW: off, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      const after = await listed(sales);
      expect(ids(after)).toEqual([cAlert.id]);
      // The Contacted alert closed too: only New's red-frame-only record is open, and New is off.
      expect(await frameOnlyShows(sales, [cAlert, a.alert])).toBe(false);
    });

    it('a longer limit clears an alert whose lead is no longer past it, and keeps one still past it', async () => {
      const { org, customer, sales, api } = await alertedCompany();
      const notPast = await alertedLead(org, customer, sales, 3);
      const stillPast = await alertedLead(org, customer, sales, 30);

      expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 1, unit: 'DAY' }, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      const after = await listed(sales);
      expect(ids(after)).toEqual([stillPast.alert.id]);
      expect(after.frame).toBe(true);
      // Red-frame-only: the one still past its limit keeps the frame; with it gone too, the frame goes.
      expect(await frameOnlyShows(sales, [notPast.alert, stillPast.alert])).toBe(true);
      expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 2, unit: 'DAY' }, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      expect(await listed(sales)).toMatchObject({ alerts: [], frame: false });
    });

    it('a shorter limit or more recipients clears nothing', async () => {
      const { org, customer, admin, sales, api } = await alertedCompany();
      const a = await alertedLead(org, customer, sales, 3);
      const before = await listed(sales);
      expect(ids(before)).toEqual([a.alert.id]);

      expect((await api.put(SETTINGS, body({}, { NEW: { enabled: true, value: 1, unit: 'HOUR' }, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      expect((await api.put(SETTINGS, body({ recipients: { roles: ['ADMIN', 'SALES'], user_ids: [admin.id], lead_owner: true } }, { NEW: { enabled: true, value: 1, unit: 'HOUR' }, CONTACTED: CONTACTED_ON }))).status).toBe(200);
      const after = await listed(sales);
      expect(ids(after)).toEqual([a.alert.id]);
      expect(after.frame).toBe(true);
      expect(await frameOnlyShows(sales, [a.alert])).toBe(true);
    });
  });

  describe('the starting summary (#2794)', () => {
    const MINE = '/api/ai-farm/spider/summary';
    const COMPANY = '/api/ai-farm/spider/summary/company';
    const HOUR_MS = 3_600_000;

    /** A summary as the sweep writes it: the summary row and each lead's summarized claim. */
    async function summaryWith(org: string, leads: { id: string; to: string[]; enteredAgoMs: number; number: string }[], made = new Date()) {
      await db.spiderSummary.deleteMany({ where: { organization_id: org } });
      const s = await db.spiderSummary.create({
        data: { organization_id: org, created_at: made, triggered_at: new Date(made.getTime() - 2 * 60_000), trigger_kind: 'SWITCHED_ON', lead_count: leads.length },
      });
      for (const l of leads) {
        const lead = await db.lead.findUniqueOrThrow({ where: { id: l.id }, select: { created_at: true } });
        await db.spiderAlert.create({
          data: {
            organization_id: org, lead_id: l.id, status: 'NEW', entered_status_at: lead.created_at, counted_from: lead.created_at,
            limit_value: 2, limit_unit: 'HOUR', alerted_at: new Date(lead.created_at.getTime() + l.enteredAgoMs), recipient_ids: l.to,
            kind: 'SUMMARIZED', summary_id: s.id, lead_number: l.number, customer_name: 'Pat Payer', service_location: '1 Test Way, Testville, MA',
            stage_name: 'New',
          },
        });
      }
      return s;
    }

    it('gives each person their own leads only, most overdue first, any role; the company view is Admin-only', async () => {
      const { org, admin, customer } = await onOrg();
      const { sales, dispatcher } = await staff(org);
      const a = await fx.addLead(org, customer, { owner: sales.id });
      const b = await fx.addLead(org, customer);
      const c = await fx.addLead(org, customer, { owner: sales.id });
      await summaryWith(org, [
        { id: a.id, to: [sales.id, admin.id], enteredAgoMs: 5 * HOUR_MS, number: 'L-A' },
        { id: b.id, to: [admin.id], enteredAgoMs: 30 * HOUR_MS, number: 'L-B' },
        { id: c.id, to: [sales.id, admin.id], enteredAgoMs: 52 * HOUR_MS, number: 'L-C' },
      ]);

      const mine = await (await fx.signedInAs(sales)).get(MINE);
      expect(mine.status).toBe(200);
      expect(mine.body.summary).toMatchObject({ scope: 'mine', total: 2, still_waiting: 2, moved_on: 0, show_owner: false, trigger_kind: 'SWITCHED_ON' });
      expect(mine.body.summary.leads.map((l: { lead_number: string }) => l.lead_number)).toEqual(['L-C', 'L-A']);
      expect(mine.body.summary.leads[0]).toMatchObject({
        lead_id: c.id, customer_name: 'Pat Payer', address: '1 Test Way, Testville, MA', stage: 'NEW', stage_name: 'New',
        in_stage: '2 days 4 hours', limit: '2 hours', over_by: '2 days 2 hours', owner_name: 'sales Tester', moved_on: false, moved_to: null,
      });

      // A person with nothing in it reads no summary; a non-Admin cannot read the company's.
      expect((await (await fx.signedInAs(dispatcher)).get(MINE)).body).toEqual({ summary: null });
      expect((await (await fx.signedInAs(sales)).get(COMPANY)).status).toBe(403);

      const company = await (await fx.signedInAs(admin)).get(COMPANY);
      expect(company.status).toBe(200);
      expect(company.body.summary).toMatchObject({ scope: 'company', total: 3, show_owner: true });
      expect(company.body.summary.leads.map((l: { lead_number: string }) => l.lead_number)).toEqual(['L-C', 'L-B', 'L-A']);
      expect(company.body.summary.leads[1]).toMatchObject({ owner_name: null });
    });

    it('marks a lead that has since left that stage "moved on", with where it is now', async () => {
      const { org, admin, customer } = await onOrg();
      const a = await fx.addLead(org, customer);
      const b = await fx.addLead(org, customer);
      const c = await fx.addLead(org, customer);
      await summaryWith(org, [
        { id: a.id, to: [admin.id], enteredAgoMs: 5 * HOUR_MS, number: 'L-A' },
        { id: b.id, to: [admin.id], enteredAgoMs: 6 * HOUR_MS, number: 'L-B' },
        { id: c.id, to: [admin.id], enteredAgoMs: 7 * HOUR_MS, number: 'L-C' },
      ]);
      await db.lead.update({ where: { id: a.id }, data: { status: 'CONTACTED', contacted_at: new Date() } });
      await db.lead.update({ where: { id: b.id }, data: { status: 'WON', won_at: new Date() } });

      const res = await (await fx.signedInAs(admin)).get(MINE);
      const byNumber = Object.fromEntries(res.body.summary.leads.map((l: { lead_number: string }) => [l.lead_number, l]));
      expect(res.body.summary).toMatchObject({ total: 3, still_waiting: 1, moved_on: 2 });
      expect(byNumber['L-A']).toMatchObject({ moved_on: true, moved_to: 'Contacted' });
      expect(byNumber['L-B']).toMatchObject({ moved_on: true, moved_to: 'Won' });
      expect(byNumber['L-C']).toMatchObject({ moved_on: false, moved_to: null });
    });

    it('reads null when there is no summary, 404 behind the gate, and never another company\'s', async () => {
      const { admin } = await onOrg();
      const other = await onOrg();
      const lead = await fx.addLead(other.org, other.customer);
      await summaryWith(other.org, [{ id: lead.id, to: [other.admin.id], enteredAgoMs: 5 * HOUR_MS, number: 'L-X' }]);
      const api = await fx.signedInAs(admin);
      expect((await api.get(MINE)).body).toEqual({ summary: null });
      expect((await api.get(COMPANY)).body).toEqual({ summary: null });
      expect((await (await fx.signedInAs(other.admin)).get(COMPANY)).body.summary.total).toBe(1);

      const closed = await fx.newOrg();
      const closedApi = await fx.signedInAs(closed.admin);
      for (const res of [await closedApi.get(MINE), await closedApi.get(COMPANY)]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
      }
    });

    it('History marks the leads reported in a starting summary', async () => {
      const { org, admin, customer } = await onOrg();
      const a = await fx.addLead(org, customer);
      await summaryWith(org, [{ id: a.id, to: [admin.id], enteredAgoMs: 5 * HOUR_MS, number: 'L-A' }]);
      const b = await fx.addLead(org, customer);
      await alertRow(org, b.id, [admin.id], new Date());
      const res = await (await fx.signedInAs(admin)).get(HISTORY);
      const byLead = Object.fromEntries(res.body.items.map((i: { lead_id: string; in_starting_summary: boolean }) => [i.lead_id, i.in_starting_summary]));
      expect(byLead).toEqual({ [a.id]: true, [b.id]: false });
    });
  });

  describe('history', () => {
    const SUMMARY = `${HISTORY}/summary`;
    const FILTERS = `${HISTORY}/filters`;
    const EXPORT = `${HISTORY}/export`;
    const SEARCH = `${HISTORY}/search`;

    /** An alert written with the alert-time copy (S3), as the sweep writes it. */
    async function snapshotRow(org: string, leadId: string, at: Date, over: Record<string, unknown> = {}) {
      return db.spiderAlert.create({
        data: {
          organization_id: org, lead_id: leadId, status: 'NEW', entered_status_at: at, counted_from: at,
          limit_value: 1, limit_unit: 'HOUR', alerted_at: at, recipient_ids: [], delivery: {},
          lead_number: 'L00001', customer_name: 'Pat Payer', company_name: null, service_location: '1 Test Way, Testville, MA',
          stage_name: 'New', elapsed_value: 2, elapsed_unit: 'HOUR', recipients: [],
          channels: {
            email: { enabled: false, status: 'SKIPPED', sent: 0, skipped: 0, failed: 0, error: null, skip_reason: null },
            sms: { enabled: false, status: 'SKIPPED', sent: 0, skipped: 0, failed: 0, error: null, skip_reason: null },
            in_app: { enabled: true, status: 'SENT' },
          },
          ...over,
        } as never,
      });
    }

    const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);

    it('every History endpoint is 403 for Sales, Dispatcher and Technician, 404 behind the gate, and 200 for an Admin', async () => {
      const { org, admin } = await spiderOrg();
      for (const person of Object.values(await staff(org)) as Person[]) {
        const api = await fx.signedInAs(person);
        for (const path of [HISTORY, SUMMARY, FILTERS, EXPORT]) expect((await api.get(path)).status).toBe(403);
        for (const path of [SEARCH, EXPORT]) expect((await api.post(path, {})).status).toBe(403);
      }
      const api = await fx.signedInAs(admin);
      for (const path of [HISTORY, SUMMARY, FILTERS, EXPORT]) expect((await api.get(path)).status).toBe(200);
      for (const path of [SEARCH, EXPORT]) expect((await api.post(path, {})).status).toBe(200);

      const gated = await fx.newOrg();
      const gatedApi = await fx.signedInAs(gated.admin);
      for (const path of [HISTORY, SUMMARY, FILTERS, EXPORT]) expect((await gatedApi.get(path)).status).toBe(404);
      for (const path of [SEARCH, EXPORT]) expect((await gatedApi.post(path, {})).status).toBe(404);
    });

    // D5: a lead still stuck after Spider is switched back on alerts again for the same stage visit.
    it('lists a re-alert as its own row, and the earlier row unchanged', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      const entered = new Date(t - 10_000);
      const first = await alertRow(org, lead.id, [admin.id], new Date(t - 2_000), {}, { enteredAt: entered, countedFrom: entered });
      const api = await fx.signedInAs(admin);
      const before = await api.get(HISTORY);
      expect(ids(before)).toEqual([first.id]);

      // Switched off and on: the same visit, counted from the new switch-on.
      const reAlert = await alertRow(org, lead.id, [admin.id], new Date(t - 1_000), {}, { enteredAt: entered, countedFrom: new Date(t - 5_000) });

      const after = await api.get(HISTORY);
      expect(after.status).toBe(200);
      expect(after.body.total).toBe(2);
      expect(ids(after)).toEqual([reAlert.id, first.id]);
      expect(after.body.items[1]).toEqual(before.body.items[0]);
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
      expect(ids(p1)).toEqual([newest.id, middle.id]);
      expect(p1.body).toMatchObject({ total: 3, page: 1, page_size: 2, total_pages: 2 });
      const p2 = await api.get(`${HISTORY}?page=2&page_size=2`);
      expect(ids(p2)).toEqual([oldest.id]);

      const big = await api.get(`${HISTORY}?page_size=500`);
      expect(big.status).toBe(200);
      expect(big.body.page_size).toBe(100);
      expect(big.body.items).toHaveLength(3);

      expect((await api.get(`${HISTORY}?page=zero`)).status).toBe(400);
    });

    it("shows the alert-time copy: the people's names, emails and roles (as the contractor did), never a phone number", async () => {
      const { org, admin, customer } = await spiderOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      await db.user.update({ where: { id: tech.id }, data: { phone: '+16175550123' } });
      const lead = await fx.addLead(org, customer);
      const at = new Date();
      await snapshotRow(org, lead.id, at, {
        recipient_ids: [admin.id, tech.id],
        lead_number: 'L00077',
        company_name: 'Payer Homes',
        service_request: 'Fix the door',
        recipients: [
          { id: admin.id, name: 'Test Admin', email: admin.email, role: 'ADMIN', type: 'admin' },
          { id: tech.id, name: 'tech Tester', email: tech.email, role: 'TECHNICIAN', type: 'user' },
        ],
        channels: {
          email: { enabled: true, status: 'SENT', sent: 1, skipped: 1, failed: 0, error: null, skip_reason: 'Recipient opted out', from: 'ServWave Spider Alerts <alerts@spider.servwave.com>' },
          sms: { enabled: true, status: 'FAILED', sent: 0, skipped: 0, failed: 2, error: 'Text message delivery failed', skip_reason: null },
          in_app: { enabled: true, status: 'SENT' },
        },
        email_subject: 'Spider Alert - Pat Payer (L00077)',
        email_body: 'the email',
        sms_message: 'the text',
        in_app_message: 'the sentence',
      });

      const res = await (await fx.signedInAs(admin)).get(HISTORY);
      const [row] = res.body.items;
      expect(row).toMatchObject({
        lead_id: lead.id,
        lead_number: 'L00077',
        customer_name: 'Pat Payer',
        company_name: 'Payer Homes',
        service_location: '1 Test Way, Testville, MA',
        stage_name: 'New',
        elapsed: { value: 2, unit: 'HOUR' },
        alerted_at: at.toISOString(),
        outcome: 'FAILED',
        outcomes: {
          email: { enabled: true, status: 'SENT', sent: 1, skipped: 1, failed: 0 },
          sms: { enabled: true, status: 'FAILED', error: 'Text message delivery failed' },
          in_app: { enabled: true, status: 'SENT' },
        },
        recipients: [
          { id: admin.id, name: 'Test Admin', email: admin.email, role: 'ADMIN', type: 'admin' },
          { id: tech.id, name: 'tech Tester', email: tech.email, role: 'TECHNICIAN', type: 'user' },
        ],
        email_subject: 'Spider Alert - Pat Payer (L00077)',
        email_body: 'the email',
        sms_message: 'the text',
        in_app_message: 'the sentence',
      });
      // Never the person's phone number, in any digit form. (A bare /555/ also matches random ids, emails and ISO times.)
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('+16175550123');
      expect(body).not.toMatch(/617[^0-9a-f]{0,3}555[^0-9a-f]{0,3}0123|16175550123/);
    });

    it('an alert from before the copy shows its lead and people as they are now, its outcome read from our sentences, and no message text', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      await alertRow(org, lead.id, [admin.id], new Date(), {
        in_app: { outcome: 'Shown in the app' },
        email: { outcome: 'Email alerts are switched off' },
        text: { outcome: 'Text skipped: no phone number on profile', recipients: [{ user_id: admin.id, outcome: 'Text skipped: no phone number on profile' }] },
      });
      const [row] = (await (await fx.signedInAs(admin)).get(HISTORY)).body.items;
      expect(row).toMatchObject({
        lead_number: `L-${lead.id.slice(0, 8)}`,
        customer_name: 'Pat Payer',
        service_location: 'Service location on file',
        stage_name: 'New',
        outcome: 'SENT',
        outcomes: {
          email: { enabled: false, status: 'SKIPPED' },
          sms: { enabled: true, status: 'SKIPPED', skipped: 1, skip_reason: 'no phone number' },
          in_app: { enabled: true, status: 'SENT' },
        },
        recipients: [{ id: admin.id, name: 'Test Admin', email: admin.email, role: 'ADMIN', type: null }],
        // The old screen's fields, in their old shape: a frontend deployed before this backend still renders.
        status_label: 'New',
        channels: { in_app: 'Shown in the app', email: 'Email alerts are switched off', text: 'Text skipped: no phone number on profile' },
        email_body: null,
        sms_message: null,
        in_app_message: null,
      });
    });

    it('searches every page, not just the one on screen: lead number, customer, company and address', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      // The match is the oldest of 30: on the second page of 25.
      const target = await snapshotRow(org, lead.id, new Date(t - 60_000), {
        lead_number: 'L09999', customer_name: 'Quinn Quarry', company_name: 'Quarry Works', service_location: '9 Granite Lane, Rockport',
      });
      for (let i = 0; i < 29; i++) await snapshotRow(org, lead.id, new Date(t - i * 1_000));
      const api = await fx.signedInAs(admin);
      for (const q of ['l09999', 'quinn', 'QUARRY works', 'granite']) {
        const res = await api.get(`${HISTORY}?search=${encodeURIComponent(q)}`);
        expect(res.body.total).toBe(1);
        expect(ids(res)).toEqual([target.id]);
      }
    });

    it('finds an alert from before the copy by its lead and customer as they are now', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      await db.customer.update({ where: { id: customer }, data: { company_name: 'Payer Homes' } });
      const legacy = await alertRow(org, lead.id, [admin.id], new Date());
      const api = await fx.signedInAs(admin);
      for (const q of [lead.id.slice(0, 8), 'payer', 'Payer Homes']) {
        expect(ids(await api.get(`${HISTORY}?search=${encodeURIComponent(q)}`))).toEqual([legacy.id]);
      }
      expect((await api.get(`${HISTORY}?search=nobody`)).body.total).toBe(0);
    });

    it('filters by stage (Walkthrough includes older Walkthrough Scheduled alerts), across pages', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      const contacted = await snapshotRow(org, lead.id, new Date(t - 50_000), { status: 'CONTACTED', stage_name: 'Contacted' });
      const completed = await snapshotRow(org, lead.id, new Date(t - 40_000), { status: 'WALKTHROUGH_COMPLETED', stage_name: 'Walkthrough Completed' });
      const scheduled = await alertRow(org, lead.id, [admin.id], new Date(t - 30_000));
      await db.spiderAlert.update({ where: { id: scheduled.id }, data: { status: 'WALKTHROUGH_SCHEDULED' } });
      for (let i = 0; i < 26; i++) await snapshotRow(org, lead.id, new Date(t - i * 100));
      const api = await fx.signedInAs(admin);
      expect(ids(await api.get(`${HISTORY}?stage=CONTACTED`))).toEqual([contacted.id]);
      expect(ids(await api.get(`${HISTORY}?stage=WALKTHROUGH`))).toEqual([scheduled.id, completed.id]);
      expect(ids(await api.get(`${HISTORY}?stage=CONTACTED,WALKTHROUGH`))).toEqual([scheduled.id, completed.id, contacted.id]);
      expect((await api.get(`${HISTORY}?stage=NEW`)).body.total).toBe(26);
      expect((await api.get(`${HISTORY}?stage=WON`)).status).toBe(400);
    });

    it('filters by date ranges (any of them), by recipient, and by customer', async () => {
      const { org, admin, customer } = await spiderOrg();
      const sales = await fx.addUser(org, 'sales', 'SALES');
      const otherCustomer = randomUUIDv4();
      await db.customer.create({
        data: { id: otherCustomer, organization_id: org, customer_number: `C-${otherCustomer.slice(0, 6)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Olive', last_name: 'Other' },
      });
      const lead = await fx.addLead(org, customer);
      const otherLead = await fx.addLead(org, otherCustomer);
      const d = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`);
      const oct1 = await snapshotRow(org, lead.id, d(1), { recipient_ids: [admin.id], customer_id: customer });
      const oct5 = await snapshotRow(org, otherLead.id, d(5), { recipient_ids: [sales.id], customer_id: otherCustomer });
      const oct9 = await alertRow(org, otherLead.id, [admin.id, sales.id], d(9));
      const api = await fx.signedInAs(admin);
      const range = (a: number, b: number) => `${d(a).toISOString().slice(0, 10)}T00:00:00.000Z~${d(b).toISOString().slice(0, 10)}T23:59:59.999Z`;

      expect(ids(await api.get(`${HISTORY}?ranges=${range(4, 6)}`))).toEqual([oct5.id]);
      expect(ids(await api.get(`${HISTORY}?ranges=${range(1, 1)},${range(9, 9)}`))).toEqual([oct9.id, oct1.id]);
      expect(ids(await api.get(`${HISTORY}?recipients=${sales.id}`))).toEqual([oct9.id, oct5.id]);
      expect(ids(await api.get(`${HISTORY}?customers=${otherCustomer}`))).toEqual([oct9.id, oct5.id]);
      expect(ids(await api.get(`${HISTORY}?customers=${customer}`))).toEqual([oct1.id]);
      expect((await api.get(`${HISTORY}?ranges=nonsense`)).status).toBe(400);
    });

    it("filters by role: the role stored at alert time, else the person's role now", async () => {
      const { org, admin, customer } = await spiderOrg();
      const dispatcher = await fx.addUser(org, 'dispatcher', 'DISPATCHER');
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      // Stored as Sales when it went out, though the same person is a Dispatcher now.
      const storedSales = await snapshotRow(org, lead.id, new Date(t - 3_000), {
        recipient_ids: [dispatcher.id],
        recipients: [{ id: dispatcher.id, name: 'dispatcher Tester', email: dispatcher.email, role: 'SALES', type: 'user' }],
      });
      const legacyDispatcher = await alertRow(org, lead.id, [dispatcher.id], new Date(t - 2_000));
      const storedAdmin = await snapshotRow(org, lead.id, new Date(t - 1_000), {
        recipient_ids: [admin.id],
        recipients: [{ id: admin.id, name: 'Test Admin', email: admin.email, role: 'ADMIN', type: 'admin' }],
      });
      const api = await fx.signedInAs(admin);
      expect(ids(await api.get(`${HISTORY}?roles=SALES`))).toEqual([storedSales.id]);
      expect(ids(await api.get(`${HISTORY}?roles=DISPATCHER`))).toEqual([legacyDispatcher.id]);
      expect(ids(await api.get(`${HISTORY}?roles=ADMIN,SALES`))).toEqual([storedAdmin.id, storedSales.id]);
      expect((await api.get(`${HISTORY}?roles=OWNER`)).status).toBe(400);
    });

    it('his "Administrator (Owner)" also finds alerts that reached the lead\'s owner', async () => {
      const { org, admin, customer } = await spiderOrg();
      const rep = await fx.addUser(org, 'rep', 'SALES');
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      const toOwner = await snapshotRow(org, lead.id, new Date(t - 2_000), {
        recipient_ids: [rep.id],
        recipients: [{ id: rep.id, name: 'rep Tester', email: rep.email, role: 'SALES', type: 'owner' }],
      });
      await snapshotRow(org, lead.id, new Date(t - 1_000), {
        recipient_ids: [rep.id],
        recipients: [{ id: rep.id, name: 'rep Tester', email: rep.email, role: 'SALES', type: 'user' }],
      });
      const api = await fx.signedInAs(admin);
      expect(ids(await api.get(`${HISTORY}?roles=ADMIN`))).toEqual([toOwner.id]);
    });

    it('POST takes the toolbar in the body: 250 ticked customers load, and filter', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const row = await snapshotRow(org, lead.id, new Date(), { customer_id: customer });
      const others = Array.from({ length: 249 }, () => randomUUIDv4());
      const api = await fx.signedInAs(admin);
      const res = await api.post(SEARCH, { page: 1, page_size: 25, customers: [customer, ...others] });
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([row.id]);
      const none = await api.post(SEARCH, { customers: others });
      expect(none.body.total).toBe(0);
      const exp = await api.post(EXPORT, { customers: [customer, ...others] });
      expect(exp.status).toBe(200);
      expect(exp.body.items.map((i: { id: string }) => i.id)).toEqual([row.id]);
      expect((await api.post(SEARCH, { customers: ['not-an-id'] })).status).toBe(400);
    });

    it('exports every filtered row, past one page, for this company only', async () => {
      const { org, admin, customer } = await spiderOrg();
      const other = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const otherLead = await fx.addLead(other.org, other.customer);
      const t = Date.now();
      for (let i = 0; i < 120; i++) await snapshotRow(org, lead.id, new Date(t - i * 1_000), { status: i % 2 ? 'CONTACTED' : 'NEW' });
      await snapshotRow(other.org, otherLead.id, new Date(t));
      const api = await fx.signedInAs(admin);
      const all = await api.get(EXPORT);
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ total: 120, truncated: false });
      expect(all.body.items).toHaveLength(120);
      const contacted = await api.get(`${EXPORT}?stage=CONTACTED`);
      expect(contacted.body.items).toHaveLength(60);
      expect(contacted.body.items.every((i: { status: string }) => i.status === 'CONTACTED')).toBe(true);
    });

    it('the summary counts every alert, and those newer than the last view', async () => {
      const { org, admin, customer } = await spiderOrg();
      const api = await fx.signedInAs(admin);
      const lead = await fx.addLead(org, customer);
      const t = Date.now();
      await alertRow(org, lead.id, [admin.id], new Date(t - 10_000));
      await alertRow(org, lead.id, [admin.id], new Date(t - 5_000));
      await alertRow(org, lead.id, [admin.id], new Date(t - 1_000));

      expect((await api.get(SUMMARY)).body).toEqual({ total: 3, new_since: 3 });
      const since = new Date(t - 6_000).toISOString();
      expect((await api.get(`${SUMMARY}?since=${since}`)).body).toEqual({ total: 3, new_since: 2 });
      expect((await api.get(`${SUMMARY}?since=nonsense`)).status).toBe(400);
    });

    it("the summary counts only this company's alerts", async () => {
      const mine = await spiderOrg();
      const other = await spiderOrg();
      const myLead = await fx.addLead(mine.org, mine.customer);
      const theirLead = await fx.addLead(other.org, other.customer);
      await alertRow(mine.org, myLead.id, [mine.admin.id], new Date());
      for (let i = 0; i < 4; i++) await alertRow(other.org, theirLead.id, [other.admin.id], new Date(Date.now() - i * 1_000));
      expect((await (await fx.signedInAs(mine.admin)).get(SUMMARY)).body).toEqual({ total: 1, new_since: 1 });
      expect((await (await fx.signedInAs(other.admin)).get(SUMMARY)).body).toEqual({ total: 4, new_since: 4 });
    });

    it("the filter lists, as his: every person and every customer of this company, and no other company's", async () => {
      const { org, admin, customer } = await spiderOrg();
      const other = await spiderOrg();
      const sales = await fx.addUser(org, 'sales', 'SALES');
      const quiet = randomUUIDv4();
      await db.customer.create({
        data: { id: quiet, organization_id: org, customer_number: `C-${quiet.slice(0, 6)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Never', last_name: 'Alerted' },
      });
      const lead = await fx.addLead(org, customer);
      await alertRow(org, lead.id, [admin.id], new Date());
      const res = await (await fx.signedInAs(admin)).get(FILTERS);
      expect(res.body.recipients).toEqual(expect.arrayContaining([
        { value: admin.id, label: 'Test Admin' },
        { value: sales.id, label: 'sales Tester' },
      ]));
      expect(res.body.recipients.map((r: { value: string }) => r.value)).not.toContain(other.admin.id);
      expect(res.body.customers).toEqual([
        { value: quiet, label: 'Never Alerted' },
        { value: customer, label: 'Pat Payer' },
      ]);
    });

    it('still returns earlier alerts after Spider is switched off', async () => {
      const { org, admin, customer } = await spiderOrg();
      const lead = await fx.addLead(org, customer);
      const api = await fx.signedInAs(admin);
      await switchOn(admin);
      const row = await alertRow(org, lead.id, [admin.id], new Date());
      const record = await unreadSpiderAlert(org, admin.id, lead.id, { spider_alert_id: row.id });
      const before = (await api.get(HISTORY)).body.items;
      await api.put(STATUS, { isActive: false });
      // Switching off ended the alert's record; its History item is unchanged.
      expect((await db.notificationRecipient.findUniqueOrThrow({ where: { id: record.id } })).read_at).not.toBeNull();
      const res = await api.get(HISTORY);
      expect(ids(res)).toEqual([row.id]);
      expect(res.body.items).toEqual(before);
    });
  });
  // ─── The sweep lease (#2993) ───────────────────────────────────────────────

  describe('one sweep at a time across servers (the sweep lease, #2993)', () => {
    const MINE = '/api/ai-farm/spider/summary';
    const lease = (sql: string) => db.$executeRawUnsafe(sql);

    it('an Admin switches Spider on over a backlog: while another server holds the lease nothing is sent, then one run sends the starting summary the Admin reads', async () => {
      const { org, admin, customer } = await onOrg();
      const save = await (await fx.signedInAs(admin)).put(SETTINGS, body({ recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false } }));
      expect(save.status).toBe(200);
      const backlog = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: backlog.id }, data: { created_at: new Date(Date.now() - 5 * 3_600_000) } });
      // Past the starting summary's quiet period.
      const later = new Date(Date.now() + 15 * 60_000);

      await lease(`INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ('spider.sweep', 'other-server', now(), now() + interval '5 minutes')
                   ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at`);
      try {
        expect((await runSpiderSweep(later)).ran).toBe(false);
        expect((await (await fx.signedInAs(admin)).get(MINE)).body).toEqual({ summary: null });
        expect(await db.spiderAlert.count({ where: { organization_id: org } })).toBe(0);
      } finally {
        // The other server's run ends and gives its lease up.
        await lease(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep' AND holder = 'other-server'`);
      }

      const result = await runSpiderSweep(later);
      expect(result.ran).toBe(true);
      expect(result.leadsSummarized).toBeGreaterThanOrEqual(1);
      const mine = await (await fx.signedInAs(admin)).get(MINE);
      expect(mine.status).toBe(200);
      expect(mine.body.summary).toMatchObject({ total: 1, trigger_kind: expect.any(String) });
      expect(mine.body.summary.leads.map((l: { lead_id: string }) => l.lead_id)).toEqual([backlog.id]);
      // The run gave the lease up: nothing is left behind for the next run on any server.
      expect(await db.$queryRawUnsafe(`SELECT holder FROM spider_sweep_leases WHERE name = 'spider.sweep'`)).toEqual([]);
    });
  });
});

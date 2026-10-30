/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.13 - Time tracking: See everyone's timesheets, and clock-in location
   checks removed.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { VERB_RULES } from '../services/notifications/templates';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

const SEE_ALL = 'see_everyones_timesheets';
// A work zone in Austin and a person a long way from it.
const STORE = { lat: 30.2672, lng: -97.7431 };
const FAR_AWAY = { lat: 40.7128, lng: -74.006 };

suite('Time tracking follows switches and no longer checks where a clock-in happened (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['time_entries', 'timeclock_ot_reviews', 'geofence_stores', 'geofence_configs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role of this base holding exactly these time tracking values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `time-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addStoreZone(org: string) {
    await db.geofenceStore.create({ data: { organization_id: org, label: 'Main store', lat: STORE.lat, lng: STORE.lng } });
    await db.geofenceConfig.upsert({ where: { organization_id: org }, update: { radius_m: 50 }, create: { organization_id: org, radius_m: 50 } });
  }

  describe('a clock-in or clock-out is never blocked, whatever the location settings say', () => {
    for (const settings of [
      { enforce_clock_in_location: true, can_approve_clock_overrides: false },
      { enforce_clock_in_location: false, can_approve_clock_overrides: false },
      { enforce_clock_in_location: true, can_approve_clock_overrides: true },
    ]) {
      it(`records a clock-in far from any work zone with no override request (${JSON.stringify(settings)}), and shows it on the person's own timesheet`, async () => {
        const { org } = await newOrg();
        await addStoreZone(org);
        const worker = await personWith(org, {});
        await db.user.update({ where: { id: worker.id }, data: settings });
        const api = await worker.api();

        const clockIn = await api.post('/api/timeclock/punches', { type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng, accuracy_m: 12 });
        expect(clockIn.status).toBe(201);
        expect(clockIn.body.requiresOverride).toBeUndefined();
        expect(clockIn.body.punch).toMatchObject({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

        const clockOut = await api.post('/api/timeclock/punches', { type: 'OUT', lat: STORE.lat + 0.5, lng: STORE.lng + 0.5 });
        expect(clockOut.status).toBe(201);

        // Where each one happened is on the person's own timesheet.
        const own = await api.get('/api/timeclock/punches');
        expect(own.status).toBe(200);
        expect(own.body.punches.map((p: { type: string; lat: number; lng: number }) => [p.type, p.lat, p.lng])).toEqual([
          ['IN', FAR_AWAY.lat, FAR_AWAY.lng],
          ['OUT', STORE.lat + 0.5, STORE.lng + 0.5],
        ]);
      });
    }

    it('raises no alert for a clock-in outside a work zone', async () => {
      const { org } = await newOrg();
      await addStoreZone(org);
      const worker = await personWith(org, {});
      const res = await (await worker.api()).post('/api/timeclock/punches', { type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });
      expect(res.status).toBe(201);
      expect(await db.notification.count({ where: { organization_id: org } })).toBe(0);
    });

    // S06.29: no clock-in raises an "OT override requested" alert, whoever there is to tell and however the person's settings are
    // set. The alert, its template and its recipient row are gone from the verb registry, so there is nothing left to send.
    it('raises no override alert for anyone, even with an approver and an admin on hand, and no such alert exists to send', async () => {
      const { org } = await newOrg();
      await addStoreZone(org);
      const approver = await personWith(org, {});
      await db.user.update({ where: { id: approver.id }, data: { can_approve_clock_overrides: true } });
      const worker = await personWith(org, {});
      await db.user.update({ where: { id: worker.id }, data: { enforce_clock_in_location: true } });
      const api = await worker.api();

      for (const type of ['IN', 'OUT'] as const) {
        const res = await api.post('/api/timeclock/punches', { type, lat: FAR_AWAY.lat, lng: FAR_AWAY.lng, accuracy_m: 12 });
        expect(res.status).toBe(201);
      }
      await reviewAttentionSettled();
      expect(await db.notification.count({ where: { organization_id: org } })).toBe(0);
      expect(Object.keys(VERB_RULES).filter((v) => /clock|override|overtime|\bot\b/i.test(v)), 'no verb for it is left in the registry').toEqual([]);
    });

    it('lets an admin on the built-in role clock in the same way', async () => {
      const { org, admin } = await newOrg();
      await addStoreZone(org);
      const res = await (await fx.signedInAs(admin)).post('/api/timeclock/punches', { type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });
      expect(res.status).toBe(201);
    });
  });

  describe('the radius, work-zone and per-user location endpoints no longer exist', () => {
    it('answer not found to an admin and to a custom role holding every switch', async () => {
      const { org, admin } = await newOrg();
      await addStoreZone(org);
      const everything = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
      const holder = await personWith(org, everything);
      const someone = await fx.addUser(org, `t${++sequence}`, 'TECHNICIAN');
      const punch = await db.timeEntry.create({
        data: { organization_id: org, user_id: someone.id, type: 'IN', ts: new Date(), lat: 1, lng: 2, status: 'OVERRIDE', review: 'PENDING' },
      });
      const store = await db.geofenceStore.findFirstOrThrow({ where: { organization_id: org } });

      const calls: Array<[string, (api: Api) => ReturnType<Api['get']>]> = [
        ['GET /config', (api) => api.get('/api/timeclock/config')],
        ['PUT /config', (api) => api.put('/api/timeclock/config', { radiusM: 100 })],
        ['POST /stores', (api) => api.post('/api/timeclock/stores', { label: 'New', lat: 1, lng: 2 })],
        ['PATCH /stores/:id', (api) => api.patch(`/api/timeclock/stores/${store.id}`, { label: 'Renamed' })],
        ['DELETE /stores/:id', (api) => api.delete(`/api/timeclock/stores/${store.id}`)],
        ['PATCH /users/:id/timeclock-settings', (api) => api.patch(`/api/timeclock/users/${someone.id}/timeclock-settings`, { enforce_clock_in_location: false })],
        ['POST override approve', (api) => api.post(`/api/timeclock/punches/${punch.id}/override/approve`)],
        ['POST override reject', (api) => api.post(`/api/timeclock/punches/${punch.id}/override/reject`)],
      ];
      for (const person of [admin, holder]) {
        const api = await fx.signedInAs(person);
        for (const [name, call] of calls) {
          expect((await call(api)).status, `${name} for ${person.email}`).toBe(404);
        }
      }
      // Nothing it would have changed was touched: the saved zone and the person's settings stay as they were.
      expect(await db.geofenceStore.count({ where: { organization_id: org } })).toBe(1);
      expect((await db.geofenceStore.findUniqueOrThrow({ where: { id: store.id } })).label).toBe('Main store');
      expect((await db.geofenceConfig.findUniqueOrThrow({ where: { organization_id: org } })).radius_m).toBe(50);
      expect((await db.user.findUniqueOrThrow({ where: { id: someone.id } })).enforce_clock_in_location).toBe(true);
      expect((await db.timeEntry.findUniqueOrThrow({ where: { id: punch.id } })).review).toBe('PENDING');
    });
  });

  describe("org timesheets open with See everyone's timesheets", () => {
    async function twoPeopleWithHours(org: string) {
      const a = await fx.addUser(org, `a${++sequence}`, 'TECHNICIAN');
      const b = await fx.addUser(org, `b${++sequence}`, 'SALES');
      const at = new Date('2026-09-01T13:00:00Z');
      for (const [person, lat] of [[a, 10], [b, 20]] as const) {
        await db.timeEntry.create({ data: { organization_id: org, user_id: person.id, type: 'IN', ts: at, lat, lng: lat, status: 'IN_ZONE' } });
        await db.timeEntry.create({ data: { organization_id: org, user_id: person.id, type: 'OUT', ts: new Date(at.getTime() + 3600_000), lat, lng: lat, status: 'IN_ZONE' } });
        await db.timeClockOtReview.create({
          data: { organization_id: org, user_id: person.id, period_key: '2026-W36', state: 'APPROVED', reviewed_by: person.id, reviewed_at: at },
        });
      }
      return { a, b };
    }

    for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER', 'ADMIN'] as const) {
      it(`lets a custom role based on ${base} open everyone's punches and overtime reviews with the switch on, with their locations`, async () => {
        const { org } = await newOrg();
        const { a, b } = await twoPeopleWithHours(org);
        const viewer = await personWith(org, { [SEE_ALL]: true }, { base });
        const api = await viewer.api();

        const punches = await api.get('/api/timeclock/punches?scope=org');
        expect(punches.status).toBe(200);
        expect(punches.body.punches.map((p: { userId: string; lat: number; lng: number }) => [p.userId, p.lat, p.lng]).sort()).toEqual(
          [[a.id, 10, 10], [a.id, 10, 10], [b.id, 20, 20], [b.id, 20, 20]].sort(),
        );

        const reviews = await api.get('/api/timeclock/ot-reviews?scope=org');
        expect(reviews.status).toBe(200);
        expect(reviews.body.reviews.map((r: { user_id: string }) => r.user_id).sort()).toEqual([a.id, b.id].sort());
      });

      it(`refuses a custom role based on ${base} the org views with the switch off, and still shows them their own`, async () => {
        const { org } = await newOrg();
        const { a } = await twoPeopleWithHours(org);
        const viewer = await personWith(org, { [SEE_ALL]: false }, { base });
        const api = await viewer.api();
        await db.timeEntry.create({ data: { organization_id: org, user_id: viewer.id, type: 'IN', ts: new Date(), lat: 5, lng: 6, status: 'IN_ZONE' } });

        expect((await api.get('/api/timeclock/punches?scope=org')).status).toBe(403);
        expect((await api.get('/api/timeclock/ot-reviews?scope=org')).status).toBe(403);

        // Their own timesheet is open to everyone, with or without the switch, and holds nobody else's.
        const own = await api.get('/api/timeclock/punches');
        expect(own.status).toBe(200);
        expect(own.body.punches.map((p: { userId: string }) => p.userId)).toEqual([viewer.id]);
        expect((await api.get('/api/timeclock/punches?scope=me')).body.punches.map((p: { userId: string }) => p.userId)).toEqual([viewer.id]);
        expect((await api.get('/api/timeclock/ot-reviews?scope=me')).status).toBe(200);
        expect(a.id).not.toBe(viewer.id);
      });
    }
  });

  describe('the route-level enforcement table', () => {
    const probes: Array<{ check: string; call: (api: Api) => ReturnType<Api['get']> }> = [
      { check: 'timesheet-punches-org', call: (api) => api.get('/api/timeclock/punches?scope=org') },
      { check: 'timesheet-ot-reviews-org', call: (api) => api.get('/api/timeclock/ot-reviews?scope=org') },
    ];

    it("has a probe for every server check the Time tracking group lists, and none for a check it does not list", () => {
      const listed = SWITCH_CATALOG.filter((s) => s.module === 'Time tracking').flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      expect(probes.map((p) => `${SEE_ALL}:${p.check}`).sort()).toEqual(listed.sort());
    });

    for (const probe of probes) {
      it(`${probe.check}: let in with ${SEE_ALL} on, refused with it off`, async () => {
        const { org } = await newOrg();
        const on = await personWith(org, { [SEE_ALL]: true });
        expect((await probe.call(await on.api())).status, 'with the switch on').toBe(200);
        const off = await personWith(org, { [SEE_ALL]: false });
        expect((await probe.call(await off.api())).status, 'with the switch off').toBe(403);
      });
    }
  });
});

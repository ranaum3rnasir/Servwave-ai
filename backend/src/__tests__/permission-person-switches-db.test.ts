/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.20 - a person's switches API: read, differences, write, reset,
   Save as role, the person's change log, and the Me read.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Expected values come from the catalog's presets, never a
   copy of them. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates
   is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { SWITCH_CATALOG, presetSwitchSet, type SwitchEntry, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;


/** A toggle the Sales preset holds off, that needs nothing else and that nothing else needs: safe to flip on. */
const flippable = (role: Role, count: number): SwitchEntry[] => {
  const needed = new Set(SWITCH_CATALOG.flatMap((s) => [...s.requires, ...(s.requiresAny ?? [])]));
  return SWITCH_CATALOG.filter(
    (s) => s.kind === 'toggle' && s.presets[role] === false && s.requires.length === 0 && !s.requiresAny && !needed.has(s.key),
  ).slice(0, count);
};

suite("a person's switches API (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /**
   * A person on a fresh custom role (everything as Dispatcher), an Admin or not: since AL-18 managing roles and people's
   * switches is the Admin flag's alone, never a switch.
   */
  async function manager(org: string, manage: boolean): Promise<Person & { api: () => Promise<Api> }> {
    const key = `mgr-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const person = await fx.addUser(org, `mgr${sequence}`, 'DISPATCHER', { customRoleId: role.id, isAdmin: manage });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A plain person on a built-in role, the one the cases read and change. */
  const target = (org: string, role: Role = 'SALES') => fx.addUser(org, `target${++sequence}`, role);

  const read = async (api: Api, id: string) => (await api.get(`/api/users/${id}/permissions`)).body;

  describe('read', () => {
    it("answers the person's resolved values, who they are based on, and no differences", async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const sales = await target(org, 'SALES');
      const res = await (await me.api()).get(`/api/users/${sales.id}/permissions`);
      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe(sales.id);
      expect(res.body.admin_box).toBe(false);
      expect(res.body.based_on).toMatchObject({ key: 'SALES', type: 'built_in' });
      expect(res.body.values).toEqual(presetSwitchSet('SALES'));
      expect(res.body.differences).toEqual([]);
      expect(res.body.difference_count).toBe(0);
    });

    it('opens a person migrated with an old Allow and Deny entry on the role\'s preset values and zero changes', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const sales = await target(org, 'SALES');
      // What the old Inherit / Allow / Deny dialog left behind: one entry of each kind.

      const body = await read(await me.api(), sales.id);
      expect(body.values).toEqual(presetSwitchSet('SALES'));
      expect(body.differences).toEqual([]);
      expect(body.difference_count).toBe(0);
    });

    it('is refused for a person of another company', async () => {
      const { org } = await fx.newOrg();
      const other = await fx.newOrg();
      const me = await manager(org, true);
      const stranger = await target(other.org);
      expect((await (await me.api()).get(`/api/users/${stranger.id}/permissions`)).status).toBe(404);
    });

    it('gives the Admin box no set and no differences, and refuses a write to it', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const res = await api.get(`/api/users/${admin.id}/permissions`);
      expect(res.status).toBe(200);
      expect(res.body.admin_box).toBe(true);
      expect(res.body.differences).toEqual([]);
      expect(res.body.difference_count).toBe(0);
      const [one] = flippable('ADMIN', 1);
      const values = { [one?.key ?? 'view_jobs']: true };
      // An Admin's switches are the Owner's to touch (ticket 26): an Admin who is not the Owner is refused first (403).
      const byOther = await api.put(`/api/users/${admin.id}/permissions`, { values });
      expect(byOther.status).toBe(403);
      expect(byOther.body.error).toBe('Only the Owner can change Admins.');
      expect(await db.permissionUserSwitch.count({ where: { user_id: admin.id } })).toBe(0);
      // The Owner is refused too: the Admin box has no set to write.
      const another = await fx.addUser(org, 'another-admin', 'ADMIN');
      expect((await (await fx.signedInAs(admin)).put(`/api/users/${another.id}/permissions`, { values })).status).toBe(400);
      expect(await db.permissionUserSwitch.count({ where: { user_id: another.id } })).toBe(0);
    });
  });

  describe('write', () => {
    it('stores the values sent and answers the differences from the role, with their count', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a, b] = flippable('SALES', 2);
      expect(a && b).toBeTruthy();

      const res = await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      expect(res.status).toBe(200);
      expect(res.body.difference_count).toBe(2);
      expect(res.body.differences.map((d: { switch_key: string }) => d.switch_key).sort()).toEqual([a!.key, b!.key].sort());
      for (const d of res.body.differences) {
        expect(d.value).toBe(true);
        expect(d.role_value).toBe(false);
      }

      const again = await read(api, sales.id);
      expect(again.values[a!.key]).toBe(true);
      expect(again.difference_count).toBe(2);
    });

    it('refuses a body with Create on and View off, storing nothing', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const res = await api.put(`/api/users/${sales.id}/permissions`, { values: { edit_jobs: true, create_jobs: true, view_jobs: false } });
      expect(res.status).toBe(400);
      expect(res.body.violations).toEqual(expect.arrayContaining([expect.objectContaining({ switchKey: 'create_jobs', needs: ['view_jobs'] })]));
      expect(await db.permissionUserSwitch.count({ where: { user_id: sales.id } })).toBe(0);
      expect((await read(api, sales.id)).difference_count).toBe(0);
    });

    it('stores Record payments on with Invoices View off', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const tech = await target(org, 'TECHNICIAN');
      const before = await read(api, tech.id);
      expect(before.values.view_invoices).toBe(false);
      const res = await api.put(`/api/users/${tech.id}/permissions`, { values: { record_payments: true } });
      expect(res.status).toBe(200);
      const after = await read(api, tech.id);
      expect(after.values.record_payments).toBe(true);
      expect(after.values.view_invoices).toBe(false);
    });

    it('refuses an unknown switch and a body with no values', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org);
      expect((await api.put(`/api/users/${sales.id}/permissions`, { values: { not_a_switch: true } })).status).toBe(400);
      expect((await api.put(`/api/users/${sales.id}/permissions`, { values: {} })).status).toBe(400);
      expect((await api.put(`/api/users/${sales.id}/permissions`, {})).status).toBe(400);
    });
  });

  describe('reset', () => {
    it("restores the role's value for one switch and leaves the others as they were", async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a, b] = flippable('SALES', 2);
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });

      const res = await api.post(`/api/users/${sales.id}/permissions/reset`, { switch_keys: [a!.key] });
      expect(res.status).toBe(200);
      expect(res.body.values[a!.key]).toBe(false);
      expect(res.body.values[b!.key]).toBe(true);
      expect(res.body.difference_count).toBe(1);
      expect(res.body.differences[0].switch_key).toBe(b!.key);
    });

    it('resets every switch with all: true', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a, b] = flippable('SALES', 2);
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      const res = await api.post(`/api/users/${sales.id}/permissions/reset`, { all: true });
      expect(res.status).toBe(200);
      expect(res.body.difference_count).toBe(0);
      expect(res.body.values).toEqual(presetSwitchSet('SALES'));
    });

    it('refuses an unknown switch and a body naming nothing to reset', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org);
      expect((await api.post(`/api/users/${sales.id}/permissions/reset`, { switch_keys: ['not_a_switch'] })).status).toBe(400);
      expect((await api.post(`/api/users/${sales.id}/permissions/reset`, {})).status).toBe(400);
    });
  });

  describe('Save as role', () => {
    it('makes a custom role from the values, records its source, moves the person onto it with zero differences', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a] = flippable('SALES', 1);
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } });
      const before = await read(api, sales.id);
      expect(before.difference_count).toBe(1);

      const res = await api.post(`/api/users/${sales.id}/permissions/save-as-role`, { label: 'Sales plus' });
      expect(res.status).toBe(201);
      expect(res.body.role).toMatchObject({ label: 'Sales plus', type: 'custom', base_role: 'SALES', made_from_role_key: 'SALES' });

      const after = await read(api, sales.id);
      expect(after.difference_count).toBe(0);
      expect(after.differences).toEqual([]);
      expect(after.based_on).toMatchObject({ key: res.body.role.role, type: 'custom', label: 'Sales plus' });
      expect(after.values).toEqual(before.values);

      const row = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: res.body.role.role } });
      expect(row.made_from_role_key).toBe('SALES');
      expect(row.base_role).toBe('SALES');
      const person = await db.user.findUniqueOrThrow({ where: { id: sales.id } });
      expect(person.custom_role_id).toBe(row.id);
      expect(person.based_on_role_key).toBe(row.key);
      // The new role holds the person's values: someone given it later starts from them.
      const stored = await db.permissionRoleSwitch.findMany({ where: { organization_id: org, role_key: row.key } });
      const storedA = stored.find((r) => r.switch_key === a!.key);
      expect(storedA?.value).toBe(true);
    });

    it('carries the base built-in role of a role made from blank, and refuses a name that is taken or reserved', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const blankRole = await fx.addCustomRole(org, `blank-${++sequence}`, 'TECHNICIAN', { madeFromBlank: true });
      const person = await fx.addUser(org, `blankp${sequence}`, 'TECHNICIAN', { customRoleId: blankRole.id, basedOnRoleKey: blankRole.key });
      const res = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Blank copy' });
      expect(res.status).toBe(201);
      const row = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: res.body.role.role } });
      expect(row.made_from_blank).toBe(true);
      expect(row.made_from_role_key).toBe(blankRole.key);

      const other = await target(org);
      expect((await api.post(`/api/users/${other.id}/permissions/save-as-role`, { label: 'Blank copy' })).status).toBe(409);
      expect((await api.post(`/api/users/${other.id}/permissions/save-as-role`, { label: 'Sales' })).status).toBe(400);
      expect((await api.post(`/api/users/${other.id}/permissions/save-as-role`, { label: '   ' })).status).toBe(400);
    });

    it('refuses the names create and rename refuse, with the same words, comparing keys and labels of live roles', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      // A role renamed after it was made keeps the key it was made with, so its label is what a person sees.
      await api.post('/api/roles', { label: 'Night Desk', blank: true });
      expect((await api.patch('/api/roles/night-desk', { label: 'Late Desk' })).status).toBe(200);
      const person = await target(org);
      const roleCount = () => db.customRole.count({ where: { organization_id: org } });
      const before = await roleCount();

      const refused = ['Technician', ' technician ', 'Administrator (Owner)', 'ADMIN', 'Administrator', 'owner', 'Late Desk', 'late   desk', 'night-desk', '!!!'];
      for (const label of refused) {
        const viaCreate = await api.post('/api/roles', { label, blank: true });
        const viaSave = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label });
        expect(viaCreate.status, label).toBeGreaterThanOrEqual(400);
        expect(viaSave.status, label).toBe(viaCreate.status);
        expect(viaSave.body.error, label).toBe(viaCreate.body.error);
      }
      const saveError = async (label: string) => (await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label })).body.error;
      expect(await saveError('Administrator (Owner)')).toBe('"Administrator (Owner)" is the name of a built-in role. Choose another name.');
      expect(await saveError('Owner')).toBe('"Owner" is the name of a built-in role. Choose another name.');
      expect(await saveError('late desk')).toBe('A role named "late desk" already exists. Choose another name.');
      // Nothing was made and the person stayed where they were.
      expect(await roleCount()).toBe(before);
      expect((await read(api, person.id)).based_on).toMatchObject({ key: 'SALES' });
      expect((await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Tech Desk' })).status).toBe(201);
    });

    it("lists the new role on the Roles list naming its source, and its reset returns to the former role's built-in preset", async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      // The person's former role is a custom one made from the Technician preset.
      const former = await fx.addCustomRole(org, `former-${++sequence}`, 'TECHNICIAN');
      const person = await fx.addUser(org, `fp${sequence}`, 'TECHNICIAN', { customRoleId: former.id, basedOnRoleKey: former.key });
      const [a] = flippable('TECHNICIAN', 1);
      expect((await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true } })).status).toBe(200);

      const saved = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Tech plus' });
      expect(saved.status).toBe(201);
      const key = saved.body.role.role as string;

      const listed = (await api.get('/api/roles')).body as Array<Record<string, unknown>>;
      expect(listed.find((r) => r.role === key)).toMatchObject({ label: 'Tech plus', type: 'custom', made_from_role_key: former.key, base_role: 'TECHNICIAN', userCount: 1 });
      expect(listed.find((r) => r.role === former.key)).toMatchObject({ userCount: 0 });
      const detail = (await api.get(`/api/roles/${key}/permissions`)).body;
      expect(detail).toMatchObject({ made_from_role_key: former.key, made_from_blank: false });
      expect(detail.values[a!.key]).toBe(true);

      const reset = await api.post(`/api/roles/${key}/reset`);
      expect(reset.status).toBe(200);
      expect(reset.body.values).toEqual(presetSwitchSet('TECHNICIAN'));
    });

    it('is refused for the Admin box', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await manager(org, true);
      // An Admin who is not the Owner is refused first (ticket 26); the Owner is refused by the Admin box (no set to save).
      const res = await (await me.api()).post(`/api/users/${admin.id}/permissions/save-as-role`, { label: 'Everything' });
      expect(res.status).toBe(403);
      const another = await fx.addUser(org, 'another-admin', 'ADMIN');
      const byOwner = await (await fx.signedInAs(admin)).post(`/api/users/${another.id}/permissions/save-as-role`, { label: 'Everything' });
      expect(byOwner.status).toBe(400);
      expect(await db.customRole.count({ where: { organization_id: org, label: 'Everything' } })).toBe(0);
    });
  });

  describe('who may use it', () => {
    it('refuses every person-set read and write and the person change log to a non-Admin; the catalog and Me answer', async () => {
      const { org } = await fx.newOrg();
      const outsider = await manager(org, false);
      const api = await outsider.api();
      const sales = await target(org);
      const [a] = flippable('SALES', 1);

      expect((await api.get(`/api/users/${sales.id}/permissions`)).status).toBe(403);
      expect((await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } })).status).toBe(403);
      expect((await api.post(`/api/users/${sales.id}/permissions/reset`, { all: true })).status).toBe(403);
      expect((await api.post(`/api/users/${sales.id}/permissions/save-as-role`, { label: 'Nope' })).status).toBe(403);
      expect((await api.get(`/api/users/${sales.id}/permissions/change-log`)).status).toBe(403);
      expect(await db.permissionUserSwitch.count({ where: { user_id: sales.id } })).toBe(0);
      expect(await db.customRole.count({ where: { organization_id: org, label: 'Nope' } })).toBe(0);

      expect((await api.get('/api/permission-switches/catalog')).status).toBe(200);
      expect((await api.get('/api/permission-switches/me')).status).toBe(200);
    });

    it('refuses a person writing their own set, holder or not, and lets a holder read their own', async () => {
      const { org } = await fx.newOrg();
      const [a] = flippable('DISPATCHER', 1);
      for (const holds of [true, false]) {
        const me = await manager(org, holds);
        const api = await me.api();
        const own = `/api/users/${me.id}/permissions`;
        expect((await api.put(own, { values: { [a!.key]: true } })).status, `put holds=${holds}`).toBe(403);
        expect((await api.post(`${own}/reset`, { all: true })).status, `reset holds=${holds}`).toBe(403);
        expect((await api.post(`${own}/save-as-role`, { label: `Mine ${holds}` })).status, `save holds=${holds}`).toBe(403);
        expect(await db.permissionUserSwitch.count({ where: { user_id: me.id } }), `rows holds=${holds}`).toBe(0);
      }
      // The id column is a uuid, which a database accepts in any case. The same person by another spelling is nobody (pre-PR
      // review fixes, SR-2: a uuid spelled any way but the canonical one answers 404), so it writes nothing either. A person
      // the route's gate refuses (not a holder) is refused there first, with the 403 that says nothing about anyone.
      for (const holds of [true, false]) {
        const me = await manager(org, holds);
        const api = await me.api();
        const own = `/api/users/${me.id.toUpperCase()}/permissions`;
        const refused = holds ? 404 : 403;
        expect((await api.put(own, { values: { [a!.key]: true } })).status, `upper put holds=${holds}`).toBe(refused);
        expect((await api.post(`${own}/reset`, { all: true })).status, `upper reset holds=${holds}`).toBe(refused);
        expect((await api.post(`${own}/save-as-role`, { label: `Upper ${holds}` })).status, `upper save holds=${holds}`).toBe(refused);
        expect(await db.permissionUserSwitch.count({ where: { user_id: me.id } }), `upper rows holds=${holds}`).toBe(0);
        if (holds) expect((await api.get(own)).status, 'upper read').toBe(404);
      }
      const holder = await manager(org, true);
      const res = await (await holder.api()).get(`/api/users/${holder.id}/permissions`);
      expect(res.status).toBe(200);
      expect(res.body.editable).toBe(false);
    });
  });

  describe('change log', () => {
    it('writes one entry per changed switch with who, when, from, to and the reason, and answers newest first', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a, b] = flippable('SALES', 2);

      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      // Sending a value the person already holds changes nothing, so it writes nothing.
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } });
      await api.post(`/api/users/${sales.id}/permissions/reset`, { switch_keys: [a!.key] });

      const res = await api.get(`/api/users/${sales.id}/permissions/change-log`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      const entries = res.body.entries as Array<{
        switch_key: string; switch_label: string; from: SwitchValue; to: SwitchValue; reason: string; created_at: string; actor: { id: string; name: string } | null;
      }>;
      expect(entries).toHaveLength(3);
      // Newest first: the reset, then the two writes.
      expect(entries[0]).toMatchObject({ switch_key: a!.key, from: true, to: false, reason: 'reset' });
      const written = entries.slice(1);
      expect(written.map((e) => e.switch_key).sort()).toEqual([a!.key, b!.key].sort());
      for (const e of written) expect(e).toMatchObject({ from: false, to: true, reason: 'manual' });
      for (const e of entries) {
        expect(e.actor?.id).toBe(me.id);
        expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
        expect(e.switch_label).toBe(SWITCH_CATALOG.find((s) => s.key === e.switch_key)!.label);
      }
    });

    it('reads the log for the person by their id, and answers another spelling of it, or a non-id, as not found', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a] = flippable('SALES', 1);
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true } });
      const log = await api.get(`/api/users/${sales.id}/permissions/change-log`);
      expect(log.status).toBe(200);
      expect(log.body.total).toBe(1);
      // An id in upper case is another spelling of a uuid, which names nobody (pre-PR review fixes, SR-2).
      expect((await api.get(`/api/users/${sales.id.toUpperCase()}/permissions/change-log`)).status).toBe(404);
      for (const path of ['permissions', 'permissions/change-log']) {
        expect((await api.get(`/api/users/not-a-uuid/${path}`)).status, path).toBe(404);
      }
      expect((await api.put('/api/users/not-a-uuid/permissions', { values: { [a!.key]: true } })).status).toBe(404);
    });

    it('pages with limit and offset', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const sales = await target(org, 'SALES');
      const [a, b] = flippable('SALES', 2);
      await api.put(`/api/users/${sales.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      const first = await api.get(`/api/users/${sales.id}/permissions/change-log?limit=1`);
      const second = await api.get(`/api/users/${sales.id}/permissions/change-log?limit=1&offset=1`);
      expect(first.body.entries).toHaveLength(1);
      expect(second.body.entries).toHaveLength(1);
      expect(first.body.total).toBe(2);
      expect(first.body.entries[0].id).not.toBe(second.body.entries[0].id);
    });
  });

  describe('Me', () => {
    it("answers the signed-in person's resolved values and compiled rules", async () => {
      const { org } = await fx.newOrg();
      const key = `me-role-${++sequence}`;
      const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
      const preset = presetSwitchSet('TECHNICIAN');
      // The Technician preset opens jobs and not invoices; the rules must say the same.
      expect(preset.view_jobs).toBe(true);
      expect(preset.view_invoices).toBe(false);
      const person = await fx.addUser(org, `me${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
      const res = await (await fx.signedInAs(person)).get('/api/permission-switches/me');
      expect(res.status).toBe(200);
      expect(res.body.admin_box).toBe(false);
      expect(res.body.values).toEqual(preset);
      const rules = (res.body.rules as Array<{ action: string | string[]; subject: string | string[] }>).map((r) => `${r.action}:${r.subject}`);
      expect(rules).toContain('read:Job');
      expect(rules).not.toContain('read:Invoice');
    });

    it('answers the Admin box with every switch on and the manage-all rule', async () => {
      const { admin } = await fx.newOrg();
      const res = await (await fx.signedInAs(admin)).get('/api/permission-switches/me');
      expect(res.status).toBe(200);
      expect(res.body.admin_box).toBe(true);
      expect(res.body.values).toEqual(presetSwitchSet('ADMIN'));
      expect(res.body.rules).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'manage', subject: 'all' })]));
    });
  });
});

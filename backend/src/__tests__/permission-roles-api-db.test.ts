/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.21 - the Roles API: a role's switch set (read and write, never touching the
   people on it), a new role from any role or from blank, role reset, rename and archive with built-in roles
   protected, and a role's change log. Every route needs Manage roles and permissions.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in role
   name) holding exactly the switch values under test. Expected values come from the catalog, never a copy of it. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SCOPE_SWITCH_KEY, SWITCH_CATALOG, THROUGH_OWN_LEADS, presetSwitchSet, type SwitchEntry, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const MANAGE = 'manage_roles_and_permissions';

/** The value a blank role starts with for a switch: off, the narrowest choice, no list members. */
const blankValue = (s: SwitchEntry): SwitchValue => (s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false);
const blankSet = (): Record<string, SwitchValue> => Object.fromEntries(SWITCH_CATALOG.map((s) => [s.key, blankValue(s)]));

/** Toggles a preset holds off, that need nothing else and that nothing else needs: safe to flip on. */
const flippable = (role: Role, count: number): SwitchEntry[] => {
  const needed = new Set(SWITCH_CATALOG.flatMap((s) => [...s.requires, ...(s.requiresAny ?? [])]));
  return SWITCH_CATALOG.filter(
    (s) => s.kind === 'toggle' && s.presets[role] === false && s.requires.length === 0 && !s.requiresAny && !needed.has(s.key),
  ).slice(0, count);
};

suite('the Roles API (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role, with Manage roles and permissions on or off, everything else as Dispatcher. */
  async function manager(org: string, manage: boolean): Promise<Person & { api: () => Promise<Api> }> {
    const key = `mgr-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { copyGrants: false });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { [MANAGE]: manage }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `mgr${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const setOf = async (api: Api, role: string) => (await api.get(`/api/roles/${role}/permissions`)).body;
  const personValues = async (api: Api, id: string) => (await api.get(`/api/users/${id}/permissions`)).body.values as Record<string, SwitchValue>;

  /** A custom role (base Dispatcher) that has people on it who hold no values of their own yet. */
  async function roleWithPeople(org: string, count = 2) {
    const key = `team-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { copyGrants: false });
    const people: Person[] = [];
    for (let i = 0; i < count; i++) people.push(await fx.addUser(org, `member${sequence}x${i}`, 'DISPATCHER', { customRoleId: role.id }));
    return { key, people };
  }

  describe('a role\'s switch set', () => {
    it('reads a built-in role as its catalog preset and a custom role as the preset of its base', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const sales = await setOf(api, 'SALES');
      expect(sales).toMatchObject({ role: 'SALES', type: 'system', editable: true });
      expect(sales.values).toEqual(presetSwitchSet('SALES'));
      const { key } = await roleWithPeople(org, 0);
      const custom = await setOf(api, key);
      expect(custom).toMatchObject({ role: key, type: 'custom', base_role: 'DISPATCHER' });
      expect(custom.values).toEqual(presetSwitchSet('DISPATCHER'));
      expect((await api.get('/api/roles/no-such-role/permissions')).status).toBe(404);
    });

    it('reads the Admin role as the Admin preset and refuses to write it', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const admin = await setOf(api, 'ADMIN');
      expect(admin).toMatchObject({ role: 'ADMIN', editable: false });
      expect(admin.values).toEqual(presetSwitchSet('ADMIN'));
      const [a] = flippable('SALES', 1);
      expect((await api.put('/api/roles/ADMIN/permissions', { values: { [a!.key]: true } })).status).toBe(400);
      expect((await api.post('/api/roles/ADMIN/reset')).status).toBe(400);
    });

    it('stores the values sent on the role, and leaves every person on it with the values they had', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key, people } = await roleWithPeople(org, 2);
      const [a, b] = flippable('DISPATCHER', 2);
      const before = await Promise.all(people.map((p) => personValues(api, p.id)));

      const res = await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      expect(res.status).toBe(200);
      expect(res.body.values[a!.key]).toBe(true);
      expect(res.body.values[b!.key]).toBe(true);
      expect((await setOf(api, key)).values[a!.key]).toBe(true);

      for (const [i, person] of people.entries()) {
        const after = await personValues(api, person.id);
        expect(after, `person ${i}`).toEqual(before[i]);
        expect(after[a!.key]).toBe(false);
      }
    });

    it('leaves a person who was given the role earlier with their own value for a switch the role changes', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key } = await roleWithPeople(org, 0);
      const [a] = flippable('DISPATCHER', 1);
      await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } });
      // Someone given the role now starts from the role's current values.
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
      const newcomer = await fx.addUser(org, `newcomer${++sequence}`, 'DISPATCHER', { customRoleId: role.id });
      expect((await personValues(api, newcomer.id))[a!.key]).toBe(true);
    });

    it('refuses a body with Create on and View off, storing nothing', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key } = await roleWithPeople(org, 0);
      const res = await api.put(`/api/roles/${key}/permissions`, { values: { create_jobs: true, view_jobs: false } });
      expect(res.status).toBe(400);
      expect(res.body.violations).toEqual(expect.arrayContaining([expect.objectContaining({ switchKey: 'create_jobs', needs: ['view_jobs'] })]));
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: key } })).toBe(0);
    });

    it('refuses an unknown switch and a body with no values', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key } = await roleWithPeople(org, 0);
      expect((await api.put(`/api/roles/${key}/permissions`, { values: { not_a_switch: true } })).status).toBe(400);
      expect((await api.put(`/api/roles/${key}/permissions`, { values: {} })).status).toBe(400);
    });

    it('writes one log entry per changed switch with who, when, from, to and the reason', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const { key } = await roleWithPeople(org, 0);
      const [a, b] = flippable('DISPATCHER', 2);
      await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      // A value the role already holds changes nothing, so it writes nothing.
      await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } });

      const res = await api.get(`/api/roles/${key}/change-log`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      const entries = res.body.entries as Array<{ switch_key: string; from: SwitchValue; to: SwitchValue; reason: string; created_at: string; actor: { id: string } | null }>;
      expect(entries.map((e) => e.switch_key).sort()).toEqual([a!.key, b!.key].sort());
      for (const e of entries) {
        expect(e).toMatchObject({ from: false, to: true, reason: 'manual' });
        expect(e.actor?.id).toBe(me.id);
        expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
      }
      expect((await api.get('/api/roles/no-such-role/change-log')).status).toBe(404);
    });
  });

  describe('a Sales role and Through own leads', () => {
    it('accepts Attached over the held value, and then refuses setting Through own leads again', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const jobsScope = SCOPE_SWITCH_KEY.Job;
      expect((await setOf(api, 'SALES')).values[jobsScope]).toBe(THROUGH_OWN_LEADS);

      const moved = await api.put('/api/roles/SALES/permissions', { values: { [jobsScope]: 'attached' } });
      expect(moved.status).toBe(200);
      expect(moved.body.values[jobsScope]).toBe('attached');

      const back = await api.put('/api/roles/SALES/permissions', { values: { [jobsScope]: THROUGH_OWN_LEADS } });
      expect(back.status).toBe(400);
      expect((await setOf(api, 'SALES')).values[jobsScope]).toBe('attached');
    });
  });

  describe('a new role', () => {
    it('from a built-in role holds that role\'s values and records where it came from', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const res = await api.post('/api/roles', { label: 'Field sales', clone_grants_from: 'SALES' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ label: 'Field sales', type: 'custom', base_role: 'SALES', made_from_role_key: 'SALES', made_from_blank: false, all_views_off: false });
      expect((await setOf(api, res.body.role)).values).toEqual(presetSwitchSet('SALES'));
    });

    it('from a custom role holds that role\'s current values, and editing the source afterwards does not reach the copy', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key } = await roleWithPeople(org, 0);
      const [a, b] = flippable('DISPATCHER', 2);
      await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } });
      const source = (await setOf(api, key)).values;

      const res = await api.post('/api/roles', { label: 'Copy of team', clone_grants_from: key });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ base_role: 'DISPATCHER', made_from_role_key: key });
      expect((await setOf(api, res.body.role)).values).toEqual(source);

      await api.put(`/api/roles/${key}/permissions`, { values: { [b!.key]: true } });
      expect((await setOf(api, res.body.role)).values[b!.key]).toBe(false);
    });

    it('from blank holds every switch off and carries the warning flag, which clears once a View is on', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const res = await api.post('/api/roles', { label: 'Nothing yet', blank: true });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: 'custom', made_from_blank: true, made_from_role_key: null, all_views_off: true });
      const read = await setOf(api, res.body.role);
      expect(read.values).toEqual(blankSet());
      expect(read.all_views_off).toBe(true);

      const edited = await api.put(`/api/roles/${res.body.role}/permissions`, { values: { view_jobs: true } });
      expect(edited.status).toBe(200);
      expect(edited.body.all_views_off).toBe(false);
    });

    it('from blank takes off for a switch added later, for the role and for a person on it', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const res = await api.post('/api/roles', { label: 'Narrow', blank: true });
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: res.body.role } });
      const person = await fx.addUser(org, `narrow${++sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: role.key });
      // A switch the built-in presets hold on, as if the product had added it after the role was made.
      const later = SWITCH_CATALOG.find((s) => s.kind === 'toggle' && s.requires.length === 0 && s.presets.TECHNICIAN === true && s.presets.ADMIN === true)!;
      await db.permissionRoleSwitch.deleteMany({ where: { organization_id: org, role_key: role.key, switch_key: later.key } });
      expect((await setOf(api, role.key)).values[later.key]).toBe(false);
      expect((await personValues(api, person.id))[later.key]).toBe(false);
    });

    it('refuses a name that is taken or reserved, and a body naming both a source and blank', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      expect((await api.post('/api/roles', { label: 'Once', blank: true })).status).toBe(201);
      expect((await api.post('/api/roles', { label: 'Once', blank: true })).status).toBe(409);
      expect((await api.post('/api/roles', { label: 'Sales', blank: true })).status).toBe(400);
      expect((await api.post('/api/roles', { label: 'Both', blank: true, clone_grants_from: 'SALES' })).status).toBe(400);
      expect((await api.post('/api/roles', { label: 'Ghost source', clone_grants_from: 'no-such-role' })).status).toBe(400);
      expect(await db.customRole.count({ where: { organization_id: org, label: { in: ['Both', 'Ghost source'] } } })).toBe(0);
    });
  });

  describe('role reset', () => {
    it('returns a built-in role to its preset, logs each change "reset", and changes no person', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const salesPerson = await fx.addUser(org, `reset-sales${++sequence}`, 'SALES');
      const [a] = flippable('SALES', 1);
      await api.put('/api/roles/SALES/permissions', { values: { [a!.key]: true, [SCOPE_SWITCH_KEY.Lead]: 'all' } });
      const personBefore = await personValues(api, salesPerson.id);

      const res = await api.post('/api/roles/SALES/reset');
      expect(res.status).toBe(200);
      expect(res.body.values).toEqual(presetSwitchSet('SALES'));
      expect((await setOf(api, 'SALES')).values).toEqual(presetSwitchSet('SALES'));
      expect(await personValues(api, salesPerson.id)).toEqual(personBefore);

      const log = (await api.get('/api/roles/SALES/change-log')).body.entries as Array<{ switch_key: string; reason: string; from: SwitchValue; to: SwitchValue }>;
      const resets = log.filter((e) => e.reason === 'reset');
      expect(resets.map((e) => e.switch_key).sort()).toEqual([a!.key, SCOPE_SWITCH_KEY.Lead].sort());
      expect(resets.find((e) => e.switch_key === a!.key)).toMatchObject({ from: true, to: false });
    });

    it('returns a custom role to the preset of its base built-in role', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key } = await roleWithPeople(org, 1);
      const [a] = flippable('DISPATCHER', 1);
      await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } });
      const res = await api.post(`/api/roles/${key}/reset`);
      expect(res.status).toBe(200);
      expect(res.body.values).toEqual(presetSwitchSet('DISPATCHER'));
      const resets = (await api.get(`/api/roles/${key}/change-log`)).body.entries.filter((e: { reason: string }) => e.reason === 'reset');
      expect(resets.map((e: { switch_key: string }) => e.switch_key)).toEqual([a!.key]);
    });

    it('returns a role made from blank to all off, and changes no person on it', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const made = await api.post('/api/roles', { label: 'Start empty', blank: true });
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: made.body.role } });
      const person = await fx.addUser(org, `blankmember${++sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: role.key });
      await api.put(`/api/roles/${role.key}/permissions`, { values: { view_jobs: true, view_customers: true } });
      const personBefore = await personValues(api, person.id);

      const res = await api.post(`/api/roles/${role.key}/reset`);
      expect(res.status).toBe(200);
      expect(res.body.values).toEqual(blankSet());
      expect(res.body.all_views_off).toBe(true);
      expect(await personValues(api, person.id)).toEqual(personBefore);
      const resets = (await api.get(`/api/roles/${role.key}/change-log`)).body.entries.filter((e: { reason: string }) => e.reason === 'reset');
      expect(resets.map((e: { switch_key: string }) => e.switch_key).sort()).toEqual(['view_customers', 'view_jobs']);
    });

    it('writes nothing for a role that already holds its starting point', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      expect((await api.post('/api/roles/TECHNICIAN/reset')).status).toBe(200);
      expect((await api.get('/api/roles/TECHNICIAN/change-log')).body.total).toBe(0);
    });
  });

  describe('rename, archive and built-in roles', () => {
    it('refuses to rename or delete a built-in role, the Dispatcher role included', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      for (const role of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']) {
        expect((await api.patch(`/api/roles/${role}`, { label: 'Renamed' })).status, `rename ${role}`).toBe(400);
        expect((await api.post(`/api/roles/${role}/archive`)).status, `archive ${role}`).toBe(400);
        expect((await api.delete(`/api/roles/${role}`)).status, `delete ${role}`).toBe(400);
      }
      const listed = (await api.get('/api/roles')).body as Array<{ role: string; label: string }>;
      expect(listed.filter((r) => ['SALES', 'DISPATCHER', 'TECHNICIAN'].includes(r.role)).map((r) => r.label)).toEqual(['Sales', 'Dispatcher', 'Technician']);
    });

    it('renames a custom role and archives it only once nobody is on it', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key, people } = await roleWithPeople(org, 1);
      const renamed = await api.patch(`/api/roles/${key}`, { label: 'Renamed team' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.label).toBe('Renamed team');

      expect((await api.post(`/api/roles/${key}/archive`)).status).toBe(409);
      await db.user.update({ where: { id: people[0]!.id }, data: { custom_role_id: null } });
      expect((await api.delete(`/api/roles/${key}`)).status).toBe(200);
      expect(((await api.get('/api/roles')).body as Array<{ role: string }>).map((r) => r.role)).not.toContain(key);
      expect((await api.get(`/api/roles/${key}/permissions`)).status).toBe(404);
    });

    it('refuses a rename to a built-in role\'s name or another role\'s name, as creating does, and lets a role keep its own', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      await api.post('/api/roles', { label: 'Ops Lead', blank: true });
      const created = await api.post('/api/roles', { label: 'Night Desk', blank: true });
      expect(created.status).toBe(201);
      const rename = (label: string) => api.patch('/api/roles/night-desk', { label });

      for (const label of ['Technician', 'technician ', 'Administrator (Owner)']) {
        const res = await rename(label);
        expect(res.status, label).toBe(400);
        expect(res.body.error).toMatch(/built-in role/);
        // Creating a role under that name is refused the same way.
        expect((await api.post('/api/roles', { label, blank: true })).status, `create ${label}`).toBe(400);
      }
      for (const label of ['Ops Lead', 'ops   lead']) {
        const res = await rename(label);
        expect(res.status, label).toBe(409);
        expect(res.body.error).toMatch(/already exists/);
        expect((await api.post('/api/roles', { label, blank: true })).status, `create ${label}`).toBe(409);
      }
      expect(((await api.get('/api/roles')).body as Array<{ role: string; label: string }>).find((r) => r.role === 'night-desk')!.label).toBe('Night Desk');

      expect((await rename('NIGHT desk')).status).toBe(200);
      expect((await rename('Late Desk')).status).toBe(200);
      // The old name is free again, and the new one is taken.
      expect((await api.post('/api/roles', { label: 'Night Desk 2', blank: true })).status).toBe(201);
      expect((await api.patch('/api/roles/ops-lead', { label: 'late desk' })).status).toBe(409);
    });

    it('refuses to archive a role the Roles list shows people on, in the same number, and archives it once they are gone', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key, people } = await roleWithPeople(org, 2);
      // A third person was filled from the role but holds another one: the list counts them on it, so archive must too.
      const elsewhere = await roleWithPeople(org, 1);
      await db.user.update({ where: { id: elsewhere.people[0]!.id }, data: { based_on_role_key: key } });

      const listed = (await api.get('/api/roles')).body as Array<{ role: string; userCount: number }>;
      const shown = listed.find((r) => r.role === key)!.userCount;
      expect(shown).toBe(people.length + 1);
      const refused = await api.post(`/api/roles/${key}/archive`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(`Cannot archive: ${shown} people are still on this role. Move them to another role first.`);

      await db.user.updateMany({ where: { id: { in: people.map((p) => p.id) } }, data: { custom_role_id: null } });
      await db.user.update({ where: { id: elsewhere.people[0]!.id }, data: { based_on_role_key: null } });
      expect((await api.post(`/api/roles/${key}/archive`)).status).toBe(200);
    });

    it('lists the roles with where each custom role came from', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      await api.post('/api/roles', { label: 'From sales', clone_grants_from: 'SALES' });
      await api.post('/api/roles', { label: 'From nothing', blank: true });
      const listed = (await api.get('/api/roles')).body as Array<{ role: string; made_from_role_key?: string | null; made_from_blank?: boolean }>;
      expect(listed.find((r) => r.role === 'from-sales')).toMatchObject({ made_from_role_key: 'SALES', made_from_blank: false });
      expect(listed.find((r) => r.role === 'from-nothing')).toMatchObject({ made_from_role_key: null, made_from_blank: true });
    });
  });

  describe('how many people are based on each role', () => {
    type Listed = { role: string; userCount: number };
    type UserRow = { role_label: string };

    it('counts each person once, under the role they are based on, active or not, and agrees with the users list', async () => {
      const { org, admin } = await fx.newOrg();
      const managerPerson = await manager(org, true);
      const api = await managerPerson.api();
      // A second person in the Admin box, a dispatcher, and a technician who has since been deactivated.
      await fx.addUser(org, `boxed${++sequence}`, 'ADMIN');
      await fx.addUser(org, `disp${++sequence}`, 'DISPATCHER');
      const gone = await fx.addUser(org, `gone${++sequence}`, 'TECHNICIAN');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      // A custom role copied from Admin (base Admin) and one from Dispatcher, each with people on it.
      const adminCopy = await fx.addCustomRole(org, `admin-copy-${++sequence}`, 'ADMIN', { copyGrants: false });
      await fx.addUser(org, `copy${++sequence}`, 'ADMIN', { customRoleId: adminCopy.id, basedOnRoleKey: adminCopy.key });
      const { key: teamKey } = await roleWithPeople(org, 2);

      const listed = (await api.get('/api/roles')).body as Listed[];
      const countOf = (role: string) => listed.find((r) => r.role === role)?.userCount;
      expect(countOf('ADMIN')).toBe(2);
      expect(countOf('DISPATCHER')).toBe(1);
      expect(countOf('TECHNICIAN')).toBe(1);
      expect(countOf('SALES')).toBe(0);
      expect(countOf(adminCopy.key)).toBe(1);
      expect(countOf(teamKey)).toBe(2);
      const managerRole = await db.user.findUniqueOrThrow({ where: { id: managerPerson.id }, select: { custom_role: { select: { key: true } } } });
      expect(countOf(managerRole.custom_role!.key)).toBe(1);
      // Nobody is counted twice: the counts add up to the company's people.
      expect(listed.reduce((sum, r) => sum + r.userCount, 0)).toBe(await db.user.count({ where: { organization_id: org } }));

      // The Users & Teams role column groups the same people the same way.
      const rows = (await (await fx.signedInAs(admin)).get('/api/users')).body.users as UserRow[];
      const labelled = (label: string) => rows.filter((u) => u.role_label === label).length;
      expect(labelled('Admin')).toBe(countOf('ADMIN'));
      expect(labelled('Dispatcher')).toBe(countOf('DISPATCHER'));
      expect(labelled('Technician')).toBe(countOf('TECHNICIAN'));
      expect(labelled(adminCopy.key)).toBe(countOf(adminCopy.key));
      expect(labelled(teamKey)).toBe(countOf(teamKey));
    });

    it('moves a person from one count to the other when they are given a custom role', async () => {
      const { org, admin } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const tech = await fx.addUser(org, `tech${++sequence}`, 'TECHNICIAN');
      const { key } = await roleWithPeople(org, 0);
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
      const countOf = async (r: string) => ((await api.get('/api/roles')).body as Listed[]).find((x) => x.role === r)?.userCount;
      expect(await countOf('TECHNICIAN')).toBe(1);

      const moved = await (await fx.signedInAs(admin)).patch(`/api/users/${tech.id}`, { role: 'DISPATCHER', custom_role_id: role.id });
      expect(moved.status).toBe(200);
      expect(await countOf('TECHNICIAN')).toBe(0);
      expect(await countOf('DISPATCHER')).toBe(0);
      expect(await countOf(key)).toBe(1);
    });
  });

  describe('who may use it', () => {
    it('lets a custom role given Manage roles and permissions read the roles, their sets and both change logs', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const { key, people } = await roleWithPeople(org, 1);
      expect((await api.get('/api/roles')).status).toBe(200);
      expect((await api.get(`/api/roles/${key}/permissions`)).status).toBe(200);
      expect((await api.get(`/api/roles/${key}/change-log`)).status).toBe(200);
      expect((await api.get(`/api/users/${people[0]!.id}/permissions`)).status).toBe(200);
      expect((await api.get(`/api/users/${people[0]!.id}/permissions/change-log`)).status).toBe(200);
    });

    it('refuses every role read and write without it, writing nothing, while the catalog and Me answer', async () => {
      const { org } = await fx.newOrg();
      const outsider = await manager(org, false);
      const api = await outsider.api();
      const { key } = await roleWithPeople(org, 0);
      const [a] = flippable('DISPATCHER', 1);

      expect((await api.get('/api/roles')).status).toBe(403);
      expect((await api.get(`/api/roles/${key}/permissions`)).status).toBe(403);
      expect((await api.put(`/api/roles/${key}/permissions`, { values: { [a!.key]: true } })).status).toBe(403);
      expect((await api.post('/api/roles', { label: 'Nope', blank: true })).status).toBe(403);
      expect((await api.post(`/api/roles/${key}/reset`)).status).toBe(403);
      expect((await api.patch(`/api/roles/${key}`, { label: 'Nope' })).status).toBe(403);
      expect((await api.post(`/api/roles/${key}/archive`)).status).toBe(403);
      expect((await api.delete(`/api/roles/${key}`)).status).toBe(403);
      expect((await api.get(`/api/roles/${key}/change-log`)).status).toBe(403);
      expect(await db.customRole.count({ where: { organization_id: org, label: 'Nope' } })).toBe(0);
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: key } })).toBe(0);

      expect((await api.get('/api/permission-switches/catalog')).status).toBe(200);
      expect((await api.get('/api/permission-switches/me')).status).toBe(200);
    });

    it('keeps one company\'s roles out of another\'s', async () => {
      const { org } = await fx.newOrg();
      const other = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const theirs = await roleWithPeople(other.org, 0);
      expect((await api.get(`/api/roles/${theirs.key}/permissions`)).status).toBe(404);
      expect((await api.get(`/api/roles/${theirs.key}/change-log`)).status).toBe(404);
      expect((await api.post('/api/roles', { label: 'Theirs too', clone_grants_from: theirs.key })).status).toBe(400);
    });
  });
});

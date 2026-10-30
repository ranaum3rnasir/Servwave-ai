/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.12 - the Users group. Since AL-18 (ticket 28) managing people is the Admin flag's
   alone: an Admin adds, invites, changes (a role included), deactivates, deletes and resets people, and View users is the
   one Users switch left (names in pickers and on records). That no switch lets a non-Admin in is proved by
   permission-admin-only-management-db.test.ts.

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
// The suite-wide email mock leaves out the invitation; no mail is sent from here.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

const GROUPS = ['Users', 'Departments', 'Locations'];

suite('the Users group follows switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) await quietly(db.$executeRawUnsafe(`DELETE FROM notes WHERE organization_id = '${org}'`));
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** Every switch in the three groups off, so a case turns on exactly what it is about. */
  const GROUPS_OFF = Object.fromEntries(SWITCH_CATALOG.filter((s) => GROUPS.includes(s.module) && s.kind === 'toggle').map((s) => [s.key, false]));

  /**
   * A person on a fresh custom role of this base holding exactly these Users, Departments and Locations
   * values (everything else in those groups off). Whatever the base, no role name may decide anything.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleId: string; roleKey: string }> {
    const key = `usr-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { ...GROUPS_OFF, view_users: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleId: role.id, roleKey: key });
  }

  /** A plain Sales person in the org that the cases act on. */
  async function target(org: string, opts: { active?: boolean } = {}) {
    const person = await fx.addUser(org, `target${++sequence}`, 'SALES');
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return person;
  }

  const roleOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).role;
  const userRow = (id: string) => db.user.findUnique({ where: { id } });

  function mockSupabaseCreate() {
    (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      data: { user: { id: randomUUID() } }, error: null,
    }));
  }
  const newUserBody = (role: Role = 'SALES', extra: object = {}) => ({
    email: `new-${randomUUID().slice(0, 8)}@example.test`, password: 'StrongPass!1', first_name: 'New', last_name: 'Person', role, ...extra,
  });
  const inviteBody = (role: Role = 'SALES', extra: object = {}) => ({
    email: `inv-${randomUUID().slice(0, 8)}@example.test`, first_name: 'New', last_name: 'Invitee', role, ...extra,
  });

  /**
   * An Admin who is not the company's Owner: the Admin flag on a person on a custom role, so no role name decides anything.
   * What only the Owner may do to another Admin is not what these cases are about: every target here is a non-Admin.
   */
  async function adminPerson(org: string): Promise<Person & { api: () => Promise<Api>; roleId: string }> {
    const key = `adm-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    const person = await fx.addUser(org, `adm${sequence}`, 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key, isAdmin: true });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleId: role.id });
  }

  describe('an Admin changes a person\'s role and their other fields', () => {
    it('applies a base role, a custom-role link and a plain field change', async () => {
      const { org } = await newOrg();
      const api = await (await adminPerson(org)).api();
      const someone = await target(org);
      const otherRole = await fx.addCustomRole(org, `usr-other-${++sequence}`, 'SALES');

      expect((await api.patch(`/api/users/${someone.id}`, { role: 'DISPATCHER' })).status).toBe(200);
      expect(await roleOf(someone.id)).toBe('DISPATCHER');
      expect((await api.patch(`/api/users/${someone.id}`, { role: 'SALES', custom_role_id: otherRole.id })).status).toBe(200);
      expect((await userRow(someone.id))?.custom_role_id).toBe(otherRole.id);
      expect((await api.patch(`/api/users/${someone.id}`, { first_name: 'Renamed' })).status).toBe(200);
      expect((await userRow(someone.id))?.first_name).toBe('Renamed');
    });
  });

  describe('an Admin creates and invites people', () => {
    it('creates a person directly, invites one, and resends an invite, each with the role it names', async () => {
      const { org } = await newOrg();
      mockSupabaseCreate();
      const api = await (await adminPerson(org)).api();

      const created = newUserBody('TECHNICIAN');
      expect((await api.post('/api/users', created)).status).toBe(201);
      expect(await db.user.count({ where: { organization_id: org, email: created.email, role: 'TECHNICIAN' } })).toBe(1);

      const invited = inviteBody('DISPATCHER');
      expect((await api.post('/api/users/invite', invited)).status).toBe(201);
      expect(await db.user.count({ where: { organization_id: org, email: invited.email, role: 'DISPATCHER' } })).toBe(1);

      const someone = await target(org);
      expect((await api.post(`/api/users/${someone.id}/invite`)).status).toBe(200);
    });
  });

  describe('an Admin deactivates and reactivates people on every path', () => {
    it('deactivates through the delete path and the field, and reactivates through the field', async () => {
      const { org } = await newOrg();
      const api = await (await adminPerson(org)).api();

      const viaDelete = await target(org);
      expect((await api.delete(`/api/users/${viaDelete.id}`)).status).toBe(200);
      expect((await userRow(viaDelete.id))?.is_active).toBe(false);
      expect((await api.patch(`/api/users/${viaDelete.id}`, { is_active: true })).status).toBe(200);
      expect((await userRow(viaDelete.id))?.is_active).toBe(true);

      const viaUpdate = await target(org);
      expect((await api.patch(`/api/users/${viaUpdate.id}`, { is_active: false })).status).toBe(200);
      expect((await userRow(viaUpdate.id))?.is_active).toBe(false);
    });
  });

  describe('an Admin\'s permanent delete and two-step login reset', () => {
    it('refuses the delete of an active user and of one with history, and removes an inactive one with none', async () => {
      const { org, customer } = await newOrg();
      const api = await (await adminPerson(org)).api();

      const active = await target(org);
      expect((await api.delete(`/api/users/${active.id}/permanent`)).status).toBe(409);
      expect(await userRow(active.id)).not.toBeNull();

      const withHistory = await target(org, { active: false });
      await db.note.create({ data: { id: randomUUID(), organization_id: org, entity_type: 'CUSTOMER', entity_id: customer, content: 'history', created_by: withHistory.id } });
      expect((await api.delete(`/api/users/${withHistory.id}/permanent`)).status).toBe(409);
      expect(await userRow(withHistory.id)).not.toBeNull();

      const clean = await target(org, { active: false });
      expect((await api.delete(`/api/users/${clean.id}/permanent`)).status).toBe(200);
      expect(await userRow(clean.id)).toBeNull();
    });

    it('resets a person\'s two-step login', async () => {
      const { org } = await newOrg();
      const someone = await target(org);
      await db.user.update({ where: { id: someone.id }, data: { mfa_email_enrolled: true } });
      expect((await (await (await adminPerson(org)).api()).post(`/api/users/${someone.id}/mfa/reset`)).status).toBe(200);
      expect((await userRow(someone.id))?.mfa_email_enrolled).toBe(false);
    });
  });

  describe('nobody changes their own role', () => {
    it('refuses an Admin changing their own custom-role link, and their own base role', async () => {
      const { org } = await newOrg();
      const person = await adminPerson(org);
      const api = await person.api();
      const other = await fx.addCustomRole(org, `usr-other-${++sequence}`, 'DISPATCHER');

      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: other.id })).status).toBe(400);
      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: null })).status).toBe(400);
      expect((await api.patch(`/api/users/${person.id}`, { role: 'SALES' })).status).toBe(400);
      expect((await userRow(person.id))?.custom_role_id).toBe(person.roleId);
      expect(await roleOf(person.id)).toBe('DISPATCHER');
    });

    it('still lets them edit their other fields, and send back the role they already hold', async () => {
      const { org } = await newOrg();
      const person = await adminPerson(org);
      const api = await person.api();
      expect((await api.patch(`/api/users/${person.id}`, { first_name: 'Mine' })).status).toBe(200);
      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: person.roleId })).status).toBe(200);
    });
  });

  describe('the route-level enforcement table for the Users, Departments and Locations groups', () => {
    type Ctx = { org: string; target: () => Promise<Person>; inactive: () => Promise<Person>; department: string; location: string };
    type Probe = {
      check: string;
      switchKey: string;
      /** Switches that must also be on for the request to pass its other checks. */
      alsoOn?: string[];
      call: (api: Api, ctx: Ctx) => Promise<{ status: number }>;
    };

    const probes: Probe[] = [
      { check: 'user-list', switchKey: 'view_users', call: (api) => api.get('/api/users') },
      { check: 'user-detail', switchKey: 'view_users', call: async (api, c) => api.get(`/api/users/${(await c.target()).id}`) },
      { check: 'department-list', switchKey: 'view_departments', call: (api) => api.get('/api/departments') },
      { check: 'department-create', switchKey: 'create_departments', call: (api) => api.post('/api/departments', { name: `Dept ${randomUUID().slice(0, 6)}` }) },
      { check: 'department-update', switchKey: 'edit_departments', call: (api, c) => api.patch(`/api/departments/${c.department}`, { name: `Renamed ${randomUUID().slice(0, 6)}` }) },
      { check: 'department-delete', switchKey: 'delete_departments', call: async (api, c) => api.delete(`/api/departments/${await fx.addDepartment(c.org, 'Spare')}`) },
      { check: 'location-list', switchKey: 'view_locations', call: (api) => api.get('/api/locations') },
      { check: 'location-create', switchKey: 'create_locations', call: (api) => api.post('/api/locations', { name: `Site ${randomUUID().slice(0, 6)}` }) },
      { check: 'location-update', switchKey: 'edit_locations', call: (api, c) => api.patch(`/api/locations/${c.location}`, { name: `Moved ${randomUUID().slice(0, 6)}` }) },
      { check: 'location-delete', switchKey: 'delete_locations', call: async (api, c) => api.delete(`/api/locations/${await fx.addLocation(c.org, 'Spare')}`) },
    ];

    it('has a probe for every server check the three groups list, and none for a check they do not list', () => {
      const listed = SWITCH_CATALOG.filter((s) => GROUPS.includes(s.module)).flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual(listed.sort());
    });

    for (const probe of probes) {
      it(`${probe.check}: let in with ${probe.switchKey} on, refused with it off`, async () => {
        const { org } = await newOrg();
        mockSupabaseCreate();
        const ctx: Ctx = {
          org,
          target: () => target(org),
          inactive: () => target(org, { active: false }),
          department: await fx.addDepartment(org, 'Existing'),
          location: await fx.addLocation(org, 'Existing'),
        };
        const needed = Object.fromEntries((probe.alsoOn ?? []).map((k) => [k, true]));
        // A switch that needs View users / View departments / View locations on has it on for both runs.
        const requires = SWITCH_CATALOG.find((s) => s.key === probe.switchKey)!.requires;
        const base = { ...needed, ...Object.fromEntries(requires.map((k) => [k, true])) };

        const on = await personWith(org, { ...base, [probe.switchKey]: true });
        const letIn = await probe.call(await on.api(), ctx);
        expect(letIn.status, `${probe.check} with the switch on`).toBeLessThan(400);

        const off = await personWith(org, { ...base, [probe.switchKey]: false });
        const refused = await probe.call(await off.api(), ctx);
        expect(refused.status, `${probe.check} with the switch off`).toBe(403);
      });
    }
  });
});

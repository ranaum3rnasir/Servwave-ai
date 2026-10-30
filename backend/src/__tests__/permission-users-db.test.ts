/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.12 - the Users group on switches: Invite users, deactivating under
   Edit users, and role fields on a user needing Manage roles and permissions.

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
    // The address probes build real addresses, so this environment has a mailbox domain.
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
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

  /** A person with a mailbox in a company that has a frozen company part (the register's answer to "set an address"). */
  async function withMailbox(c: { org: string; target: () => Promise<Person> }) {
    const { changeCompanyPart, issueUserMailbox } = await import('../lib/mailbox/register.js');
    const person = await c.target();
    const org = await db.organization.findUniqueOrThrow({ where: { id: c.org }, select: { email_sender_local_part: true } });
    if (!org.email_sender_local_part) await changeCompanyPart(db, c.org, `probe${randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10)}`);
    await db.$transaction((tx) => issueUserMailbox(tx, { id: person.id, organization_id: c.org, first_name: 'Probe', last_name: 'Person' }));
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

  describe('a role field needs Manage roles and permissions on top of Edit users', () => {
    it('refuses an update carrying a base role or a custom-role link, and applies one with no role field', async () => {
      const { org } = await newOrg();
      const editor = await personWith(org, { edit_users: true, manage_roles_and_permissions: false });
      const api = await editor.api();
      const someone = await target(org);
      const otherRole = await fx.addCustomRole(org, `usr-other-${++sequence}`, 'SALES');

      for (const body of [{ role: 'DISPATCHER' }, { custom_role_id: otherRole.id }, { custom_role_id: null }, { role: 'SALES', custom_role_id: otherRole.id }]) {
        expect((await api.patch(`/api/users/${someone.id}`, body)).status, JSON.stringify(body)).toBe(403);
      }
      const row = await userRow(someone.id);
      expect(row?.role).toBe('SALES');
      expect(row?.custom_role_id).toBeNull();

      const plain = await api.patch(`/api/users/${someone.id}`, { first_name: 'Renamed' });
      expect(plain.status).toBe(200);
      expect((await userRow(someone.id))?.first_name).toBe('Renamed');
    });

    it('applies a role change from a person holding both switches, whatever role they are based on', async () => {
      const { org } = await newOrg();
      for (const base of ['SALES', 'TECHNICIAN', 'DISPATCHER'] as const) {
        const both = await personWith(org, { edit_users: true, manage_roles_and_permissions: true }, { base });
        const someone = await target(org);
        const res = await (await both.api()).patch(`/api/users/${someone.id}`, { role: 'DISPATCHER' });
        expect(res.status, base).toBe(200);
        expect(await roleOf(someone.id), base).toBe('DISPATCHER');
      }
    });

    it('refuses a role change from Manage roles and permissions alone: Edit users is still needed', async () => {
      const { org } = await newOrg();
      const rolesOnly = await personWith(org, { edit_users: false, manage_roles_and_permissions: true });
      const someone = await target(org);
      expect((await (await rolesOnly.api()).patch(`/api/users/${someone.id}`, { role: 'DISPATCHER' })).status).toBe(403);
      expect(await roleOf(someone.id)).toBe('SALES');
    });
  });

  describe('Create users and Invite users', () => {
    it('refuses a create or an invite that sets a role without Manage roles and permissions', async () => {
      const { org } = await newOrg();
      mockSupabaseCreate();
      const person = await personWith(org, { create_users: true, invite_users: true, manage_roles_and_permissions: false });
      const api = await person.api();

      const created = newUserBody();
      expect((await api.post('/api/users', created)).status).toBe(403);
      expect(await db.user.count({ where: { organization_id: org, email: created.email } })).toBe(0);

      const invited = inviteBody();
      expect((await api.post('/api/users/invite', invited)).status).toBe(403);
      expect(await db.user.count({ where: { organization_id: org, email: invited.email } })).toBe(0);
    });

    it('refuses an invite and a resend-invite without Invite users even with Create users on, and lets a direct create in', async () => {
      const { org } = await newOrg();
      mockSupabaseCreate();
      const person = await personWith(org, { create_users: true, invite_users: false, manage_roles_and_permissions: true });
      const api = await person.api();

      const invited = inviteBody();
      expect((await api.post('/api/users/invite', invited)).status).toBe(403);
      expect(await db.user.count({ where: { organization_id: org, email: invited.email } })).toBe(0);
      const someone = await target(org);
      expect((await api.post(`/api/users/${someone.id}/invite`)).status).toBe(403);

      const created = newUserBody('TECHNICIAN');
      const res = await api.post('/api/users', created);
      expect(res.status).toBe(201);
      expect(await db.user.count({ where: { organization_id: org, email: created.email, role: 'TECHNICIAN' } })).toBe(1);
    });

    it('lets an invite and a resend-invite in with Invite users, and refuses a direct create without Create users', async () => {
      const { org } = await newOrg();
      mockSupabaseCreate();
      const person = await personWith(org, { create_users: false, invite_users: true, manage_roles_and_permissions: true });
      const api = await person.api();

      const invited = inviteBody('DISPATCHER');
      const res = await api.post('/api/users/invite', invited);
      expect(res.status).toBe(201);
      expect(await db.user.count({ where: { organization_id: org, email: invited.email, role: 'DISPATCHER' } })).toBe(1);

      const someone = await target(org);
      expect((await api.post(`/api/users/${someone.id}/invite`)).status).toBe(200);

      expect((await api.post('/api/users', newUserBody())).status).toBe(403);
    });

    it('lets a resend-invite in with Invite users alone: a resend sets no role', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { invite_users: true, manage_roles_and_permissions: false });
      const someone = await target(org);
      expect((await (await person.api()).post(`/api/users/${someone.id}/invite`)).status).toBe(200);
    });
  });

  describe('deactivating and reactivating follow Edit users on every path', () => {
    it('deactivates and reactivates with Edit users on and Delete users off', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { edit_users: true, delete_users: false });
      const api = await person.api();

      const viaDelete = await target(org);
      expect((await api.delete(`/api/users/${viaDelete.id}`)).status).toBe(200);
      expect((await userRow(viaDelete.id))?.is_active).toBe(false);
      expect((await api.patch(`/api/users/${viaDelete.id}`, { is_active: true })).status).toBe(200);
      expect((await userRow(viaDelete.id))?.is_active).toBe(true);

      const viaUpdate = await target(org);
      expect((await api.patch(`/api/users/${viaUpdate.id}`, { is_active: false })).status).toBe(200);
      expect((await userRow(viaUpdate.id))?.is_active).toBe(false);
    });

    it('refuses a deactivate on every path with Delete users on and Edit users off', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { edit_users: false, delete_users: true });
      const api = await person.api();

      const someone = await target(org);
      expect((await api.delete(`/api/users/${someone.id}`)).status).toBe(403);
      expect((await api.patch(`/api/users/${someone.id}`, { is_active: false })).status).toBe(403);
      expect((await userRow(someone.id))?.is_active).toBe(true);

      const inactive = await target(org, { active: false });
      expect((await api.patch(`/api/users/${inactive.id}`, { is_active: true })).status).toBe(403);
      expect((await userRow(inactive.id))?.is_active).toBe(false);
    });
  });

  describe('permanent delete follows Delete users', () => {
    it('is refused without Delete users, even for an inactive user with no history', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { edit_users: true, delete_users: false });
      const inactive = await target(org, { active: false });
      expect((await (await person.api()).delete(`/api/users/${inactive.id}/permanent`)).status).toBe(403);
      expect(await userRow(inactive.id)).not.toBeNull();
    });

    it('is refused with Delete users for an active user and for one with history, and removes an inactive one with none', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { edit_users: false, delete_users: true });
      const api = await person.api();

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

    it('resets two-step login with Delete users and not without it', async () => {
      const { org } = await newOrg();
      const someone = await target(org);
      await db.user.update({ where: { id: someone.id }, data: { mfa_email_enrolled: true } });

      const without = await personWith(org, { edit_users: true, delete_users: false });
      expect((await (await without.api()).post(`/api/users/${someone.id}/mfa/reset`)).status).toBe(403);
      expect((await userRow(someone.id))?.mfa_email_enrolled).toBe(true);

      const withSwitch = await personWith(org, { edit_users: false, delete_users: true });
      expect((await (await withSwitch.api()).post(`/api/users/${someone.id}/mfa/reset`)).status).toBe(200);
      expect((await userRow(someone.id))?.mfa_email_enrolled).toBe(false);
    });
  });

  describe('nobody changes their own role', () => {
    it('refuses a person changing their own custom-role link, and their own base role, whatever they hold', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { edit_users: true, manage_roles_and_permissions: true });
      const api = await person.api();
      const other = await fx.addCustomRole(org, `usr-other-${++sequence}`, 'DISPATCHER');

      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: other.id })).status).toBe(400);
      expect((await api.patch(`/api/users/${person.id}`, { role: 'DISPATCHER', custom_role_id: null })).status).toBe(400);
      expect((await api.patch(`/api/users/${person.id}`, { role: 'ADMIN' })).status).toBe(400);
      expect((await userRow(person.id))?.custom_role_id).toBe(person.roleId);
      expect(await roleOf(person.id)).toBe('DISPATCHER');
    });

    it('still lets them edit their other fields, and send back the role they already hold', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { edit_users: true, manage_roles_and_permissions: true });
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
      { check: 'user-create', switchKey: 'create_users', alsoOn: ['manage_roles_and_permissions'], call: (api) => api.post('/api/users', newUserBody()) },
      { check: 'user-invite', switchKey: 'invite_users', alsoOn: ['manage_roles_and_permissions'], call: (api) => api.post('/api/users/invite', inviteBody()) },
      { check: 'user-invite-resend', switchKey: 'invite_users', call: async (api, c) => api.post(`/api/users/${(await c.target()).id}/invite`) },
      { check: 'user-update', switchKey: 'edit_users', call: async (api, c) => api.patch(`/api/users/${(await c.target()).id}`, { first_name: 'Probe' }) },
      { check: 'user-deactivate', switchKey: 'edit_users', call: async (api, c) => api.delete(`/api/users/${(await c.target()).id}`) },
      { check: 'user-reactivate', switchKey: 'edit_users', call: async (api, c) => api.patch(`/api/users/${(await c.inactive()).id}`, { is_active: true }) },
      // S10.25: set or change the name part of a person's own address. The person needs a mailbox and the company a frozen part to be let in.
      { check: 'user-mailbox-address', switchKey: 'edit_users', call: async (api, c) => api.put(`/api/users/${(await withMailbox(c)).id}/mailbox-address`, { name_part: `probe.${randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10)}` }) },
      // S10.22: hand a leaver's mailbox on later. The owner must be deactivated and have a mailbox.
      { check: 'user-mailbox-move', switchKey: 'edit_users', call: async (api, c) => api.put(`/api/users/${(await withMailbox({ org: c.org, target: c.inactive })).id}/mailbox-handover`, { handover_to: 'main' }) },
      { check: 'user-delete-permanent', switchKey: 'delete_users', call: async (api, c) => api.delete(`/api/users/${(await c.inactive()).id}/permanent`) },
      { check: 'user-reset-two-step-login', switchKey: 'delete_users', call: async (api, c) => api.post(`/api/users/${(await c.target()).id}/mfa/reset`) },
      { check: 'user-role-field', switchKey: 'manage_roles_and_permissions', alsoOn: ['edit_users'], call: async (api, c) => api.patch(`/api/users/${(await c.target()).id}`, { role: 'DISPATCHER' }) },
      // The role routes still guard on read and update Role until the roles API replaces them (S01.21); both stand on this switch.
      { check: 'role-list', switchKey: 'manage_roles_and_permissions', call: (api) => api.get('/api/roles') },
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

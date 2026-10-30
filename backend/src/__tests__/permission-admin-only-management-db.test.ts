/* =============================================================================
   Roles & Permissions security, AL-18 (ticket 28): user and role management is Admin-only.

   Every role route, every person-switch route and every user-management route answers only an Admin (the `is_admin`
   flag on the person), never a switch. A non-Admin holding every switch the catalog has, at its widest, is refused on
   each of them; and no single switch value, alone or with the switches it needs, lets a non-Admin edit a role, clone the
   Admin role, change a person's switches or assign a role. "Send password reset" follows the Admin flag too.

   Everything goes through the public interface: the routes, called as people on custom roles made from blank holding
   exactly the switch values under test (never a built-in role name). Expected values come from the switch catalog,
   never a copy. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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
import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, findSwitch, storableChoices, type SwitchValue } from '../lib/permissions/switches/catalog';
import { clearSwitchCacheForOrg } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

/** Every switch at its widest: each toggle on, each choice at its last (widest) storable value, each list at "all". */
function everySwitchOn(): Record<string, SwitchValue> {
  return Object.fromEntries(
    SWITCH_CATALOG.map((s) => [
      s.key,
      s.kind === 'toggle' ? true : s.kind === 'choice' ? storableChoices(s).at(-1)! : ALL_ACCEPTED_METHODS,
    ]),
  );
}

/** One switch at one value, with the switches it needs on (and nothing else), so the set is one the product stores. */
function alone(key: string, value: SwitchValue): Record<string, SwitchValue> {
  const set: Record<string, SwitchValue> = { [key]: value };
  const need = (k: string) => {
    const s = findSwitch(k)!;
    for (const r of [...s.requires, ...(s.requiresAny ? [s.requiresAny[0]!] : [])]) {
      if (set[r] === true) continue;
      set[r] = true;
      need(r);
    }
  };
  if (value === true) need(key);
  return set;
}

/** Every value of every switch: on for a toggle, each storable choice, "all" and every option for a list. */
function everySwitchValue(): Array<{ label: string; values: Record<string, SwitchValue> }> {
  return SWITCH_CATALOG.flatMap((s) => {
    const values: SwitchValue[] =
      s.kind === 'toggle' ? [true] : s.kind === 'choice' ? storableChoices(s) : [ALL_ACCEPTED_METHODS, [...(s.listOptions ?? [])]];
    return values.map((v) => ({ label: `${s.key}=${JSON.stringify(v)}`, values: alone(s.key, v) }));
  });
}

suite('user and role management is Admin-only (AL-18, real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** A company with a non-Admin on a blank custom role, a colleague on another custom role, and a third role to move people to. */
  async function company() {
    const { org, admin } = await fx.newOrg();
    const holdersRole = await fx.addCustomRole(org, 'holders', 'DISPATCHER', { madeFromBlank: true });
    const colleaguesRole = await fx.addCustomRole(org, 'colleagues', 'TECHNICIAN', { madeFromBlank: true });
    const otherRole = await fx.addCustomRole(org, 'other', 'TECHNICIAN', { madeFromBlank: true });
    const holder = await fx.addUser(org, 'holder', 'DISPATCHER', { customRoleId: holdersRole.id, basedOnRoleKey: holdersRole.key });
    const colleague = await fx.addUser(org, 'colleague', 'TECHNICIAN', { customRoleId: colleaguesRole.id, basedOnRoleKey: colleaguesRole.key });
    return { org, admin, holdersRole, colleaguesRole, otherRole, holder, colleague };
  }

  /** Give the holders' role exactly these values: every stored row of it replaced. */
  async function holdExactly(org: string, roleKey: string, values: Record<string, SwitchValue>) {
    await db.permissionRoleSwitch.deleteMany({ where: { organization_id: org, role_key: roleKey } });
    await fx.setRoleSwitches(org, roleKey, values);
    clearSwitchCacheForOrg(org);
  }

  /** Every role, person-switch and user-management route, with a body that would pass validation. */
  function managementRoutes(c: Awaited<ReturnType<typeof company>>) {
    const { colleague, colleaguesRole, otherRole } = c;
    const id = colleague.id;
    const role = colleaguesRole.key;
    const someToggle = SWITCH_CATALOG.find((s) => s.kind === 'toggle' && s.requires.length === 0 && !s.requiresAny)!.key;
    return [
      // Roles & Permissions.
      { method: 'get', path: '/api/roles' },
      { method: 'post', path: '/api/roles', body: { label: 'Copy of Admin', base_role: 'ADMIN', clone_grants_from: 'ADMIN' } },
      { method: 'get', path: `/api/roles/${role}/permissions` },
      { method: 'put', path: `/api/roles/${role}/permissions`, body: { values: { [someToggle]: true } } },
      { method: 'post', path: `/api/roles/${role}/reset` },
      { method: 'get', path: `/api/roles/${role}/change-log` },
      { method: 'patch', path: `/api/roles/${role}`, body: { label: 'Renamed' } },
      { method: 'post', path: `/api/roles/${otherRole.key}/archive` },
      { method: 'delete', path: `/api/roles/${otherRole.key}` },
      // A person's switches.
      { method: 'get', path: `/api/users/${id}/permissions` },
      { method: 'put', path: `/api/users/${id}/permissions`, body: { values: { [someToggle]: true } } },
      { method: 'post', path: `/api/users/${id}/permissions/reset`, body: { all: true } },
      { method: 'post', path: `/api/users/${id}/permissions/save-as-role`, body: { label: 'Saved' } },
      { method: 'get', path: `/api/users/${id}/permissions/change-log` },
      // Users & Teams: adding, inviting, changing, deactivating, deleting and erasing people.
      { method: 'post', path: '/api/users', body: { email: `new-${randomUUID().slice(0, 8)}@example.test`, first_name: 'New', last_name: 'Person', custom_role_id: otherRole.id } },
      { method: 'post', path: '/api/users/invite', body: { email: `inv-${randomUUID().slice(0, 8)}@example.test`, first_name: 'Inv', last_name: 'Person', custom_role_id: otherRole.id } },
      { method: 'post', path: `/api/users/${id}/invite` },
      { method: 'post', path: `/api/users/${id}/revoke-login` },
      { method: 'post', path: `/api/users/${id}/password-reset` },
      { method: 'get', path: `/api/users/${id}/deactivation-summary` },
      { method: 'post', path: `/api/users/${id}/reassign`, body: {} },
      { method: 'patch', path: `/api/users/${id}`, body: { custom_role_id: otherRole.id } },
      { method: 'patch', path: `/api/users/${id}`, body: { phone: '555-0100' } },
      { method: 'put', path: `/api/users/${id}/mailbox-address`, body: { local_part: 'someone' } },
      { method: 'put', path: `/api/users/${id}/mailbox-handover`, body: { handover_to: 'main' } },
      { method: 'delete', path: `/api/users/${id}`, body: {} },
      { method: 'delete', path: `/api/users/${id}/permanent` },
      { method: 'post', path: `/api/users/${id}/erase-personal-data` },
      { method: 'post', path: `/api/users/${id}/mfa/reset` },
      { method: 'delete', path: `/api/users/${id}/avatar` },
    ] as const;
  }

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const call = (api: Api, r: { method: string; path: string; body?: object }) =>
    r.method === 'get' ? api.get(r.path)
      : r.method === 'post' ? api.post(r.path, r.body)
        : r.method === 'put' ? api.put(r.path, r.body)
          : r.method === 'patch' ? api.patch(r.path, r.body)
            : api.delete(r.path, r.body);

  it('refuses every role, person-switch and user-management route to a non-Admin holding every switch at its widest', async () => {
    const c = await company();
    await holdExactly(c.org, c.holdersRole.key, everySwitchOn());
    const colleagueBefore = await db.user.findUniqueOrThrow({ where: { id: c.colleague.id } });

    const refused: string[] = [];
    const letIn: string[] = [];
    for (const r of managementRoutes(c)) {
      const res = await call(await fx.signedInAs(c.holder), r);
      (res.status === 403 ? refused : letIn).push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(letIn).toEqual([]);
    expect(refused).toHaveLength(managementRoutes(c).length);

    // Nothing moved: the colleague is on the same role, active, with the same details; no role was made, renamed or archived.
    const colleagueAfter = await db.user.findUniqueOrThrow({ where: { id: c.colleague.id } });
    expect(colleagueAfter).toEqual(colleagueBefore);
    const roles = await db.customRole.findMany({ where: { organization_id: c.org }, select: { key: true, label: true, archived_at: true } });
    expect(roles.map((r) => `${r.key}:${r.label}:${r.archived_at === null}`).sort()).toEqual(['colleagues:colleagues:true', 'holders:holders:true', 'other:other:true']);
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: c.org, role_key: c.colleaguesRole.key } })).toBe(0);
    expect(await db.permissionUserSwitch.count({ where: { organization_id: c.org, user_id: c.colleague.id } })).toBe(0);
  });

  it('lets an Admin through the same routes (no 403)', async () => {
    const c = await company();
    const admin: Person = c.admin;
    // No sign-in, so the reset below stops at the handler's own answer and sends nothing.
    await db.user.update({ where: { id: c.colleague.id }, data: { has_login: false } });
    const reads = [
      { method: 'get', path: '/api/roles' },
      { method: 'get', path: `/api/roles/${c.colleaguesRole.key}/permissions` },
      { method: 'get', path: `/api/users/${c.colleague.id}/permissions` },
      { method: 'get', path: `/api/users/${c.colleague.id}/deactivation-summary` },
    ] as const;
    for (const r of reads) expect((await call(await fx.signedInAs(admin), r)).status, r.path).toBe(200);
    // Assigning a role.
    const moved = await (await fx.signedInAs(admin)).patch(`/api/users/${c.colleague.id}`, { custom_role_id: c.otherRole.id });
    expect(moved.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: c.colleague.id } })).custom_role_id).toBe(c.otherRole.id);
    // Send password reset gets past the gate to the handler's own answer.
    const reset = await (await fx.signedInAs(admin)).post(`/api/users/${c.colleague.id}/password-reset`);
    expect(reset.status).toBe(400);
    expect(reset.body.code).toBe('no_login');
  });

  it('answers 403 to a non-Admin asking to send a password reset, whatever their switches', async () => {
    const c = await company();
    await db.user.update({ where: { id: c.colleague.id }, data: { has_login: true } });
    for (const values of [{}, everySwitchOn()]) {
      await holdExactly(c.org, c.holdersRole.key, values);
      const res = await (await fx.signedInAs(c.holder)).post(`/api/users/${c.colleague.id}/password-reset`);
      expect(res.status).toBe(403);
    }
  });

  it('lets no switch value, alone or with what it needs, edit a role, clone the Admin role, change a person\'s switches, assign a role, or create, invite or save as a role with one', async () => {
    const c = await company();
    const someToggle = SWITCH_CATALOG.find((s) => s.kind === 'toggle' && s.requires.length === 0 && !s.requiresAny)!.key;
    const probes = [
      { name: 'edit their own role', method: 'put', path: `/api/roles/${c.holdersRole.key}/permissions`, body: { values: { [someToggle]: true } } },
      { name: 'edit another role', method: 'put', path: `/api/roles/${c.colleaguesRole.key}/permissions`, body: { values: { [someToggle]: true } } },
      { name: 'clone the Admin role', method: 'post', path: '/api/roles', body: { label: 'Copy of Admin', base_role: 'ADMIN', clone_grants_from: 'ADMIN' } },
      { name: 'change a person\'s switches', method: 'put', path: `/api/users/${c.colleague.id}/permissions`, body: { values: { [someToggle]: true } } },
      { name: 'assign a role', method: 'patch', path: `/api/users/${c.colleague.id}`, body: { custom_role_id: c.otherRole.id } },
      { name: 'create a person on a role', method: 'post', path: '/api/users', body: { email: 'loop-create@example.test', first_name: 'Loop', last_name: 'Create', role: 'TECHNICIAN', custom_role_id: c.otherRole.id } },
      { name: 'invite a person on a role', method: 'post', path: '/api/users/invite', body: { email: 'loop-invite@example.test', first_name: 'Loop', last_name: 'Invite', role: 'TECHNICIAN', custom_role_id: c.otherRole.id } },
      { name: 'save a person\'s switches as a role', method: 'post', path: `/api/users/${c.colleague.id}/permissions/save-as-role`, body: { label: 'Saved from the loop' } },
    ] as const;

    const cases = [{ label: 'every switch at its widest', values: everySwitchOn() }, ...everySwitchValue()];
    const granted: string[] = [];
    for (const k of cases) {
      await holdExactly(c.org, c.holdersRole.key, k.values);
      for (const p of probes) {
        const res = await call(await fx.signedInAs(c.holder), p);
        if (res.status !== 403) granted.push(`${k.label}: ${p.name} -> ${res.status}`);
      }
    }
    expect(granted).toEqual([]);
    // The loop really ran over the catalog: one case per value, plus the all-on case.
    expect(cases.length).toBeGreaterThan(SWITCH_CATALOG.length);
    expect((await db.user.findUniqueOrThrow({ where: { id: c.colleague.id } })).custom_role_id).toBe(c.colleaguesRole.id);
    expect(await db.customRole.count({ where: { organization_id: c.org } })).toBe(3);
    expect(await db.user.count({ where: { organization_id: c.org, email: { in: ['loop-create@example.test', 'loop-invite@example.test'] } } })).toBe(0);
  }, 600_000);
});

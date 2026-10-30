/* =============================================================================
   Roles & Permissions, PRD 2, slice S02.12 - the change logs behind the Roles page and a person's Permissions page.

   A role's log and a person's log are read newest first, a page at a time, behind the Admin flag (AL-18). This
   suite proves what each write leaves in them (the reason, the role's name on the rows that are about a role, the one
   event row a Save as role writes), that a page never repeats or skips a row when a whole burst shares one timestamp,
   that a page costs the queries the hosted pool can afford, and that nobody outside the company's managers reads one.

   Everything goes through the routes, as people on custom roles (never a built-in role name). Expected values come from
   the catalog. Real migrated database (TEST_DATABASE_URL), reached through a client with ONE connection, the size of
   the hosted pool, so a query that escapes a transaction would time out here; the suite skips when the variable is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '10');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, findSwitch, type SwitchEntry, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;


interface Entry {
  id: string;
  switch_key: string | null;
  switch_label: string | null;
  from: SwitchValue | null;
  to: SwitchValue | null;
  reason: string;
  role_label: string | null;
  created_at: string;
  actor: { id: string; name: string } | null;
}
interface Page { total: number | null; has_more: boolean; entries: Entry[] }

/** Toggles a preset holds off, that need nothing else and that nothing else needs: safe to flip on. */
const flippable = (role: Role, count: number): SwitchEntry[] => {
  const needed = new Set(SWITCH_CATALOG.flatMap((s) => [...s.requires, ...(s.requiresAny ?? [])]));
  return SWITCH_CATALOG.filter(
    (s) => s.kind === 'toggle' && s.presets[role] === false && s.requires.length === 0 && !s.requiresAny && !needed.has(s.key),
  ).slice(0, count);
};

suite('the change logs of a role and of a person (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
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
  async function manager(org: string, manage: boolean, name = `mgr${++sequence}`): Promise<Person & { api: () => Promise<Api> }> {
    const key = `mgr-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, name, 'DISPATCHER', { customRoleId: role.id, isAdmin: manage });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A person on a Sales base, the person whose log is read. */
  const target = (org: string, role: Role = 'SALES') => fx.addUser(org, `target${++sequence}`, role);

  const roleLog = async (api: Api, key: string, query = ''): Promise<Page> => (await api.get(`/api/roles/${key}/change-log${query}`)).body;
  const personLog = async (api: Api, id: string, query = ''): Promise<Page> => (await api.get(`/api/users/${id}/permissions/change-log${query}`)).body;

  describe("a role's log", () => {
    it('shows an edit as manual, a reset as reset and a role made through Save as role as save as role, newest first', async () => {
      const { org } = await fx.newOrg();
      const me = await manager(org, true);
      const api = await me.api();
      const [a, b] = flippable('SALES', 2);

      // A role is made through Save as role from a person who holds the switch `a` on.
      const person = await target(org);
      await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true } });
      const saved = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Sales plus' });
      expect(saved.status).toBe(201);
      const key = saved.body.role.role as string;

      expect((await api.put(`/api/roles/${key}/permissions`, { values: { [b!.key]: true } })).status).toBe(200);
      expect((await api.post(`/api/roles/${key}/reset`)).status).toBe(200);

      const log = await roleLog(api, key);
      const reasons = log.entries.map((e) => e.reason);
      // Newest first: the reset, then the edit, then everything the role was made with.
      const lastReset = reasons.lastIndexOf('reset');
      const firstManual = reasons.indexOf('manual');
      const firstSaved = reasons.indexOf('save as role');
      expect(lastReset).toBeLessThan(firstManual);
      expect(firstManual).toBeLessThan(firstSaved);
      expect(new Set(reasons)).toEqual(new Set(['reset', 'manual', 'save as role']));
      // The reset undoes both switches: `b` the edit, and `a` the value the role was made with.
      const resets = log.entries.filter((e) => e.reason === 'reset');
      expect(resets.map((e) => e.switch_key).sort()).toEqual([a!.key, b!.key].sort());
      expect(log.entries.find((e) => e.reason === 'manual')).toMatchObject({ switch_key: b!.key, from: false, to: true });
      // Every row names who did it.
      for (const e of log.entries) expect(e.actor?.id).toBe(me.id);
    });

    it('opens with one event row for the Save as role, with no switch, even when the role holds exactly its starting values', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const saved = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Plain copy' });
      expect(saved.status).toBe(201);

      const log = await roleLog(api, saved.body.role.role);
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]).toMatchObject({ switch_key: null, switch_label: null, from: null, to: null, reason: 'save as role' });
    });

    it('puts the event row of a Save as role ahead of the switch rows it was written with', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a, b] = flippable('SALES', 2);
      await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });
      const saved = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Sales two' });

      const log = await roleLog(api, saved.body.role.role);
      expect(log.entries).toHaveLength(3);
      // One transaction, one timestamp: the event comes first, then the switches in a fixed order.
      expect(log.entries[0]!.switch_key).toBeNull();
      expect(log.entries.slice(1).map((e) => e.switch_key)).toEqual([a!.key, b!.key].sort());
    });
  });

  describe("a person's log", () => {
    it('shows a switch edit, a per-switch reset, a role assignment and a Save as role, each with its reason and the role named', async () => {
      const { org, admin } = await fx.newOrg();
      const me = await manager(org, true);
      const person = await fx.addUser(org, `walker${++sequence}`, 'DISPATCHER');
      const [a] = flippable('SALES', 1);

      // A role assignment: Dispatcher to Sales, through the user update, by an admin (who may edit users). The sign-in
      // is the last one asked for, so the manager signs in again once the admin is done.
      expect((await (await fx.signedInAs(admin)).patch(`/api/users/${person.id}`, { role: 'SALES' })).status).toBe(200);
      const api = await me.api();
      // An edit and its per-switch reset.
      await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true } });
      await api.post(`/api/users/${person.id}/permissions/reset`, { switch_keys: [a!.key] });
      // Save as role.
      const saved = await api.post(`/api/users/${person.id}/permissions/save-as-role`, { label: 'Walker desk' });
      expect(saved.status).toBe(201);

      const log = await personLog(api, person.id, '?limit=200');
      // Newest first: Save as role, the reset, the edit, then the assignment.
      expect(log.entries[0]).toMatchObject({ reason: 'save as role', switch_key: null, role_label: 'Walker desk' });
      expect(log.entries[1]).toMatchObject({ reason: 'reset', switch_key: a!.key, from: true, to: false });
      expect(log.entries[2]).toMatchObject({ reason: 'manual', switch_key: a!.key, from: false, to: true });
      const assigned = log.entries.slice(3);
      expect(assigned.length).toBeGreaterThan(0);
      for (const e of assigned) expect(e).toMatchObject({ reason: 'role assigned', role_label: 'Sales', actor: { id: admin.id } });
      expect(assigned.map((e) => e.switch_key).sort()).toEqual(
        SWITCH_CATALOG.filter((s) => s.presets.DISPATCHER !== s.presets.SALES).map((s) => s.key).sort(),
      );
      for (const e of log.entries.slice(0, 3)) expect(e.actor?.id).toBe(me.id);
      for (const e of log.entries) {
        if (e.switch_key) expect(e.switch_label).toBe(findSwitch(e.switch_key)!.label);
      }
    });

    it('names a custom role as it was called when it was given, even after it is renamed', async () => {
      const { org, admin } = await fx.newOrg();
      const reader = await manager(org, true);
      const role = await fx.addCustomRole(org, `crew-${++sequence}`, 'DISPATCHER');
      await db.customRole.update({ where: { id: role.id }, data: { label: 'Crew lead' } });
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [flippable('DISPATCHER', 1)[0]!.key]: true }, actorId: null, reason: 'manual' });
      const person = await fx.addUser(org, `crew${++sequence}`, 'DISPATCHER');

      expect((await (await fx.signedInAs(admin)).patch(`/api/users/${person.id}`, { custom_role_id: role.id })).status).toBe(200);
      await db.customRole.update({ where: { id: role.id }, data: { label: 'Crew captain' } });

      const log = await personLog(await reader.api(), person.id);
      expect(log.entries.length).toBeGreaterThan(0);
      for (const e of log.entries) expect(e).toMatchObject({ reason: 'role assigned', role_label: 'Crew lead' });
    });

    it('shows a migration row, or any row with no actor, with no actor', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a] = flippable('SALES', 1);
      await db.permissionChangeLog.create({
        data: { organization_id: org, target_type: 'USER', target_id: person.id, switch_key: a!.key, from_value: false, to_value: true, actor_id: null, reason: 'migration' },
      });

      const log = await personLog(api, person.id);
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]).toMatchObject({ reason: 'migration', actor: null, role_label: null });
    });

    it('shows the label the catalog holds for a key, and no label for one the catalog no longer has', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a] = flippable('SALES', 1);
      await db.permissionChangeLog.createMany({
        data: [
          { organization_id: org, target_type: 'USER', target_id: person.id, switch_key: a!.key, from_value: false, to_value: true, reason: 'manual' },
          { organization_id: org, target_type: 'USER', target_id: person.id, switch_key: 'a_switch_that_was_removed', from_value: true, to_value: false, reason: 'manual' },
        ],
      });
      const log = await personLog(api, person.id);
      const byKey = new Map(log.entries.map((e) => [e.switch_key, e]));
      expect(byKey.get(a!.key)?.switch_label).toBe(findSwitch(a!.key)!.label);
      // The reader says only what it knows, never a raw key as a label: the screen words the fallback.
      expect(byKey.get('a_switch_that_was_removed')).toMatchObject({ switch_key: 'a_switch_that_was_removed', switch_label: null });
    });
  });

  describe('paging', () => {
    it('pages a burst that shares one timestamp with no row repeated or skipped, in the order a single read gives', async () => {
      const { org, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const person = await fx.addUser(org, `burst${++sequence}`, 'TECHNICIAN');
      // A role assignment writes one row per changed switch in one statement: one timestamp for the lot.
      expect((await api.patch(`/api/users/${person.id}`, { role: 'SALES' })).status).toBe(200);
      const whole = await personLog(api, person.id, '?limit=200');
      expect(whole.entries.length).toBeGreaterThan(30);
      expect(new Set(whole.entries.map((e) => e.created_at)).size).toBe(1);

      const seen: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 50; guard++) {
        const page = await personLog(api, person.id, `?limit=7&offset=${offset}`);
        seen.push(...page.entries.map((e) => e.id));
        offset += page.entries.length;
        if (!page.has_more) break;
      }
      expect(seen).toEqual(whole.entries.map((e) => e.id));
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('says whether older rows remain, and counts the log on the first page only', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a, b, c] = flippable('SALES', 3);
      for (const s of [a, b, c]) await api.put(`/api/users/${person.id}/permissions`, { values: { [s!.key]: true } });

      const first = await personLog(api, person.id, '?limit=2');
      expect(first).toMatchObject({ total: 3, has_more: true });
      expect(first.entries).toHaveLength(2);
      const second = await personLog(api, person.id, '?limit=2&offset=2');
      expect(second).toMatchObject({ total: null, has_more: false });
      expect(second.entries).toHaveLength(1);
      // Exactly a full page left is not "more".
      expect((await personLog(api, person.id, '?limit=3')).has_more).toBe(false);
      expect((await personLog(api, person.id, '?limit=3&offset=3')).entries).toEqual([]);
    });

    it('asks the database for a later page in one query for the rows and at most one for the names', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a, b] = flippable('SALES', 2);
      await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true, [b!.key]: true } });

      const rows = vi.spyOn(db.permissionChangeLog, 'findMany');
      const count = vi.spyOn(db.permissionChangeLog, 'count');
      const names = vi.spyOn(db.user, 'findMany');
      try {
        const res = await api.get(`/api/users/${person.id}/permissions/change-log?limit=1&offset=1`);
        expect(res.status).toBe(200);
        expect(rows).toHaveBeenCalledTimes(1);
        expect(count).not.toHaveBeenCalled();
        expect(names).toHaveBeenCalledTimes(1);
      } finally {
        rows.mockRestore();
        count.mockRestore();
        names.mockRestore();
      }
    });
  });

  describe('who may read it', () => {
    it('is read by an Admin, refused to a non-Admin, and never shows another company\'s rows', async () => {
      const { org } = await fx.newOrg();
      const other = await fx.newOrg();
      const holder = await manager(org, true);
      const plain = await manager(org, false);
      const person = await target(org);
      const [a] = flippable('SALES', 1);
      await (await holder.api()).put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true } });
      const role = await fx.addCustomRole(org, `watched-${++sequence}`, 'DISPATCHER');

      const holderApi = await holder.api();
      expect((await holderApi.get(`/api/users/${person.id}/permissions/change-log`)).status).toBe(200);
      expect((await holderApi.get(`/api/roles/${role.key}/change-log`)).status).toBe(200);

      const plainApi = await plain.api();
      expect((await plainApi.get(`/api/users/${person.id}/permissions/change-log`)).status).toBe(403);
      expect((await plainApi.get(`/api/roles/${role.key}/change-log`)).status).toBe(403);

      // A manager of another company asks for this company's person and role: nothing of theirs is shown.
      const outsider = await manager(other.org, true);
      const outsiderApi = await outsider.api();
      expect((await outsiderApi.get(`/api/users/${person.id}/permissions/change-log`)).status).toBe(404);
      expect((await outsiderApi.get(`/api/roles/${role.key}/change-log`)).status).toBe(404);
      // And a log row written for the same key in another company is never in this company's page.
      await db.permissionChangeLog.create({
        data: { organization_id: other.org, target_type: 'USER', target_id: person.id, switch_key: a!.key, from_value: false, to_value: true, reason: 'manual' },
      });
      expect((await personLog(holderApi, person.id)).entries).toHaveLength(1);
    });

    it('shows a person the switch names and values only, nothing else about them', async () => {
      const { org } = await fx.newOrg();
      const api = await (await manager(org, true)).api();
      const person = await target(org);
      const [a] = flippable('SALES', 1);
      await api.put(`/api/users/${person.id}/permissions`, { values: { [a!.key]: true } });
      const res = await api.get(`/api/users/${person.id}/permissions/change-log`);
      const text = JSON.stringify(res.body);
      const row = await db.user.findUniqueOrThrow({ where: { id: person.id } });
      expect(text).not.toContain(row.email);
      expect(text).not.toContain(row.phone ?? 'no-phone-on-file');
      for (const e of res.body.entries as Entry[]) expect(Object.keys(e).sort()).toEqual(
        ['actor', 'created_at', 'from', 'id', 'reason', 'role_label', 'switch_key', 'switch_label', 'to'].sort(),
      );
    });
  });
});

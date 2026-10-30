/* =============================================================================
   Roles & Permissions alignment, AL-01a (P14): a person's effective switches are their role's switches with their
   own overrides on top. A role edit reaches every person who holds no override on the changed switch; assigning a role
   stores the link and clears the overrides, and copies nothing.

   Everything goes through the public interface: the Users update that gives a person a role, the Roles API that edits
   one, and the person's resolved switches. Migration M3 is run against real rows the way the deploy runs it. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
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
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { resolveSwitches, readPersonSet, readChangeLog, setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

/** A toggle no preset turns on for a Dispatcher and nothing requires or depends on: safe to flip. */
const FLIP = 'apply_discounts';
const OTHER = 'export_customers';
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100000_permission_person_overrides_only', 'migration.sql');

suite('the person store is role + overrides (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());

  async function subject(person: Person) {
    return db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, organization_id: true, role: true, is_admin: true, custom_role_id: true, custom_role: { select: { key: true } }, based_on_role_key: true },
    });
  }
  const valueOf = async (person: Person, key: string) => (await resolveSwitches(await subject(person)))[key];

  /** An org with a custom role made from Dispatcher and two people on it. */
  async function roleWithTwoPeople() {
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'office', 'DISPATCHER', { copyGrants: false });
    const ann = await fx.addUser(org, 'ann', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const bob = await fx.addUser(org, 'bob', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    return { org, admin, role, ann, bob };
  }

  it('lets a role edit change a person who holds no override on that switch; a value of their own that the role comes to equal is dropped, so they follow its next edit (CR-7)', async () => {
    const { org, admin, role, ann, bob } = await roleWithTwoPeople();
    const api = await fx.signedInAs(admin);
    // Bob holds his own value for the switch: the opposite of the role's.
    const roleValue = findSwitch(FLIP)!.presets.DISPATCHER as boolean;
    expect((await api.put(`/api/users/${bob.id}/permissions`, { values: { [FLIP]: !roleValue } })).status).toBe(200);
    expect(await valueOf(ann, FLIP)).toBe(roleValue);
    expect(await valueOf(bob, FLIP)).toBe(!roleValue);

    // The role is edited to the value Bob already holds, then back. Once the role holds Bob's value his own row is no exception
    // any more and goes (as Reset and a person save drop one; pre-PR review CR-7), so both follow the role back.
    expect((await api.put(`/api/roles/${role.key}/permissions`, { values: { [FLIP]: !roleValue } })).status).toBe(200);
    expect(await valueOf(ann, FLIP)).toBe(!roleValue);
    expect(await valueOf(bob, FLIP)).toBe(!roleValue);
    expect(await db.permissionUserSwitch.count({ where: { user_id: bob.id, switch_key: FLIP } })).toBe(0);
    expect((await api.put(`/api/roles/${role.key}/permissions`, { values: { [FLIP]: roleValue } })).status).toBe(200);
    expect(await valueOf(ann, FLIP)).toBe(roleValue);
    expect(await valueOf(bob, FLIP)).toBe(roleValue);
    expect(org).toBeTruthy();
  });

  it('stores only the role link when a person is given a role, and writes no per-person copy', async () => {
    const { org, admin } = await fx.newOrg();
    const dee = await fx.addUser(org, 'dee', 'DISPATCHER');
    const api = await fx.signedInAs(admin);

    expect((await api.patch(`/api/users/${dee.id}`, { role: 'SALES' })).status).toBe(200);

    expect(await db.permissionUserSwitch.count({ where: { user_id: dee.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: dee.id } })).based_on_role_key).toBe('SALES');
    expect(await valueOf(dee, FLIP)).toBe(findSwitch(FLIP)!.presets.SALES);
    // And the edit of the built-in role afterwards reaches her.
    expect((await api.put('/api/roles/SALES/permissions', { values: { [FLIP]: !findSwitch(FLIP)!.presets.SALES } })).status).toBe(200);
    expect(await valueOf(dee, FLIP)).toBe(!findSwitch(FLIP)!.presets.SALES);
  });

  it('clears the overrides of a person who is given a different role', async () => {
    const { org, admin } = await fx.newOrg();
    const pat = await fx.addUser(org, 'pat', 'DISPATCHER');
    const api = await fx.signedInAs(admin);
    expect((await api.put(`/api/users/${pat.id}/permissions`, { values: { [OTHER]: true } })).status).toBe(200);
    expect(await db.permissionUserSwitch.count({ where: { user_id: pat.id } })).toBe(1);

    expect((await api.patch(`/api/users/${pat.id}`, { role: 'TECHNICIAN' })).status).toBe(200);
    expect(await db.permissionUserSwitch.count({ where: { user_id: pat.id } })).toBe(0);
  });

  it('stores a person value only while it differs from the role: setting it back to the role value drops the override', async () => {
    const { admin, ann } = await roleWithTwoPeople();
    const api = await fx.signedInAs(admin);
    const roleValue = findSwitch(FLIP)!.presets.DISPATCHER as boolean;

    await api.put(`/api/users/${ann.id}/permissions`, { values: { [FLIP]: !roleValue } });
    expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id, switch_key: FLIP } })).toBe(1);
    await api.put(`/api/users/${ann.id}/permissions`, { values: { [FLIP]: roleValue } });
    expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id, switch_key: FLIP } })).toBe(0);
    expect((await readPersonSet((await subject(ann)).organization_id, ann.id)).differences).toEqual([]);
  });

  it('keeps every value when a person is saved as a role, with no overrides left over', async () => {
    const { org, admin, ann } = await roleWithTwoPeople();
    const api = await fx.signedInAs(admin);
    await api.put(`/api/users/${ann.id}/permissions`, { values: { [OTHER]: true } });

    const res = await api.post(`/api/users/${ann.id}/permissions/save-as-role`, { label: 'Ann plus' });
    expect(res.status).toBe(201);
    expect(await valueOf(ann, OTHER)).toBe(true);
    expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id } })).toBe(0);
    expect(org).toBeTruthy();
  });

  it('puts a person back on their role when Reset is used: every override goes, and a later role edit reaches them', async () => {
    const { admin, role, ann } = await roleWithTwoPeople();
    const api = await fx.signedInAs(admin);
    const roleValue = findSwitch(FLIP)!.presets.DISPATCHER as boolean;
    await api.put(`/api/users/${ann.id}/permissions`, { values: { [FLIP]: !roleValue, [OTHER]: true } });
    expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id } })).toBe(2);

    expect((await api.post(`/api/users/${ann.id}/permissions/reset`, { all: true })).status).toBe(200);

    expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id } })).toBe(0);
    expect((await readPersonSet((await subject(ann)).organization_id, ann.id)).differences).toEqual([]);
    await api.put(`/api/roles/${role.key}/permissions`, { values: { [FLIP]: !roleValue } });
    expect(await valueOf(ann, FLIP)).toBe(!roleValue);
  });

  it('removes an override a role edit leaves without what it needs, logs it once, and keeps the person\'s other overrides', async () => {
    const { org, admin, role, ann, bob } = await roleWithTwoPeople();
    const api = await fx.signedInAs(admin);
    // Ann holds Export customers on by hand (the role has it off) and Apply discounts on by hand.
    await api.put(`/api/users/${ann.id}/permissions`, { values: { [OTHER]: true, [FLIP]: !(findSwitch(FLIP)!.presets.DISPATCHER as boolean) } });
    // The role then closes Customers: View customers and everything that needs it go off.
    const needs = new Set(['view_customers']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const sw of SWITCH_CATALOG) if (!needs.has(sw.key) && sw.requires.some((r) => needs.has(r))) { needs.add(sw.key); grew = true; }
    }
    const off = Object.fromEntries(SWITCH_CATALOG.filter((sw) => needs.has(sw.key) && sw.kind === 'toggle').map((sw) => [sw.key, false]));

    const res = await api.put(`/api/roles/${role.key}/permissions`, { values: off });
    expect(res.status).toBe(200);

    // Ann's Export customers override could not stand without View customers: gone, with one entry saying so.
    const kept = (await db.permissionUserSwitch.findMany({ where: { user_id: ann.id } })).map((r) => r.switch_key);
    expect(kept).toEqual([FLIP]);
    const removed = (await readChangeLog({ organizationId: org, targetType: 'USER', targetId: ann.id })).filter((l) => l.reason === 'role edit');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ switch_key: OTHER, from_value: true, to_value: false, actor_id: admin.id });
    expect(await valueOf(ann, OTHER)).toBe(false);
    expect(await valueOf(bob, 'view_customers')).toBe(false);
  });

  it('answers a role save with how many people it reached and how many kept their own value', async () => {
    const { org, admin, role, ann, bob } = await roleWithTwoPeople();
    const cat = await fx.addUser(org, 'cat', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const api = await fx.signedInAs(admin);
    const roleValue = findSwitch(FLIP)!.presets.DISPATCHER as boolean;
    await api.put(`/api/users/${bob.id}/permissions`, { values: { [FLIP]: !roleValue } });

    const res = await api.put(`/api/roles/${role.key}/permissions`, { values: { [FLIP]: !roleValue, [OTHER]: true } });
    expect(res.status).toBe(200);
    // Ann and Cat follow both switches. Bob's own Apply discounts now equals the role's, so it is dropped and he follows both
    // too (pre-PR review CR-7); a person who keeps a value that still differs is counted in permission-prepr-review-fixes-db.
    expect(res.body).toMatchObject({ reaches: 3, keep_own: 0 });
    expect(await valueOf(cat, OTHER)).toBe(true);
    expect(await valueOf(ann, OTHER)).toBe(true);

    // A save that changes nothing reaches nobody.
    const again = await api.put(`/api/roles/${role.key}/permissions`, { values: { [FLIP]: !roleValue } });
    expect(again.body).toMatchObject({ reaches: 0, keep_own: 0 });
  });

  describe('migration M3', () => {
    const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

    it('deletes each copy that equals the role\'s value, keeps a real override, writes no change-log line, and changes nobody\'s effective switches', async () => {
      const { org, admin, role, ann, bob } = await roleWithTwoPeople();
      // The role holds a stored value for one switch; the other falls back to the Dispatcher preset.
      await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [OTHER]: true }, actorId: null, reason: 'manual' });
      const presetFlip = findSwitch(FLIP)!.presets.DISPATCHER as boolean;
      const copy = (user: Person, key: string, value: boolean) =>
        db.permissionUserSwitch.create({ data: { organization_id: org, user_id: user.id, switch_key: key, value } });
      // Ann: two copies, one equal to the stored role row, one equal to the preset fallback.
      await copy(ann, OTHER, true);
      await copy(ann, FLIP, presetFlip);
      // Bob: a copy equal to the role and a real override.
      await copy(bob, OTHER, true);
      await copy(bob, FLIP, !presetFlip);
      // The Admin box holds no set: a stray row is left alone.
      await copy(admin, OTHER, true);
      const before = { ann: await valueOf(ann, FLIP), bob: await valueOf(bob, FLIP), annO: await valueOf(ann, OTHER), bobO: await valueOf(bob, OTHER) };

      await run();

      expect(await db.permissionUserSwitch.count({ where: { user_id: ann.id } })).toBe(0);
      expect((await db.permissionUserSwitch.findMany({ where: { user_id: bob.id } })).map((r) => r.switch_key)).toEqual([FLIP]);
      expect(await db.permissionUserSwitch.count({ where: { user_id: admin.id } })).toBe(1);
      const { clearSwitchCacheForOrg } = await import('../lib/permissions/switches/store.js');
      clearSwitchCacheForOrg(org);
      expect({ ann: await valueOf(ann, FLIP), bob: await valueOf(bob, FLIP), annO: await valueOf(ann, OTHER), bobO: await valueOf(bob, OTHER) }).toEqual(before);

      // Nobody's access changed, so the person's Change log gains no line: dropping a copy that equals the role is not
      // history, and the log is append-only from M14, so a noise line could never be removed again.
      expect(await readChangeLog({ organizationId: org, targetType: 'USER', targetId: ann.id })).toEqual([]);
      expect(await readChangeLog({ organizationId: org, targetType: 'USER', targetId: bob.id })).toEqual([]);
      expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(0);
      // Specifically no 'X -> X' line, for any reason.
      const sameValueLines = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM permission_change_log
        WHERE organization_id = ${org}::uuid AND target_type = 'USER' AND from_value IS NOT DISTINCT FROM to_value`;
      expect(Number(sameValueLines[0].n)).toBe(0);

      // A second run changes nothing and still logs nothing.
      await run();
      expect(await db.permissionUserSwitch.count({ where: { user_id: bob.id } })).toBe(1);
      expect(await db.permissionChangeLog.count({ where: { organization_id: org, target_type: 'USER' } })).toBe(0);
    });
  });
});

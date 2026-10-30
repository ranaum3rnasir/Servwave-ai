/* =============================================================================
   Roles & Permissions security, AL-18 (ticket 28), migration M13: the five user and role switches retire.

   Create users, Invite users, Edit users, Delete users and Manage roles and permissions are gone from the catalog, so the
   catalog validation refuses their keys on every write, and migration 20261028130000 deletes their stored rows from both
   switch tables (role values and person overrides), logging each. Run against real rows the way the deploy runs it, and
   through the API as an Admin for the refusal. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
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

import { switchFixture } from './permission-switches-fixture';
import { findSwitch } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const suite = realClient ? describe : describe.skip;
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028130000_retire_user_role_switches', 'migration.sql');
// The five switches ruling 10 (2026-10-27) retires: user and role management is the Admin flag's alone.
const RETIRED = ['create_users', 'invite_users', 'edit_users', 'delete_users', 'manage_roles_and_permissions'];

suite('migration M13: the five user and role switches retire (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('deletes the five keys from roles and people, leaves every other row alone, logs each deletion, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'managers', 'DISPATCHER');
    const person = await fx.addUser(org, 'max', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });

    const roleRow = (role_key: string, switch_key: string, value: boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id: person.id, switch_key, value } });

    for (const key of RETIRED) await roleRow(role.key, key, true);
    await roleRow('SALES', 'edit_users', false);
    await roleRow(role.key, 'view_users', true);
    await roleRow(role.key, 'view_jobs', true);
    await userRow('manage_roles_and_permissions', true);
    await userRow('invite_users', true);
    await userRow('view_users', false);

    await run();

    for (const key of RETIRED) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
    }
    // View users stays (names in pickers and on records), and nothing else moved.
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'view_users' } }))?.value).toBe(true);
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'view_jobs' } }))?.value).toBe(true);
    expect((await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key: 'view_users' } }))?.value).toBe(false);

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}:${JSON.stringify(l.to_value)}`).sort()).toEqual(
      [
        ...RETIRED.map((k) => `ROLE:${role.key}:${k}:true:null`),
        'ROLE:SALES:edit_users:false:null',
        `USER:${person.id}:manage_roles_and_permissions:true:null`,
        `USER:${person.id}:invite_users:true:null`,
      ].sort(),
    );

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(log.length);
  });

  it('has the five gone from the catalog, so the validation refuses their keys and a write naming one is refused', async () => {
    for (const key of RETIRED) {
      expect(findSwitch(key), key).toBeUndefined();
      expect(validateSwitchSet({ [key]: true }).map((v) => v.switchKey), key).toEqual([key]);
    }
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'writers', 'TECHNICIAN');
    const person = await fx.addUser(org, 'wes', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: role.key });
    for (const key of RETIRED) {
      const onRole = await (await fx.signedInAs(admin)).put(`/api/roles/${role.key}/permissions`, { values: { [key]: true } });
      expect(onRole.status, key).toBe(400);
      const onPerson = await (await fx.signedInAs(admin)).put(`/api/users/${person.id}/permissions`, { values: { [key]: true } });
      expect(onPerson.status, key).toBe(400);
    }
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: { in: RETIRED } } })).toBe(0);
    expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: { in: RETIRED } } })).toBe(0);
  });
});

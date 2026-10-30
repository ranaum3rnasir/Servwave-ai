/* =============================================================================
   Roles & Permissions security, ticket 36b, migration M17: the Company settings switch retires.

   `company_settings` is gone from the catalog, so the catalog validation refuses its key on every write, and migration
   20261029120000 deletes its stored rows from both switch tables (role values and person overrides), logging each and touching no
   other key. Run against real rows the way the deploy runs it, and through the API as an Admin for the refusal. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261029120000_retire_company_settings_switch', 'migration.sql');
const RETIRED = 'company_settings';

suite('migration M17: the Company settings switch retires (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('deletes the key from roles and people in every company, leaves every other row alone, logs each deletion, and is a no-op the second time', async () => {
    const one = await fx.newOrg();
    const two = await fx.newOrg();
    const role = await fx.addCustomRole(one.org, 'managers', 'DISPATCHER');
    const other = await fx.addCustomRole(two.org, 'helpers', 'TECHNICIAN');
    const person = await fx.addUser(one.org, 'max', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const helper = await fx.addUser(two.org, 'hal', 'TECHNICIAN', { customRoleId: other.id, basedOnRoleKey: other.key });

    const roleRow = (org: string, role_key: string, switch_key: string, value: boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (org: string, user_id: string, switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id, switch_key, value } });

    await roleRow(one.org, role.key, RETIRED, true);
    await roleRow(one.org, 'SALES', RETIRED, false);
    await roleRow(two.org, other.key, RETIRED, true);
    await roleRow(one.org, role.key, 'view_jobs', true);
    await roleRow(one.org, role.key, 'manage_payout_account', true);
    await userRow(one.org, person.id, RETIRED, true);
    await userRow(two.org, helper.id, RETIRED, false);
    await userRow(one.org, person.id, 'view_users', false);

    await run();

    for (const org of [one.org, two.org]) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: RETIRED } }), org).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: RETIRED } }), org).toBe(0);
    }
    // Nothing else moved: not the neighbouring payments switch, not the others.
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: one.org, role_key: role.key, switch_key: 'manage_payout_account' } }))?.value).toBe(true);
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: one.org, role_key: role.key, switch_key: 'view_jobs' } }))?.value).toBe(true);
    expect((await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key: 'view_users' } }))?.value).toBe(false);

    const log = async (org: string) => (await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } }))
      .map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}:${JSON.stringify(l.to_value)}`).sort();
    expect(await log(one.org)).toEqual([
      `ROLE:${role.key}:${RETIRED}:true:null`, `ROLE:SALES:${RETIRED}:false:null`, `USER:${person.id}:${RETIRED}:true:null`,
    ].sort());
    expect(await log(two.org)).toEqual([`ROLE:${other.key}:${RETIRED}:true:null`, `USER:${helper.id}:${RETIRED}:false:null`].sort());

    await run();
    expect(await log(one.org)).toHaveLength(3);
    expect(await log(two.org)).toHaveLength(2);
  });

  it('has the switch gone from the catalog, so the validation refuses its key and a write naming it is refused', async () => {
    expect(findSwitch(RETIRED)).toBeUndefined();
    expect(validateSwitchSet({ [RETIRED]: true }).map((v) => v.switchKey)).toEqual([RETIRED]);
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'writers', 'TECHNICIAN');
    const person = await fx.addUser(org, 'wes', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: role.key });
    const onRole = await (await fx.signedInAs(admin)).put(`/api/roles/${role.key}/permissions`, { values: { [RETIRED]: true } });
    expect(onRole.status).toBe(400);
    const onPerson = await (await fx.signedInAs(admin)).put(`/api/users/${person.id}/permissions`, { values: { [RETIRED]: true } });
    expect(onPerson.status).toBe(400);
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: RETIRED } })).toBe(0);
    expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: RETIRED } })).toBe(0);
  });

  it('is not offered by the switch list the role editor reads', async () => {
    const { admin } = await fx.newOrg();
    const res = await (await fx.signedInAs(admin)).get('/api/permission-switches/catalog');
    expect(res.status).toBe(200);
    const keys = JSON.stringify(res.body);
    expect(keys).not.toContain('"company_settings"');
  });
});

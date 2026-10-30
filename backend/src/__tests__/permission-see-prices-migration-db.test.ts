/* =============================================================================
   Roles & Permissions alignment, AL-05 (M4): migration 20261028100400 puts See prices on every stored role, so the new
   money chain has a root that keeps today's behaviour (a price follows the record), and renames See financial data to See
   costs in both switch tables and the change log. Run against real rows the way the deploy runs it. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
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

const suite = realClient ? describe : describe.skip;
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100400_permission_see_prices_root', 'migration.sql');

suite('migration M4: See prices is the root (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  // The file is re-run on a database migrated past M14, which makes the switch history append-only. A deploy runs this file
  // BEFORE M14, so the re-run switches the history's two rules off for its own transaction only (DDL is transactional: no other
  // session ever sees them off), and puts them back, ALWAYS, before it commits.
  const run = () => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE permission_change_log DISABLE TRIGGER permission_change_log_append_only');
    await tx.$executeRawUnsafe('ALTER TABLE permission_change_log DISABLE TRIGGER permission_change_log_delete_with_company');
    await tx.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));
    await tx.$executeRawUnsafe('ALTER TABLE permission_change_log ENABLE ALWAYS TRIGGER permission_change_log_append_only');
    await tx.$executeRawUnsafe('ALTER TABLE permission_change_log ENABLE ALWAYS TRIGGER permission_change_log_delete_with_company');
  }, { timeout: 60_000 });

  const roleRow = (organization_id: string, role_key: string, switch_key: string, value: boolean) =>
    db.permissionRoleSwitch.create({ data: { organization_id, role_key, switch_key, value } });

  it('puts See prices on every stored role that lacks it, logs each, leaves a stored value alone, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    // Roles that hold other rows but no See prices: a custom role and a stored built-in row.
    await roleRow(org, 'desk', 'view_estimates', true);
    await roleRow(org, 'desk', 'edit_estimates', true);
    await roleRow(org, 'SALES', 'view_jobs', true);
    // A role that already holds the row: on stays on, off stays off (a choice somebody made, never overwritten).
    await roleRow(org, 'kept-on', 'see_prices', true);
    await roleRow(org, 'kept-on', 'view_jobs', true);
    await roleRow(org, 'kept-off', 'see_prices', false);
    await roleRow(org, 'kept-off', 'view_jobs', true);

    await run();

    const value = async (role_key: string) =>
      (await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key, switch_key: 'see_prices' } }))?.value;
    expect(await value('desk')).toBe(true);
    expect(await value('SALES')).toBe(true);
    expect(await value('kept-on')).toBe(true);
    expect(await value('kept-off')).toBe(false);

    // One row per role that gained the switch, with the reason 'migration'; the two that already had it are not logged.
    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.to_value)}`).sort()).toEqual([
      'ROLE:SALES:see_prices:true',
      'ROLE:desk:see_prices:true',
    ]);

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(2);
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: 'see_prices' } })).toBe(4);
  });

  it('renames See financial data to See costs in both switch tables and the change log, keeps a row that already exists under the new key, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'cost-readers', 'DISPATCHER', { copyGrants: false });
    const plain = await fx.addUser(org, 'plain', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const both = await fx.addUser(org, 'both', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const userRow = (user_id: string, switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id, switch_key, value } });

    // A role holding the old key, one holding both (the new one wins), a person holding the old key, one holding both.
    await roleRow(org, role.key, 'see_financial_data', true);
    await roleRow(org, 'both-keys', 'see_financial_data', true);
    await roleRow(org, 'both-keys', 'see_costs', false);
    await userRow(plain.id, 'see_financial_data', false);
    await userRow(both.id, 'see_financial_data', true);
    await userRow(both.id, 'see_costs', false);
    await db.permissionChangeLog.create({
      data: { organization_id: org, target_type: 'ROLE', target_id: role.key, switch_key: 'see_financial_data', from_value: false, to_value: true, reason: 'manual' },
    });

    await run();

    const roleValue = async (role_key: string, switch_key: string) =>
      (await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key, switch_key } }))?.value;
    expect(await roleValue(role.key, 'see_costs')).toBe(true);
    expect(await roleValue(role.key, 'see_financial_data')).toBeUndefined();
    // The role that already had a See costs row keeps it, whatever the old row said.
    expect(await roleValue('both-keys', 'see_costs')).toBe(false);
    expect(await roleValue('both-keys', 'see_financial_data')).toBeUndefined();
    const userValue = async (user_id: string, switch_key: string) =>
      (await db.permissionUserSwitch.findFirst({ where: { user_id, switch_key } }))?.value;
    expect(await userValue(plain.id, 'see_costs')).toBe(false);
    expect(await userValue(plain.id, 'see_financial_data')).toBeUndefined();
    expect(await userValue(both.id, 'see_costs')).toBe(false);
    expect(await userValue(both.id, 'see_financial_data')).toBeUndefined();
    // The history reads under the new name, and nothing is left under the old one.
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, switch_key: 'see_financial_data' } })).toBe(0);
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, target_id: role.key, switch_key: 'see_costs' } })).toBe(1);
    // A role that holds See costs also holds its root (part 1 ran first).
    expect(await roleValue(role.key, 'see_prices')).toBe(true);

    const before = await db.permissionRoleSwitch.count({ where: { organization_id: org } });
    await run();
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org } })).toBe(before);
    expect(await roleValue(role.key, 'see_costs')).toBe(true);
  });

  it('is scoped to the roles that exist: a company with no stored role gets no row', async () => {
    const { org } = await fx.newOrg();
    await run();
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org } })).toBe(0);
  });
});

/* =============================================================================
   Roles & Permissions alignment, AL-08 (M9a): migration 20261028100500 turns the four See-all toggles into each module's
   scope switch and Communication scope's "Linked to me" into Attached. Run against real rows the way the deploy runs it.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100500_permission_reach_toggles_become_scope', 'migration.sql');

suite('migration: reach toggles become scope switches (real database)', () => {
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

  it('renames each toggle to its scope switch with off -> Attached and on -> All, maps Linked to me to Attached, logs no change (no one\'s access changed), rewrites the history, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'field-office', 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, 'pat', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });

    const roleRow = (role_key: string, switch_key: string, value: unknown) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value: value as never } });
    const userRow = (user_id: string, switch_key: string, value: unknown) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id, switch_key, value: value as never } });

    await roleRow(role.key, 'see_all_tasks', true);
    await roleRow(role.key, 'see_all_calendar_entries', false);
    await roleRow(role.key, 'see_all_assets', true);
    await roleRow(role.key, 'see_everyones_timesheets', false);
    await roleRow(role.key, 'communication_scope', 'linked_to_me');
    await roleRow('TECHNICIAN', 'communication_scope', 'all');
    await userRow(person.id, 'see_all_tasks', false);
    await userRow(person.id, 'communication_scope', 'linked_to_me');
    // History written before the migration: a manual edit of the old toggle by someone.
    await db.permissionChangeLog.create({
      data: { organization_id: org, target_type: 'ROLE', target_id: role.key, switch_key: 'see_all_tasks', from_value: false, to_value: true, reason: 'manual' },
    });
    await db.permissionChangeLog.create({
      data: { organization_id: org, target_type: 'ROLE', target_id: role.key, switch_key: 'communication_scope', from_value: 'all', to_value: 'linked_to_me', reason: 'manual' },
    });

    await run();

    const role_ = async (role_key: string, switch_key: string) =>
      (await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key, switch_key } }))?.value;
    expect(await role_(role.key, 'tasks_scope')).toBe('all');
    expect(await role_(role.key, 'events_scope')).toBe('attached');
    expect(await role_(role.key, 'assets_scope')).toBe('all');
    expect(await role_(role.key, 'timesheets_scope')).toBe('attached');
    expect(await role_(role.key, 'communication_scope')).toBe('attached');
    expect(await role_('TECHNICIAN', 'communication_scope')).toBe('all');
    for (const old of ['see_all_tasks', 'see_all_calendar_entries', 'see_all_assets', 'see_everyones_timesheets']) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: old } }), old).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: old } }), old).toBe(0);
    }
    const own = async (switch_key: string) => (await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key } }))?.value;
    expect(await own('tasks_scope')).toBe('attached');
    expect(await own('communication_scope')).toBe('attached');

    // Nobody's access changed (off was Attached, on was All, Linked to me is Attached), so the rename writes no change-log row:
    // a row would read "Tasks scope: Off -> All" for a change that never happened (pre-PR review CR-19). 100400 logs its own
    // rename the same way: not at all.
    const migrated = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(migrated.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}>${JSON.stringify(l.to_value)}`)).toEqual([]);
    // No row anywhere in the log puts a true/false on a choice switch.
    const onChoice = await db.permissionChangeLog.findMany({
      where: { organization_id: org, switch_key: { in: ['tasks_scope', 'events_scope', 'assets_scope', 'timesheets_scope', 'communication_scope'] } },
    });
    for (const l of onChoice) {
      expect(typeof l.from_value, JSON.stringify(l)).toBe('string');
      expect(typeof l.to_value, JSON.stringify(l)).toBe('string');
    }

    // The history already in the log reads under the new key and value.
    const manual = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'manual' } });
    expect(manual.map((l) => `${l.switch_key}:${JSON.stringify(l.from_value)}>${JSON.stringify(l.to_value)}`).sort()).toEqual(
      [`tasks_scope:"attached">"all"`, `communication_scope:"all">"attached"`].sort(),
    );

    // A second run changes nothing.
    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(0);
    expect(await role_(role.key, 'tasks_scope')).toBe('all');
  });
});

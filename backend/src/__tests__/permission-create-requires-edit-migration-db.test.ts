/* =============================================================================
   Roles & Permissions alignment, AL-04 (M7 and M8): migration 20261028100300 turns Edit on wherever a stored role or a
   person has Create on and Edit off, and moves the built-in rows that still equal the old preset. Run against real rows
   the way the deploy runs it. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100300_permission_create_requires_edit', 'migration.sql');

suite('migration: Create requires Edit (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('turns Edit on for a role and a person that hold Create without it, moves the untouched built-in rows, logs each change, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'creators', 'DISPATCHER', { copyGrants: false });
    const follower = await fx.addUser(org, 'follower', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const roleOff = await fx.addUser(org, 'roleoff', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const ownCreate = await fx.addUser(org, 'owncreate', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    const role2 = await fx.addCustomRole(org, 'plain', 'DISPATCHER', { copyGrants: false });
    const plain = await fx.addUser(org, 'plain', 'DISPATCHER', { customRoleId: role2.id, basedOnRoleKey: role2.key });

    const roleRow = (role_key: string, switch_key: string, value: boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (user_id: string, switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id, switch_key, value } });

    // Role "creators": Create leads on, Edit leads off. Create jobs on, Edit jobs on (fine).
    await roleRow(role.key, 'create_leads', true);
    await roleRow(role.key, 'edit_leads', false);
    await roleRow(role.key, 'create_jobs', true);
    await roleRow(role.key, 'edit_jobs', true);
    // A person on "creators" who turned Edit jobs off by hand: the role's Edit is on, so their "off" is dropped.
    await userRow(roleOff.id, 'edit_jobs', false);
    // Role "plain": Create estimates off, Edit estimates off. A person turns Create estimates on by hand: Edit goes on with it.
    await roleRow(role2.key, 'create_estimates', false);
    await roleRow(role2.key, 'edit_estimates', false);
    await userRow(ownCreate.id, 'create_estimates', true);
    // (ownCreate sits on role "creators", so give that role the estimates rows too, off.)
    await roleRow(role.key, 'create_estimates', false);
    await roleRow(role.key, 'edit_estimates', false);
    // The built-in rows of this company: Technician still at the old preset, Dispatcher Send payment links changed by hand.
    await roleRow('TECHNICIAN', 'record_payments', true);
    await roleRow('TECHNICIAN', 'send_payment_links', true);
    await roleRow('TECHNICIAN', 'edit_jobs', false);
    await roleRow('DISPATCHER', 'edit_customers', false);

    await run();

    const value = async (role_key: string, switch_key: string) =>
      (await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key, switch_key } }))?.value;
    expect(await value(role.key, 'edit_leads')).toBe(true);
    expect(await value(role.key, 'edit_jobs')).toBe(true);
    expect(await db.permissionUserSwitch.count({ where: { user_id: roleOff.id } })).toBe(0);
    const added = await db.permissionUserSwitch.findFirst({ where: { user_id: ownCreate.id, switch_key: 'edit_estimates' } });
    expect(added?.value).toBe(true);
    expect(await value('TECHNICIAN', 'record_payments')).toBe(false);
    expect(await value('TECHNICIAN', 'send_payment_links')).toBe(false);
    expect(await value('TECHNICIAN', 'edit_jobs')).toBe(true); // Create jobs is on in the Technician preset, so M7 turns it on (logged once); M8 then finds nothing left to move
    expect(await value('DISPATCHER', 'edit_customers')).toBe(true);
    expect(follower.id && plain.id).toBeTruthy();

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    const entries = log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}`).sort();
    expect(entries).toEqual([
      `ROLE:DISPATCHER:edit_customers`,
      `ROLE:TECHNICIAN:edit_jobs`,
      `ROLE:TECHNICIAN:record_payments`,
      `ROLE:TECHNICIAN:send_payment_links`,
      `ROLE:${role.key}:edit_leads`,
      `USER:${ownCreate.id}:edit_estimates`,
      `USER:${roleOff.id}:edit_jobs`,
    ].sort());

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(entries.length);
  });

  // Pre-PR review CR-8: an Edit that is off only in the preset (no stored row says so) is still off. 100000 deleted every person
  // row equal to the role or its preset, and a role made from a base stores nothing, so the pair is often half stored.
  it('turns Edit on where the Edit "off" lives only in the preset: a person\'s own Create on, and a role\'s stored Create on', async () => {
    const { org } = await fx.newOrg();
    // A Sales person with their own Create jobs on. Sales has Create jobs and Edit jobs off in its preset; no stored row says so.
    const salesRole = await fx.addCustomRole(org, 'sales-like', 'SALES', { copyGrants: false });
    const seller = await fx.addUser(org, 'seller', 'SALES', { customRoleId: salesRole.id, basedOnRoleKey: salesRole.key });
    await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: seller.id, switch_key: 'create_jobs', value: true } });
    // A person on the built-in Sales role itself (no custom role), with their own Create invoices on.
    const plainSeller = await fx.addUser(org, 'plainseller', 'SALES');
    await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: plainSeller.id, switch_key: 'create_invoices', value: true } });
    // A role made from Sales that stores only Create events on (Edit events off in the Sales preset).
    const eventsRole = await fx.addCustomRole(org, 'events-maker', 'SALES', { copyGrants: false });
    await db.permissionRoleSwitch.create({ data: { organization_id: org, role_key: eventsRole.key, switch_key: 'create_events', value: true } });
    const follower = await fx.addUser(org, 'eventsfollower', 'SALES', { customRoleId: eventsRole.id, basedOnRoleKey: eventsRole.key });
    // Nothing to do: Sales has Edit leads on in its preset, so a person's own Create leads is already fine.
    const fine = await fx.addUser(org, 'fine', 'SALES', { customRoleId: salesRole.id, basedOnRoleKey: salesRole.key });
    await db.permissionUserSwitch.create({ data: { organization_id: org, user_id: fine.id, switch_key: 'create_leads', value: true } });

    await run();

    const own = async (user_id: string, switch_key: string) =>
      (await db.permissionUserSwitch.findFirst({ where: { user_id, switch_key } }))?.value;
    const roleValue = async (role_key: string, switch_key: string) =>
      (await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key, switch_key } }))?.value;
    expect(await own(seller.id, 'edit_jobs')).toBe(true);
    expect(await own(plainSeller.id, 'edit_invoices')).toBe(true);
    expect(await roleValue(eventsRole.key, 'edit_events')).toBe(true);
    // The role carries it now, so its follower needs no row of their own.
    expect(await own(follower.id, 'edit_events')).toBeUndefined();
    expect(await own(fine.id, 'edit_leads')).toBeUndefined();

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}>${JSON.stringify(l.to_value)}`).sort()).toEqual([
      `ROLE:${eventsRole.key}:edit_events:false>true`,
      `USER:${plainSeller.id}:edit_invoices:false>true`,
      `USER:${seller.id}:edit_jobs:false>true`,
    ].sort());

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(3);
  });
});

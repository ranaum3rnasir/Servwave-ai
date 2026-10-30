/* =============================================================================
   Roles & Permissions alignment, AL-10 (M9b): migration 20261028100700 deletes the stored rows of the fifteen Show-page switches
   and the Phone usage bar from both switch tables, logging each. Run against real rows the way the deploy
   runs it. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100700_permission_display_switches_retire', 'migration.sql');
const RETIRED = [
  'show_customers_page', 'show_leads_page', 'show_jobs_page', 'show_estimates_page', 'show_invoices_page', 'show_payments_page',
  'show_service_plans_page', 'show_automations_page', 'show_tasks_page', 'show_users_teams_page', 'show_stock_page',
  'show_purchase_orders_page', 'show_vendors_page', 'show_logistic_orders_page', 'show_price_book_page', 'phone_usage_bar',
];

suite('migration: display-only switches retire (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('deletes the sixteen keys from roles and people, leaves every other row alone, logs each deletion, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'pagers', 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, 'pia', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });

    const roleRow = (role_key: string, switch_key: string, value: boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id: person.id, switch_key, value } });

    for (const key of RETIRED) await roleRow(role.key, key, key !== 'show_vendors_page');
    await roleRow('TECHNICIAN', 'show_jobs_page', false);
    await roleRow(role.key, 'view_jobs', true);
    await userRow('show_leads_page', true);
    await userRow('phone_usage_bar', false);
    await userRow('view_leads', false);

    await run();

    for (const key of RETIRED) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
    }
    // Nothing else moved.
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'view_jobs' } }))?.value).toBe(true);
    expect((await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key: 'view_leads' } }))?.value).toBe(false);

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}`).sort()).toEqual(
      [
        ...RETIRED.map((k) => `ROLE:${role.key}:${k}:${k !== 'show_vendors_page'}`),
        'ROLE:TECHNICIAN:show_jobs_page:false',
        `USER:${person.id}:show_leads_page:true`,
        `USER:${person.id}:phone_usage_bar:false`,
      ].sort(),
    );

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(log.length);
  });
});

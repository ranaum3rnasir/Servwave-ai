/* =============================================================================
   Roles & Permissions alignment, AL-06b (M6): migration 20261028101000 deletes the stored rows of the Estimates scope and the
   Invoices scope from both switch tables, logging each. Run against real rows the way the deploy runs it. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028101000_permission_document_scopes_retire', 'migration.sql');
const RETIRED = ['estimates_scope', 'invoices_scope'];

suite('migration: the Estimates scope and the Invoices scope retire (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('deletes the two keys from roles and people, leaves every other row alone, logs each deletion, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'scopers', 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, 'sam', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });

    const roleRow = (role_key: string, switch_key: string, value: string | boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (switch_key: string, value: string | boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id: person.id, switch_key, value } });

    await roleRow(role.key, 'estimates_scope', 'all');
    await roleRow(role.key, 'invoices_scope', 'attached');
    await roleRow('SALES', 'estimates_scope', 'through_own_leads');
    await roleRow(role.key, 'jobs_scope', 'team');
    await roleRow(role.key, 'view_estimates', true);
    await userRow('invoices_scope', 'all');
    await userRow('leads_scope', 'attached');

    await run();

    for (const key of RETIRED) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
    }
    // Nothing else moved: the Jobs and Leads scopes are what the documents follow now.
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'jobs_scope' } }))?.value).toBe('team');
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'view_estimates' } }))?.value).toBe(true);
    expect((await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key: 'leads_scope' } }))?.value).toBe('attached');

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}`).sort()).toEqual(
      [
        `ROLE:${role.key}:estimates_scope:"all"`,
        `ROLE:${role.key}:invoices_scope:"attached"`,
        'ROLE:SALES:estimates_scope:"through_own_leads"',
        `USER:${person.id}:invoices_scope:"all"`,
      ].sort(),
    );

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(log.length);
  });
});

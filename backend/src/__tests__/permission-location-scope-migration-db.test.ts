/* =============================================================================
   Roles & Permissions alignment, AL-02 (P6, M2): migration 20261028100100 rewrites a stored Location scope to Attached.
   Run against real rows the way the deploy runs it. Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100100_permission_drop_location_scope', 'migration.sql');

suite('migration: the Location scope becomes Attached (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('rewrites every stored location value on a role and on a person, leaves other values alone, logs each rewrite, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'wide', 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, 'lou', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });
    await db.permissionRoleSwitch.createMany({ data: [
      { organization_id: org, role_key: role.key, switch_key: 'jobs_scope', value: 'location' },
      { organization_id: org, role_key: role.key, switch_key: 'leads_scope', value: 'team' },
    ] });
    await db.permissionUserSwitch.createMany({ data: [
      { organization_id: org, user_id: person.id, switch_key: 'estimates_scope', value: 'location' },
      { organization_id: org, user_id: person.id, switch_key: 'invoices_scope', value: 'all' },
    ] });

    await run();

    const roleRows = Object.fromEntries((await db.permissionRoleSwitch.findMany({ where: { organization_id: org, role_key: role.key } })).map((r) => [r.switch_key, r.value]));
    expect(roleRows).toEqual({ jobs_scope: 'attached', leads_scope: 'team' });
    const userRows = Object.fromEntries((await db.permissionUserSwitch.findMany({ where: { user_id: person.id } })).map((r) => [r.switch_key, r.value]));
    expect(userRows).toEqual({ estimates_scope: 'attached', invoices_scope: 'all' });
    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.switch_key}:${l.from_value}>${l.to_value}`).sort()).toEqual([
      `ROLE:jobs_scope:location>attached`, `USER:estimates_scope:location>attached`,
    ].sort());

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(2);
  });
});

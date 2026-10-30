/* =============================================================================
   Roles & Permissions alignment, AL-07 (M5): migration 20261028100600 deletes the stored rows of the four attachment
   switches and Delete other people's notes from both switch tables, logging each. Run against real rows the way the deploy
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
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100600_permission_attachments_notes_with_record', 'migration.sql');
const RETIRED = ['view_attachments', 'upload_attachments', 'edit_attachments', 'delete_attachments', 'delete_others_notes'];

suite('migration: attachments and notes come with the record (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  it('deletes the five keys from roles and people, leaves every other row alone, logs each deletion, and is a no-op the second time', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'filers', 'DISPATCHER', { copyGrants: false });
    const person = await fx.addUser(org, 'fran', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: role.key });

    const roleRow = (role_key: string, switch_key: string, value: boolean) =>
      db.permissionRoleSwitch.create({ data: { organization_id: org, role_key, switch_key, value } });
    const userRow = (switch_key: string, value: boolean) =>
      db.permissionUserSwitch.create({ data: { organization_id: org, user_id: person.id, switch_key, value } });

    for (const key of RETIRED) await roleRow(role.key, key, key !== 'delete_attachments');
    await roleRow('TECHNICIAN', 'edit_attachments', false);
    await roleRow(role.key, 'add_notes', true);
    await userRow('delete_attachments', true);
    await userRow('delete_others_notes', false);
    await userRow('add_notes', false);

    await run();

    for (const key of RETIRED) {
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
      expect(await db.permissionUserSwitch.count({ where: { organization_id: org, switch_key: key } }), key).toBe(0);
    }
    // Nothing else moved.
    expect((await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'add_notes' } }))?.value).toBe(true);
    expect((await db.permissionUserSwitch.findFirst({ where: { user_id: person.id, switch_key: 'add_notes' } }))?.value).toBe(false);

    const log = await db.permissionChangeLog.findMany({ where: { organization_id: org, reason: 'migration' } });
    expect(log.map((l) => `${l.target_type}:${l.target_id}:${l.switch_key}:${JSON.stringify(l.from_value)}`).sort()).toEqual(
      [
        ...RETIRED.map((k) => `ROLE:${role.key}:${k}:${k !== 'delete_attachments'}`),
        'ROLE:TECHNICIAN:edit_attachments:false',
        `USER:${person.id}:delete_attachments:true`,
        `USER:${person.id}:delete_others_notes:false`,
      ].sort(),
    );

    await run();
    expect(await db.permissionChangeLog.count({ where: { organization_id: org, reason: 'migration' } })).toBe(log.length);
  });
});

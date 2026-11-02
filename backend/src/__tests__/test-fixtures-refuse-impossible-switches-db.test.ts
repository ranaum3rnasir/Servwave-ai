/* =============================================================================
   The real-database switch fixture refuses a role the product cannot hold: a switch on while a switch it Requires is off.
   `setRoleSwitches` already refused a set whose own values broke the rule; it now checks the role's WHOLE set after the
   write (preset and stored values with the new ones laid over them), so a root turned off with a dependant left on by the
   preset is refused too. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { withDependantsOff } from './support/switchDependants';

const suite = realClient ? describe : describe.skip;

suite('setRoleSwitches refuses an impossible role (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  it('See prices off on a Sales-based role whose preset keeps See costs on throws, naming both, and stores nothing', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'priceblind', 'SALES');
    await expect(fx.setRoleSwitches(org, role.key, { see_prices: false })).rejects.toThrow(
      /See costs \(see_costs\) needs See prices \(see_prices\)/,
    );
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: role.key } })).toBe(0);
  });

  it('See prices off with its dependants is stored', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'priceblind', 'SALES');
    await fx.setRoleSwitches(org, role.key, withDependantsOff(['see_prices']));
    const row = await db.permissionRoleSwitch.findFirst({ where: { organization_id: org, role_key: role.key, switch_key: 'see_costs' } });
    expect(row?.value).toBe(false);
  });

  it('a value laid over an earlier call is checked against what the role already holds', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'blank', 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, role.key, { see_prices: true, see_costs: true });
    // `{ see_prices: false }` alone breaks no rule; the role it leaves behind does (See costs is still stored on).
    await expect(fx.setRoleSwitches(org, role.key, { see_prices: false })).rejects.toThrow(/See costs.*See prices/);
  });

  it('the named opt-out stores the impossible set, and needs a reason', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'odd', 'SALES');
    await fx.setRoleSwitches(org, role.key, { see_prices: false }, { impossibleOnPurpose: 'a role stored before the rule existed' });
    expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: role.key } })).toBe(1);
    await expect(fx.setRoleSwitches(org, role.key, { see_prices: false }, { impossibleOnPurpose: '' })).rejects.toThrow(/reason/);
  });
});

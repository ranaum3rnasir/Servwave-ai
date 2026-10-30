/* =============================================================================
   Roles & Permissions, PRD 2, slice S02.13 - the users list names each person's role and counts the switches that
   differ from it, for the Users & Teams role column ("<role> · N changes").

   Everything goes through the public interface: the users list route and the user update route, called as the
   company's Admin. Expected labels are the role names a person sees; the number of changes is the number of switches
   the test itself wrote. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { setPersonSwitchValues, setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchEntry } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Toggles the preset of this role holds off, that need nothing else and that nothing else needs: safe to flip on. */
const flippable = (role: Role, count: number): SwitchEntry[] => {
  const needed = new Set(SWITCH_CATALOG.flatMap((s) => [...s.requires, ...(s.requiresAny ?? [])]));
  return SWITCH_CATALOG.filter(
    (s) => s.kind === 'toggle' && s.presets[role] === false && s.requires.length === 0 && !s.requiresAny && !needed.has(s.key),
  ).slice(0, count);
};

suite('the users list names the role and counts the changes (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Row = { id: string; role_label: string; change_count: number; admin_box: boolean };
  let sequence = 0;

  /** The users list as the company's Admin reads it, keyed by person. */
  async function listAs(admin: { id: string; email: string }): Promise<Map<string, Row>> {
    const res = await (await fx.signedInAs(admin)).get('/api/users');
    expect(res.status).toBe(200);
    return new Map((res.body.users as Row[]).map((u) => [u.id, u]));
  }

  it('reads a built-in role by its name with no changes for a person who holds the preset', async () => {
    const { org, admin } = await fx.newOrg();
    const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
    const tech = await fx.addUser(org, `tech${++sequence}`, 'TECHNICIAN');
    const rows = await listAs(admin);
    expect(rows.get(sales.id)).toMatchObject({ role_label: 'Sales', change_count: 0 });
    expect(rows.get(tech.id)).toMatchObject({ role_label: 'Technician', change_count: 0 });
    expect(rows.get(admin.id)).toMatchObject({ role_label: 'Admin', change_count: 0 });
  });

  it("counts the switches that differ from the person's role, and none that the person holds the same", async () => {
    const { org, admin } = await fx.newOrg();
    const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
    const flips = flippable('SALES', 3);
    expect(flips.length).toBe(3);
    await setPersonSwitchValues({
      organizationId: org, userId: sales.id, values: Object.fromEntries(flips.map((s) => [s.key, true])), actorId: admin.id,
    });
    expect((await listAs(admin)).get(sales.id)).toMatchObject({ role_label: 'Sales', change_count: 3 });

    // Putting one back to the role's value leaves two.
    await setPersonSwitchValues({ organizationId: org, userId: sales.id, values: { [flips[0]!.key]: false }, actorId: admin.id });
    expect((await listAs(admin)).get(sales.id)).toMatchObject({ change_count: 2 });
  });

  it('reads a custom role by its name, and counts against that role, not against its built-in base', async () => {
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, `front-desk-${++sequence}`, 'SALES');
    await db.customRole.update({ where: { id: role.id }, data: { label: 'Front desk' } });
    const [one] = flippable('SALES', 1);
    // The role itself holds one switch the Sales preset does not; a person given the role holds it too, so no change.
    await setRoleSwitchValues({ organizationId: org, roleKey: role.key, values: { [one!.key]: true }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `fd${++sequence}`, 'SALES', { customRoleId: role.id, basedOnRoleKey: role.key });
    expect((await listAs(admin)).get(person.id)).toMatchObject({ role_label: 'Front desk', change_count: 0 });
  });

  it('puts the person on the new role with no changes after a role change through the user update', async () => {
    const { org, admin } = await fx.newOrg();
    const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
    const [one] = flippable('SALES', 1);
    await setPersonSwitchValues({ organizationId: org, userId: sales.id, values: { [one!.key]: true }, actorId: admin.id });
    expect((await listAs(admin)).get(sales.id)?.change_count).toBe(1);

    const res = await (await fx.signedInAs(admin)).patch(`/api/users/${sales.id}`, { role: 'DISPATCHER', custom_role_id: null });
    expect(res.status).toBe(200);
    expect((await listAs(admin)).get(sales.id)).toMatchObject({ role_label: 'Dispatcher', change_count: 0 });
  });

  it('says who is in the Admin box: base role Admin and no custom role, not a role copied from Admin', async () => {
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, `admin-copy-${++sequence}`, 'ADMIN');
    const copy = await fx.addUser(org, `copy${++sequence}`, 'ADMIN', { customRoleId: role.id, basedOnRoleKey: role.key });
    const sales = await fx.addUser(org, `sales${++sequence}`, 'SALES');
    const rows = await listAs(admin);
    expect(rows.get(admin.id)?.admin_box).toBe(true);
    expect(rows.get(copy.id)?.admin_box).toBe(false);
    expect(rows.get(sales.id)?.admin_box).toBe(false);
  });
});

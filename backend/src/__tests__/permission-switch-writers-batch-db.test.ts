/* =============================================================================
   #3245: storing a set of permission switches takes a bounded number of database round trips, however many switches are
   in the set. A role save, a person save and the test fixture's role writer each send the same statements for one
   switch, for ten and for every switch the catalog holds.

   The count is the number of statements the real client sends (support/query-counter.ts), read through the writers'
   public functions. Real migrated database (TEST_DATABASE_URL); skips when it is unset. Every org it creates is removed
   again.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  // Built with the query-event log, so the query counter can count it.
  return { realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { countQueries } from './support/query-counter';
import { presetValues, setRoleSwitchValues, setPersonSwitchValues } from '../lib/permissions/switches/store';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import type { SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** The first `size` switches of the Administrator preset that can be stored together (every one it needs is in the set too). */
function setOf(size: number): Record<string, SwitchValue> {
  const everything = presetValues('ADMIN');
  if (size === Infinity) return everything;
  const chosen: Record<string, SwitchValue> = {};
  for (const key of Object.keys(everything)) {
    if (Object.keys(chosen).length >= size) break;
    if (validateSwitchSet({ ...chosen, [key]: everything[key]! }).length === 0) chosen[key] = everything[key]!;
  }
  return chosen;
}

const SIZES = [
  { label: '1 switch', size: 1 },
  { label: '10 switches', size: 10 },
  { label: 'every switch', size: Infinity },
];

suite('storing switches takes a bounded number of round trips (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(async () => {
    await fx.cleanup();
  });

  let sequence = 0;
  /** A fresh role made from blank (nothing stored, everything off), so every switch of the set is a change. */
  async function blankRole() {
    const { org } = await fx.newOrg();
    const key = `batch-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER', { madeFromBlank: true });
    return { org, key, role };
  }

  /** How many statements `write` sends for each size of set, each on a role (and person) of its own. */
  async function statementsPerSize(
    write: (ctx: Awaited<ReturnType<typeof blankRole>> & { person: string }, values: Record<string, SwitchValue>) => Promise<unknown>,
  ) {
    const counts: Record<string, number> = {};
    for (const { label, size } of SIZES) {
      const ctx = await blankRole();
      const person = await fx.addUser(ctx.org, `batch${sequence}`, 'DISPATCHER', { customRoleId: ctx.role.id, basedOnRoleKey: ctx.key });
      counts[label] = (await countQueries(() => write({ ...ctx, person: person.id }, setOf(size)), db)).count;
    }
    return counts;
  }

  const sameForEverySize = (counts: Record<string, number>) => {
    expect(counts['10 switches']).toBe(counts['1 switch']);
    expect(counts['every switch']).toBe(counts['1 switch']);
  };

  it('the set used for "every switch" holds more than ten switches, and the 10-set holds ten', () => {
    expect(Object.keys(setOf(10))).toHaveLength(10);
    expect(Object.keys(setOf(Infinity)).length).toBeGreaterThan(100);
  });

  it('a role save (setRoleSwitchValues) sends the same number of statements for 1, 10 and every switch', async () => {
    sameForEverySize(
      await statementsPerSize((c, values) => setRoleSwitchValues({ organizationId: c.org, roleKey: c.key, values, actorId: null, reason: 'manual' })),
    );
  });

  it('a person save (setPersonSwitchValues) sends the same number of statements for 1, 10 and every switch', async () => {
    sameForEverySize(
      await statementsPerSize((c, values) => setPersonSwitchValues({ organizationId: c.org, userId: c.person, values, actorId: null })),
    );
  });

  it('the fixture (setRoleSwitches) sends the same number of statements for 1, 10 and every switch', async () => {
    sameForEverySize(await statementsPerSize((c, values) => fx.setRoleSwitches(c.org, c.key, values)));
  });

  it('a second save of a role changes the stored value in place: same row, same created_at, a later updated_at', async () => {
    const { org, key } = await blankRole();
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { view_stock: true }, actorId: null, reason: 'manual' });
    const first = await db.permissionRoleSwitch.findFirstOrThrow({ where: { organization_id: org, role_key: key, switch_key: 'view_stock' } });
    await new Promise((r) => setTimeout(r, 20));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { view_stock: false }, actorId: null, reason: 'manual' });
    const rows = await db.permissionRoleSwitch.findMany({ where: { organization_id: org, role_key: key, switch_key: 'view_stock' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.value).toBe(false);
    expect(rows[0]!.created_at).toEqual(first.created_at);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
  });

  it('a person save stores their own value, keeps it on a second save, and drops it when it matches the role', async () => {
    const ctx = await blankRole();
    const person = await fx.addUser(ctx.org, 'own', 'DISPATCHER', { customRoleId: ctx.role.id, basedOnRoleKey: ctx.key });
    const where = { user_id: person.id, switch_key: 'view_stock' };
    await setPersonSwitchValues({ organizationId: ctx.org, userId: person.id, values: { view_stock: true }, actorId: null });
    const first = await db.permissionUserSwitch.findFirstOrThrow({ where });
    expect(first.value).toBe(true);
    await setPersonSwitchValues({ organizationId: ctx.org, userId: person.id, values: { view_stock: true }, actorId: null });
    expect((await db.permissionUserSwitch.findFirstOrThrow({ where })).id).toBe(first.id);
    await setPersonSwitchValues({ organizationId: ctx.org, userId: person.id, values: { view_stock: false }, actorId: null });
    expect(await db.permissionUserSwitch.count({ where })).toBe(0);
  });
});

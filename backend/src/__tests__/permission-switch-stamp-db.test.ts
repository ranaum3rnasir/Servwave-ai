/* =============================================================================
   P17 - the version stamp of a person's switches. Every authenticated response carries it (header) and /auth/me
   carries it (body); a role edit moves every member's stamp, a person edit only that person's, a role assignment
   moves the person's, and the cached stamp never hides a change: the next request after a write already carries
   the new one. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { clearSwitchCacheForUser } from '../lib/permissions/switches/cache';

const HEADER = 'x-access-stamp';
const suite = realClient ? describe : describe.skip;

suite('the switches version stamp (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  /** The stamp a person's next request carries, read from the header of a plain authenticated read. */
  async function stampOf(person: Person): Promise<string> {
    const res = await (await fx.signedInAs(person)).get('/api/permission-switches/catalog');
    expect(res.status).toBe(200);
    const stamp = res.headers[HEADER];
    expect(typeof stamp).toBe('string');
    expect(stamp.length).toBeGreaterThan(0);
    return stamp;
  }

  it('is on every authenticated response, and on /auth/me and the switches read in the body, and they agree', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'stamped', 'DISPATCHER');
    const person = await fx.addUser(org, 'sam', 'DISPATCHER', { customRoleId: role.id });
    const api = await fx.signedInAs(person);

    const me = await api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.headers[HEADER]).toBe(me.body.switches_version);
    const mine = await api.get('/api/permission-switches/me');
    expect(mine.body.switches_version).toBe(me.body.switches_version);
    expect((await api.get('/api/permission-switches/accepted-payment-methods')).headers[HEADER]).toBe(me.body.switches_version);
  });

  it('is exposed to a browser on another origin', async () => {
    const { org } = await fx.newOrg();
    const person = await fx.addUser(org, 'ola', 'TECHNICIAN');
    const res = await (await fx.signedInAs(person)).get('/api/permission-switches/catalog');
    expect(String(res.headers['access-control-expose-headers'] ?? '').toLowerCase()).toContain(HEADER);
  });

  it('moves every member of a role when the role is edited, and nobody on another role', async () => {
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'crew-chiefs', 'DISPATCHER');
    const other = await fx.addCustomRole(org, 'back-office', 'DISPATCHER');
    const a = await fx.addUser(org, 'ann', 'DISPATCHER', { customRoleId: role.id });
    const b = await fx.addUser(org, 'bob', 'DISPATCHER', { customRoleId: role.id });
    const c = await fx.addUser(org, 'cat', 'DISPATCHER', { customRoleId: other.id });
    const before = { a: await stampOf(a), b: await stampOf(b), c: await stampOf(c) };

    const edit = await (await fx.signedInAs(admin)).put(`/api/roles/${role.key}/permissions`, { values: { apply_discounts: true } });
    expect(edit.status).toBe(200);

    // The very next request of each member already carries the new stamp: the cached one was dropped with the write.
    const after = { a: await stampOf(a), b: await stampOf(b), c: await stampOf(c) };
    expect(after.a).not.toBe(before.a);
    expect(after.b).not.toBe(before.b);
    expect(after.c).toBe(before.c);
  });

  it('moves only the person when one person is edited, reset, or given another role', async () => {
    const { org, admin } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'floor', 'DISPATCHER');
    const second = await fx.addCustomRole(org, 'floor-two', 'DISPATCHER');
    const a = await fx.addUser(org, 'dee', 'DISPATCHER', { customRoleId: role.id });
    const b = await fx.addUser(org, 'eli', 'DISPATCHER', { customRoleId: role.id });
    // The fixture points the mocked sign-in at the person it was last asked for, so the Admin signs in again per call.
    const asAdmin = () => fx.signedInAs(admin);
    const start = { a: await stampOf(a), b: await stampOf(b) };

    // A person edit (an override) moves that person's stamp only.
    expect((await (await asAdmin()).put(`/api/users/${a.id}/permissions`, { values: { apply_discounts: true } })).status).toBe(200);
    const edited = { a: await stampOf(a), b: await stampOf(b) };
    expect(edited.a).not.toBe(start.a);
    expect(edited.b).toBe(start.b);

    // Reset DELETES the override row: no newer timestamp is left behind, and the stamp still moves.
    expect((await (await asAdmin()).post(`/api/users/${a.id}/permissions/reset`, { all: true })).status).toBe(200);
    const reset = await stampOf(a);
    expect(reset).not.toBe(edited.a);
    expect(await stampOf(b)).toBe(start.b);

    // A role assignment (P14) is a change of the person's switches too.
    expect((await (await asAdmin()).patch(`/api/users/${b.id}`, { role: 'DISPATCHER', custom_role_id: second.id })).status).toBe(200);
    expect(await stampOf(b)).not.toBe(start.b);
    expect(await stampOf(a)).toBe(reset);
  });

  it('moves when the department of the person changes, since Their team reads it', async () => {
    const { org } = await fx.newOrg();
    const role = await fx.addCustomRole(org, 'shifts', 'DISPATCHER');
    const person = await fx.addUser(org, 'fay', 'DISPATCHER', { customRoleId: role.id });
    const dept = await fx.addDepartment(org, 'North');
    const start = await stampOf(person);

    await db.user.update({ where: { id: person.id }, data: { department_id: dept } });
    clearSwitchCacheForUser(person.id);
    expect(await stampOf(person)).not.toBe(start);
  });

  it('is a constant for the Admin box, which holds no stored set', async () => {
    const { admin } = await fx.newOrg();
    const first = await stampOf(admin);
    const second = await stampOf(admin);
    expect(second).toBe(first);
  });
});

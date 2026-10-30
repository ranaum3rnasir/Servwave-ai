/* =============================================================================
   Roles & Permissions security, ticket 37 (spec story 68): the switch cache is cleared only after the database step commits.

   Moving a person to another role writes the person, clears their own switches and records the change, in one transaction.
   The person's switches kept in memory used to be dropped in the middle of that transaction, before it committed: a request
   landing in between filled the memory again from what was still committed, and if the transaction then failed (the access
   record could not be written, say) the memory had been dropped for a change that never happened. The memory is now dropped
   once, after the commit, and a rolled-back change leaves it exactly as it was: still serving the committed values.

   The rollback is forced the way it happens in production: the access record (ticket 25), written last in the same
   transaction, fails. Real migrated database (TEST_DATABASE_URL); skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient, failAccessRecord } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, failAccessRecord: { on: false } };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAdminChangeAlertEmail: vi.fn().mockResolvedValue(true),
}));
// The access record is the last write of the role move's transaction; failing it rolls the whole move back.
vi.mock('../lib/users/access-audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/users/access-audit')>();
  return {
    ...real,
    recordAccessChange: (async (...args: Parameters<typeof real.recordAccessChange>) => {
      if (failAccessRecord.on) throw new Error('the access record could not be written');
      return real.recordAccessChange(...args);
    }) as typeof real.recordAccessChange,
  };
});

import { switchFixture } from './permission-switches-fixture';
import { getCachedSwitches, runWithSwitchesStamp } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;
const HEADER = 'x-access-stamp';

suite('the switch cache is cleared only after the change commits (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    failAccessRecord.on = false;
  });

  /** A Technician on a role that holds View customers, another role that does not, and their switches held in memory. */
  async function setUp() {
    const { org, admin } = await fx.newOrg();
    const tag = Math.random().toString(36).slice(2, 8);
    const role = await fx.addCustomRole(org, `t37-crew-${tag}`, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, role.key, { view_customers: true });
    const blank = await fx.addCustomRole(org, `t37-blank-${tag}`, 'TECHNICIAN', { madeFromBlank: true });
    const person = await fx.addUser(org, 'tom', 'TECHNICIAN', { customRoleId: role.id });
    const res = await (await fx.signedInAs(person)).get('/api/customers');
    expect(res.status).toBe(200);
    const stamp = res.headers[HEADER] as string;
    expect(stamp).toMatch(/^[0-9a-f]{32}$/);
    const held = () => runWithSwitchesStamp(person.id, stamp, () => getCachedSwitches(person.id));
    expect(held()?.view_customers).toBe(true);
    return { admin, person, blank, stamp, held };
  }

  it('a move to another role that rolls back leaves the memory as it was, serving the committed values', async () => {
    const { admin, person, blank, stamp, held } = await setUp();

    failAccessRecord.on = true;
    const move = await (await fx.signedInAs(admin)).patch(`/api/users/${person.id}`, { custom_role_id: blank.id });
    expect(move.status).toBe(500);
    failAccessRecord.on = false;

    // Nothing changed in the database ...
    const stored = await db.user.findUnique({ where: { id: person.id }, select: { custom_role_id: true } });
    expect(stored?.custom_role_id).not.toBe(blank.id);
    // ... so the memory was not touched: the committed values are still served from it, under the unchanged stamp.
    expect(held()?.view_customers).toBe(true);
    const again = await (await fx.signedInAs(person)).get('/api/customers');
    expect(again.status).toBe(200);
    expect(again.headers[HEADER]).toBe(stamp);
  });

  it('a move that commits drops the memory once it has committed, and the next request has the new role', async () => {
    const { admin, person, blank, held } = await setUp();

    const move = await (await fx.signedInAs(admin)).patch(`/api/users/${person.id}`, { custom_role_id: blank.id });
    expect(move.status, JSON.stringify(move.body)).toBe(200);

    expect(held()).toBeNull();
    expect((await (await fx.signedInAs(person)).get('/api/customers')).status).toBe(403);
  });
});

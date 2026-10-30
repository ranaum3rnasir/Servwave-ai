/* =============================================================================
   Roles & Permissions AL-16 (ticket 24, H5, migration M11): the database itself holds "every company has one Owner".

   The Owner is a reference on the company (organizations.owner_user_id), not a mark on a person, so a company can name one
   person at most. The reference is the pair (company, person), so the Owner is always one of the company's own people, and a
   person is the Owner of one company at most. While someone is the Owner their row cannot be deleted.

   These are database rules, so they are tested through the database. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

/** The Postgres error code a refused write carries (Prisma wraps raw errors; the code is in the message or meta). */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (err) {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    return e.meta?.code ?? /Code: `(\w+)`/.exec(e.message ?? '')?.[1] ?? e.code ?? 'refused';
  }
  return 'accepted';
}

suite('the Owner is held by the database (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  it('a company made the way onboarding makes one has its first Admin as its Owner', async () => {
    const { org, admin } = await fx.newOrg();
    const row = await db.organization.findUniqueOrThrow({ where: { id: org }, select: { owner_user_id: true } });
    expect(row.owner_user_id).toBe(admin.id);
  });

  it('refuses a person from another company as the Owner', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const outsider = await fx.addUser(b.org, 'outsider', 'ADMIN');

    const code = await refusal(db.$executeRawUnsafe(
      `UPDATE organizations SET owner_user_id = $1::uuid WHERE id = $2::uuid`, outsider.id, a.org,
    ));
    expect(code).toBe('23503');
    const row = await db.organization.findUniqueOrThrow({ where: { id: a.org }, select: { owner_user_id: true } });
    expect(row.owner_user_id).toBe(a.admin.id);
  });

  it('refuses a second company naming a person who is already an Owner', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    await db.$executeRawUnsafe(`UPDATE organizations SET owner_user_id = NULL WHERE id = $1::uuid`, b.org);

    const code = await refusal(db.$executeRawUnsafe(
      `UPDATE organizations SET owner_user_id = $1::uuid WHERE id = $2::uuid`, a.admin.id, b.org,
    ));
    // The person can't be named twice (unique), and isn't one of company B's people (the pair reference): either refuses.
    expect(['23505', '23503']).toContain(code);
    const row = await db.organization.findUniqueOrThrow({ where: { id: b.org }, select: { owner_user_id: true } });
    expect(row.owner_user_id).toBeNull();
  });

  it('holds exactly one Owner per company: the reference is one column, and it is unique', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'organizations' AND column_name LIKE '%owner%'`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['owner_user_id']);
    const unique = await db.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'organizations' AND indexdef LIKE 'CREATE UNIQUE INDEX%(owner_user_id)'`,
    );
    expect(unique).toHaveLength(1);
  });

  it("refuses to delete the Owner's row while they are the Owner", async () => {
    const { org, admin } = await fx.newOrg();

    const code = await refusal(db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, admin.id));
    expect(code).toBe('23503');
    expect(await db.user.count({ where: { id: admin.id, organization_id: org } })).toBe(1);
  });
});

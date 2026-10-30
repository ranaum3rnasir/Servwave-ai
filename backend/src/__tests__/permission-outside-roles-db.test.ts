/* =============================================================================
   Roles & Permissions security, ticket 37 (spec story 66): the database the tests run on has the hosted database's two
   outside roles, so the check for tables opened to them can fail.

   The hosted database has two roles that its public data door uses for callers from outside: `anon` (nobody signed in) and
   `authenticated`. A table granted to either is readable from the internet with the key the browser carries, past the app and
   every check in it. The migrations take those grants away table by table, but only where the roles exist, and a plain
   Postgres has neither, so on the test database "no table is opened to them" was true by construction and could never fail.

   backend/scripts/ci-outside-roles.sql makes the two roles (they cannot sign in and hold nothing). CI runs it before the
   migrations and drops the roles when the job ends (permission-outside-roles-ci-guard.test.ts holds that in place), so there
   the check below runs against what the migrations really did to them. A local or runner database, built without them on a
   cluster other suites share, gets them only inside each case's own transaction, which is rolled back: a role left on a shared
   cluster would meet every later full migration run there. Real migrated database (TEST_DATABASE_URL); skips when it is unset.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient, type Prisma } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const ROLES_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'ci-outside-roles.sql'), 'utf8');

/**
 * Every table, view and sequence of the app's schema that an outside role can reach with any privilege, as `relation (role)`.
 * `has_table_privilege` counts a grant to the role itself and one to PUBLIC, which every role holds.
 */
async function openedToOutsideRoles(db: Prisma.TransactionClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ opened: string }[]>(`
    SELECT c.relname || ' (' || r.rolname || ')' AS opened
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND CASE WHEN c.relkind = 'S'
                THEN has_sequence_privilege(r.oid, c.oid, 'USAGE, SELECT, UPDATE')
                ELSE has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           END`);
  return rows.map((r) => r.opened).sort();
}

const ROLLBACK = new Error('rolled back on purpose');

suite('the outside roles are on the test database, and a table opened to them is caught (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  afterAll(() => db.$disconnect());

  /** Runs `fn` with both outside roles present (made by the CI script where missing), then rolls everything back. */
  async function withOutsideRoles<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ROLES_SQL);
      out = await fn(tx);
      throw ROLLBACK;
    }, { timeout: 15_000 })).rejects.toBe(ROLLBACK);
    return out as T;
  }

  it.runIf(process.env.CI === 'true')('in CI, had both roles before the migrations ran (the role step ran)', async () => {
    const roles = await db.$queryRawUnsafe<{ rolname: string }[]>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname`,
    );
    expect(roles.map((r) => r.rolname)).toEqual(['anon', 'authenticated']);
  });

  it('makes both outside roles, neither able to sign in nor above the rules', async () => {
    const roles = await withOutsideRoles((tx) => tx.$queryRawUnsafe<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]>(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname`,
    ));
    expect(roles).toEqual([
      { rolname: 'anon', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: 'authenticated', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('opens no table, view or sequence of the app to an outside role', async () => {
    expect(await withOutsideRoles(openedToOutsideRoles), 'relations an outside role can reach').toEqual([]);
  });

  it('catches a table deliberately opened to an outside role (the check can fail)', async () => {
    const seen = await withOutsideRoles(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TABLE t37_opened_probe (id int, organization_id uuid)');
      await tx.$executeRawUnsafe('CREATE SEQUENCE t37_opened_probe_seq');
      const closed = await openedToOutsideRoles(tx);
      await tx.$executeRawUnsafe('GRANT SELECT ON t37_opened_probe TO anon');
      await tx.$executeRawUnsafe('GRANT INSERT ON t37_opened_probe TO PUBLIC');
      await tx.$executeRawUnsafe('GRANT USAGE ON SEQUENCE t37_opened_probe_seq TO authenticated');
      return { closed, opened: await openedToOutsideRoles(tx) };
    });
    expect(seen.closed.filter((r) => r.startsWith('t37_'))).toEqual([]);
    expect(seen.opened.filter((r) => r.startsWith('t37_'))).toEqual([
      't37_opened_probe (anon)', 't37_opened_probe (authenticated)', 't37_opened_probe_seq (authenticated)',
    ]);
    // Rolled back: nothing of the probe is left behind.
    const left = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 't37_opened_probe%'`);
    expect(left[0]!.n).toBe(0);
  });
});

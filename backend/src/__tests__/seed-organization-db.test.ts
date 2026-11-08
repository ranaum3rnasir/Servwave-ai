/* =============================================================================
   The organization seed actually lands the seeded org.

   PREVIOUSLY A CI STEP - a raw `docker exec ... psql -tA -c` piped into a shell
   `if [ "$COUNT" != "1" ]`. That works, but when it failed it printed
   "Expected 1 seeded org row, got 0" with no indication of what the table did
   contain, and it could only ever run inside CI.

   Same assertion, as a test: it names what it found on failure, and anyone with
   a throwaway Postgres can run it locally.

   Requires a seeded throwaway database - runs in the `database` CI job after
   `prisma migrate deploy` + `tsx src/seed-organization.ts`, and skips when
   TEST_DATABASE_URL is unset (same idiom as rls-isolation.test.ts).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

/** Fixed ID the seed script assigns the seeded organization. */
const SEED_ORG_ID = '00000000-0000-0000-0000-000000000001';

suite('seed-organization', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates exactly one organization at the fixed seed ID', async () => {
    // $1::uuid, not a bare $1 - `organizations.id` is a uuid column and Postgres
    // has no uuid = text operator, so an uncast parameter fails with 42883
    // rather than simply matching nothing. Same convention as the sibling RLS
    // tests in this directory.
    const rows = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
      'SELECT id::text, name FROM organizations WHERE id = $1::uuid',
      SEED_ORG_ID,
    );

    if (rows.length !== 1) {
      // On failure, say what IS in the table - the shell version could not.
      const all = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
        'SELECT id::text, name FROM organizations ORDER BY name LIMIT 10',
      );
      expect.fail(
        `Expected exactly 1 organization at ${SEED_ORG_ID}, found ${rows.length}.\n` +
          `Organizations present (first 10): ${JSON.stringify(all, null, 2)}`,
      );
    }

    expect(rows).toHaveLength(1);
  });
});

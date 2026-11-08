import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * DB-LEVEL proof that a single missed tenantWhere() cannot leak cross-org data.
 *
 * Self-contained: builds a table with the EXACT tenant_isolation policy shape
 * from migrations/*_tenant_rls, a non-BYPASSRLS role, and two orgs' rows, then
 * verifies isolation as that role. Requires a throwaway Postgres — runs in the
 * `Database (migrations + RLS)` CI job (postgres:16) and skips locally when
 * TEST_DATABASE_URL is unset. That same job separately proves the real
 * migration applies, and runs this test BEFORE seeding so the DB is pristine.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('RLS tenant isolation (DB-level)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const custA = randomUUID();
  const custB = randomUUID();

  // Run a block as the non-bypass role with the given tenant session vars, all
  // inside one transaction so SET LOCAL ROLE + set_config pin to one connection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function asRole(org: string | null, bypass: boolean, fn: (tx: any) => Promise<unknown>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE rls_demo_role');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org ?? '');
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', $1, true)", bypass ? 'on' : '');
      return fn(tx);
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS rls_demo_customers CASCADE');
    await prisma.$executeRawUnsafe('DROP ROLE IF EXISTS rls_demo_role');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE rls_demo_customers (id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text)',
    );
    await prisma.$executeRawUnsafe('ALTER TABLE rls_demo_customers ENABLE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe('ALTER TABLE rls_demo_customers FORCE ROW LEVEL SECURITY');
    await prisma.$executeRawUnsafe(
      `CREATE POLICY tenant_isolation ON rls_demo_customers
         USING (current_setting('app.bypass_rls', true) = 'on'
                OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
         WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
                    OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
    );
    await prisma.$executeRawUnsafe('CREATE ROLE rls_demo_role NOLOGIN');
    await prisma.$executeRawUnsafe('GRANT ALL ON rls_demo_customers TO rls_demo_role');
    // Seed as the connecting superuser (bypasses RLS for setup).
    await prisma.$executeRawUnsafe(
      "INSERT INTO rls_demo_customers (id, organization_id, name) VALUES ($1::uuid,$2::uuid,'A'),($3::uuid,$4::uuid,'B')",
      custA, orgA, custB, orgB,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS rls_demo_customers CASCADE');
    await prisma.$executeRawUnsafe('DROP ROLE IF EXISTS rls_demo_role');
    await prisma.$disconnect();
  });

  it('a query with NO WHERE clause still returns only the current org rows', async () => {
    const rows = (await asRole(orgA, false, (tx) =>
      tx.$queryRawUnsafe('SELECT organization_id FROM rls_demo_customers'))) as Array<{ organization_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgA);
  });

  it('cannot read another org row even when selecting it by id', async () => {
    const rows = (await asRole(orgA, false, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM rls_demo_customers WHERE id = $1::uuid', custB))) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('cannot INSERT a row for another org (WITH CHECK blocks it)', async () => {
    await expect(
      asRole(orgA, false, (tx) =>
        tx.$executeRawUnsafe(
          "INSERT INTO rls_demo_customers (id, organization_id, name) VALUES ($1::uuid,$2::uuid,'X')",
          randomUUID(), orgB,
        )),
    ).rejects.toThrow();
  });

  it('the controlled bypass sees every org', async () => {
    const rows = (await asRole(null, true, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM rls_demo_customers'))) as unknown[];
    expect(rows).toHaveLength(2);
  });

  it('with no session var set at all, RLS is fail-closed (zero rows)', async () => {
    const rows = (await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE rls_demo_role');
      return tx.$queryRawUnsafe('SELECT id FROM rls_demo_customers');
    })) as unknown[];
    expect(rows).toHaveLength(0);
  });
});

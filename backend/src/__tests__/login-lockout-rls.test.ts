import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * DB-LEVEL proof that login can never be locked out again under RLS enforcement.
 *
 * Reproduces the staging+prod incident (#602/#603): once the tenant-isolation
 * backstop is live (app connects as the non-BYPASSRLS `app_rls` role), the login
 * bootstrap lookup runs BEFORE any org context exists. If it is not wrapped in
 * `unscopedRequest`/`runUnscoped`, the fail-closed `tenant_isolation` policy on
 * `users` (and `organizations`, which resolveAppUser joins) matches ZERO rows and
 * every login 401s.
 *
 * This test runs against the REAL migrated schema + the REAL `app_rls` role, so it
 * is tied to the actual `users`/`organizations` tables and the actual policy — not
 * a synthetic copy. It asserts:
 *   - no session var  → user is invisible  (the incident)
 *   - bypass = 'on'   → user resolves      (what runUnscoped restores)
 *   - correct org set  → user resolves      (the normal authenticated request path)
 *
 * Requires a throwaway Postgres with all migrations applied — runs in the
 * `Database (migrations + RLS)` CI job and skips locally when TEST_DATABASE_URL
 * is unset. The route
 * wiring is guarded separately by auth-rls-bootstrap.test.ts; together they prove
 * both that the pass is required AND that every login route carries it.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Login is not locked out under RLS enforcement (DB-level)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `admin.${userId}@example.com`;

  // Run a block as the real non-BYPASSRLS `app_rls` role with the given tenant
  // session vars, all inside one transaction so SET LOCAL ROLE + set_config pin to
  // one connection. This is exactly what lib/tenant-guard.ts does at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function asAppRls(org: string | null, bypass: boolean, fn: (tx: any) => Promise<unknown>) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      await tx.$executeRawUnsafe("SELECT set_config('app.current_org_id', $1, true)", org ?? '');
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', $1, true)", bypass ? 'on' : '');
      return fn(tx);
    });
  }

  beforeAll(async () => {
    // The runtime non-bypass role, mirroring docs/rls-activation-runbook.md.
    // Idempotent so re-runs on the shared CI DB are safe.
    await prisma.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_rls');
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');

    // Seed as the connecting superuser (BYPASSRLS) so the insert is not itself
    // filtered by the policy we are about to test.
    await prisma.organization.create({
      data: {
        id: orgId,
        plan: 'SCALE',
        name: 'RLS Login Test Org',
        address_line1: '1 Test St',
        city: 'Testville',
        state: 'VA',
        postal_code: '20001',
        email: 'org@example.com',
        estimate_terms: 'x',
        estimate_notes: 'x',
        estimate_payment_terms: 'x',
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        email,
        first_name: 'Ada',
        last_name: 'Admin',
        role: 'ADMIN',
        organization_id: orgId,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it('THE INCIDENT: with no org context, the login user lookup returns zero rows', async () => {
    const rows = (await asAppRls(null, false, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM users WHERE id = $1::uuid', userId))) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('THE INCIDENT: the organizations join resolveAppUser does is equally locked out', async () => {
    const rows = (await asAppRls(null, false, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM organizations WHERE id = $1::uuid', orgId))) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('THE FIX: the unscoped bypass (runUnscoped/unscopedRequest) resolves the user + org', async () => {
    const user = (await asAppRls(null, true, (tx) =>
      tx.$queryRawUnsafe('SELECT id, organization_id FROM users WHERE id = $1::uuid', userId))) as Array<{
      organization_id: string;
    }>;
    expect(user).toHaveLength(1);
    expect(user[0].organization_id).toBe(orgId);

    const org = (await asAppRls(null, true, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM organizations WHERE id = $1::uuid', orgId))) as unknown[];
    expect(org).toHaveLength(1);
  });

  it('the normal authenticated path (org scoped via runWithOrg) also sees the user', async () => {
    const rows = (await asAppRls(orgId, false, (tx) =>
      tx.$queryRawUnsafe('SELECT id FROM users WHERE id = $1::uuid', userId))) as unknown[];
    expect(rows).toHaveLength(1);
  });
});

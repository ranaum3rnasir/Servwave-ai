/* =============================================================================
   Spider sweep lease (#2993): the lease table migration, applied for real.

   Proves against real Postgres, the way the deploy applies it (the Prisma deploy command), on a fresh database at the
   migration before it:
     - spider_sweep_leases exists with its key and columns, and only one lease row can exist per sweep name;
     - the app's runtime role (a NOBYPASSRLS role with the grants the RLS runbook gives `app_rls`) can claim, renew,
       read and release a lease with no company set: the table holds no company data, so it carries no tenant policy
       (row-level security on with no policy would deny that role every row and stop every sweep);
     - neither outside role (`anon`, `authenticated`) can reach the table, even on a database that hands every new
       table to them the way the hosted database does (its default privileges grant them everything on each new table
       in the public schema), so only the migration's own REVOKE can take that away;
     - a second run of the file changes nothing and prints no error.

   Builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from a
   temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it never falls back to a checkout's .env.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployMigrations, createMigrationDatabase } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261103090000_spider_sweep_lease';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Spider sweep lease migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

const clientAt = (dbUrl: string) => new PrismaClient({ datasources: { db: { url: dbUrl } } });
type Db = ReturnType<typeof clientAt>;
const ROLLBACK = new Error('rolled back on purpose');

suite('Spider sweep lease migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const tempDirs: string[] = [];
  const name = `se_lease_mig_${randomUUID().slice(0, 8)}`;
  let dbUrl = '';
  let db: Db | undefined;
  let dir = '';
  /** Whether both outside roles exist on this cluster (CI and the runner make them; a bare local Postgres may not). */
  let outsideRoles = false;
  /** A table made by the migrating role just before the migration ran, under the same default privileges. */
  let probeReach: { rolname: string; reach: boolean }[] = [];

  const reachOf = (c: Db, table: string) =>
    c.$queryRawUnsafe<{ rolname: string; reach: boolean }[]>(
      `SELECT r.rolname, has_table_privilege(r.oid, $1::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS reach
         FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') ORDER BY r.rolname`, `public.${table}`);

  async function migrated(): Promise<Db> {
    if (db) return db;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    db = clientAt(dbUrl);
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    outsideRoles = n === 2;
    if (outsideRoles) {
      // The hosted database's default privileges: every table the migrating role creates in public is granted in full
      // to both outside roles. Set on this throwaway database only, for the role the deploy below connects as.
      await db.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated`);
      await db.$executeRawUnsafe(`CREATE TABLE se_lease_probe (id int)`);
      probeReach = await reachOf(db, 'se_lease_probe');
      await db.$executeRawUnsafe(`DROP TABLE se_lease_probe`);
    }
    dir = deployMigrations(dbUrl, MIGRATION, 'through', tempDirs);
    return db;
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    if (db) await quietly(db.$disconnect());
    await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });

  const columns = (c: Db) =>
    c.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'spider_sweep_leases' ORDER BY column_name`);

  it('adds the lease table, keyed by the sweep name', async () => {
    const c = await migrated();
    expect(await columns(c)).toEqual([
      { column_name: 'claimed_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'expires_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'holder', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', is_nullable: 'NO' },
    ]);
    const insert = (holder: string) =>
      c.$executeRawUnsafe(`INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ('spider.sweep', $1, now(), now())`, holder);
    await insert('run-1');
    await expect(insert('run-2')).rejects.toThrow();
    await c.$executeRawUnsafe(`DELETE FROM spider_sweep_leases`);
  }, 300_000);

  it("the app's runtime role claims, renews, reads and releases a lease with no company set", async () => {
    const c = await migrated();
    const role = `se_lease_app_${randomUUID().slice(0, 8)}`;
    const seen: Record<string, unknown> = {};
    // A role made and granted inside the transaction, which is rolled back: nothing is left on the shared cluster.
    await expect(c.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS`);
      // The grants docs/rls-activation-runbook.md gives app_rls.
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await tx.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      seen.claimed = await tx.$queryRawUnsafe(
        `INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ('spider.sweep', 'run-1', now(), now() + interval '2 minutes')
         ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at
           WHERE spider_sweep_leases.expires_at <= now()
         RETURNING holder`);
      seen.renewed = await tx.$executeRawUnsafe(
        `UPDATE spider_sweep_leases SET expires_at = now() + interval '2 minutes' WHERE name = 'spider.sweep' AND holder = 'run-1' AND expires_at > now()`);
      seen.read = await tx.$queryRawUnsafe(`SELECT holder FROM spider_sweep_leases`);
      seen.released = await tx.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep' AND holder = 'run-1'`);
      throw ROLLBACK;
    }, { timeout: 15_000 })).rejects.toBe(ROLLBACK);
    expect(seen).toEqual({ claimed: [{ holder: 'run-1' }], renewed: 1, read: [{ holder: 'run-1' }], released: 1 });

    const [rls] = await c.$queryRawUnsafe<{ rls_on: boolean; policies: number }[]>(
      `SELECT c.relrowsecurity AS rls_on, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.oid = 'public.spider_sweep_leases'::regclass`);
    expect(rls).toEqual({ rls_on: false, policies: 0 });
  }, 300_000);

  it('takes the table away from both outside roles, though the default privileges hand it to them', async (ctx) => {
    const c = await migrated();
    // CI's Database job makes both roles before the migrations (scripts/ci-outside-roles.sql), so there this must run.
    if (!outsideRoles) {
      expect(process.env.CI, 'the outside roles are missing in CI').not.toBe('true');
      ctx.skip();
    }
    // The setup bites: a table made right before the migration WAS open to both roles.
    expect(probeReach).toEqual([{ rolname: 'anon', reach: true }, { rolname: 'authenticated', reach: true }]);
    // The lease table, made by the migration under the same default privileges, is not.
    expect(await reachOf(c, 'spider_sweep_leases')).toEqual([{ rolname: 'anon', reach: false }, { rolname: 'authenticated', reach: false }]);
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const c = await migrated();
    await c.$executeRawUnsafe(
      `INSERT INTO spider_sweep_leases (name, holder, claimed_at, expires_at) VALUES ('spider.sweep', 'run-again', now(), now() + interval '1 minute')`);
    const before = await columns(c);

    const again = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });

    expect(again.status, again.stderr).toBe(0);
    expect(await columns(c)).toEqual(before);
    expect(await c.$queryRawUnsafe(`SELECT holder FROM spider_sweep_leases`)).toEqual([{ holder: 'run-again' }]);
  }, 300_000);
});

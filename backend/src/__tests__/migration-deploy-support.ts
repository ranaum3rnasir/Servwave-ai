/*
 * Shared by the real-database migration tests (`*-migration-db.test.ts`).
 *
 * A migration test proves its own migration applies as the next migration on a database that is at the one
 * before it, so it deploys "before" to build the prod-shaped starting point and "through" to apply the migration
 * under test. It never deploys a migration written AFTER its own: a later data-moving migration would write rows
 * into tables the test asserts are untouched (batch 75: the user-mailbox migration issued a mailbox to the user
 * two older tests had seeded, and their "no other table changed" check went red). The deploy still runs through
 * the real Prisma deploy command, as Render does.
 */
import { spawnSync } from 'child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const LOCK_FILE = 'migration_lock.toml';

/** 'before': migrations older than the one under test. 'through': those plus the one under test, nothing later. */
export type MigrationReach = 'before' | 'through';

/**
 * A scratch directory holding the schema and the migration folders up to the reach. The directory is pushed
 * onto `tempDirs` so the test's afterAll can remove it.
 */
export function prepareMigrationsDir(migration: string, reach: MigrationReach, tempDirs: string[]): string {
  const source = join(PRISMA_DIR, 'migrations');
  if (!existsSync(join(source, migration))) throw new Error(`${migration} is not a migration in ${source}`);
  const dir = mkdtempSync(join(tmpdir(), 'migration-deploy-'));
  tempDirs.push(dir);
  copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
  mkdirSync(join(dir, 'migrations'));
  for (const entry of readdirSync(source)) {
    const stops = reach === 'before' ? entry >= migration : entry > migration;
    if (entry !== LOCK_FILE && stops) continue;
    cpSync(join(source, entry), join(dir, 'migrations', entry), { recursive: true });
  }
  return dir;
}

/**
 * The hosted database's stub auth helpers, for a database a test makes for itself. Once the cluster has the hosted
 * database's `authenticated` role (CI makes it, ticket 37: scripts/ci-outside-roles.sql), the oldest guarded migration
 * (20260623120000_add_audit_logs) writes a policy naming auth.uid(), so a fresh database needs the same NULL-answering
 * auth.uid(), auth.role() and auth.jwt() that script gives CI's own database. It touches only this database, makes only
 * what is missing, and does nothing on a cluster without the role (a plain Postgres), where the migrations name no auth
 * helper and a test database should keep no auth schema.
 */
const AUTH_STUBS_SQL = `DO $auth_stubs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    IF to_regprocedure('auth.uid()') IS NULL THEN
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    END IF;
    IF to_regprocedure('auth.role()') IS NULL THEN
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
    END IF;
    IF to_regprocedure('auth.jwt()') IS NULL THEN
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
    END IF;
  END IF;
END
$auth_stubs$;`;

/** Gives the database at `dbUrl` the stub auth helpers (see AUTH_STUBS_SQL); throws with the output when it fails. */
export function stubAuthHelpers(dbUrl: string): void {
  const run = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--stdin'], {
    input: AUTH_STUBS_SQL,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`auth stubs failed:\n${run.stdout}\n${run.stderr}`);
}

/**
 * The Prisma deploy command over a prepared directory; throws with its output when it fails. The database gets the stub
 * auth helpers first, so every database a test makes and migrates meets the migrations the way CI's own database does.
 */
export function deployFrom(dbUrl: string, dir: string): string {
  stubAuthHelpers(dbUrl);
  const run = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`deploy failed:\n${run.stdout}\n${run.stderr}`);
  return dir;
}

/**
 * Deploy only the migrations up to the reach. Returns the directory, so a test can run the migration file
 * again (`prisma db execute`) from the same place.
 */
export function deployMigrations(dbUrl: string, migration: string, reach: MigrationReach, tempDirs: string[]): string {
  return deployFrom(dbUrl, prepareMigrationsDir(migration, reach, tempDirs));
}

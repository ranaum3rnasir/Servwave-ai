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

/**
 * The fixed point the run's base template is migrated up to: the newest migration before the oldest target any suite
 * proves ("rows at the migration before X, then X"). A target newer than this starts from a copy of the base and
 * applies only the migrations between the base and itself; a target at or below it replays the full history, because
 * the base already contains it.
 */
export const BASE_MIGRATION = '20260928150000_automation_task_cancelled_trigger';

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

/**
 * Runs `sql` on the database at `dbUrl` over a direct connection (psql, which the Database job already requires), and
 * throws with its output when it fails. A Prisma CLI spawn costs about 0.8 s of fixed start-up, which on a tail of a few
 * dozen migrations was most of the time this helper exists to save; psql answers in milliseconds.
 */
function runSql(dbUrl: string, sql: string, what: string): void {
  const u = new URL(dbUrl);
  for (const param of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']) u.searchParams.delete(param); // Prisma-only
  const run = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', u.toString(), '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  });
  if (run.error) throw new Error(`${what}: could not start psql: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${what}:\n${run.stdout}\n${run.stderr}`);
}

/** Gives the database at `dbUrl` the stub auth helpers (see AUTH_STUBS_SQL); throws with the output when it fails. */
export function stubAuthHelpers(dbUrl: string): void {
  runSql(dbUrl, AUTH_STUBS_SQL, 'auth stubs failed');
}

/** The databases this module made as a copy of the run's base: they already carry the stub auth helpers. */
const baseCopies = new Set<string>();
const databaseOf = (dbUrl: string) => decodeURIComponent(new URL(dbUrl).pathname.slice(1));

/**
 * The Prisma deploy command over a prepared directory; throws with its output when it fails. The database gets the stub
 * auth helpers first (unless it is a copy of the run's base, which has them), so every database a test makes and migrates meets the migrations the way CI's own database does.
 */
export function deployFrom(dbUrl: string, dir: string): string {
  if (!baseCopies.has(databaseOf(dbUrl))) stubAuthHelpers(dbUrl); // a copy of the base was stubbed when the base was built
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
  const dir = deployFrom(dbUrl, prepareMigrationsDir(migration, reach, tempDirs));
  if (reach === 'before') assertAtMigrationBefore(dbUrl, migration);
  return dir;
}

// ── The run's base template ─────────────────────────────────────────────────────────────────────────────────────────

/** Every migration folder name in the checkout, oldest first (byte order, the order the deploy applies them in). */
export function migrationNames(): string[] {
  return readdirSync(join(PRISMA_DIR, 'migrations')).filter((e) => e !== LOCK_FILE).sort();
}

/** The migration written just before `target`, or null when `target` is the first one. Throws for a name that is not one. */
export function migrationBefore(target: string, all: string[] = migrationNames()): string | null {
  const at = all.indexOf(target);
  if (at < 0) throw new Error(`${target} is not a migration in ${join(PRISMA_DIR, 'migrations')}`);
  return at === 0 ? null : all[at - 1]!;
}

/** Whether a copy of the base can serve the target: only a target newer than the base. At or below it, replay everything. */
export function canStartFromBase(target: string, base: string = BASE_MIGRATION): boolean {
  return target > base;
}

/**
 * Whether `name` is a base that an earlier run of this machine left behind (killed or cancelled before its teardown ran):
 * it is named for a process that no longer exists. Used only to drop such leftovers; a base is never read from an earlier run.
 */
export function isLeftoverBase(name: string, isAlive: (pid: number) => boolean): boolean {
  const m = /^migration_base_(\d+)_[0-9a-f]+$/.exec(name);
  return m !== null && !isAlive(Number(m[1]));
}

const SAFE_NAME = /^[0-9a-z_]+$/;

/**
 * After the "before" deploy, the database must be exactly at the migration before the target: the newest applied
 * migration is that one and the target is not applied. Without this, a copy of the base that is too old (or too new)
 * would make "rows at the migration before X, then X" prove nothing. Throws with what it found.
 */
export function assertAtMigrationBefore(dbUrl: string, target: string): void {
  const expected = migrationBefore(target);
  if (expected === null) return; // the very first migration has nothing before it
  if (!SAFE_NAME.test(expected) || !SAFE_NAME.test(target)) throw new Error('unexpected characters in a migration name');
  const sql = `DO $before_target$
DECLARE newest text;
BEGIN
  SELECT max(migration_name COLLATE "C") INTO newest FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF newest IS DISTINCT FROM '${expected}' THEN
    RAISE EXCEPTION 'newest applied migration is %, expected ${expected}', newest;
  END IF;
  IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '${target}') THEN
    RAISE EXCEPTION 'the target ${target} is already applied';
  END IF;
END
$before_target$;`;
  runSql(dbUrl, sql, `database is not at the migration before ${target}`);
}

/** The slice of a Prisma client the helper needs, so a suite passes its own admin client. */
export interface AdminSql {
  // Loose on purpose: a suite passes its PrismaClient, and checking that client's full generic overloads against a strict
  // signature costs the backend typecheck memory it does not have to spare.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $executeRawUnsafe: (query: string, ...values: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRawUnsafe: (query: string, ...values: any[]) => Promise<any>;
}

/** The run's base name, set by the global setup (migration-base.global-setup.ts); undefined where there is none. */
export const baseName = (): string | undefined => process.env.MIGRATION_BASE_DB || undefined;

function urlWithDatabase(server: string, name: string): string {
  const u = new URL(server);
  u.pathname = `/${name}`;
  return u.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The Postgres error code (SQLSTATE) a failed raw query carries: Prisma puts it in `meta.code`; the message is the fallback. */
function sqlState(e: unknown): string | undefined {
  const err = e as { meta?: { code?: unknown }; message?: string } | null;
  if (typeof err?.meta?.code === 'string') return err.meta.code;
  return /\b(42P04|23505|55006)\b/.exec(String(err?.message ?? e))?.[1];
}
// Two workers creating the base at once: the loser gets 42P04 (duplicate_database) or, when both reach the insert into pg_database
// together, 23505 (unique_violation on its name index). Either way the base exists or is being built, so the loser waits for it.
const isDuplicate = (e: unknown) => ['42P04', '23505'].includes(sqlState(e) ?? '');
const isBusy = (e: unknown) => sqlState(e) === '55006'; // object_in_use: the template is still being read by another copy

let baseReady: Promise<void> | undefined;

/**
 * Builds the run's base once, whichever worker needs it first. The CREATE DATABASE is the claim: the one worker whose
 * CREATE succeeds builds (stub auth helpers, then the real deploy command through BASE_MIGRATION, from this checkout)
 * and then closes the database to connections; every other worker waits for that. Built inside the run, named for the
 * run, dropped by the global setup's teardown, reused by nobody afterwards.
 */
function ensureBase(admin: AdminSql, serverUrl: string, name: string, tempDirs: string[]): Promise<void> {
  baseReady ??= (async () => {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      for (let waited = 0; waited < 600_000; waited += 250) {
        const [row] = (await admin.$queryRawUnsafe(
          `SELECT datallowconn AS open, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname = $1`, name)) as { open: boolean; note: string | null }[];
        if (row && !row.open) {
          if (row.note?.startsWith('failed')) throw new Error(`the migration base failed to build: ${row.note}`);
          return;
        }
        await sleep(250);
      }
      throw new Error('timed out waiting for the migration base to be built');
    }
    try {
      deployFrom(urlWithDatabase(serverUrl, name), prepareMigrationsDir(BASE_MIGRATION, 'through', tempDirs));
    } catch (e) {
      await admin.$executeRawUnsafe(`COMMENT ON DATABASE "${name}" IS 'failed: build error'`);
      await admin.$executeRawUnsafe(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
      throw e;
    }
    await admin.$executeRawUnsafe(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);
  })();
  return baseReady;
}

/**
 * Creates the database `name` for a migration suite whose target is `target` (null: the true empty database).
 * A target newer than BASE_MIGRATION gets a copy of the run's base; the "before" deploy that follows then applies only
 * the migrations between the base and the target. Anything else (target at or below the base, no base provided by the
 * run, a suite that asks for empty) is a plain empty database and a full replay. Returns which of the two it was.
 */
export async function createMigrationDatabase(
  admin: AdminSql, name: string, target: string | null, tempDirs: string[],
): Promise<'base' | 'empty'> {
  const base = baseName();
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (target === null || !base || !serverUrl || !canStartFromBase(target)) {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    return 'empty';
  }
  await ensureBase(admin, serverUrl, base, tempDirs);
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${base}"`);
      baseCopies.add(name);
      return 'base';
    } catch (e) {
      if (!isBusy(e) || attempt >= 40) throw e;
      await sleep(250);
    }
  }
}

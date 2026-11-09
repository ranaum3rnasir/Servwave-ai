/*
 * The shared helper the real-database migration tests deploy through. It builds a migrations directory that
 * stops at (or just before) the migration under test, so a test never replays a migration written after it:
 * a later data-moving migration would otherwise change tables the test asserts are untouched.
 * No database is needed; this checks only which migration folders land in the directory, and the base's pure rules.
 * The real-Postgres half is in migration-base-db.test.ts, so the Database job runs it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { BASE_MIGRATION, canStartFromBase, isLeftoverBase, migrationBefore, prepareMigrationsDir } from './migration-deploy-support';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const folders = (dir: string) => readdirSync(join(dir, 'migrations'));

describe('migration test deploy directory', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Two real migrations with a later one after them, whatever is added to the folder in future.
  const all = readdirSync(MIGRATIONS).filter((e) => e !== 'migration_lock.toml').sort();
  const own = all[Math.floor(all.length / 2)];
  const earlier = all.filter((e) => e < own);
  const later = all.filter((e) => e > own);

  it('"before" holds every migration older than the one under test, and neither it nor a later one', () => {
    const dir = prepareMigrationsDir(own, 'before', dirs);
    expect(folders(dir).filter((e) => e !== 'migration_lock.toml')).toEqual(earlier);
    expect(existsSync(join(dir, 'migrations', 'migration_lock.toml'))).toBe(true);
    expect(existsSync(join(dir, 'schema.prisma'))).toBe(true);
  });

  it('"through" holds the migration under test and everything before it, and nothing written after it', () => {
    expect(later.length).toBeGreaterThan(0);
    const dir = prepareMigrationsDir(own, 'through', dirs);
    expect(folders(dir).filter((e) => e !== 'migration_lock.toml')).toEqual([...earlier, own]);
    expect(existsSync(join(dir, 'migrations', 'migration_lock.toml'))).toBe(true);
  });

  it('refuses a migration name that does not exist, so a typo cannot quietly mean "everything"', () => {
    expect(() => prepareMigrationsDir('20990101000000_not_a_migration', 'through', dirs)).toThrow(/not a migration/);
  });
});

describe('migration base: which migration is "before", and when the base can serve a target', () => {
  const names = ['20260101000000_a', '20260102000000_b', '20260103000000_c'];

  it('names the migration written just before the target', () => {
    expect(migrationBefore('20260103000000_c', names)).toBe('20260102000000_b');
    expect(migrationBefore('20260102000000_b', names)).toBe('20260101000000_a');
  });

  it('has nothing before the first migration, and refuses a name that is not a migration', () => {
    expect(migrationBefore('20260101000000_a', names)).toBeNull();
    expect(() => migrationBefore('20990101000000_nope', names)).toThrow(/not a migration/);
  });

  it('serves a target newer than the base from the base', () => {
    expect(canStartFromBase('20260103000000_c', '20260102000000_b')).toBe(true);
  });

  it('falls back to a full replay for a target at the base, or below it', () => {
    expect(canStartFromBase('20260102000000_b', '20260102000000_b')).toBe(false);
    expect(canStartFromBase('20260101000000_a', '20260102000000_b')).toBe(false);
  });

  it('calls a base leftover only when the run that made it is gone, and never a database that is not a base', () => {
    const alive = (pid: number) => pid === 4242;
    expect(isLeftoverBase('migration_base_4242_0a1b2c3d', alive)).toBe(false); // its run is still going
    expect(isLeftoverBase('migration_base_999_0a1b2c3d', alive)).toBe(true);
    expect(isLeftoverBase('migration_base_x_0a1b2c3d', alive)).toBe(false);
    expect(isLeftoverBase('postgres', alive)).toBe(false);
    expect(isLeftoverBase('t3244_unit_0a1b2c3d', alive)).toBe(false);
  });

  it('a worker that loses the race to create the base waits for the finished base, whichever duplicate code Postgres raises', async () => {
    // Two workers creating the same database at once: the loser gets 42P04, or 23505 (unique violation on pg_database).
    vi.resetModules();
    vi.stubEnv('MIGRATION_BASE_DB', 'migration_base_test_race');
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://root@127.0.0.1:5432/postgres');
    try {
      const fresh = await import('./migration-deploy-support.js');
      const statements: string[] = [];
      const loser = {
        $executeRawUnsafe: async (q: string) => {
          statements.push(q);
          if (q === 'CREATE DATABASE "migration_base_test_race"') {
            throw Object.assign(new Error('Raw query failed'), { meta: { code: '23505', message: 'Key (datname)=(migration_base_test_race) already exists.' } });
          }
          return 0;
        },
        // first look: still building (open); second look: built and closed to connections
        $queryRawUnsafe: vi.fn()
          .mockResolvedValueOnce([{ open: true, note: null }])
          .mockResolvedValue([{ open: false, note: null }]),
      };
      const reach = await fresh.createMigrationDatabase(loser, 't3244_race_copy', '20261104120100_lead_notes_to_general_note', []);
      expect(reach).toBe('base');
      expect(loser.$queryRawUnsafe).toHaveBeenCalledTimes(2); // it waited out the build, and did not use the half-built base
      expect(statements.at(-1)).toBe('CREATE DATABASE "t3244_race_copy" TEMPLATE "migration_base_test_race"');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('keeps the base point on a real migration, so a renamed or removed one is noticed', () => {
    expect(existsSync(join(MIGRATIONS, BASE_MIGRATION))).toBe(true);
  });

  it('is used by every real-database suite that deploys part of the history: only the listed suites still replay everything', () => {
    // Every suite that deploys part of the history starts from the base. The two suites that once replayed everything
    // (the schema-vs-foreign-keys check and the demo-people seed) are served by a base copy plus the tail: the base is built
    // by the same deploy command from the same checkout, so the final schema and every data migration are the same. The true
    // empty-database path is still taken where a test asks for it (createMigrationDatabase(..., null)) and is proved on every
    // run by the Database job's own "Apply migrations" step.
    const FULL_REPLAY: string[] = [];
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'migration-deploy-support.test.ts');
    const usesDeploy = (source: string) => /\b(deployFrom|deployMigrations)\(/.test(source);
    // Any CREATE DATABASE, however the name is quoted or built; a suite that has it and deploys must also use the helper.
    const createsRawDatabase = (source: string) => /CREATE\s+DATABASE\b/i.test(source);
    const converted = files.filter((f) => readFileSync(join(dir, f), 'utf8').includes('createMigrationDatabase('));
    const replaying = files.filter((f) => {
      const source = readFileSync(join(dir, f), 'utf8');
      return usesDeploy(source) && createsRawDatabase(source) && !source.includes('createMigrationDatabase(');
    });
    expect(replaying.sort()).toEqual([...FULL_REPLAY].sort());
    // and the old per-suite filter that rebuilt the history older than the target by hand must not come back
    const handRolled = converted.filter((f) => /entry >= MIGRATION/.test(readFileSync(join(dir, f), 'utf8')));
    expect(handRolled).toEqual([]);
    expect(converted.length).toBeGreaterThanOrEqual(20);
  });
});

/*
 * The shared helper the real-database migration tests deploy through. It builds a migrations directory that
 * stops at (or just before) the migration under test, so a test never replays a migration written after it:
 * a later data-moving migration would otherwise change tables the test asserts are untouched.
 * No database is needed; this checks only which migration folders land in the directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { prepareMigrationsDir } from './migration-deploy-support';

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

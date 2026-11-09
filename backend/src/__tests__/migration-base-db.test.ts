/*
 * The migration base helper against real Postgres (the pure half is in migration-deploy-support.test.ts). It lives in a
 * `*-db.test.ts` file so the Database job's shards run it; the Backend job has no database and skips it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  type AdminSql, BASE_MIGRATION, assertAtMigrationBefore, baseName, createMigrationDatabase, deployMigrations,
} from './migration-deploy-support';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

type Sql = AdminSql & { $disconnect(): Promise<void> };
const url = process.env.TEST_DATABASE_URL;
const withDatabase = url ? describe : describe.skip;

withDatabase('migration base against real Postgres', () => {
  const admin = new PrismaClient({ datasources: { db: { url: url ?? '' } } }) as unknown as Sql;
  const dirs: string[] = [];
  const databases: string[] = [];
  const clients: Sql[] = [];
  const all = readdirSync(MIGRATIONS).filter((e) => e !== 'migration_lock.toml').sort();
  const target = all[all.length - 1]!;
  const urlOf = (name: string) => {
    const u = new URL(url ?? '');
    u.pathname = `/${name}`;
    return u.toString();
  };
  const clientFor = (name: string) => {
    const c = new PrismaClient({ datasources: { db: { url: urlOf(name) } } }) as unknown as Sql;
    clients.push(c);
    return c;
  };
  const newName = () => {
    const name = `t3244_unit_${randomUUID().slice(0, 8)}`;
    databases.push(name);
    return name;
  };

  afterAll(async () => {
    for (const c of clients) await c.$disconnect().catch(() => undefined);
    for (const name of databases) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('closes the run\'s base to connections once it is built', async () => {
    const base = baseName() ?? '';
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs); // builds the base if no suite did yet
    const [row] = (await admin.$queryRawUnsafe(`SELECT datallowconn AS open FROM pg_database WHERE datname = $1`, base)) as { open: boolean }[];
    expect(row?.open).toBe(false);
  }, 300_000);

  it('gives a target newer than the base a copy of the base, holding exactly the migrations up to the base', async () => {
    const name = newName();
    expect(await createMigrationDatabase(admin, name, target, dirs)).toBe('base');
    const applied = await clientFor(name).$queryRawUnsafe(
      `SELECT max(migration_name COLLATE "C") AS n FROM _prisma_migrations`);
    expect(applied[0]?.n).toBe(BASE_MIGRATION);
  }, 300_000);

  it('gives a target at the base the true empty database: no tables, no history', async () => {
    const name = newName();
    expect(await createMigrationDatabase(admin, name, BASE_MIGRATION, dirs)).toBe('empty');
    const tables = await clientFor(name).$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(tables[0]?.n).toBe(0);
  }, 300_000);

  it('gives a suite that asks for the empty database the empty database', async () => {
    const name = newName();
    expect(await createMigrationDatabase(admin, name, null, dirs)).toBe('empty');
  }, 300_000);

  it('accepts a database whose newest applied migration is the one before the target and the target is not applied', async () => {
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs);
    deployMigrations(urlOf(name), target, 'before', dirs); // asserts for itself
    expect(() => assertAtMigrationBefore(urlOf(name), target)).not.toThrow();
  }, 300_000);

  it('refuses a database that is behind: the newest applied migration is not the one before the target', async () => {
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs);
    const earlier = all[all.length - 3]!; // deployed up to all[length - 4], two behind what the target needs
    deployMigrations(urlOf(name), earlier, 'before', dirs);
    expect(() => assertAtMigrationBefore(urlOf(name), target)).toThrow(/newest applied migration is/);
  }, 300_000);

  it('refuses a database that already has the target applied', async () => {
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs);
    deployMigrations(urlOf(name), target, 'through', dirs);
    expect(() => assertAtMigrationBefore(urlOf(name), target)).toThrow(/newest applied migration is|already applied/);
  }, 300_000);

  // The wiring: the assertion must run as part of the "before" deploy itself, not only when a test calls it directly.
  it('"before" deploy refuses, on its own, a database that already holds the target', async () => {
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs);
    deployMigrations(urlOf(name), target, 'through', dirs);
    expect(() => deployMigrations(urlOf(name), target, 'before', dirs)).toThrow(/database is not at the migration before/);
  }, 300_000);

  it('refuses a database that records the target as started, even unfinished', async () => {
    const name = newName();
    await createMigrationDatabase(admin, name, target, dirs);
    deployMigrations(urlOf(name), target, 'before', dirs);
    await clientFor(name).$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES ($1, 'x', $2, now(), 0)`,
      randomUUID(), target);
    expect(() => assertAtMigrationBefore(urlOf(name), target)).toThrow(/already applied/);
  }, 300_000);
});

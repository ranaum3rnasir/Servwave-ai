/* =============================================================================
   Spider partial indexes (#2994): the migration, applied for real.

   On a fresh database at the migration before it, the Prisma deploy command applies the file and:
     - both indexes exist, with the names production is given by hand, on the right table and columns;
     - each is partial, with the exact predicate (open leads; unread recipient rows), and is not unique;
     - the file runs again where the indexes already exist (production gets them first, by hand) with no error.

   Builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases.
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

const MIGRATION = '20261103100000_spider_partial_indexes';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Spider partial indexes migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

const clientAt = (dbUrl: string) => new PrismaClient({ datasources: { db: { url: dbUrl } } });
type Db = ReturnType<typeof clientAt>;

interface IndexRow { indexname: string; tablename: string; indisunique: boolean; columns: string; predicate: string | null }

suite('Spider partial indexes migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const tempDirs: string[] = [];
  const name = `se_pidx_mig_${randomUUID().slice(0, 8)}`;
  let dbUrl = '';
  let db: Db | undefined;
  let dir = '';

  async function migrated(): Promise<Db> {
    if (db) return db;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    db = clientAt(dbUrl);
    deployMigrations(dbUrl, MIGRATION, 'before', tempDirs);
    const before = await indexes(db);
    expect(before, 'the indexes must not exist before the migration').toEqual([]);
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

  const indexes = (c: Db) =>
    c.$queryRawUnsafe<IndexRow[]>(
      `SELECT i.indexname, i.tablename, x.indisunique,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                 FROM unnest(x.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS columns,
              pg_get_expr(x.indpred, x.indrelid) AS predicate
         FROM pg_indexes i
         JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = 'public'::regnamespace
         JOIN pg_index x ON x.indexrelid = ic.oid
        WHERE i.schemaname = 'public'
          AND i.indexname IN ('leads_open_org_idx', 'notification_recipients_unread_org_notification_idx')
        ORDER BY i.indexname`);

  it('creates the open-leads index, partial on the three outcome stamps', async () => {
    const rows = await indexes(await migrated());
    const row = rows.find((r) => r.indexname === 'leads_open_org_idx');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ tablename: 'leads', indisunique: false, columns: 'organization_id' });
    expect(row!.predicate).toBe('((won_at IS NULL) AND (lost_at IS NULL) AND (cancelled_at IS NULL))');
  }, 300_000);

  it('creates the unread-recipients index, partial on read_at being empty', async () => {
    const rows = await indexes(await migrated());
    const row = rows.find((r) => r.indexname === 'notification_recipients_unread_org_notification_idx');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ tablename: 'notification_recipients', indisunique: false, columns: 'organization_id,notification_id' });
    expect(row!.predicate).toBe('(read_at IS NULL)');
  }, 300_000);

  it('runs again where the indexes already exist (production has them first) with no error and no change', async () => {
    const c = await migrated();
    const before = await indexes(c);
    const again = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
    expect(again.status, again.stderr).toBe(0);
    expect(await indexes(c)).toEqual(before);
    expect(before).toHaveLength(2);
  }, 300_000);

  it('has no CONCURRENTLY, which cannot run inside the migration transaction', () => {
    const sql = require('fs').readFileSync(MIGRATION_SQL, 'utf8').split('\n').filter((l: string) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/CONCURRENTLY/i);
  });
});

/* =============================================================================
   Payments go-live V7-10a - the attachments.source migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy
   (every migration BEFORE this one, with a file already written):
     - attachments gained a nullable `source` text column with no default, and the file that existed reads null;
     - the partial index for the Documents list exists and covers only marked rows;
     - nothing else about the existing row changed;
     - a second run of the file changes nothing and prints no error.

   Builds a throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployMigrations } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261016150000_attachment_source';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Attachment source migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('attachment source migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `v7_10a_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    // A cluster that also hosts the hosted platform's API roles needs the (stub) auth schema the oldest
    // migrations name; a vanilla server (CI) has neither and needs nothing.
    const roles = await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'authenticated'`);
    if (roles[0].n > 0) {
      await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS auth`);
      for (const fn of ['uid() RETURNS uuid', 'role() RETURNS text', 'jwt() RETURNS jsonb']) {
        const type = fn.split(' ').pop();
        await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION auth.${fn} LANGUAGE sql AS 'SELECT NULL::${type}'`);
      }
    }
    return { dbUrl, client };
  }

  const ids = { org: randomUUID(), user: randomUUID(), file: randomUUID(), entity: randomUUID() };

  /** One company with a file already on the books (the prod-shaped copy). */
  async function seed(db: Db) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ($1::uuid, 'Co V7 10a', 'v710a@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at)
       VALUES ($1::uuid, 'v710aadmin@example.test', 'Pat', 'Admin', 'ADMIN', $2::uuid, now())`, ids.user, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO attachments (id, entity_type, entity_id, file_name, file_url, storage_path, file_type, file_size, display_name, uploaded_by, organization_id)
       VALUES ($1::uuid, 'INVOICE', $2::uuid, 'receipt.pdf', 'x', 'p/receipt.pdf', 'application/pdf', 1000, 'receipt.pdf', $3::uuid, $4::uuid)`,
      ids.file, ids.entity, ids.user, ids.org);
  }

  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  const oldRow = (db: Db) => db.$queryRawUnsafe<unknown[]>(
    `SELECT id::text, entity_type::text, entity_id::text, file_name, file_url, storage_path, file_type, file_size, display_name, uploaded_by::text FROM attachments`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('adds a nullable source column with no default; the file that existed reads null and nothing else changed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const before = await oldRow(client);
    const without = await client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'source'`);
    expect(without[0].n).toBe(0);

    deploy(dbUrl, 'through');

    const col = await client.$queryRawUnsafe<{ data_type: string; is_nullable: string; column_default: string | null }[]>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'source'`);
    expect(col).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    expect(await oldRow(client)).toEqual(before);
    const value = await client.$queryRawUnsafe<{ source: string | null }[]>(`SELECT source FROM attachments WHERE id = $1::uuid`, ids.file);
    expect(value).toEqual([{ source: null }]);
  }, 300_000);

  it('adds a partial index over marked rows only', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    deploy(dbUrl, 'through');
    const idx = await client.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'attachments' AND indexname = 'attachments_organization_id_created_at_documents_idx'`);
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain('(organization_id, created_at DESC)');
    expect(idx[0].indexdef).toContain('WHERE (source IS NOT NULL)');
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');
    await client.$executeRawUnsafe(`UPDATE attachments SET source = 'PAYMENTS_DOCUMENTS' WHERE id = $1::uuid`, ids.file);

    const again = spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await client.$queryRawUnsafe(`SELECT source FROM attachments WHERE id = $1::uuid`, ids.file)).toEqual([{ source: 'PAYMENTS_DOCUMENTS' }]);
  }, 300_000);
});

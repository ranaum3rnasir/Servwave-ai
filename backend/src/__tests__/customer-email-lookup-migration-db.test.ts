/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.20 - the customer email lookup indexes, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy (every migration
   BEFORE this one, with a company, customers and an extra address already written):
     - the two expression indexes exist, on exactly the expression the address lookup compares (lower-cased address);
     - the lookup of `lib/communication/customerByAddress.ts` is answered from them (the planner is shown the index with a
       sequential scan ruled out, as a small table would otherwise be read whole);
     - the migration writes no row anywhere and changes no column (it is indexes only: no back-fill);
     - a second run of the file changes nothing and prints no error.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards. Skips when
   TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma CLI runs from a temp
   directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to the checkout's .env.
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

const MIGRATION = '20261012820000_customer_email_lookup_indexes';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Customer email lookup migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('customer email lookup indexes migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `s1020_mig_${randomUUID().slice(0, 8)}`;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
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

  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  function runFileAgain(dbUrl: string, dir: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
  }

  const ids = { org: randomUUID(), one: randomUUID(), two: randomUUID(), extra: randomUUID() };

  /** One company with two customers, one of them with a second address. */
  async function seed(db: Db) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ($1::uuid, 'Co S1020', 's1020@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, ids.org);
    for (const [id, number, email] of [[ids.one, 'C-1', 'One@Example.com'], [ids.two, 'C-2', 'two@example.com']] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO customers (id, organization_id, customer_number, kind, segment, first_name, email, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'PERSON', 'RESIDENTIAL', 'Pat', $4, now())`, id, ids.org, number, email);
    }
    await db.$executeRawUnsafe(`INSERT INTO customer_emails (id, customer_id, email) VALUES ($1::uuid, $2::uuid, 'Second@Example.com')`, ids.extra, ids.one);
  }

  const snapshot = (db: Db) =>
    db.$queryRawUnsafe<unknown[]>(
      `SELECT c.id::text, c.email, (SELECT count(*)::int FROM customer_emails ce WHERE ce.customer_id = c.id) AS extras FROM customers c ORDER BY c.id`);

  const indexes = (db: Db, table: string) =>
    db.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, table);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the two lower-cased address indexes on a copy that holds customers, and writes no row', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const before = await snapshot(client);
    const beforeIndexes = (await indexes(client, 'customers')).map((i) => i.indexname);
    expect(beforeIndexes).not.toContain('customers_organization_id_lower_email_idx');

    deploy(dbUrl, 'through');

    const onCustomers = (await indexes(client, 'customers')).find((i) => i.indexname === 'customers_organization_id_lower_email_idx');
    expect(onCustomers?.indexdef).toMatch(/\(organization_id, lower\(\(?email\)?(::text)?\)\)/);
    const onExtras = (await indexes(client, 'customer_emails')).find((i) => i.indexname === 'customer_emails_lower_email_idx');
    expect(onExtras?.indexdef).toMatch(/\(lower\(\(?email\)?(::text)?\)\)/);
    expect(await snapshot(client)).toEqual(before);
  }, 300_000);

  it('answers the address lookup from them', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');

    const plan = await client.$transaction(async (tx) => {
      // A table this small is read whole by choice; ruling that out shows the index is one the lookup can use.
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      const own = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM customers WHERE organization_id = '${ids.org}'::uuid AND lower(email) = ANY(ARRAY['one@example.com']::text[])`);
      const extra = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT customer_id FROM customer_emails WHERE lower(email) = ANY(ARRAY['second@example.com']::text[])`);
      return [...own, ...extra].map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('customers_organization_id_lower_email_idx');
    expect(plan).toContain('customer_emails_lower_email_idx');
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');
    const before = await snapshot(client);
    const beforeIndexes = await indexes(client, 'customers');

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await snapshot(client)).toEqual(before);
    expect(await indexes(client, 'customers')).toEqual(beforeIndexes);
  }, 300_000);
});

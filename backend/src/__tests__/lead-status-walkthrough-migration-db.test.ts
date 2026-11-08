/* =============================================================================
   Walkthrough lead statuses, slice 01 - the enum migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command):
     - enum_range(LeadStatus) is New, Contacted, Walkthrough Scheduled, Walkthrough Completed,
       Estimate Sent, Won, Lost, Cancelled (the order the leads list sorts by);
     - ORDER BY status over real leads gives that pipeline order;
     - on a prod-shaped copy (every migration BEFORE this one, leads in the old statuses), existing
       leads keep their status and the values are added between Contacted and ESTIMATED;
     - re-running the migration file is a no-op.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops
   it afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates
   and drops databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL
   passed explicitly, so it can never fall back to the checkout's .env (the shared staging DB).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261006200000_lead_status_add_walkthrough_values';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

const PIPELINE = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
  'ESTIMATED',
  'WON',
  'LOST',
  'CANCELLED',
];

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`lead-status migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

// One factory, typed as what it returns (see payment-ledger-states-migration-db.test.ts for why).
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('lead status walkthrough values migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `lws01_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  function cli(dbUrl: string, args: string[], cwd: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
  }

  /** The Prisma deploy command with either every migration or only those before MIGRATION. */
  function deploy(dbUrl: string, which: 'all' | 'before'): string {
    const dir = mkdtempSync(join(tmpdir(), 'lws01-mig-'));
    tempDirs.push(dir);
    copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
    const source = join(PRISMA_DIR, 'migrations');
    for (const entry of readdirSync(source)) {
      if (which === 'before' && entry !== 'migration_lock.toml' && entry >= MIGRATION) continue;
      cpSync(join(source, entry), join(dir, 'migrations', entry), { recursive: true });
    }
    const run = cli(dbUrl, ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], dir);
    if (run.status !== 0) throw new Error(`deploy failed:\n${run.stdout}\n${run.stderr}`);
    return dir;
  }

  async function enumRange(db: Db): Promise<string[]> {
    const rows = await db.$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'LeadStatus' ORDER BY e.enumsortorder`,
    );
    return rows.map((r) => r.label);
  }

  /** An org, a customer, then one lead per given status (raw SQL: the typed client may not know a status yet). */
  async function leadsIn(db: Db, statuses: string[]) {
    const org = randomUUID();
    const customer = randomUUID();
    const tag = org.slice(0, 8);
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ('${org}', 'lws01-${tag}', 'lws01-${tag}@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO customers (id, organization_id, customer_number, kind, segment, updated_at)
       VALUES ('${customer}', '${org}', 'C-${tag}', 'PERSON', 'RESIDENTIAL', now())`,
    );
    for (const [i, status] of statuses.entries()) {
      await db.$executeRawUnsafe(
        `INSERT INTO leads (id, organization_id, customer_id, lead_number, service_request, status, updated_at)
         VALUES ('${randomUUID()}', '${org}', '${customer}', 'L-${tag}-${i}', 'lws01', '${status}', now())`,
      );
    }
    return { org };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('enum_range is in pipeline order, and ORDER BY status sorts leads in that order', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'all');

    expect(await enumRange(client)).toEqual(PIPELINE);

    // Insert in a scrambled order; the database must hand them back in pipeline order.
    const scrambled = ['CANCELLED', 'WALKTHROUGH_COMPLETED', 'NEW', 'ESTIMATED', 'WALKTHROUGH_SCHEDULED', 'LOST', 'CONTACTED', 'WON'];
    const { org } = await leadsIn(client, scrambled);
    const sorted = await client.$queryRawUnsafe<{ status: string }[]>(
      `SELECT l.status::text AS status FROM leads l WHERE l.organization_id = '${org}' ORDER BY l.status ASC`,
    );
    expect(sorted.map((r) => r.status)).toEqual(PIPELINE);
  }, 180_000);

  it('re-running the migration file is a no-op', async () => {
    const { dbUrl, client } = await createDatabase();
    const dir = deploy(dbUrl, 'all');
    const before = await enumRange(client);

    const again = cli(
      dbUrl,
      ['db', 'execute', '--url', dbUrl, '--file', join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql')],
      dir,
    );
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await enumRange(client)).toEqual(before);
    expect(before).toEqual(PIPELINE);
  }, 180_000);

  it('on a prod-shaped copy, existing leads keep their status and the values land before ESTIMATED', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    expect(await enumRange(client)).toEqual(['NEW', 'CONTACTED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED']);

    const { org } = await leadsIn(client, ['NEW', 'CONTACTED', 'ESTIMATED', 'WON']);
    deploy(dbUrl, 'all');

    expect(await enumRange(client)).toEqual(PIPELINE);
    const rows = await client.$queryRawUnsafe<{ status: string }[]>(
      `SELECT l.status::text AS status FROM leads l WHERE l.organization_id = '${org}' ORDER BY l.status ASC`,
    );
    expect(rows.map((r) => r.status)).toEqual(['NEW', 'CONTACTED', 'ESTIMATED', 'WON']);
  }, 180_000);
});

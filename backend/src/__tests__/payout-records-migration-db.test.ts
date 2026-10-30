/* =============================================================================
   Payments go-live, slice P2 - the payout records migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, with a payment and a refund already written):
     - the payouts and payment_attention_resolutions tables exist, with the unique keys the sync relies on;
     - payments gained payout_id and failure_code, refunds gained failure_code, organizations gained
       payout_summary, all empty on the rows that already existed;
     - nothing existing changed (the old rows read back exactly as they were);
     - both new tables carry the fail-closed tenant policy (the RLS backstop);
     - a second run of the file changes nothing and prints no error.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it
   afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops
   databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging DB).
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

const MIGRATION = '20261013100000_payout_records';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Payout records migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('payout records migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `p2_mig_${randomUUID().slice(0, 8)}`;
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

  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  function runFileAgain(dbUrl: string, dir: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
  }

  const ids = { org: randomUUID(), user: randomUUID(), customer: randomUUID(), invoice: randomUUID(), payment: randomUUID(), refund: randomUUID() };

  /** One company with a payment and a refund already on the books (the prod-shaped copy). */
  async function seed(db: Db) {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ($1::uuid, 'Co P2', 'p2@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at)
       VALUES ($1::uuid, 'p2admin@example.test', 'Pat', 'Admin', 'ADMIN', $2::uuid, now())`, ids.user, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO customers (id, organization_id, customer_number, kind, segment, first_name, last_name, updated_at)
       VALUES ($1::uuid, $2::uuid, 'C-P2', 'PERSON', 'RESIDENTIAL', 'Pat', 'Payer', now())`, ids.customer, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO invoices (id, organization_id, customer_id, invoice_number, subtotal, tax_amount, total_amount, status, amount_due, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'INV-P2', 100, 0, 100, 'PAID', 0, now())`, ids.invoice, ids.org, ids.customer);
    await db.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ($1::uuid, $2::uuid, 100, 'CARD', now(), 'SUCCEEDED')`,
      ids.payment, ids.invoice);
    await db.$executeRawUnsafe(
      `INSERT INTO refunds (id, invoice_id, payment_id, amount, method, reason_category, refunded_by, organization_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 10, 'CARD', 'OTHER', $4::uuid, $5::uuid)`,
      ids.refund, ids.invoice, ids.payment, ids.user, ids.org);
  }

  const columns = (db: Db, table: string) =>
    db.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, table);

  const oldRows = (db: Db) =>
    db.$queryRawUnsafe<unknown[]>(
      `SELECT p.id::text AS payment, p.amount::text, p.state::text, r.id::text AS refund, r.amount::text AS refund_amount, r.state::text AS refund_state
       FROM payments p JOIN refunds r ON r.payment_id = p.id`);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the payout tables and columns on a copy that already holds payments and refunds, and changes nothing that existed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const before = await oldRows(client);

    deploy(dbUrl, 'through');

    const payouts = new Map((await columns(client, 'payouts')).map((c) => [c.column_name, c]));
    for (const name of ['id', 'organization_id', 'stripe_payout_id', 'status', 'amount', 'arrival_date', 'processor_created_at', 'is_automatic',
      'destination_label', 'failure_code', 'created_at', 'updated_at']) {
      expect(payouts.has(name), `payouts.${name}`).toBe(true);
    }
    // a text column and a TS union on purpose: a new Prisma enum would trip the frontend status registry
    expect(payouts.get('status')!.data_type).toBe('text');

    const resolutions = new Map((await columns(client, 'payment_attention_resolutions')).map((c) => [c.column_name, c]));
    for (const name of ['id', 'organization_id', 'item_key', 'resolution', 'note', 'resolved_by', 'resolved_by_name', 'resolved_at']) {
      expect(resolutions.has(name), `payment_attention_resolutions.${name}`).toBe(true);
    }

    const has = async (table: string, column: string) => (await columns(client, table)).some((c) => c.column_name === column);
    expect(await has('payments', 'payout_id')).toBe(true);
    expect(await has('payments', 'failure_code')).toBe(true);
    expect(await has('refunds', 'failure_code')).toBe(true);
    expect(await has('organizations', 'payout_summary')).toBe(true);

    // the rows that were there are untouched and read empty in the new columns
    expect(await oldRows(client)).toEqual(before);
    const payment = await client.$queryRawUnsafe<{ payout_id: string | null; failure_code: string | null }[]>(
      `SELECT payout_id::text, failure_code FROM payments WHERE id = $1::uuid`, ids.payment);
    expect(payment[0]).toEqual({ payout_id: null, failure_code: null });
    const refund = await client.$queryRawUnsafe<{ failure_code: string | null }[]>(`SELECT failure_code FROM refunds WHERE id = $1::uuid`, ids.refund);
    expect(refund[0].failure_code).toBeNull();
  }, 300_000);

  it('keeps one payout per processor id, one resolution per item per company, and clears a payment link when a payout row goes', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');

    const payoutId = randomUUID();
    const insertPayout = (id: string, processorId: string) => client.$executeRawUnsafe(
      `INSERT INTO payouts (id, organization_id, stripe_payout_id, status, amount, updated_at) VALUES ($1::uuid, $2::uuid, $3, 'PAID', 25.50, now())`,
      id, ids.org, processorId);
    await insertPayout(payoutId, 'po_unique');
    await expect(insertPayout(randomUUID(), 'po_unique')).rejects.toThrow();

    const insertResolution = () => client.$executeRawUnsafe(
      `INSERT INTO payment_attention_resolutions (id, organization_id, item_key, resolution, resolved_by_name) VALUES ($1::uuid, $2::uuid, $3, 'Marked resolved', 'Pat Admin')`,
      randomUUID(), ids.org, `failed_payment:${ids.payment}`);
    await insertResolution();
    await expect(insertResolution()).rejects.toThrow();

    await client.$executeRawUnsafe(`UPDATE payments SET payout_id = $1::uuid WHERE id = $2::uuid`, payoutId, ids.payment);
    await client.$executeRawUnsafe(`DELETE FROM payouts WHERE id = $1::uuid`, payoutId);
    const after = await client.$queryRawUnsafe<{ payout_id: string | null }[]>(`SELECT payout_id::text FROM payments WHERE id = $1::uuid`, ids.payment);
    expect(after[0].payout_id).toBeNull();
  }, 300_000);

  it('carries the fail-closed tenant policy on both new tables', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    deploy(dbUrl, 'through');

    const rows = await client.$queryRawUnsafe<{ table_name: string; rls_on: boolean; forced: boolean; policies: string }[]>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS forced,
              coalesce((SELECT string_agg(polname, ',') FROM pg_policy p WHERE p.polrelid = c.oid), '') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('payouts', 'payment_attention_resolutions') ORDER BY c.relname`);
    expect(rows).toEqual([
      { table_name: 'payment_attention_resolutions', rls_on: true, forced: true, policies: 'tenant_isolation' },
      { table_name: 'payouts', rls_on: true, forced: true, policies: 'tenant_isolation' },
    ]);
    // the policy itself is the one every org table carries: a company sees only its own rows, or none without a company set
    const policy = await client.$queryRawUnsafe<{ qual: string }[]>(
      `SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polrelid = 'public.payouts'::regclass`);
    expect(policy[0].qual).toContain('app.current_org_id');
    expect(policy[0].qual).toContain('organization_id');
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');
    await client.$executeRawUnsafe(
      `INSERT INTO payouts (id, organization_id, stripe_payout_id, status, amount, updated_at) VALUES ($1::uuid, $2::uuid, 'po_again', 'PAID', 1, now())`,
      randomUUID(), ids.org);
    const snapshot = await client.$queryRawUnsafe<unknown[]>(`SELECT stripe_payout_id, status, amount::text FROM payouts`);

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await client.$queryRawUnsafe(`SELECT stripe_payout_id, status, amount::text FROM payouts`)).toEqual(snapshot);
  }, 300_000);
});

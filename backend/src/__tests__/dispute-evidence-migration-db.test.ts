/* =============================================================================
   Payments go-live, slice P10 - the dispute evidence migration, applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped
   copy (every migration BEFORE this one, with an invoice, a payment, a file and a dispute already written):
     - the dispute gained the draft and submission columns, empty on the rows that already existed, and the
       dispute_evidence_items table exists with its unique key, its restrict link to the file and its cascade
       from the dispute;
     - nothing existing changed;
     - the new table carries the fail-closed tenant policy and a company cannot read another's rows;
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

const MIGRATION = '20261013200000_dispute_evidence';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Dispute evidence migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('dispute evidence migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `p10_mig_${randomUUID().slice(0, 8)}`;
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

  const ids = { org: randomUUID(), org2: randomUUID(), user: randomUUID(), customer: randomUUID(), invoice: randomUUID(), payment: randomUUID(), dispute: randomUUID(), file: randomUUID() };

  /** One company with an invoice, a payment, a stored file and a dispute already on the books (the prod-shaped copy). */
  async function seed(db: Db) {
    for (const [org, tag] of [[ids.org, 'a'], [ids.org2, 'b']] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
         VALUES ($1::uuid, 'Co P10 ' || $2, 'p10' || $2 || '@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`, org, tag);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at)
       VALUES ($1::uuid, 'p10admin@example.test', 'Pat', 'Admin', 'ADMIN', $2::uuid, now())`, ids.user, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO customers (id, organization_id, customer_number, kind, segment, first_name, last_name, updated_at)
       VALUES ($1::uuid, $2::uuid, 'C-P10', 'PERSON', 'RESIDENTIAL', 'Pat', 'Payer', now())`, ids.customer, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO invoices (id, organization_id, customer_id, invoice_number, subtotal, tax_amount, total_amount, status, amount_due, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'INV-P10', 100, 0, 100, 'PAID', 0, now())`, ids.invoice, ids.org, ids.customer);
    await db.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, state) VALUES ($1::uuid, $2::uuid, 100, 'CARD', now(), 'SUCCEEDED')`,
      ids.payment, ids.invoice);
    await db.$executeRawUnsafe(
      `INSERT INTO attachments (id, entity_type, entity_id, file_name, file_url, storage_path, file_type, file_size, display_name, uploaded_by, organization_id)
       VALUES ($1::uuid, 'INVOICE', $2::uuid, 'receipt.pdf', 'x', 'p/receipt.pdf', 'application/pdf', 1000, 'receipt.pdf', $3::uuid, $4::uuid)`,
      ids.file, ids.invoice, ids.user, ids.org);
    await db.$executeRawUnsafe(
      `INSERT INTO disputes (id, organization_id, invoice_id, payment_id, stripe_dispute_id, status, amount, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'dp_p10', 'NEEDS_RESPONSE', 100, now())`, ids.dispute, ids.org, ids.invoice, ids.payment);
  }

  const columns = (db: Db, table: string) =>
    db.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, table);

  const oldRows = (db: Db) =>
    db.$queryRawUnsafe<unknown[]>(
      `SELECT d.id::text AS dispute, d.stripe_dispute_id, d.status::text, d.amount::text, a.id::text AS file, a.file_name FROM disputes d, attachments a`);

  const addItem = (db: Db, field = 'receipt') => db.$executeRawUnsafe(
    `INSERT INTO dispute_evidence_items (id, organization_id, dispute_id, evidence_field, attachment_id, file_name, mime, size_bytes, page_count, sha256)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'receipt.pdf', 'application/pdf', 1000, 2, 'abc')`,
    randomUUID(), ids.org, ids.dispute, field, ids.file);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the draft columns and the items table on a copy that already holds a dispute, and changes nothing that existed', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const before = await oldRows(client);

    deploy(dbUrl, 'through');

    const disputes = new Map((await columns(client, 'disputes')).map((c) => [c.column_name, c]));
    for (const name of ['evidence_text', 'evidence_version', 'evidence_staged_at', 'evidence_submitted_at', 'evidence_submitted_by',
      'evidence_submitted_by_name', 'evidence_submission_count']) {
      expect(disputes.has(name), `disputes.${name}`).toBe(true);
    }
    expect(disputes.get('evidence_text')!.data_type).toBe('jsonb');
    expect(disputes.get('evidence_version')!.is_nullable).toBe('NO');
    expect(disputes.get('evidence_submission_count')!.is_nullable).toBe('NO');
    expect(disputes.get('evidence_staged_at')!.data_type).toBe('timestamp with time zone');

    const items = new Map((await columns(client, 'dispute_evidence_items')).map((c) => [c.column_name, c]));
    for (const name of ['id', 'organization_id', 'dispute_id', 'evidence_field', 'attachment_id', 'file_name', 'mime', 'size_bytes', 'page_count',
      'sha256', 'processor_file_id', 'staged_at', 'submitted_at']) {
      expect(items.has(name), `dispute_evidence_items.${name}`).toBe(true);
    }
    expect(items.get('processor_file_id')!.is_nullable).toBe('YES');

    expect(await oldRows(client)).toEqual(before);
    const row = await client.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT evidence_text, evidence_version, evidence_staged_at, evidence_submitted_at, evidence_submitted_by, evidence_submitted_by_name, evidence_submission_count FROM disputes WHERE id = $1::uuid`, ids.dispute);
    expect(row[0]).toEqual({
      evidence_text: null, evidence_version: 0, evidence_staged_at: null, evidence_submitted_at: null, evidence_submitted_by: null,
      evidence_submitted_by_name: null, evidence_submission_count: 0,
    });
  }, 300_000);

  it('keeps one file per field, refuses to delete a file that is attached and clears items with their dispute', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');

    await addItem(client);
    await expect(addItem(client)).rejects.toThrow();
    await addItem(client, 'refund_policy');

    await expect(client.$executeRawUnsafe(`DELETE FROM attachments WHERE id = $1::uuid`, ids.file)).rejects.toThrow();

    await client.$executeRawUnsafe(`DELETE FROM disputes WHERE id = $1::uuid`, ids.dispute);
    const left = await client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM dispute_evidence_items`);
    expect(left[0].n).toBe(0);
    // once nothing holds the file, it can go
    await client.$executeRawUnsafe(`DELETE FROM attachments WHERE id = $1::uuid`, ids.file);
  }, 300_000);

  it('sets the submitter to null when the person is deleted', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');
    const other = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO users (id, email, first_name, last_name, role, organization_id, updated_at) VALUES ($1::uuid, 'p10other@example.test', 'Sam', 'Other', 'ADMIN', $2::uuid, now())`, other, ids.org);
    await client.$executeRawUnsafe(`UPDATE disputes SET evidence_submitted_by = $1::uuid, evidence_submitted_by_name = 'Sam Other' WHERE id = $2::uuid`, other, ids.dispute);
    await client.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, other);
    const row = await client.$queryRawUnsafe<{ by: string | null; name: string | null }[]>(
      `SELECT evidence_submitted_by::text AS by, evidence_submitted_by_name AS name FROM disputes WHERE id = $1::uuid`, ids.dispute);
    expect(row[0]).toEqual({ by: null, name: 'Sam Other' });
  }, 300_000);

  it('carries the fail-closed tenant policy on the new table and hides another company\'s rows', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    deploy(dbUrl, 'through');
    await addItem(client);

    const rows = await client.$queryRawUnsafe<{ table_name: string; rls_on: boolean; forced: boolean; policies: string }[]>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_on, c.relforcerowsecurity AS forced,
              coalesce((SELECT string_agg(polname, ',') FROM pg_policy p WHERE p.polrelid = c.oid), '') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'dispute_evidence_items'`);
    expect(rows).toEqual([{ table_name: 'dispute_evidence_items', rls_on: true, forced: true, policies: 'tenant_isolation' }]);

    // Behaviour, as a role that does not bypass row security: the owning company reads its row, another reads none.
    const role = `p10_rls_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await client.$executeRawUnsafe(`GRANT SELECT ON dispute_evidence_items TO ${role}`);
      const countAs = (org: string) => client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${org}', true)`);
        return (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM dispute_evidence_items`))[0].n;
      });
      expect(await countAs(ids.org)).toBe(1);
      expect(await countAs(ids.org2)).toBe(0);
    } finally {
      await client.$executeRawUnsafe(`REVOKE ALL ON dispute_evidence_items FROM ${role}`).catch(() => undefined);
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
  }, 300_000);

  it('a second run of the file changes nothing and reports no error', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    await seed(client);
    const dir = deploy(dbUrl, 'through');
    await addItem(client);
    await client.$executeRawUnsafe(`UPDATE disputes SET evidence_version = 3, evidence_text = '{"customer_name":"Pat"}'::jsonb WHERE id = $1::uuid`, ids.dispute);
    const snapshot = await client.$queryRawUnsafe<unknown[]>(`SELECT d.evidence_version, d.evidence_text::text, (SELECT count(*)::int FROM dispute_evidence_items) AS items FROM disputes d`);

    const again = runFileAgain(dbUrl, dir);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await client.$queryRawUnsafe(`SELECT d.evidence_version, d.evidence_text::text, (SELECT count(*)::int FROM dispute_evidence_items) AS items FROM disputes d`)).toEqual(snapshot);
  }, 300_000);
});

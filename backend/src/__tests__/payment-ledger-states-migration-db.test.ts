/* =============================================================================
   Payments go-live, slice 04 - the ledger schema migration, applied for real.

   The migration gives every payment a state (PROCESSING | SUCCEEDED | FAILED) and every
   refund a state (PENDING | SUCCEEDED | FAILED), adds ACH as an online bank-debit method and
   adds the display/lookup fields a processor charge carries. The promise it must keep is
   "every existing row is unchanged in meaning": every payment and refund that exists when it
   runs reads SUCCEEDED afterwards.

   That promise is physical (a column default, a backfill, an enum the database accepts), so it
   is proven against real Postgres, the way Render applies it: `prisma migrate deploy`.
     - FRESH DB:        every migration, this one included, onto an empty database.
     - PROD-SHAPED COPY: every migration BEFORE this one, then payments and refunds written in
                         the old shape (card, manual, voided, refunded), then this migration on
                         top of those rows.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and
   drops it afterwards. Skips when TEST_DATABASE_URL is unset, like every other *-db suite, and
   REFUSES to run against anything but a local server: it creates and drops databases.

   The Prisma CLI is run from a temp directory holding a copy of the schema and migrations, with
   DATABASE_URL and DIRECT_URL passed explicitly. No .env is in reach of that directory, so it
   cannot fall back to the checkout's .env (which points at the shared staging database).
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

/** The migration under test. Everything sorted before it is "the old shape". */
const MIGRATION = '20261006120000_payment_ledger_states';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`payment-ledger migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

/**
 * Every client here is `new PrismaClient({ datasources })`, whose inferred options generic differs
 * from a bare `PrismaClient`. Relating the two (a `PrismaClient[]` push, a `PrismaClient` return
 * type or parameter) makes tsc compare the whole generated client structurally: about 3.7M type
 * instantiations and ~800MB of heap, enough to push the backend type-check past the CI runner's
 * heap limit. So every client in this suite is built by one function and typed as what it returns.
 */
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type LedgerClient = ReturnType<typeof clientAt>;

suite('payment ledger states migration (real database)', () => {
  // describe.skip still runs this body to collect the tests, so nothing here may assume a URL.
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: LedgerClient[] = [];
  const tempDirs: string[] = [];

  function urlFor(db: string): string {
    const u = new URL(server.toString());
    u.pathname = `/${db}`;
    return u.toString();
  }

  async function createDatabase(): Promise<{ dbUrl: string; client: LedgerClient }> {
    const name = `pay04_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const dbUrl = urlFor(name);
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  /** `prisma migrate deploy` with either every migration or only those before MIGRATION. */
  function deploy(dbUrl: string, which: 'all' | 'before'): void {
    const dir = mkdtempSync(join(tmpdir(), 'pay04-mig-'));
    tempDirs.push(dir);
    copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
    const source = join(PRISMA_DIR, 'migrations');
    for (const entry of readdirSync(source)) {
      if (which === 'before' && entry !== 'migration_lock.toml' && entry >= MIGRATION) continue;
      cpSync(join(source, entry), join(dir, 'migrations', entry), { recursive: true });
    }
    const run = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
    if (run.status !== 0) throw new Error(`migrate deploy failed:\n${run.stdout}\n${run.stderr}`);
  }

  /** Writes an org, a user, a customer and an invoice in the old shape; returns their ids. */
  async function oldShapeInvoice(db: LedgerClient) {
    const org = randomUUID();
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const tag = org.slice(0, 8);
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, updated_at)
       VALUES ('${org}', 'pay04-${tag}', 'pay04-${tag}@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO users (id, organization_id, email, first_name, last_name, role, updated_at)
       VALUES ('${user}', '${org}', 'admin-${tag}@example.test', 'Test', 'Admin', 'ADMIN', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO customers (id, organization_id, customer_number, kind, segment, updated_at)
       VALUES ('${customer}', '${org}', 'C-${tag}', 'PERSON', 'RESIDENTIAL', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO invoices (id, organization_id, customer_id, invoice_number, subtotal, tax_amount, total_amount, amount_due, updated_at)
       VALUES ('${invoice}', '${org}', '${customer}', 'INV-${tag}', 500, 0, 500, 0, now())`,
    );
    return { org, user, customer, invoice };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('applies on a fresh database, and a payment written without a state reads SUCCEEDED', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'all');

    const { invoice } = await oldShapeInvoice(client);
    const payment = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at) VALUES ('${payment}', '${invoice}', 120, 'CASH', now())`,
    );

    const row = await client.payment.findUniqueOrThrow({ where: { id: payment } });
    expect(row.state).toBe('SUCCEEDED');

    // The shared staging database may see a migration twice: running it again changes nothing.
    const again = spawnSync(
      process.execPath,
      [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql')],
      { cwd: tempDirs[tempDirs.length - 1], env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }, encoding: 'utf8' },
    );
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect((await client.payment.findUniqueOrThrow({ where: { id: payment } })).state).toBe('SUCCEEDED');
  }, 180_000);

  it('on a prod-shaped copy, every payment that existed before it reads SUCCEEDED, the rest of the row untouched', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');

    const { invoice, user } = await oldShapeInvoice(client);
    const card = randomUUID();
    const manual = randomUUID();
    const voided = randomUUID();
    const refunded = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, stripe_payment_intent_id, stripe_account_id) VALUES
         ('${card}', '${invoice}', 200, 'CARD', '2026-09-01T10:00:00Z', 'pi_old_shape', 'acct_old_shape')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, collected_by, reference_number) VALUES
         ('${manual}', '${invoice}', 150, 'BANK_TRANSFER', '2026-09-02T10:00:00Z', '${user}', 'wire-77')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, voided_at, voided_reason) VALUES
         ('${voided}', '${invoice}', 50, 'CHECK', '2026-09-03T10:00:00Z', '2026-09-04T10:00:00Z', 'bounced')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at, refunded_at, refunded_amount) VALUES
         ('${refunded}', '${invoice}', 100, 'CARD', '2026-09-05T10:00:00Z', '2026-09-06T10:00:00Z', 100)`,
    );

    deploy(dbUrl, 'all');

    const rows = await client.payment.findMany({ where: { invoice_id: invoice }, orderBy: { paid_at: 'asc' } });
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      [card, 'SUCCEEDED'],
      [manual, 'SUCCEEDED'],
      [voided, 'SUCCEEDED'],
      [refunded, 'SUCCEEDED'],
    ]);
    // Unchanged in meaning: the money, the method and the processor link read exactly as before.
    expect(rows.map((r) => [Number(r.amount), r.method])).toEqual([
      [200, 'CARD'],
      [150, 'BANK_TRANSFER'],
      [50, 'CHECK'],
      [100, 'CARD'],
    ]);
    expect(rows[0]?.stripe_payment_intent_id).toBe('pi_old_shape');
    expect(rows[1]?.reference_number).toBe('wire-77');
    expect(rows[2]?.voided_at).not.toBeNull();
    expect(Number(rows[3]?.refunded_amount)).toBe(100);
  }, 180_000);

  it('a fresh database stores an online bank debit (ACH) and a wallet card payment with their display details, found by processor ids', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'all');
    const { invoice } = await oldShapeInvoice(client);

    const bank = await client.payment.create({
      data: {
        invoice_id: invoice, amount: 480, method: 'ACH', state: 'PROCESSING', paid_at: new Date('2026-10-06T12:00:00Z'),
        bank_name: 'STRIPE TEST BANK', bank_last4: '6789',
        stripe_charge_id: 'py_bank_1', stripe_checkout_session_id: 'cs_bank_1',
      },
    });
    const wallet = await client.payment.create({
      data: {
        invoice_id: invoice, amount: 20, method: 'CARD', paid_at: new Date('2026-10-06T12:05:00Z'),
        wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242',
        stripe_charge_id: 'ch_card_1', stripe_checkout_session_id: 'cs_card_1',
      },
    });

    const byCharge = await client.payment.findFirstOrThrow({ where: { stripe_charge_id: 'py_bank_1' } });
    expect([byCharge.id, byCharge.method, byCharge.state, byCharge.bank_name, byCharge.bank_last4, byCharge.wallet]).toEqual([
      bank.id, 'ACH', 'PROCESSING', 'STRIPE TEST BANK', '6789', null,
    ]);
    const bySession = await client.payment.findFirstOrThrow({ where: { stripe_checkout_session_id: 'cs_card_1' } });
    expect([bySession.id, bySession.state, bySession.wallet, bySession.card_brand, bySession.card_last4]).toEqual([
      wallet.id, 'SUCCEEDED', 'APPLE_PAY', 'visa', '4242',
    ]);
    // The manual vocabulary is untouched: BANK_TRANSFER is still a recordable method beside ACH.
    const manual = await client.payment.create({
      data: { invoice_id: invoice, amount: 5, method: 'BANK_TRANSFER', paid_at: new Date('2026-10-06T12:10:00Z') },
    });
    expect([manual.method, manual.state, manual.wallet, manual.stripe_charge_id]).toEqual(['BANK_TRANSFER', 'SUCCEEDED', null, null]);

    // Every later processor event resolves its payment by one of these two ids, so both are indexed.
    const indexed = await client.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'payments'`,
    );
    const defs = indexed.map((i) => i.indexdef);
    expect(defs.some((d) => /\(stripe_charge_id\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(stripe_checkout_session_id\)/.test(d))).toBe(true);
  }, 180_000);

  it('one checkout session and one charge can only ever be one payment, while payments with no processor ids stay unlimited', async () => {
    // A bank debit sends several DIFFERENT events for the same money, possibly out of order and at
    // the same time. Each has its own event id, so the webhook's event claim cannot stop two
    // handlers from each booking a payment; the database has to.
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'all');
    const { invoice } = await oldShapeInvoice(client);
    const paidAt = new Date('2026-10-06T12:00:00Z');

    await client.payment.create({
      data: { invoice_id: invoice, amount: 480, method: 'ACH', state: 'PROCESSING', paid_at: paidAt,
        stripe_charge_id: 'py_once', stripe_checkout_session_id: 'cs_once' },
    });

    const sameSession = client.payment.create({
      data: { invoice_id: invoice, amount: 480, method: 'ACH', state: 'PROCESSING', paid_at: paidAt,
        stripe_checkout_session_id: 'cs_once' },
    });
    await expect(sameSession).rejects.toMatchObject({ code: 'P2002' });
    const sameCharge = client.payment.create({
      data: { invoice_id: invoice, amount: 480, method: 'ACH', state: 'SUCCEEDED', paid_at: paidAt,
        stripe_charge_id: 'py_once' },
    });
    await expect(sameCharge).rejects.toMatchObject({ code: 'P2002' });

    // Manual and deposit-credit payments carry neither id: any number of them coexist.
    for (const amount of [5, 6, 7]) {
      await client.payment.create({ data: { invoice_id: invoice, amount, method: 'CASH', paid_at: paidAt } });
    }
    expect(await client.payment.count({ where: { invoice_id: invoice } })).toBe(4);
    expect(await client.payment.count({ where: { stripe_checkout_session_id: 'cs_once' } })).toBe(1);
    expect(await client.payment.count({ where: { stripe_charge_id: 'py_once' } })).toBe(1);
  }, 180_000);

  it('on a prod-shaped copy, every refund that existed before it reads SUCCEEDED, and a new one written without a state does too', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');

    const { org, invoice, user } = await oldShapeInvoice(client);
    const payment = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO payments (id, invoice_id, amount, method, paid_at) VALUES ('${payment}', '${invoice}', 300, 'CARD', '2026-09-01T10:00:00Z')`,
    );
    const byProcessor = randomUUID();
    const byHand = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO refunds (id, organization_id, invoice_id, payment_id, amount, method, reason_category, refunded_by, stripe_refund_id, created_at) VALUES
         ('${byProcessor}', '${org}', '${invoice}', '${payment}', 40, 'CARD', 'CUSTOMER_REQUEST', '${user}', 're_old_shape', '2026-09-02T10:00:00Z')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO refunds (id, organization_id, invoice_id, amount, method, reason_category, refunded_by, created_at) VALUES
         ('${byHand}', '${org}', '${invoice}', 25, 'CASH', 'OVERPAYMENT', '${user}', '2026-09-03T10:00:00Z')`,
    );

    deploy(dbUrl, 'all');

    const after = await client.refund.findMany({ where: { invoice_id: invoice }, orderBy: { created_at: 'asc' } });
    expect(after.map((r) => [r.id, r.state, Number(r.amount), r.method, r.stripe_refund_id])).toEqual([
      [byProcessor, 'SUCCEEDED', 40, 'CARD', 're_old_shape'],
      [byHand, 'SUCCEEDED', 25, 'CASH', null],
    ]);

    const fresh = randomUUID();
    await client.$executeRawUnsafe(
      `INSERT INTO refunds (id, organization_id, invoice_id, amount, method, reason_category, refunded_by) VALUES
         ('${fresh}', '${org}', '${invoice}', 10, 'CHECK', 'GOODWILL', '${user}')`,
    );
    expect((await client.refund.findUniqueOrThrow({ where: { id: fresh } })).state).toBe('SUCCEEDED');
  }, 180_000);
});

/* =============================================================================
   Payments go-live, slice 19 - the payment options migration, applied for real.

   The migration adds the org payment defaults (tips on/off, three tip presets, deposit policy,
   bank-transfer instructions, card and bank offered by default), the invoice overrides
   (methods, allow-partial) and the estimate deposit-policy override. Whether the account can
   take bank payments is ACH's presence in accepted_payment_methods, not a column of its own.
   Its promise is "existing orgs read the defaults": tips off, presets 10/15/20, deposit
   required before approval (today's behaviour), card and bank offered by default, no ACH,
   every override null. Bank-transfer instructions an org already wrote
   (the legacy per-org setting row) move onto the org.

   Proven against real Postgres the way Render applies it, `prisma migrate deploy`:
     - FRESH DB:         every migration onto an empty database.
     - PROD-SHAPED COPY: every migration BEFORE this one, rows in the old shape, then this one.
   Skips when TEST_DATABASE_URL is unset and refuses anything but a local server, because it
   creates and drops databases. The Prisma CLI runs from a temp directory with the URLs passed
   explicitly, so it can never fall back to the checkout's .env (the shared staging database).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import { deployFrom } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261006210000_payment_options';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`payment-options migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

/**
 * Every client is built by this one function and typed as what it returns: relating a
 * `new PrismaClient({ datasources })` to a bare `PrismaClient` type blows up the backend
 * type-check's memory on the CI runner (see payment-ledger-states-migration-db.test.ts).
 */
function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type OptionsClient = ReturnType<typeof clientAt>;

suite('payment options migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: OptionsClient[] = [];
  const tempDirs: string[] = [];

  function urlFor(db: string): string {
    const u = new URL(server.toString());
    u.pathname = `/${db}`;
    return u.toString();
  }

  async function createDatabase(): Promise<{ dbUrl: string; client: OptionsClient }> {
    const name = `pay19_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const dbUrl = urlFor(name);
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  function deploy(dbUrl: string, which: 'all' | 'before'): string {
    const dir = mkdtempSync(join(tmpdir(), 'pay19-mig-'));
    tempDirs.push(dir);
    copyFileSync(join(PRISMA_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
    const source = join(PRISMA_DIR, 'migrations');
    for (const entry of readdirSync(source)) {
      if (which === 'before' && entry !== 'migration_lock.toml' && entry >= MIGRATION) continue;
      cpSync(join(source, entry), join(dir, 'migrations', entry), { recursive: true });
    }
    // The shared deploy gives the database the stub auth helpers first (see migration-deploy-support).
    deployFrom(dbUrl, dir);
    return dir;
  }

  async function oldShapeOrg(db: OptionsClient) {
    const org = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const tag = org.slice(0, 8);
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, accepted_payment_methods, stripe_charges_enabled, updated_at)
       VALUES ('${org}', 'pay19-${tag}', 'pay19-${tag}@example.test', '1 Test Way', 'Testville', 'MA', '02108', '', '', '', '["CARD","CHECK"]', true, now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO customers (id, organization_id, customer_number, kind, segment, updated_at)
       VALUES ('${customer}', '${org}', 'C-${tag}', 'PERSON', 'RESIDENTIAL', now())`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO invoices (id, organization_id, customer_id, invoice_number, subtotal, tax_amount, total_amount, amount_due, updated_at)
       VALUES ('${invoice}', '${org}', '${customer}', 'INV-${tag}', 500, 0, 500, 500, now())`,
    );
    return { org, invoice };
  }

  async function bankInstructionsSetting(db: OptionsClient, org: string, value: string) {
    await db.$executeRawUnsafe(
      `INSERT INTO app_settings (organization_id, key, value, updated_at)
       VALUES ('${org}', 'bank_transfer_instructions', '${value.replace(/'/g, "''")}', now())`,
    );
  }

  async function expectDefaults(db: OptionsClient, org: string, invoice: string) {
    const o = await db.organization.findUniqueOrThrow({
      where: { id: org },
      select: { card_offered_by_default: true, bank_offered_by_default: true, tips_enabled: true, tip_presets: true, deposit_policy: true, accepted_payment_methods: true },
    });
    expect(o).toEqual({
      card_offered_by_default: true,
      bank_offered_by_default: true,
      tips_enabled: false,
      tip_presets: [10, 15, 20],
      deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
      accepted_payment_methods: ['CARD', 'CHECK'],
    });
    const i = await db.invoice.findUniqueOrThrow({
      where: { id: invoice },
      select: { payment_methods_override: true, allow_partial_payment: true },
    });
    expect(i).toEqual({ payment_methods_override: null, allow_partial_payment: null });
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('applies on a fresh database; an org and invoice written without the new fields read the defaults; running it twice changes nothing', async () => {
    const { dbUrl, client } = await createDatabase();
    const dir = deploy(dbUrl, 'all');
    const { org, invoice } = await oldShapeOrg(client);
    await expectDefaults(client, org, invoice);

    // The estimate override exists and is nullable with no default (null = follow the org).
    const col = await client.$queryRawUnsafe<{ is_nullable: string; column_default: string | null; udt_name: string }[]>(
      `SELECT is_nullable, column_default, udt_name FROM information_schema.columns WHERE table_name = 'estimates' AND column_name = 'deposit_policy'`,
    );
    expect(col).toEqual([{ is_nullable: 'YES', column_default: null, udt_name: 'DepositPolicy' }]);

    const again = spawnSync(
      process.execPath,
      [PRISMA_CLI, 'db', 'execute', '--url', dbUrl, '--file', join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql')],
      { cwd: dir, env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl }, encoding: 'utf8' },
    );
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    await expectDefaults(client, org, invoice);
  }, 180_000);

  it('on a prod-shaped copy, existing orgs read the defaults and keep the bank-transfer instructions they wrote', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const written = await oldShapeOrg(client);
    const blank = await oldShapeOrg(client);
    const none = await oldShapeOrg(client);
    await bankInstructionsSetting(client, written.org, "Wire to account 000123. Use the invoice number as the memo; we'll mark it paid.");
    await bankInstructionsSetting(client, blank.org, '');

    deploy(dbUrl, 'all');

    for (const o of [written, blank, none]) await expectDefaults(client, o.org, o.invoice);
    const instructions = await client.organization.findMany({
      where: { id: { in: [written.org, blank.org, none.org] } },
      select: { id: true, bank_transfer_instructions: true },
    });
    const byId = Object.fromEntries(instructions.map((r) => [r.id, r.bank_transfer_instructions]));
    expect(byId).toEqual({
      [written.org]: "Wire to account 000123. Use the invoice number as the memo; we'll mark it paid.",
      [blank.org]: null,
      [none.org]: null,
    });
  }, 180_000);

  // ACH in accepted_payment_methods now means "the account can take bank payments", written only
  // by the account-status sync (conductor decision 2026-10-06). An ACH a settings payload stored
  // before this migration is not that fact, so the migration removes it and keeps the rest in
  // order; the next refresh or account update adds it back for an account that can take it.
  it('on a prod-shaped copy, an ACH a settings save stored is removed and the other methods keep their order', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const withAch = await oldShapeOrg(client);
    const without = await oldShapeOrg(client);
    await client.$executeRawUnsafe(
      `UPDATE organizations SET accepted_payment_methods = '["CHECK","ACH","CARD","ZELLE"]' WHERE id = '${withAch.org}'`,
    );

    deploy(dbUrl, 'all');

    const rows = await client.organization.findMany({
      where: { id: { in: [withAch.org, without.org] } },
      select: { id: true, accepted_payment_methods: true },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.accepted_payment_methods]));
    expect(byId).toEqual({
      [withAch.org]: ['CHECK', 'CARD', 'ZELLE'],
      [without.org]: ['CARD', 'CHECK'],
    });
  }, 180_000);
});

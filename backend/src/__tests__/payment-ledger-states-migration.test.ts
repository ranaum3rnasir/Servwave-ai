import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PaymentMethod, PaymentState, PaymentWallet, RefundState } from '@prisma/client';

/**
 * Payments go-live slice 04 - the ledger migration's shape, in the ordinary (no database) suite.
 *
 * The behaviour itself (applies on a fresh DB and on a prod-shaped copy, every existing payment
 * and refund reads SUCCEEDED) is proven against real Postgres in
 * payment-ledger-states-migration-db.test.ts, which needs TEST_DATABASE_URL. This file pins the
 * properties that keep that true on every database the migration meets, so a later edit cannot
 * quietly break them where no real database runs.
 */
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261006120000_payment_ledger_states/migration.sql'),
  'utf8',
);
// Statements only: the header prose names things the SQL must not do.
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('payment ledger states migration', () => {
  it('backfills by default: both state columns are NOT NULL DEFAULT SUCCEEDED', () => {
    expect(statements).toMatch(/ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "state" "PaymentState" NOT NULL DEFAULT 'SUCCEEDED'/);
    expect(statements).toMatch(/ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "state" "RefundState" NOT NULL DEFAULT 'SUCCEEDED'/);
  });

  it('adds ACH with ADD VALUE and never uses it in the same migration', () => {
    expect(statements).toMatch(/ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ACH'/);
    expect(statements.match(/'ACH'/g)).toHaveLength(1);
  });

  it('is idempotent: every type is guarded and every column and index is IF NOT EXISTS', () => {
    for (const type of ['PaymentState', 'RefundState', 'PaymentWallet']) {
      expect(statements).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_type WHERE typname = '${type}'\\)`));
    }
    const adds = statements.match(/ADD COLUMN[^;]*/g) ?? [];
    expect(adds.length).toBe(9);
    expect(adds.filter((a) => !a.startsWith('ADD COLUMN IF NOT EXISTS'))).toEqual([]);
    const indexes = statements.match(/CREATE (UNIQUE )?INDEX[^;]*/g) ?? [];
    expect(indexes.length).toBe(2);
    expect(indexes.filter((i) => !/INDEX IF NOT EXISTS/.test(i))).toEqual([]);
  });

  it('makes each processor id unique, so one checkout session or one charge is never two payments', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_charge_id_key" ON "payments"\("stripe_charge_id"\)/);
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_checkout_session_id_key" ON "payments"\("stripe_checkout_session_id"\)/,
    );
    expect(statements).not.toMatch(/CREATE INDEX IF NOT EXISTS "payments_stripe_(charge|checkout_session)_id_idx"/);
  });

  it('is pure expand: nothing dropped, renamed or narrowed, and no invoice status added', () => {
    expect(statements).not.toMatch(/DROP |RENAME |SET NOT NULL|ALTER COLUMN|"InvoiceStatus"/i);
  });

  it('the generated client carries the new vocabularies', () => {
    expect(Object.values(PaymentState)).toEqual(['PROCESSING', 'SUCCEEDED', 'FAILED']);
    expect(Object.values(RefundState)).toEqual(['PENDING', 'SUCCEEDED', 'FAILED']);
    expect(Object.values(PaymentWallet)).toEqual(['APPLE_PAY', 'GOOGLE_PAY', 'LINK']);
    expect(PaymentMethod.ACH).toBe('ACH');
    expect(PaymentMethod.BANK_TRANSFER).toBe('BANK_TRANSFER');
  });
});

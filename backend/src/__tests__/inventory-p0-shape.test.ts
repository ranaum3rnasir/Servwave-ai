import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StockSyncStatus } from '@prisma/client';

/**
 * Inventory P0 foundations — additive schema shape (plan §3.1 minus Asset tables).
 *
 * Two cheap signals, same pattern as migration-additive-shape.test.ts +
 * schema-assignment-shape.test.ts:
 *  1. `prisma generate` regenerated the client with the new StockSyncStatus enum.
 *  2. The hand-written migration SQL is idempotent (IF NOT EXISTS / guarded DO
 *     blocks — it may run twice on the shared staging DB), portable (vanilla
 *     postgres:16 — no Supabase-only objects), and non-destructive.
 */

const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260717032601_inventory_p0_schema/migration.sql'),
  'utf8',
);

describe('inventory P0 — generated client shape', () => {
  it('exposes the StockSyncStatus enum', () => {
    expect(StockSyncStatus.NOT_TRACKED).toBe('NOT_TRACKED');
    expect(StockSyncStatus.UNSYNCED).toBe('UNSYNCED');
    expect(StockSyncStatus.SYNCED).toBe('SYNCED');
  });
});

describe('inventory P0 — migration SQL shape', () => {
  it('creates the StockSyncStatus enum guarded (pg_type check, re-runnable)', () => {
    expect(SQL).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'StockSyncStatus'\)/);
    expect(SQL).toContain(`CREATE TYPE "StockSyncStatus" AS ENUM ('NOT_TRACKED', 'UNSYNCED', 'SYNCED')`);
  });

  it('adds every new column with ADD COLUMN IF NOT EXISTS', () => {
    const columns: Array<[string, string]> = [
      ['price_book_items', 'track_inventory'],
      ['organizations', 'block_negative_stock'],
      ['organizations', 'purchase_order_prefix'],
      ['organizations', 'purchase_order_next_number'],
      ['organizations', 'purchase_order_first_issued_at'],
      ['stock_movements', 'item_id'],
      ['stock_movements', 'job_id'],
      ['stock_movements', 'job_line_item_id'],
      ['stock_movements', 'invoice_line_item_id'],
      ['stock_movements', 'unit_cost'],
      ['stock_movements', 'actor_user_id'],
      ['job_line_items', 'stock_status'],
      ['job_line_items', 'stock_location_id'],
      ['invoice_line_items', 'stock_status'],
      ['invoice_line_items', 'stock_location_id'],
      ['purchase_orders', 'vendor_id'],
      ['estimate_reservations', 'status'],
      ['estimate_reservations', 'converted_purchase_order_id'],
    ];
    for (const [table, column] of columns) {
      expect(SQL, `missing guarded column: ${table}.${column}`).toContain(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}"`,
      );
    }
  });

  it('widens qty/on_hand/reserved Int -> numeric(10,2) with USING casts, guarded on data_type', () => {
    expect(SQL).toMatch(/ALTER COLUMN "qty" TYPE DECIMAL\(10,2\) USING "qty"::numeric\(10,2\)/);
    expect(SQL).toMatch(/ALTER COLUMN "on_hand" TYPE DECIMAL\(10,2\) USING "on_hand"::numeric\(10,2\)/);
    expect(SQL).toMatch(/ALTER COLUMN "reserved" TYPE DECIMAL\(10,2\) USING "reserved"::numeric\(10,2\)/);
    // information_schema guard skips the table rewrite on re-run.
    const guards = SQL.match(/AND data_type = 'integer'/g) ?? [];
    expect(guards.length).toBe(3);
  });

  it('adds every FK guarded by a pg_constraint conname check, ON DELETE SET NULL', () => {
    const fks = [
      'stock_movements_item_id_fkey',
      'stock_movements_job_id_fkey',
      'stock_movements_job_line_item_id_fkey',
      'stock_movements_invoice_line_item_id_fkey',
      'stock_movements_actor_user_id_fkey',
      'job_line_items_stock_location_id_fkey',
      'invoice_line_items_stock_location_id_fkey',
      'purchase_orders_vendor_id_fkey',
      'estimate_reservations_converted_purchase_order_id_fkey',
    ];
    for (const conname of fks) {
      expect(SQL, `missing guarded FK: ${conname}`).toContain(
        `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${conname}')`,
      );
    }
    const setNull = SQL.match(/ON DELETE SET NULL ON UPDATE CASCADE/g) ?? [];
    expect(setNull.length).toBe(fks.length);
  });

  it('creates every index with CREATE INDEX IF NOT EXISTS', () => {
    const indexes = [
      'stock_movements_item_id_idx',
      'stock_movements_job_id_idx',
      'stock_movements_job_line_item_id_idx',
      'stock_movements_invoice_line_item_id_idx',
      'stock_movements_actor_user_id_idx',
      'job_line_items_stock_location_id_idx',
      'invoice_line_items_stock_location_id_idx',
      'purchase_orders_vendor_id_idx',
      'estimate_reservations_converted_purchase_order_id_idx',
    ];
    for (const idx of indexes) {
      expect(SQL, `missing index: ${idx}`).toContain(`CREATE INDEX IF NOT EXISTS "${idx}"`);
    }
  });

  it('backfills purchase_orders.vendor_id by exact per-org name match, unambiguous only', () => {
    expect(SQL).toMatch(/UPDATE "purchase_orders" po\s+SET "vendor_id" = v\."id"/);
    expect(SQL).toContain(`po."vendor_id" IS NULL`); // idempotent re-run guard
    expect(SQL).toMatch(/v\."organization_id" = po\."organization_id"/); // tenant-scoped
    expect(SQL).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "vendors" v2/); // duplicate-name ambiguity guard
  });

  it('is portable (no Supabase-only objects) and non-destructive', () => {
    // Assert on statements only — the header comment *documents* the Supabase-only
    // objects it avoids, so strip `--` comment lines before matching.
    const statements = SQL.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/TO authenticated|TO anon|TO service_role|auth\./);
    expect(statements).not.toMatch(/DROP TABLE|DROP COLUMN/i);
  });
});

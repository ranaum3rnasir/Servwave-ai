import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DisputeStatus } from '@prisma/client';

/**
 * Payments go-live slice 09 - the dispute record's migration, in the ordinary (no database) suite.
 *
 * The behaviour (a dispute opened, updated and closed through the webhook route) is proven against
 * real Postgres in disputes-reconciler-db.test.ts, which needs TEST_DATABASE_URL, and the tenant
 * backstop by rls-coverage.test.ts. This file pins the properties that keep the migration safe on
 * every database it meets (CI's vanilla Postgres, the deploy, a second run on shared staging).
 */
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261007090000_disputes/migration.sql'),
  'utf8',
);
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('disputes migration', () => {
  it('creates the dispute record, keyed once per processor dispute id', () => {
    expect(statements).toMatch(/CREATE TABLE IF NOT EXISTS "disputes"/);
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "disputes_stripe_dispute_id_key" ON "disputes"\("stripe_dispute_id"\)/);
  });

  it('is idempotent: the type is guarded, every index is IF NOT EXISTS, every constraint tolerates a re-run', () => {
    expect(statements).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'DisputeStatus'\)/);
    const indexes = statements.match(/CREATE (UNIQUE )?INDEX[^;]*/g) ?? [];
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.filter((i) => !/INDEX IF NOT EXISTS/.test(i))).toEqual([]);
    const constraints = statements.match(/ADD CONSTRAINT/g) ?? [];
    const guarded = statements.match(/EXCEPTION WHEN duplicate_object THEN null/g) ?? [];
    expect(constraints.length).toBe(guarded.length);
    expect(statements).toMatch(/DROP POLICY IF EXISTS "tenant_isolation" ON "disputes"/);
  });

  it('carries the tenant backstop and strips the data-API grants behind a role guard', () => {
    expect(statements).toMatch(/ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY/);
    expect(statements).toMatch(/ALTER TABLE "disputes" FORCE ROW LEVEL SECURITY/);
    expect(statements).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\)/);
  });

  it('is pure expand: nothing dropped, renamed or narrowed on an existing table, and no invoice status added', () => {
    expect(statements).not.toMatch(/DROP (TABLE|COLUMN|TYPE)|RENAME |SET NOT NULL|ALTER COLUMN|"InvoiceStatus"/i);
  });

  it('the generated client carries the dispute states', () => {
    expect(Object.values(DisputeStatus)).toEqual(['NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'CLOSED']);
  });
});

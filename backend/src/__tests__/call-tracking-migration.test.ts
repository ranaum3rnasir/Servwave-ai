import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guard for the hand-authored call-tracking migration: pins the RLS backstop +
 * PostgREST revokes on the new org-scoped table, idempotent DDL, and the two
 * unique keys the receiver and the stash upsert depend on.
 */
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20260910120000_call_tracking_integrations/migration.sql'),
  'utf8',
);

describe('call tracking integrations migration', () => {
  it('creates the enum, table and columns idempotently', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'CallTrackingProvider'\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "call_tracking_integrations"/);
    expect(sql).toMatch(/ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "from_number" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "provider" "CallTrackingProvider"/);
    expect(sql).toMatch(/ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "vendor_call_id" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "tracking_source" TEXT/);
    expect(sql).toMatch(/ALTER TABLE "pending_call_attributions" ADD COLUMN IF NOT EXISTS "attribution" JSONB/);
    expect(sql).toMatch(/ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "call_tracking_provider" "CallTrackingProvider"/);
    expect(sql).toMatch(/ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "vendor_call_id" TEXT/);
  });

  it('enforces the unique keys the receiver and the stash upsert rely on', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "call_tracking_integrations_url_token_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "call_tracking_integrations_organization_id_provider_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "pending_call_attributions_provider_vendor_call_id_key"/);
  });

  it('adds the inbound claim index and the vendor-handle index', () => {
    expect(sql).toMatch(/"pending_call_attributions_organization_id_from_number_created_idx"/);
    expect(sql).toMatch(/"call_sessions_call_tracking_provider_vendor_call_id_idx"/);
  });

  it('applies the tenant RLS backstop and the guarded PostgREST revokes to the new org-scoped table', () => {
    expect(sql).toMatch(/ALTER TABLE "call_tracking_integrations" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "call_tracking_integrations" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY "tenant_isolation" ON "call_tracking_integrations"/);
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON public\.call_tracking_integrations FROM anon/);
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON public\.call_tracking_integrations FROM authenticated/);
  });

  it('drops or renames nothing (pure expand)', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DROP TYPE|RENAME (COLUMN|TO)/i);
  });
});

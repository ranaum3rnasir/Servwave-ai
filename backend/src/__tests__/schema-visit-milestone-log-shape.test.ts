import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Scheduling-notifications slice 08's migration, pinned by TEXT.
 *
 * BE HONEST ABOUT THE SEAM (schema-visit-lifecycle-shape.test.ts says it first): this is a ratchet
 * against accidental edits, not a behaviour driven through a public interface. Prisma is fully
 * mocked across the backend suite and no test here executes migration SQL, so a green run is NOT
 * evidence the migration works. The real verification is manual: apply the whole ledger twice
 * against a scratch vanilla postgres:16 and confirm the second run is a no-op.
 */
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260913140000_visit_milestone_log_and_skip_stamps/migration.sql'),
  'utf8',
);

describe('visit milestone log and skip stamps migration (scheduling-notifications slice 08)', () => {
  it('adds a skipped marker per skippable milestone to visits, idempotently and defaulted false', () => {
    // Completed is last in lifecycle order, so it can never be skipped and carries no marker.
    for (const column of ['en_route_skipped', 'on_site_skipped', 'started_skipped']) {
      expect(SQL).toContain(`ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "${column}" BOOLEAN NOT NULL DEFAULT false`);
    }
  });

  it('creates the two enums guarded on pg_type, so a second application is a no-op', () => {
    expect(SQL).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitMilestoneName')`);
    expect(SQL).toContain(`CREATE TYPE "VisitMilestoneName" AS ENUM ('en_route', 'on_site', 'started', 'completed')`);
    expect(SQL).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitMilestoneLogKind')`);
    expect(SQL).toContain(`CREATE TYPE "VisitMilestoneLogKind" AS ENUM ('tapped', 'skipped', 'reverted')`);
  });

  it('creates the append-only log table, org-scoped like visits, idempotently', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS "visit_milestone_log"');
    // Column definitions are aligned with runs of spaces in the file; collapse them to compare.
    const flat = SQL.replace(/[ \t]+/g, ' ');
    for (const column of ['"organization_id" UUID NOT NULL', '"visit_id" UUID NOT NULL', '"milestone" "VisitMilestoneName" NOT NULL', '"kind" "VisitMilestoneLogKind" NOT NULL', '"occurred_at" TIMESTAMP(3) NOT NULL', '"actor_id" UUID,']) {
      expect(flat).toContain(column);
    }
    // A visit going away takes its history with it; a user going away leaves the history standing.
    expect(SQL).toContain('FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE CASCADE');
    expect(SQL).toContain('FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL');
    expect(SQL).toContain('FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")');
    expect(SQL).toContain('CREATE INDEX IF NOT EXISTS "visit_milestone_log_visit_id_occurred_at_idx"');
    expect(SQL).toContain('CREATE INDEX IF NOT EXISTS "visit_milestone_log_organization_id_idx"');
  });

  it('carries the tenant_isolation policy, dropped before created, and guards the vendor-only role revokes', () => {
    expect(SQL).toContain('ALTER TABLE "visit_milestone_log" ENABLE ROW LEVEL SECURITY');
    expect(SQL).toContain('ALTER TABLE "visit_milestone_log" FORCE ROW LEVEL SECURITY');
    expect(SQL).toContain('DROP POLICY IF EXISTS "tenant_isolation" ON "visit_milestone_log"');
    expect(SQL).toContain('CREATE POLICY "tenant_isolation" ON "visit_milestone_log"');
    expect(SQL).toContain(`"organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid`);
    // Vanilla postgres:16 in CI has neither role: an unguarded REVOKE aborts the whole ledger there.
    expect(SQL).toContain(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')`);
    expect(SQL).toContain(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')`);
    expect(SQL).not.toMatch(/^\s*REVOKE/m);
  });
});

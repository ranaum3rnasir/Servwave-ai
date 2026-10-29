import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// PR-A2 of the walkthrough-as-entity redesign (md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md).
// This migration ONLY creates the walkthroughs table and backfills it - nothing reads it yet, so it
// must produce zero observable behavior change. Mirrors the assertion style of
// schema-assignment-shape.test.ts, which pins the equivalent additive-then-later-drop split for the
// lead/job assignee M2M redesign.
const SQL = readFileSync(
  join(__dirname, '../../prisma/migrations/20260728150000_walkthrough_entity_foundations_v2/migration.sql'),
  'utf8',
);

describe('walkthrough entity foundations migration', () => {
  it('guards the WalkthroughStatus enum behind a pg_type existence check', () => {
    expect(SQL).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'WalkthroughStatus'\)/);
    expect(SQL).toMatch(
      /CREATE TYPE "WalkthroughStatus" AS ENUM \('REQUESTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED'\)/,
    );
  });

  it('creates the walkthroughs table idempotently', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS "walkthroughs"');
  });

  it('indexes lead_id, organization_id, and the (organization_id, status) bucket-query pair', () => {
    expect(SQL).toContain('CREATE INDEX IF NOT EXISTS "walkthroughs_lead_id_idx" ON "walkthroughs"("lead_id")');
    expect(SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "walkthroughs_organization_id_idx" ON "walkthroughs"("organization_id")',
    );
    expect(SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "walkthroughs_organization_id_status_idx" ON "walkthroughs"("organization_id", "status")',
    );
  });

  it('adds all three walkthroughs FKs guarded by pg_constraint checks, with the right delete actions', () => {
    expect(SQL).toMatch(
      /walkthroughs_lead_id_fkey[\s\S]*?FOREIGN KEY \("lead_id"\) REFERENCES "leads"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(SQL).toMatch(
      /walkthroughs_organization_id_fkey[\s\S]*?FOREIGN KEY \("organization_id"\) REFERENCES "organizations"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
    expect(SQL).toMatch(
      /walkthroughs_cancelled_by_fkey[\s\S]*?FOREIGN KEY \("cancelled_by"\) REFERENCES "users"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    );
    for (const name of ['walkthroughs_lead_id_fkey', 'walkthroughs_organization_id_fkey', 'walkthroughs_cancelled_by_fkey']) {
      expect(SQL).toContain(`SELECT 1 FROM pg_constraint WHERE conname = '${name}'`);
    }
  });

  it('carries the standard tenant_isolation RLS block for the new table', () => {
    expect(SQL).toContain('ALTER TABLE "walkthroughs" ENABLE ROW LEVEL SECURITY');
    expect(SQL).toContain('ALTER TABLE "walkthroughs" FORCE ROW LEVEL SECURITY');
    expect(SQL).toContain('DROP POLICY IF EXISTS "tenant_isolation" ON "walkthroughs"');
    expect(SQL).toMatch(
      /CREATE POLICY "tenant_isolation" ON "walkthroughs"\s*\n\s*USING \(current_setting\('app\.bypass_rls', true\) = 'on' OR "organization_id" = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\)\s*\n\s*WITH CHECK \(current_setting\('app\.bypass_rls', true\) = 'on' OR "organization_id" = NULLIF\(current_setting\('app\.current_org_id', true\), ''\)::uuid\);/,
    );
  });

  it('revokes anon/authenticated grants on walkthroughs, guarded for vanilla Postgres', () => {
    expect(SQL).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\)/);
    expect(SQL).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'\)/);
    expect(SQL).toContain('REVOKE ALL PRIVILEGES ON public.walkthroughs FROM anon');
    expect(SQL).toContain('REVOKE ALL PRIVILEGES ON public.walkthroughs FROM authenticated');
  });

  it('backfills one walkthrough row per lead with any walkthrough data, in cancelled > completed > scheduled > needed order', () => {
    expect(SQL).toContain('INSERT INTO "walkthroughs" (');

    const caseBlockMatch = SQL.match(/CASE[\s\S]*?END::"WalkthroughStatus"/);
    expect(caseBlockMatch, 'expected a CASE expression deriving WalkthroughStatus').toBeTruthy();
    const caseBlock = caseBlockMatch![0];
    const cancelledIdx = caseBlock.indexOf('walkthrough_cancelled_at');
    const completedIdx = caseBlock.indexOf('walkthrough_completed_at');
    const scheduledIdx = caseBlock.indexOf('walkthrough_scheduled_at');
    const neededIdx = caseBlock.indexOf('walkthrough_needed');
    expect(cancelledIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(-1);
    expect(scheduledIdx).toBeGreaterThan(-1);
    expect(neededIdx).toBeGreaterThan(-1);
    // Precedence: cancelled wins over completed, which wins over scheduled, which wins over needed.
    expect(cancelledIdx).toBeLessThan(completedIdx);
    expect(completedIdx).toBeLessThan(scheduledIdx);
    expect(scheduledIdx).toBeLessThan(neededIdx);
    expect(caseBlock).toMatch(/'CANCELLED'/);
    expect(caseBlock).toMatch(/'COMPLETED'/);
    expect(caseBlock).toMatch(/'SCHEDULED'/);
    expect(caseBlock).toMatch(/'REQUESTED'/);
  });

  it('is re-runnable: the main backfill only inserts for leads with no walkthrough row yet', () => {
    expect(SQL).toMatch(/NOT EXISTS \(SELECT 1 FROM "walkthroughs" w WHERE w\."lead_id" = l\."id"\)/);
  });

  it('creates a REQUESTED walkthrough for any lead with performer rows but no walkthrough row, so no crew is orphaned', () => {
    expect(SQL).toMatch(
      /EXISTS \(SELECT 1 FROM "lead_walkthrough_performers" lwp WHERE lwp\."lead_id" = l\."id"\)/,
    );
  });

  it('adds walkthrough_id to lead_walkthrough_performers additively (nullable, no NOT NULL yet)', () => {
    expect(SQL).toContain('ALTER TABLE "lead_walkthrough_performers" ADD COLUMN IF NOT EXISTS "walkthrough_id" UUID');
    expect(SQL).not.toMatch(/ALTER TABLE "lead_walkthrough_performers"[\s\S]*?ALTER COLUMN "walkthrough_id" SET NOT NULL/);
  });

  it('backfills walkthrough_id by joining each performer row lead_id to its walkthrough row', () => {
    expect(SQL).toMatch(
      /UPDATE "lead_walkthrough_performers"[\s\S]*?SET "walkthrough_id" = w\."id"[\s\S]*?FROM "walkthroughs" w[\s\S]*?WHERE w\."lead_id" = lwp\."lead_id"/,
    );
  });

  it('adds the walkthrough_id FK and index on lead_walkthrough_performers, guarded', () => {
    expect(SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "lead_walkthrough_performers_walkthrough_id_idx" ON "lead_walkthrough_performers"("walkthrough_id")',
    );
    expect(SQL).toMatch(
      /lead_walkthrough_performers_walkthrough_id_fkey[\s\S]*?FOREIGN KEY \("walkthrough_id"\) REFERENCES "walkthroughs"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/,
    );
    expect(SQL).toContain("SELECT 1 FROM pg_constraint WHERE conname = 'lead_walkthrough_performers_walkthrough_id_fkey'");
  });

  it('contains NO destructive change to the legacy lead_id column or its unique constraint (PR-A2 is additive-only; the repoint co-deploys with PR-B2, mirroring assignment_backfill_supersede_drop)', () => {
    expect(SQL).not.toMatch(/DROP COLUMN[^;]*"?lead_id"?/i);
    expect(SQL).not.toMatch(/DROP CONSTRAINT[^;]*lead_walkthrough_performers_lead_id_fkey/i);
    expect(SQL).not.toMatch(/DROP INDEX[^;]*lead_walkthrough_performers_lead_id_user_id_key/i);
    expect(SQL).not.toMatch(/walkthrough_id",\s*"user_id"\)/); // no new (visit_id, user_id) unique index yet
  });
});

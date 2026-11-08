-- Walkthrough-as-entity redesign, PR-A2 (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
-- plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md). Creates the walkthroughs
-- table and backfills it from the 9 legacy Lead.walkthrough_* columns. NOTHING reads this table yet -
-- no controller, route, or frontend file changes ship with this migration - so this is a pure
-- additive + backfill step with zero observable behavior change.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere; enum + FKs inside guarded DO blocks; every backfill INSERT
--   is guarded so a second run of this migration on the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - RLS policy has no TO clause (core Postgres);
--   the only Supabase-role objects are the anon/authenticated REVOKEs, guarded by pg_roles checks.
--
-- Deliberately NOT done here (see LeadWalkthroughPerformer section below): dropping
-- lead_walkthrough_performers.lead_id, swapping its unique constraint to (walkthrough_id, user_id),
-- or touching any controller/route/frontend file. Those must co-deploy with the controller change
-- that starts keying performers by walkthrough_id (PR-B2) - this repo already has that exact split
-- for the sibling assignee M2M redesign: compare 20260610120000_assignment_m2m_additive
-- (additive-only) with 20260610120100_assignment_backfill_supersede_drop ("Co-deployed with the new
-- CASL/controller code (which already reads the crew shape)").

-- ─── Enum ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WalkthroughStatus') THEN
    CREATE TYPE "WalkthroughStatus" AS ENUM ('REQUESTED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;

-- ─── walkthroughs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "walkthroughs" (
  "id"                     UUID NOT NULL,
  "organization_id"        UUID NOT NULL,
  "lead_id"                UUID NOT NULL,
  "status"                 "WalkthroughStatus" NOT NULL DEFAULT 'REQUESTED',
  "scheduled_at"           TIMESTAMP(3),
  "duration_minutes"       INTEGER,
  "completed_at"           TIMESTAMP(3),
  "notes"                  TEXT,
  "cancelled_at"           TIMESTAMP(3),
  "cancelled_reason"       TEXT,
  "cancelled_by"           UUID,
  "customer_email_sent_at" TIMESTAMP(3),
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "walkthroughs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "walkthroughs_lead_id_idx" ON "walkthroughs"("lead_id");
CREATE INDEX IF NOT EXISTS "walkthroughs_organization_id_idx" ON "walkthroughs"("organization_id");
-- Bucket query (D10/D11: Walkthrough.status = REQUESTED, no lead status involved).
CREATE INDEX IF NOT EXISTS "walkthroughs_organization_id_status_idx" ON "walkthroughs"("organization_id", "status");

-- lead_id CASCADE (owned child - a visit has no meaning without its lead); organization_id
-- RESTRICT (tenant row must outlive its children); cancelled_by SET NULL (optional actor link,
-- mirrors leads_walkthrough_cancelled_by_fkey - the row survives a hard user delete).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthroughs_lead_id_fkey') THEN
    ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthroughs_organization_id_fkey') THEN
    ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthroughs_cancelled_by_fkey') THEN
    ALTER TABLE "walkthroughs" ADD CONSTRAINT "walkthroughs_cancelled_by_fkey"
      FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed; INERT until
--     non-BYPASSRLS role + DB_TENANT_GUARD=on) ────────────────────────────────
ALTER TABLE "walkthroughs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "walkthroughs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "walkthroughs";
CREATE POLICY "tenant_isolation" ON "walkthroughs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth: strip Supabase PostgREST role grants (the global sweep in 20260708140000 only
-- covered tables existing at its run time; a new table must repeat this). pg_roles guards keep this
-- valid on CI's vanilla postgres.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.walkthroughs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.walkthroughs FROM authenticated';
  END IF;
END $$;

-- ─── Backfill: one walkthrough row per lead with ANY walkthrough data ────────
-- Status precedence: cancelled_at set -> CANCELLED; else completed_at set -> COMPLETED; else
-- scheduled_at set -> SCHEDULED; else walkthrough_needed true -> REQUESTED. A lead with
-- walkthrough_needed = false and no timestamps has no walkthrough data and gets no row.
-- Guarded by NOT EXISTS so re-running this migration on the shared staging DB is a no-op.
INSERT INTO "walkthroughs" (
  "id", "organization_id", "lead_id", "status", "scheduled_at", "duration_minutes",
  "completed_at", "notes", "cancelled_at", "cancelled_reason", "cancelled_by",
  "customer_email_sent_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  l."organization_id",
  l."id",
  CASE
    WHEN l."walkthrough_cancelled_at" IS NOT NULL THEN 'CANCELLED'
    WHEN l."walkthrough_completed_at" IS NOT NULL THEN 'COMPLETED'
    WHEN l."walkthrough_scheduled_at" IS NOT NULL THEN 'SCHEDULED'
    WHEN l."walkthrough_needed" = true THEN 'REQUESTED'
  END::"WalkthroughStatus",
  l."walkthrough_scheduled_at",
  l."walkthrough_duration_minutes",
  l."walkthrough_completed_at",
  l."walkthrough_notes",
  l."walkthrough_cancelled_at",
  l."walkthrough_cancelled_reason",
  l."walkthrough_cancelled_by",
  l."walkthrough_customer_email_sent_at",
  NOW(),
  NOW()
FROM "leads" l
WHERE (
    l."walkthrough_cancelled_at" IS NOT NULL
    OR l."walkthrough_completed_at" IS NOT NULL
    OR l."walkthrough_scheduled_at" IS NOT NULL
    OR l."walkthrough_needed" = true
  )
  AND NOT EXISTS (SELECT 1 FROM "walkthroughs" w WHERE w."lead_id" = l."id");

-- Orphan-crew guard (spec PR-A2 note): a lead may have lead_walkthrough_performers rows (a crew was
-- assigned) yet fail every condition above (walkthrough_needed was toggled off with no timestamps
-- ever set). Every lead with performer rows must end up with SOME walkthrough row, so give it a
-- REQUESTED one. Guarded the same way - idempotent on re-run.
-- No DISTINCT: FROM "leads" l has no join, so l.id (its PK) already makes one row per matching lead.
INSERT INTO "walkthroughs" (
  "id", "organization_id", "lead_id", "status", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  l."organization_id",
  l."id",
  'REQUESTED'::"WalkthroughStatus",
  NOW(),
  NOW()
FROM "leads" l
WHERE EXISTS (SELECT 1 FROM "lead_walkthrough_performers" lwp WHERE lwp."lead_id" = l."id")
  AND NOT EXISTS (SELECT 1 FROM "walkthroughs" w WHERE w."lead_id" = l."id");

-- ─── LeadWalkthroughPerformer: additive repoint prep (walkthrough_id column only) ────────────────
-- lead_id, its FK, and its @@unique([lead_id, user_id]) constraint are UNTOUCHED in this PR - see
-- header note. walkthrough_id stays nullable: rows created by app code between this migration and
-- PR-B2's deploy still write lead_id only, exactly as today.
ALTER TABLE "lead_walkthrough_performers" ADD COLUMN IF NOT EXISTS "walkthrough_id" UUID;

-- Backfill walkthrough_id for every existing performer row by joining its lead_id to the
-- walkthrough row synthesized above for that lead (both backfill INSERTs together guarantee at
-- most one walkthrough row per lead, so this join is deterministic). Only touches rows not yet
-- backfilled, so a second run is a no-op.
UPDATE "lead_walkthrough_performers" lwp
SET "walkthrough_id" = w."id"
FROM "walkthroughs" w
WHERE w."lead_id" = lwp."lead_id"
  AND lwp."walkthrough_id" IS NULL;

CREATE INDEX IF NOT EXISTS "lead_walkthrough_performers_walkthrough_id_idx" ON "lead_walkthrough_performers"("walkthrough_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_walkthrough_performers_walkthrough_id_fkey') THEN
    ALTER TABLE "lead_walkthrough_performers" ADD CONSTRAINT "lead_walkthrough_performers_walkthrough_id_fkey"
      FOREIGN KEY ("walkthrough_id") REFERENCES "walkthroughs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

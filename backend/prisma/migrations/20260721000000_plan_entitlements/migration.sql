-- Plan entitlements: Plan enum + plan/trial_ends_at/feature_overrides on organizations.
--
-- IDEMPOTENT: enum guarded by a DO block; ADD COLUMN IF NOT EXISTS everywhere.
--   Both backfills are scoped by created_at, so a re-run (CLAUDE.md names manual
--   Supabase MCP as a third application path that bypasses _prisma_migrations)
--   cannot touch an org created after this migration landed. An unscoped
--   `WHERE plan = 'STARTER'` would silently upgrade every legitimately-STARTER
--   customer on replay — the column default is STARTER, so such rows always exist.
-- PORTABLE: vanilla postgres:16 — no Supabase-only objects, no pg_roles guards needed.
-- RLS: no new tables; organizations already carries tenant_isolation from
--   20260703000100_tenant_rls.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Plan') THEN
    CREATE TYPE "Plan" AS ENUM ('STARTER', 'PRO', 'SCALE', 'ENTERPRISE');
  END IF;
END $$;

-- TIMESTAMP(3), not TIMESTAMPTZ: a bare `DateTime?` in schema.prisma generates
-- TIMESTAMP(3). Using TIMESTAMPTZ here produces permanent `prisma migrate diff`
-- drift that CI cannot catch (migration-check runs `migrate status`, which
-- compares DB against _prisma_migrations, never against schema.prisma).
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "plan"              "Plan"       NOT NULL DEFAULT 'STARTER',
  ADD COLUMN IF NOT EXISTS "trial_ends_at"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "feature_overrides" JSONB        NOT NULL DEFAULT '{}';

-- ─── Backfill 1 (D7): every pre-existing org to SCALE ────────────────────────
-- All current orgs predate pricing (pilots / dual-run / demo). SCALE = they lose
-- nothing. Scoped by created_at so replay never touches a real plan assignment.
UPDATE "organizations"
  SET "plan" = 'SCALE'
  WHERE "created_at" < TIMESTAMP '2026-07-21 00:00:00';

-- ─── Backfill 2: preserve today's Communication access exactly ───────────────
-- SCALE includes `phone` (minPlan PRO), but Communication is NOT enabled for
-- real production orgs today — backend/src/lib/communicationAccess.ts grants it
-- ONLY to demo orgs and the Northwind Services allowlist. Without this statement the
-- migration would silently hand Lakeside, Riverbend and every other tenant the full
-- /api/communication/* surface, including the softphone token minter at
-- comm-phone-access.routes.ts:19.
--
-- `||` merges rather than overwrites — this is the correct shape to copy for
-- any future override, unlike a bare assignment.
UPDATE "organizations"
  SET "feature_overrides" = COALESCE("feature_overrides", '{}'::jsonb) || '{"phone": false}'::jsonb
  WHERE "created_at" < TIMESTAMP '2026-07-21 00:00:00'
    AND "is_demo" = false
    AND "id" <> '11111111-2222-4333-8444-555555555555';  -- Northwind Services, the CTM pilot

-- On a vanilla postgres:16 CI database no organizations rows exist, so both
-- UPDATEs match 0 rows and return success. Harmless — same pattern as
-- 20260619000000_org_is_demo_flag.

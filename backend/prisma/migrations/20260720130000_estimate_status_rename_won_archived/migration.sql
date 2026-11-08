-- Estimate v13 status rename (D1, closure-plan §10 / port-plan §4 M1).
-- APPROVED -> WON, CANCELLED -> ARCHIVED. Native enum-value rename: existing
-- rows keep their value, no data backfill needed. PENDING is deliberately
-- left untouched — it is being repurposed in place (same enum value, new
-- meaning), handled entirely in later frontend/backend stages, not here.
--
-- Idempotent: each rename is guarded by a pg_enum existence check on the old
-- label, so re-running this migration on a DB where the rename already
-- landed is a no-op (safe on the shared staging DB, matches CI's fresh
-- postgres:16 run). No Supabase-only objects are involved, so no
-- pg_roles/auth-role guard is needed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EstimateStatus'
      AND e.enumlabel = 'APPROVED'
  ) THEN
    ALTER TYPE "EstimateStatus" RENAME VALUE 'APPROVED' TO 'WON';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EstimateStatus'
      AND e.enumlabel = 'CANCELLED'
  ) THEN
    ALTER TYPE "EstimateStatus" RENAME VALUE 'CANCELLED' TO 'ARCHIVED';
  END IF;
END $$;

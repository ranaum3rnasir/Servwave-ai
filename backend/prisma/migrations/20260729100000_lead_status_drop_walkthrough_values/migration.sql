-- Walkthrough-as-entity redesign, PR-C2 (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
-- plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md). Drops
-- WALKTHROUGH_SCHEDULED / WALKTHROUGH_COMPLETED from LeadStatus - PR-A2/PR-B2 already moved every
-- walkthrough behavior onto the `walkthroughs` table, so these two lead-status values are dead
-- weight; any lead still sitting in one of them remaps to CONTACTED, which is the closest
-- "in progress, pre-estimate" bucket both values already lived inside conceptually.
--
-- Postgres cannot drop an enum value in place (ALTER TYPE ... DROP VALUE does not exist), so the
-- standard safe rebuild is used: remap rows off the retired values, build a new narrower type,
-- swap the column onto it via a text cast, then drop the old type and rename the new one into its
-- place.
--
-- IDEMPOTENT: the whole rebuild is gated on the retired values still being present in the LIVE
--   LeadStatus type. Once this migration has run once, "LeadStatus" no longer contains
--   WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED, so the guard is false and a second application of
--   this file (the shared staging DB sometimes sees a migration twice) is a no-op. A leftover
--   "LeadStatus_new" from an aborted manual/out-of-transaction run is also swept before use.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects are touched here at
--   all (no roles, no auth.uid(), no RLS policy edits), so no pg_roles guard is needed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LeadStatus'
      AND e.enumlabel IN ('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED')
  ) THEN
    -- 1. Remap existing rows off the retired values BEFORE the type is touched.
    UPDATE "leads"
    SET "status" = 'CONTACTED'
    WHERE "status" IN ('WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED');

    -- 2. Build the new, narrower enum type. Drop any debris from an aborted prior attempt first.
    DROP TYPE IF EXISTS "LeadStatus_new";
    CREATE TYPE "LeadStatus_new" AS ENUM ('NEW', 'CONTACTED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED');

    -- 3. Swap the column onto the new type via a text cast; the default is dropped and re-set
    --    around the ALTER because a column default that references the old type blocks the swap.
    ALTER TABLE "leads" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "leads" ALTER COLUMN "status" TYPE "LeadStatus_new" USING ("status"::text::"LeadStatus_new");
    ALTER TABLE "leads" ALTER COLUMN "status" SET DEFAULT 'NEW';

    -- 4. Drop the old (wider) type and rename the new one into place so "LeadStatus" is once again
    --    the live type name every other reference (schema.prisma, other migrations) expects.
    DROP TYPE "LeadStatus";
    ALTER TYPE "LeadStatus_new" RENAME TO "LeadStatus";
  END IF;
END $$;

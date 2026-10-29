-- Editable record IDs (Workiz dual-run), step 1 of 5 (md_files/plans/numbering/2026-08-19-editable-record-ids.md).
--
-- Foundation columns only - no allocator/permission/endpoint behavior changes ship here.
--
-- Per numbered table (customers, leads, estimates, jobs, invoices):
--   number_is_custom  - true once a human directly edits the number. Governs exclusion from the
--                        allocator self-heal (lib/numbering.ts, step 2) and from the settings
--                        collision guard (maxNumberForTx), and immunity from parent cascades.
--   original_number   - the number this row was FIRST issued, set once on the first change of any
--                        kind (rename or cascade). Lets an old id still find the record.
--
-- Estimate only:
--   container_kind / container_seq - which container (LEAD/CUSTOMER/JOB) minted a container-style
--   estimate number (`L00005-1`/`C00010-1`/`J00007-1`, SERV10X-61) and its seq within that
--   container. Nothing on Estimate today records this - customer_id/lead_id/job_id describe
--   CURRENT links, not which one shaped the number, and there is no `seq` column (the counter
--   lives on the parent row's `estimate_seq`). Recovering this after the fact is a one-time
--   string-match against candidate parent numbers; free-text ids destroy that recoverability
--   (two containers can legally share a hand-typed number later), so this ships before any
--   renumbering capability is granted to anyone. Backfilled by
--   scripts/estimate-container-backfill.ts, run manually per org after this migration lands.
--
-- PORTABLE: no Supabase-only objects touched (no roles, no auth.*, no RLS) - no pg_roles guard
--   needed.
-- IDEMPOTENT: every CREATE TYPE / ADD COLUMN is guarded so a second application (the shared
--   staging DB sometimes sees a migration twice) is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EstimateContainerKind') THEN
    CREATE TYPE "EstimateContainerKind" AS ENUM ('LEAD', 'CUSTOMER', 'JOB');
  END IF;
END $$;

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "number_is_custom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "original_number" TEXT;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "number_is_custom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "original_number" TEXT;

ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "number_is_custom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "original_number" TEXT;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "container_kind" "EstimateContainerKind";
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "container_seq" INTEGER;

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "number_is_custom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "original_number" TEXT;

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "number_is_custom" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "original_number" TEXT;

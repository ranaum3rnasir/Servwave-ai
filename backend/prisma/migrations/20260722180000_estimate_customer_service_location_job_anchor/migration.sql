-- R6 (2026-07-22) — M5 + M4: Estimate anchor columns, backend-foundation-only stage.
--
-- M5: mirrors Job's own anchor shape (Job.customer_id/service_location_id) onto Estimate,
-- and relaxes lead_id to optional so a future lead-less create path (SERV10X-61) has a schema
-- to land on. No create-time UI ships in this stage — createEstimateSchema still requires
-- lead_id, so every row (past and future, for as long as creation stays lead-anchored)
-- continues to have customer_id/service_location_id denormalized from its lead.
--
-- customer_id -> NOT NULL after backfill: verified on staging, 0 of 629 existing estimates
--   have a lead with a null customer_id (100% backfill coverage).
-- service_location_id -> stays NULLABLE (unlike Job's required column): verified on staging,
--   342 of 629 existing estimates have a lead with a null service_location_id (~54% of leads
--   are still on the legacy service_address_* fields, not yet migrated to a ServiceLocation
--   row) — forcing NOT NULL here would either fail or require inventing address data.
--
-- M4: Estimate.job_id mirrors Job.estimate_id in reverse (which estimate a job's single-estimate
-- provenance points at). Backfilled once here from the 82 existing jobs.estimate_id rows;
-- backend/src/controllers/job.controller.ts's create() keeps it in sync at the one write site
-- going forward so the column doesn't start drifting the moment this ships.
--
-- IDEMPOTENT: IF NOT EXISTS / guarded DO blocks throughout (may run twice on the shared staging
--   DB). PORTABLE: no Supabase-only objects — plain columns, indexes, and FKs on an
--   already-RLS-covered table (no new table, so no new RLS policy needed).

ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "customer_id" UUID;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "service_location_id" UUID;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "job_id" UUID;

ALTER TABLE "estimates" ALTER COLUMN "lead_id" DROP NOT NULL;

-- Backfill customer_id + service_location_id from the lead (idempotent: only touches rows
-- customer_id hasn't been set on yet, so a second run is a no-op).
UPDATE "estimates" e
SET "customer_id" = l."customer_id",
    "service_location_id" = l."service_location_id"
FROM "leads" l
WHERE e."lead_id" = l."id" AND e."customer_id" IS NULL;

-- Backfill job_id from the existing Job.estimate_id 1:1 provenance link.
UPDATE "estimates" e
SET "job_id" = j."id"
FROM "jobs" j
WHERE j."estimate_id" = e."id" AND e."job_id" IS NULL;

-- customer_id becomes required — see header note on 100% backfill coverage. Guarded: only
-- flips NOT NULL when every row already has a value, so a re-run (or a future dataset with a
-- genuine gap) fails loudly instead of silently locking in a partially-backfilled column.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "estimates" WHERE "customer_id" IS NULL) THEN
    ALTER TABLE "estimates" ALTER COLUMN "customer_id" SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "estimates_customer_id_idx" ON "estimates"("customer_id");
CREATE INDEX IF NOT EXISTS "estimates_service_location_id_idx" ON "estimates"("service_location_id");
CREATE INDEX IF NOT EXISTS "estimates_job_id_idx" ON "estimates"("job_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimates_customer_id_fkey') THEN
    ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimates_service_location_id_fkey') THEN
    ALTER TABLE "estimates" ADD CONSTRAINT "estimates_service_location_id_fkey"
      FOREIGN KEY ("service_location_id") REFERENCES "service_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimates_job_id_fkey') THEN
    ALTER TABLE "estimates" ADD CONSTRAINT "estimates_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

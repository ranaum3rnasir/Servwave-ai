-- Job.lead_id — direct lead provenance for a job.
--
-- Until now the ONLY job->lead path was `job.estimate.lead_id`. That path is null in two
-- real cases: a job converted from SEVERAL estimates (job.controller.ts create() writes
-- estimate_id only when exactly one estimate was selected) and a job created from scratch.
-- Lead attachment/note forwarding onto the job hangs off that path, so it went silent on
-- multi-estimate jobs even though such a job is required to come from ONE shared lead.
--
-- Expand-only: adds a nullable column, an index, an FK, and backfills. Nothing is dropped
-- or rewritten, so a code rollback leaves a harmless unused column behind.

-- 1. Column (nullable; a from-scratch job legitimately has no lead).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "lead_id" UUID;

-- 2. Index — every read added by this change filters on it.
CREATE INDEX IF NOT EXISTS "jobs_lead_id_idx" ON "jobs"("lead_id");

-- 3. FK. ON DELETE SET NULL, not RESTRICT: a job outlives the lead it came from, and losing
--    the provenance pointer must never block deleting a lead. Guarded so a re-run is a no-op.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_lead_id_fkey'
  ) THEN
    ALTER TABLE "jobs"
      ADD CONSTRAINT "jobs_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Backfill, path A — the single-estimate provenance FK (jobs.estimate_id).
UPDATE "jobs" j
SET "lead_id" = e."lead_id"
FROM "estimates" e
WHERE j."estimate_id" = e."id"
  AND e."lead_id" IS NOT NULL
  AND j."lead_id" IS NULL;

-- 5. Backfill, path B — the reverse mirror (estimates.job_id, the EstimateJobLink 1:N added
--    in R6). This is the ONLY path that reaches a multi-estimate job, whose estimate_id is
--    null. create() enforces that every estimate on one job shares a single lead_id, so the
--    aggregate below can only collapse to one value; MIN() is a defensive tie-break, and the
--    HAVING clause refuses to guess if any historical row ever violated that rule.
UPDATE "jobs" j
SET "lead_id" = src."lead_id"
FROM (
  SELECT e."job_id" AS job_id, MIN(e."lead_id"::text)::uuid AS lead_id
  FROM "estimates" e
  WHERE e."job_id" IS NOT NULL
    AND e."lead_id" IS NOT NULL
  GROUP BY e."job_id"
  HAVING COUNT(DISTINCT e."lead_id") = 1
) src
WHERE j."id" = src.job_id
  AND j."lead_id" IS NULL;

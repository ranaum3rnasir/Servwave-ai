-- Harden the Job -> ServicePlan link: ON DELETE SET NULL  ->  ON DELETE RESTRICT.
--
-- A service plan with materialized visit-jobs must not be deletable out from under them.
-- Under SET NULL, deleting a plan would orphan its visit-jobs AND silently un-suppress their
-- billing (the non-billable guard keys off jobs.source_plan_id). RESTRICT fails the delete
-- instead. Plan delete is draft-only and drafts have no visit-jobs, so this never blocks a
-- legitimate delete; it is a fail-closed backstop if that invariant ever changes.
--
-- Idempotent: drop-if-exists then re-add, so it is safe to re-run against the shared staging DB.
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_source_plan_id_fkey";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_plan_id_fkey"
  FOREIGN KEY ("source_plan_id") REFERENCES "service_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

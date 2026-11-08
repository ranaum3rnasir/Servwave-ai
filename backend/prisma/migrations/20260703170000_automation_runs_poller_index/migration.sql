-- Poller hot-path index. executeDueRuns runs every minute:
--   WHERE status='PENDING' AND fire_at <= now ORDER BY fire_at LIMIT 50
-- which is cross-org, so the org-leading (organization_id, status, fire_at)
-- index can't serve it. Index the scan predicate directly.
-- Idempotent + portable. Safe to re-run on the shared staging DB.
CREATE INDEX IF NOT EXISTS "automation_runs_status_fire_at_idx"
  ON "automation_runs"("status","fire_at");

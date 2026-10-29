-- Scheduling-notifications slice 03: record the outcome of every send per audience.
-- One jsonb array per step run, one element per resolved audience:
--   {audience, label, outcome: sent|skipped|failed, summary}
-- The step-level status keeps its meaning (any sent means SENT); this column says WHICH
-- audience was reached. NOT NULL DEFAULT '[]' backfills every existing row to "nothing
-- recorded per audience", which is what was true of them. Idempotent (ADD COLUMN IF NOT
-- EXISTS), portable (no vendor-only object, so no role guard needed), no secrets.
ALTER TABLE "workflow_step_runs" ADD COLUMN IF NOT EXISTS "audience_outcomes" jsonb NOT NULL DEFAULT '[]'::jsonb;

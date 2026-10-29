-- Cutover continuity: bridge the legacy AutomationRun engine to the multi-step
-- Workflow engine so the deploy is BOTH loss-free and double-send-free.
--
-- At deploy, dispatch.ts now routes events into enrollOnEvent and the poller
-- re-scans timed candidates inside bounded grace windows (48h completed / 7d
-- overdue+follow-up / offset-length job-start). `workflow_enrollments` starts
-- EMPTY, so without this migration:
--   * DOUBLE-SEND: entities the OLD engine already messaged are still inside
--     those windows -> the new poller would re-enroll + re-message them once.
--   * LOST SEND: legacy `automation_runs` still PENDING (send-window-deferred
--     overnight sends) would never execute -- the old executor is gone.
--
-- Fix: project every legacy run of a FOLDED rule (one that became a published
-- 1-step Workflow in 20260710130000_workflow_backfill_rules) into a continuity
-- enrollment carrying the SAME dedupe_key. buildDedupeKey is reused verbatim by
-- the new engine (Task 6), so legacy keys collide 1:1 with what the new
-- scan/enroll would generate, and the @@unique(workflow_id, dedupe_key) blocks
-- every cross-engine re-fire. Terminal runs land past the single folded step
-- (step_cursor = 1) with NO step-run rows, so the Activity union (legacy
-- automation_runs + new workflow_step_runs) shows each historical send once.
-- PENDING runs land ACTIVE at cursor 0 with resume_at = fire_at so the poller
-- executes the deferred send at its original time, re-checking staleness first.
--
-- Idempotent: ON CONFLICT DO NOTHING on the continuity INSERT + the emptying
-- WHERE on the pending-close UPDATE make the whole file a no-op on a second run
-- (CI migration-check, Render `prisma migrate deploy`, and possible Supabase MCP
-- apply all re-run migrations against the shared staging DB). Portable: standard
-- Postgres only -- no Supabase-only objects; gen_random_uuid() / now() are core
-- and already relied on by 20260710130000_workflow_backfill_rules. Touches only
-- our own tables (workflow_enrollments, automation_runs) so no role/RLS
-- statements are needed; the migration role bypasses the FORCE RLS on
-- workflow_enrollments exactly as the backfill INSERT into workflows does.
-- NEVER run `prisma migrate` from a worktree (it mutates staging silently).

-- 1) One continuity enrollment per legacy run of a folded, published rule.
--    Runs BEFORE the pending-close UPDATE below so PENDING -> ACTIVE holds.
INSERT INTO workflow_enrollments
  (id, workflow_id, workflow_version_id, status, entity_type, entity_id, entity_label,
   occurrence_key, dedupe_key, step_cursor, resume_at, started_at, finished_at,
   finished_reason, organization_id)
SELECT
  gen_random_uuid(), w.id, w.published_version_id,
  CASE r.status
    WHEN 'SENT'    THEN 'COMPLETED'::"WorkflowEnrollmentStatus"
    WHEN 'SKIPPED' THEN 'STOPPED'::"WorkflowEnrollmentStatus"
    WHEN 'FAILED'  THEN 'FAILED'::"WorkflowEnrollmentStatus"
    WHEN 'PENDING' THEN 'ACTIVE'::"WorkflowEnrollmentStatus"
  END,
  r.entity_type, r.entity_id, r.entity_label,
  -- Recover the occurrence discriminator from the legacy dedupe_key
  -- (`${trigger}:${entityId}` or `${trigger}:${entityId}:${occurrence}`) so the
  -- continuity row matches what the new engine's createEnrollment would write.
  CASE WHEN char_length(r.dedupe_key) > char_length(w.trigger_type::text || ':' || r.entity_id::text)
       THEN substring(r.dedupe_key from char_length(w.trigger_type::text || ':' || r.entity_id::text || ':') + 1)
       ELSE NULL END,
  r.dedupe_key,
  CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END,
  COALESCE(r.fire_at, r.created_at),
  r.created_at,
  CASE WHEN r.status = 'PENDING' THEN NULL ELSE COALESCE(r.executed_at, r.created_at) END,
  CASE WHEN r.status = 'PENDING' THEN NULL ELSE COALESCE(r.detail, 'Handled by the previous automation engine') END,
  r.organization_id
FROM automation_runs r
JOIN workflows w ON w.legacy_rule_id = r.rule_id AND w.published_version_id IS NOT NULL
ON CONFLICT (workflow_id, dedupe_key) DO NOTHING;

-- 2) Close the legacy pendings honestly -- their continuity ACTIVE enrollment
--    (inserted above) now owns the deferred send; the old executor is gone.
--    Idempotent: the WHERE empties after the first run.
UPDATE automation_runs
SET status = 'SKIPPED', executed_at = now(),
    detail = 'Continued by the new workflow engine'
WHERE status = 'PENDING' AND executed_at IS NULL;

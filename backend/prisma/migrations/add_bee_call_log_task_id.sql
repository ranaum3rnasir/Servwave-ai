-- Migration: add task_id column to bee_call_logs
-- Links a follow-up task (auto-created by Bee or manually by user) directly to the call log row.
-- Replaces the fragile description text-search heuristic used previously.

ALTER TABLE bee_call_logs
  ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bee_call_logs_task_id_idx ON bee_call_logs (task_id)
  WHERE task_id IS NOT NULL;


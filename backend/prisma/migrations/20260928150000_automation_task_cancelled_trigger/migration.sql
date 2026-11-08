-- "Task is cancelled": a task's status moved into CANCELLED, and the people waiting on it should
-- be told by email or text that the work will not happen (visits-and-task-categories plan, slice 15).
--
-- ONE value, in its own migration, for the reason 20260928140000_automation_task_completed_trigger
-- states: a Postgres enum value can never be removed, so the smaller irreversible step is the safer one.
--
-- Bare ADD VALUE IF NOT EXISTS, following 20260828150000_automation_task_deleted_trigger: it is
-- idempotent, portable to vanilla Postgres, and nothing in this file uses the new value, so it is
-- safe inside the transaction the deploy step wraps it in. No backfill, nothing destructive.
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'TASK_CANCELLED';

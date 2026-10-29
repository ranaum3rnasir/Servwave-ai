-- Spec B slice 2: someone added to a task that already existed.
--
-- ONE value again, for the reason the TASK_CREATED migration states: a Postgres enum
-- value can never be removed, so the smaller irreversible step is the safer one, and an
-- admin must never be able to author a workflow against a trigger that has not shipped.
-- The remaining three task triggers land with the slices that dispatch them.
--
-- Bare ADD VALUE, following 20260828120000_automation_task_created_trigger.
-- No backfill and nothing destructive in this file.
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNED';

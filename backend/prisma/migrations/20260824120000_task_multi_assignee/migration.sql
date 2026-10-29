-- Tasks: replace the single `owner_id` scalar with a flat set of `assignee_ids`.
--
-- Shape: expand (add + backfill) then contract (drop) in one file. Every
-- statement is guarded so a re-run is a no-op, because this file runs in three
-- places (CI's vanilla postgres, Render's `migrate deploy`, and by hand via
-- Supabase MCP) and the shared staging DB may see it twice.

-- Step 1 — add the array.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assignee_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Step 2 — backfill.
--
-- COALESCE to `created_by`, not a bare owner_id: rows predating this change can
-- have a NULL owner (2 such rows on staging at time of writing), and the new
-- model's invariant is that a task always has at least one assignee. Falling
-- back to the creator keeps those rows reachable by a human instead of
-- stranding them as admin-only.
--
-- Guarded on `cardinality = 0` so re-running never clobbers assignees that were
-- edited after the first application.
UPDATE "tasks"
SET "assignee_ids" = ARRAY[COALESCE("owner_id", "created_by")]
WHERE cardinality("assignee_ids") = 0;

-- Step 3 — drop the scalar and its dependants.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_owner_id_fkey";
DROP INDEX IF EXISTS "tasks_owner_id_idx";
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "owner_id";

-- Step 4 — index both membership arrays. Every task visibility query filters
-- `assignee_ids has :me OR watcher_ids has :me`; without GIN both arms are a
-- sequential scan. watcher_ids has never been indexed — fixed here alongside.
CREATE INDEX IF NOT EXISTS "tasks_assignee_ids_idx" ON "tasks" USING GIN ("assignee_ids");
CREATE INDEX IF NOT EXISTS "tasks_watcher_ids_idx" ON "tasks" USING GIN ("watcher_ids");

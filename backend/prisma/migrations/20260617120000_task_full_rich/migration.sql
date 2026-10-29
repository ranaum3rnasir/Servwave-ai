-- TaskSource enum
DO $$ BEGIN
  CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'AI_NL', 'AI_TEMPLATE', 'AI_EXTRACT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Extend NoteEntity with TASK (PG12+ allows ADD VALUE; IF NOT EXISTS makes it idempotent)
ALTER TYPE "NoteEntity" ADD VALUE IF NOT EXISTS 'TASK';

-- Task columns
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "watcher_ids" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "ai_source" "TaskSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "ai_suggested_by" TEXT;

-- task_subtasks
CREATE TABLE IF NOT EXISTS "task_subtasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_id" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_subtasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "task_subtasks_task_id_idx" ON "task_subtasks"("task_id");
DO $$ BEGIN
  ALTER TABLE "task_subtasks" ADD CONSTRAINT "task_subtasks_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

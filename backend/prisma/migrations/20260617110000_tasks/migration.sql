-- Tasks module: Task table + enums + Organization numbering columns.
-- Additive + fully idempotent (re-runnable on the shared staging DB):
--   * enums   -> DO/EXCEPTION duplicate_object blocks
--   * table   -> CREATE TABLE IF NOT EXISTS
--   * indexes -> CREATE [UNIQUE] INDEX IF NOT EXISTS
--   * FKs     -> added inside DO/EXCEPTION blocks (no ADD CONSTRAINT IF NOT EXISTS in PG)
--   * org cols -> ADD COLUMN IF NOT EXISTS

-- Enums
DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TaskEntity" AS ENUM ('JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable: tasks
CREATE TABLE IF NOT EXISTS "tasks" (
    "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
    "task_number"        TEXT           NOT NULL,
    "title"              TEXT           NOT NULL,
    "description"        TEXT           NOT NULL DEFAULT '',
    "status"             "TaskStatus"   NOT NULL DEFAULT 'TODO',
    "priority"           "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "owner_id"           UUID,
    "due_at"             TIMESTAMP(3),
    "linked_entity_type" "TaskEntity",
    "linked_entity_id"   UUID,
    "tags"               TEXT[]         NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by"         UUID           NOT NULL,
    "created_at"         TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3)   NOT NULL,
    "completed_at"       TIMESTAMP(3),
    "organization_id"    UUID           NOT NULL,
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_organization_id_task_number_key"
  ON "tasks"("organization_id", "task_number");

CREATE INDEX IF NOT EXISTS "tasks_organization_id_idx"
  ON "tasks"("organization_id");

CREATE INDEX IF NOT EXISTS "tasks_linked_entity_type_linked_entity_id_idx"
  ON "tasks"("linked_entity_type", "linked_entity_id");

CREATE INDEX IF NOT EXISTS "tasks_owner_id_idx"
  ON "tasks"("owner_id");

-- Foreign keys (idempotent via DO/EXCEPTION)
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Organization numbering columns (idempotent)
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "task_prefix"          VARCHAR(10)  NOT NULL DEFAULT 'T';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "task_next_number"     INTEGER      NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "task_first_issued_at" TIMESTAMP(3);

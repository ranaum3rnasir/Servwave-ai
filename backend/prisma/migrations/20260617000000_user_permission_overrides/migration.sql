-- RBAC Phase 2: per-user permission overrides (allow/deny layered on the role grant).
-- Additive + fully idempotent (re-runnable on the shared staging DB):
--   * table   -> CREATE TABLE IF NOT EXISTS
--   * indexes -> CREATE [UNIQUE] INDEX IF NOT EXISTS
--   * FKs     -> added inside DO/EXCEPTION blocks (no ADD CONSTRAINT IF NOT EXISTS in PG)

-- CreateTable: user_permission_overrides
CREATE TABLE IF NOT EXISTS "user_permission_overrides" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "user_permission_overrides_user_id_action_subject_key"
  ON "user_permission_overrides"("user_id", "action", "subject");
CREATE INDEX IF NOT EXISTS "user_permission_overrides_user_id_idx"
  ON "user_permission_overrides"("user_id");
CREATE INDEX IF NOT EXISTS "user_permission_overrides_organization_id_idx"
  ON "user_permission_overrides"("organization_id");

-- Foreign keys (idempotent via DO/EXCEPTION)
DO $$ BEGIN
  ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

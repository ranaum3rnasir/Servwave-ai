-- Identity for an org's copy of a seeded built-in automation. NULL for every
-- ordinary, builder-authored workflow — Postgres never treats two NULLs as
-- equal under a unique index, so this constraint only ever fires when two
-- rows in the SAME org share the same real builtin_key (the seeder's own
-- idempotency guarantee), never against the many ordinary NULL rows.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "builtin_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "workflows_organization_id_builtin_key_key"
  ON "workflows"("organization_id", "builtin_key");

-- Demo-org flag. Idempotent because the staging DB is shared across branches
-- (see memory: Shared-Staging-DB-Migration-Drift) — re-running must no-op.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "is_demo" BOOLEAN NOT NULL DEFAULT false;

-- The seed/demo org "Servwave Test" keeps the mock-first surfaces for sales demos.
-- Scoped to that one well-known id; every other org defaults to false (real data only).
UPDATE "organizations" SET "is_demo" = true WHERE "id" = '00000000-0000-0000-0000-000000000001';

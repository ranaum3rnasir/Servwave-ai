-- Estimate workspace redesign (2026-07-03). Idempotent + portable: runs on the
-- CI migration-check shadow DB (vanilla postgres:16), Render `prisma migrate
-- deploy` against Supabase, and manual Supabase MCP application. No
-- Supabase-only objects (no RLS / auth.uid()) — these are backend-only tables,
-- matching estimate_line_items / estimate_send_configs.

-- New EstimateStatus value for revise→supersede (§A2 of the redesign spec).
ALTER TYPE "EstimateStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- estimates: name/version/edit-after-send guardrail/supersede link/deposit override/scope name
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "modified_after_send" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "superseded_by_id" UUID;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "deposit_type" "DepositDefaultType";
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "deposit_value" DECIMAL(12,2);
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "scope_name" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimates_superseded_by_id_key') THEN
    ALTER TABLE "estimates" ADD CONSTRAINT "estimates_superseded_by_id_key" UNIQUE ("superseded_by_id");
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimates_superseded_by_id_fkey') THEN
    ALTER TABLE "estimates" ADD CONSTRAINT "estimates_superseded_by_id_fkey"
      FOREIGN KEY ("superseded_by_id") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- estimate_line_items: customer-selectable optional add-on flag (§D)
ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "is_optional" BOOLEAN NOT NULL DEFAULT false;

-- organizations: org-level lock-on-send policy toggle (§A3a), default OFF
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "lock_on_send" BOOLEAN NOT NULL DEFAULT false;

-- Immutable per-send snapshot for the edit-after-send version history (§A3).
CREATE TABLE IF NOT EXISTS "estimate_version_snapshots" (
  "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
  "estimate_id"  UUID           NOT NULL,
  "version"      INTEGER        NOT NULL,
  "total_amount" DECIMAL(12,2)  NOT NULL,
  "line_items"   JSONB          NOT NULL,
  "sent_at"      TIMESTAMP(3)   NOT NULL,
  "created_at"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "estimate_version_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "estimate_version_snapshots_estimate_id_idx"
  ON "estimate_version_snapshots" ("estimate_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_version_snapshots_estimate_id_fkey') THEN
    ALTER TABLE "estimate_version_snapshots" ADD CONSTRAINT "estimate_version_snapshots_estimate_id_fkey"
      FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Reusable named/priced scope-of-work presets (§D, P1 #9).
CREATE TABLE IF NOT EXISTS "scope_presets" (
  "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID          NOT NULL,
  "name"            TEXT          NOT NULL,
  "emoji"           TEXT,
  "scope_text"      TEXT          NOT NULL,
  "priced"          BOOLEAN       NOT NULL DEFAULT false,
  "price"           DECIMAL(12,2),
  "created_at"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scope_presets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scope_presets_organization_id_idx"
  ON "scope_presets" ("organization_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scope_presets_organization_id_fkey') THEN
    ALTER TABLE "scope_presets" ADD CONSTRAINT "scope_presets_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

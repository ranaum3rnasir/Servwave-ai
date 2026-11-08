-- Custom Fields MVP (SRVW-114): enums, custom_field_definitions table, and a `custom_fields`
-- JSONB value bag on leads/jobs/customers/price_book_items.
--
-- This is slice 1 of the program (md_files/plans/custom-fields/). It lands the FULL schema for
-- the whole MVP up front so no later slice needs a second migration - only the JOB path is wired
-- up end-to-end this slice; the other three entities and the remaining field types turn on in
-- slices 2-6 without any further DDL.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guards throughout) - safe to re-run on the shared
-- staging DB. Portable - plain Postgres only, no Supabase-only objects. NEVER run `prisma migrate`
-- from a worktree; this file is applied by CI (vanilla postgres:16), Render deploy, or by hand via
-- the Supabase MCP.

DO $$ BEGIN
  CREATE TYPE "CustomFieldType" AS ENUM ('TEXT','NUMBER','DATE','SELECT','CHECKBOX');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CustomFieldEntity" AS ENUM ('LEAD','JOB','CUSTOMER','PRICE_BOOK_ITEM');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "entity_types"    "CustomFieldEntity"[] NOT NULL,
  "key"             TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  "type"            "CustomFieldType" NOT NULL,
  "options"         JSONB NOT NULL DEFAULT '[]',
  "required"        BOOLEAN NOT NULL DEFAULT false,
  "sort_order"      INTEGER NOT NULL DEFAULT 0,
  "archived_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "custom_field_definitions_organization_id_key_key"
  ON "custom_field_definitions"("organization_id","key");
CREATE INDEX IF NOT EXISTS "custom_field_definitions_organization_id_idx"
  ON "custom_field_definitions"("organization_id");

DO $$ BEGIN
  ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Value bags, keyed by definition UUID: { "<definition-uuid>": <scalar> }
ALTER TABLE "leads"           ADD COLUMN IF NOT EXISTS "custom_fields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "jobs"             ADD COLUMN IF NOT EXISTS "custom_fields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "customers"        ADD COLUMN IF NOT EXISTS "custom_fields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "price_book_items" ADD COLUMN IF NOT EXISTS "custom_fields" JSONB NOT NULL DEFAULT '{}';

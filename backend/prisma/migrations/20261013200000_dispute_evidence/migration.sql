-- Payments go-live, slice P10: answering a dispute inside ServWave
-- (md_files/plans/payments/2026-10-05-payments-go-live/03-slices/P10-dispute-evidence-api.md).
--
-- An office user attaches files they already hold (stored on the dispute's invoice), writes an explanation, stages the
-- evidence and submits it. This migration holds the draft and the record of what went:
--   - disputes: the draft text, a version for the optimistic lock, when the draft was last staged, and who submitted
--     the evidence and when (a submission is final);
--   - dispute_evidence_items: one row per file slot (one file per evidence field), with a snapshot of the file as it was
--     sent (name, type, size, pages, sha256) and the processor's file token (server-only, never returned).
--
-- PURE EXPAND. Seven nullable or defaulted columns on disputes and one new table with its indexes, foreign keys and the
-- tenant RLS backstop. Nothing existing is dropped, renamed or narrowed, so the old instance running during the deploy
-- overlap never names anything that has gone. Defaults are constants (metadata-only on Postgres 11+).
--
-- IDEMPOTENT + portable: every ADD COLUMN and CREATE is IF NOT EXISTS, every constraint tolerates a re-run, every policy is
-- dropped before it is created, and the Supabase-only roles sit behind a pg_roles guard. Runs on CI's vanilla postgres:16,
-- on the Render deploy, and possibly twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.
--
-- Foreign keys: the organization and the dispute CASCADE (a purge takes the items with it); the file is RESTRICT (a file
-- attached to a dispute cannot be deleted from under it; the app answers a friendly 409 in front of this); the person who
-- submitted is SET NULL (the name is kept in evidence_submitted_by_name).
--
-- No backfill: disputes that exist today have no draft and no submission through ServWave.

ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_text" JSONB;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_staged_at" TIMESTAMPTZ(6);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_submitted_at" TIMESTAMPTZ(6);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_submitted_by" UUID;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_submitted_by_name" TEXT;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "evidence_submission_count" INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "disputes" ADD CONSTRAINT "disputes_evidence_submitted_by_fkey"
    FOREIGN KEY ("evidence_submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "dispute_evidence_items" (
  "id"                UUID NOT NULL,
  "organization_id"   UUID NOT NULL,
  "dispute_id"        UUID NOT NULL,
  "evidence_field"    TEXT NOT NULL,
  "attachment_id"     UUID NOT NULL,
  "file_name"         TEXT NOT NULL,
  "mime"              TEXT NOT NULL,
  "size_bytes"        INTEGER NOT NULL,
  "page_count"        INTEGER NOT NULL,
  "sha256"            TEXT NOT NULL,
  "processor_file_id" TEXT,
  "staged_at"         TIMESTAMPTZ(6),
  "submitted_at"      TIMESTAMPTZ(6),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispute_evidence_items_pkey" PRIMARY KEY ("id")
);

-- One file per evidence field per dispute.
CREATE UNIQUE INDEX IF NOT EXISTS "dispute_evidence_items_dispute_id_evidence_field_key" ON "dispute_evidence_items"("dispute_id", "evidence_field");
CREATE INDEX IF NOT EXISTS "dispute_evidence_items_organization_id_idx" ON "dispute_evidence_items"("organization_id");
CREATE INDEX IF NOT EXISTS "dispute_evidence_items_attachment_id_idx" ON "dispute_evidence_items"("attachment_id");

DO $$ BEGIN
  ALTER TABLE "dispute_evidence_items" ADD CONSTRAINT "dispute_evidence_items_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_evidence_items" ADD CONSTRAINT "dispute_evidence_items_dispute_id_fkey"
    FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_evidence_items" ADD CONSTRAINT "dispute_evidence_items_attachment_id_fkey"
    FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). rls-coverage.test.ts requires it of every table with an
-- organization_id column.
ALTER TABLE "dispute_evidence_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispute_evidence_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "dispute_evidence_items";
CREATE POLICY "tenant_isolation" ON "dispute_evidence_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants: the dynamic sweep in 20260708140000 ran long before this table
-- existed. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.dispute_evidence_items FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.dispute_evidence_items FROM authenticated';
  END IF;
END $$;

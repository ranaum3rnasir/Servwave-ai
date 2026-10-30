-- Payments go-live V7-10a: a marker on an attachment saying which screen created it.
-- The Payments page's Documents tab lists only files uploaded from it (source = 'PAYMENTS_DOCUMENTS'); every
-- other attachment keeps source NULL. Additive and nullable: no backfill, no default, no enum change, so the
-- previous release keeps working against the new column. Idempotent: safe to run twice.

ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "source" TEXT;

-- The Documents list filters on the marker for one company, newest first; `attachments` is a large table and
-- almost every row has no marker, so the index is partial and stays small.
CREATE INDEX IF NOT EXISTS "attachments_organization_id_created_at_documents_idx"
  ON "attachments" ("organization_id", "created_at" DESC)
  WHERE "source" IS NOT NULL;

-- Attachment storage hardening
-- Adds canonical storage_path column so signed URLs can be minted on every read
-- (no more reliance on long-lived public URLs). Existing rows backfilled by
-- parsing the public URL — Supabase public URLs end in `/storage/v1/object/public/attachments/<path>`.

ALTER TABLE "attachments" ADD COLUMN "storage_path" TEXT;

-- Backfill from existing file_url. Extract the path segment after the bucket.
UPDATE attachments
SET storage_path = SUBSTRING(file_url FROM '/storage/v1/object/public/attachments/(.+)$')
WHERE storage_path IS NULL AND file_url IS NOT NULL;

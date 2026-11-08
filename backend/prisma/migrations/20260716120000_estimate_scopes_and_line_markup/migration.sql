ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "scopes" JSONB;
ALTER TABLE "estimate_line_items" ADD COLUMN IF NOT EXISTS "markup_percent" DECIMAL(5,2);
ALTER TABLE "estimate_version_snapshots" ADD COLUMN IF NOT EXISTS "scopes" JSONB;

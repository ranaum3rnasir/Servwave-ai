-- #2980 (spec #2978): the estimate stores the customer's current deposit method and when it was picked.
--
-- Two NULLABLE columns, no default, no backfill: existing rows stay null (no method on file), and the
-- public estimate page then shows the method list exactly as it does today. The type is the existing
-- "PaymentMethod" enum; no new enum.
--
-- IDEMPOTENT (ADD COLUMN IF NOT EXISTS). Portable plain PostgreSQL: no role, no extension, no schema
-- outside public. Adding a nullable column with no default rewrites no rows. NEVER run `prisma migrate`
-- from a worktree.

ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "deposit_method" "PaymentMethod";
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "deposit_method_at" TIMESTAMP(3);

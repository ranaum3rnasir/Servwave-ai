-- SRVW-54: pair every phone column with an optional extension.
--
-- `users.phone_ext` and `customers.phone_ext` already existed; these five are the
-- gap. All nullable, so existing rows are unaffected and the migration is
-- backward-compatible with code that never sends an extension.
--
-- Idempotent (IF NOT EXISTS) because the shared staging DB may see this twice;
-- plain ANSI DDL, so CI's vanilla postgres:16 runs it unchanged.

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "contact_phone_ext" TEXT;
ALTER TABLE "vendor_contacts" ADD COLUMN IF NOT EXISTS "phone_ext" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "phone_ext" TEXT;
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "phone_ext" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "phone_ext" TEXT;

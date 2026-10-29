-- Phone is no longer required at the DB layer on a customer. This unblocks
-- historical data migrations (e.g. ServiceCore imports) where ~half of customers
-- have no phone on file. The app-layer requirement (create-customer Zod still
-- requires phone) is INTENTIONALLY kept — new customers created through the API/UI
-- must still have a forward number. Mirrors 20260624000000_customer_email_nullable.
-- Idempotent: re-running DROP NOT NULL on an already-nullable column is a no-op.
-- Portable: no Supabase-only objects.
ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;

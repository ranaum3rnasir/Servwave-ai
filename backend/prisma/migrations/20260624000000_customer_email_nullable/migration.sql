-- Email is no longer required on a customer. Only first name (or company name)
-- and phone identify a customer; last name was already nullable
-- (20260526000001_customer_names_nullable). Idempotent: re-running DROP NOT NULL
-- on an already-nullable column is a no-op.
ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL;

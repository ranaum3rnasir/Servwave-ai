-- Allow company-only customers (no first/last name) per launch checklist §3.5c.
-- Person-or-company invariant is enforced at the Zod layer on create.
ALTER TABLE "customers" ALTER COLUMN "first_name" DROP NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "last_name" DROP NOT NULL;

-- Allow multiple invoices per Job (Lakeside progress-billing: 40% closing, 50% cabinet balance, etc.)
-- Drops the legacy 1:1 unique on invoices.job_id so the relation becomes 1:N.
DROP INDEX IF EXISTS "invoices_job_id_key";
-- Add a regular (non-unique) index to keep job_id lookups fast.
CREATE INDEX IF NOT EXISTS "invoices_job_id_idx" ON "invoices"("job_id");

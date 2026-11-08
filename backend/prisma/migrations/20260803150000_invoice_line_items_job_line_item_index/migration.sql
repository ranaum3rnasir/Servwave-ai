-- SRVW-85: the already-billed-line guard on the itemized job-invoice door filters
-- invoice_line_items by job_line_item_id on a synchronous write path. Postgres does not
-- index the referencing side of a foreign key, so without this the guard sequentially
-- scans the whole table, which grows with every line of every invoice ever written.
--
-- Mirrors the index the sibling column already has:
--   stock_movements_job_line_item_id_idx (20260717032601_inventory_p0_schema)
--
-- Portable (no Supabase-only objects) and idempotent (IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS "invoice_line_items_job_line_item_id_idx" ON "invoice_line_items"("job_line_item_id");

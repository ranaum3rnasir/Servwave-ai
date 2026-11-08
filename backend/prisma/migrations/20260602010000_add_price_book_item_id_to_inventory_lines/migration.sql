-- V6/D5: link inventory line items to the catalog (PriceBookItem) alongside the item_sku string.
-- Non-destructive: nullable FK, no backfill (existing rows keep NULL until re-saved).

ALTER TABLE "purchase_order_lines" ADD COLUMN "price_book_item_id" UUID;
CREATE INDEX "purchase_order_lines_price_book_item_id_idx" ON "purchase_order_lines"("price_book_item_id");
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_price_book_item_id_fkey"
  FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rfq_lines" ADD COLUMN "price_book_item_id" UUID;
CREATE INDEX "rfq_lines_price_book_item_id_idx" ON "rfq_lines"("price_book_item_id");
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_price_book_item_id_fkey"
  FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reservation_lines" ADD COLUMN "price_book_item_id" UUID;
CREATE INDEX "reservation_lines_price_book_item_id_idx" ON "reservation_lines"("price_book_item_id");
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_price_book_item_id_fkey"
  FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "job_stage_lines" ADD COLUMN "price_book_item_id" UUID;
CREATE INDEX "job_stage_lines_price_book_item_id_idx" ON "job_stage_lines"("price_book_item_id");
ALTER TABLE "job_stage_lines" ADD CONSTRAINT "job_stage_lines_price_book_item_id_fkey"
  FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

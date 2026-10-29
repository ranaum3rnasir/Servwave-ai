-- DEC2: per-line actual cost (cost source for the job material-cost roll-up; falls back to PriceBookItem.unit_cost).
ALTER TABLE "purchase_order_lines" ADD COLUMN "unit_cost" DECIMAL(12,2);
ALTER TABLE "job_stage_lines" ADD COLUMN "unit_cost" DECIMAL(12,2);

-- DEC3: org default receive-location (the receive resolver reads this; falls back to first warehouse if NULL).
ALTER TABLE "organizations" ADD COLUMN "default_inventory_location_id" UUID;
CREATE INDEX "organizations_default_inventory_location_id_idx" ON "organizations"("default_inventory_location_id");
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_default_inventory_location_id_fkey"
  FOREIGN KEY ("default_inventory_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

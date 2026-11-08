-- DEC1: allow lead-less estimates.
-- 1) lead_id becomes nullable (estimates can exist with no Lead).
-- 2) add a direct customer_id FK (estimates previously reached Customer only via Lead).
-- Non-destructive: every existing estimate has a lead_id (unaffected by DROP NOT NULL);
-- customer_id is nullable with no backfill (existing rows keep NULL, still reachable via lead).

ALTER TABLE "estimates" ALTER COLUMN "lead_id" DROP NOT NULL;

ALTER TABLE "estimates" ADD COLUMN "customer_id" UUID;
CREATE INDEX "estimates_customer_id_idx" ON "estimates"("customer_id");
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Inventory P2 — purchasing (plan §3.6/§3.8, items 4c + 6e).
-- Additive + idempotent + portable (no Supabase-only objects): runs on vanilla
-- postgres:16 in CI, on Supabase via Render deploy, and may run twice on the
-- shared staging DB.

-- ─── 6e: inventory_emails.purchase_order_id — the real-PO-send persistence home ─
-- InventoryEmail previously linked only rfq_id / estimate_reservation_id; a PO
-- send had no legal home (QA-908). Cascade matches the model's existing choices.
ALTER TABLE "inventory_emails" ADD COLUMN IF NOT EXISTS "purchase_order_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_emails_purchase_order_id_fkey') THEN
    ALTER TABLE "inventory_emails" ADD CONSTRAINT "inventory_emails_purchase_order_id_fkey"
      FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "inventory_emails_purchase_order_id_idx" ON "inventory_emails"("purchase_order_id");

-- ─── 4c backfill: staged-PO linkage (single-receive-path prereq, D14) ─────────
-- Link legacy string-linked stage lines to their PO by (org, po_number) —
-- po_number is @@unique per org. Idempotent via the IS NULL guard.
UPDATE "job_stage_lines" sl
SET "purchase_order_id" = po."id"
FROM "purchase_orders" po
WHERE sl."purchase_order_id" IS NULL
  AND sl."po_number" IS NOT NULL
  AND po."organization_id" = sl."organization_id"
  AND po."po_number" = sl."po_number";

-- Mark a PO staged only when ALL of its linked stage lines sit in exactly one
-- stage; ambiguous multi-stage POs stay unlinked (their linked lines are still
-- protected by the per-line direct-receive guard). Idempotent via IS NULL.
UPDATE "purchase_orders" po
SET "staged_as_job_stage_id" = s."stage_id"
FROM (
  SELECT "purchase_order_id", (MIN("job_stage_id"::text))::uuid AS "stage_id"
  FROM "job_stage_lines"
  WHERE "purchase_order_id" IS NOT NULL
  GROUP BY "purchase_order_id"
  HAVING COUNT(DISTINCT "job_stage_id") = 1
) s
WHERE po."staged_as_job_stage_id" IS NULL
  AND po."id" = s."purchase_order_id";

-- Roles & Permissions S07.11: the stored pickup of a logistic order ("Taken by me" / "Taken by..." after Processed).
-- The same five fields a stage carries (S07.6): who took the parts, who recorded it (the same person for "Taken by
-- me"), and when. Names are kept beside the ids so the record reads the same after a person is renamed or removed.
-- Additive and nullable; no backfill, so an old backend that ignores the columns keeps working during a deploy overlap.
ALTER TABLE "logistic_orders" ADD COLUMN IF NOT EXISTS "taken_by_id" UUID;
ALTER TABLE "logistic_orders" ADD COLUMN IF NOT EXISTS "taken_by_name" TEXT;
ALTER TABLE "logistic_orders" ADD COLUMN IF NOT EXISTS "recorded_by_id" UUID;
ALTER TABLE "logistic_orders" ADD COLUMN IF NOT EXISTS "recorded_by_name" TEXT;
ALTER TABLE "logistic_orders" ADD COLUMN IF NOT EXISTS "taken_at" TIMESTAMP(3);

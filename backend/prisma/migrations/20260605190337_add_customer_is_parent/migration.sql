-- Customer-form-redesign — add Customer.is_parent (franchise / billing group flag).
-- ADDITIVE ONLY: new NOT NULL column with a safe DEFAULT, so existing rows backfill to
-- false and nothing else is touched. A customer flagged is_parent=true is a top-level
-- franchise (billing group) that members may point at via parent_id.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "is_parent" BOOLEAN NOT NULL DEFAULT false;

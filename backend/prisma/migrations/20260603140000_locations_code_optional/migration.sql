-- Location "code" is no longer a required field in the UI (org Settings → Locations).
-- Relax the column to nullable so a branch can be created without a code.
-- Additive/relaxing change: existing rows and the (organization_id, code) unique
-- constraint are unaffected (Postgres treats NULLs as distinct).
ALTER TABLE "locations" ALTER COLUMN "code" DROP NOT NULL;

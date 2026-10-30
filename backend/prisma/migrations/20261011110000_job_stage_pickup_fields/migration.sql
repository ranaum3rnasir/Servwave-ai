-- Roles & Permissions S07.6: the stored pickup of a stage ("Taken by me"). Who took the parts, who recorded it
-- (the same person for "Taken by me"), and when. Names are kept beside the ids so the record reads the same after
-- a person is renamed or removed. Additive and nullable; no data moves.
ALTER TABLE "job_stages" ADD COLUMN IF NOT EXISTS "taken_by_id" UUID;
ALTER TABLE "job_stages" ADD COLUMN IF NOT EXISTS "taken_by_name" TEXT;
ALTER TABLE "job_stages" ADD COLUMN IF NOT EXISTS "recorded_by_id" UUID;
ALTER TABLE "job_stages" ADD COLUMN IF NOT EXISTS "recorded_by_name" TEXT;
ALTER TABLE "job_stages" ADD COLUMN IF NOT EXISTS "taken_at" TIMESTAMP(3);

-- A service plan may be open-ended (no contract end date). Making end_date nullable lets a plan
-- "run forever"; with no end the scheduler card shows "ongoing" and no finite visits-left
-- (derive.ts returns null planned_visit_count / visits_remaining). This unblocks the Riverbend Septic
-- migration, where ServiceCore recurring routes carry no contract-end date.
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op. Portable: no Supabase objects.
ALTER TABLE "service_plans" ALTER COLUMN "end_date" DROP NOT NULL;

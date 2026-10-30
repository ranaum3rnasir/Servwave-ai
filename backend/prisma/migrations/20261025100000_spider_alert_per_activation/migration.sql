-- Spider (D5, SPEC-3): one alert per lead per stage visit PER SWITCHED-ON PERIOD.
--
-- The claim key gains counted_from (the later of entered_status_at and the activated_at in force
-- when the alert was raised). Within one switched-on period it is fixed for a visit, so repeat sweeps
-- still collide; after an off/on it moves to the new activated_at, so a still-stuck lead can be
-- claimed once more. Existing rows already hold counted_from: no backfill, and a wider unique key
-- cannot conflict with them. No row is changed.
--
-- New index first, old one second, so the table is never without a unique claim key. Idempotent
-- and portable per .claude/skills/writing-migrations: IF NOT EXISTS / IF EXISTS, no Supabase roles,
-- RLS untouched.
--
-- Going back: roll back the CODE only and keep this index (old code's pre-check still skips any
-- claimed visit). Re-creating the old 4-column key fails once any re-alert row exists, and making it
-- succeed would mean deleting History rows. Forward-only.
CREATE UNIQUE INDEX IF NOT EXISTS "spider_alerts_visit_activation_key"
  ON "spider_alerts"("organization_id", "lead_id", "status", "entered_status_at", "counted_from");
DROP INDEX IF EXISTS "spider_alerts_organization_id_lead_id_status_entered_status_key";

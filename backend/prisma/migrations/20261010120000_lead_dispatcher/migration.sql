-- Roles & Permissions, PRD 3 (S03.4): a lead gains a Dispatcher.
--
-- A nullable reference to a user, emptied when that user is deleted (the same delete behaviour as the
-- job's Dispatcher and the lead's creator), indexed for the Leads list filter and the access resolver.
-- Existing leads start with no Dispatcher: nothing is backfilled, and an empty Dispatcher alone never
-- puts a lead in any count.
--
-- Idempotent: the shared staging database may see this migration twice.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "dispatcher_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_dispatcher_id_fkey'
  ) THEN
    ALTER TABLE "leads"
      ADD CONSTRAINT "leads_dispatcher_id_fkey"
      FOREIGN KEY ("dispatcher_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "leads_dispatcher_id_idx" ON "leads"("dispatcher_id");

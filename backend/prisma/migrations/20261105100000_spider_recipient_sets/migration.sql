-- Spider stores each recipient list once, not inside every alert row (#3107).
--
-- Every alert-log row (spider_alerts) carried its own copy of the people it told in `recipients` (about 8 KB for a
-- 60-person list), so a starting summary for 5,000 leads wrote tens of megabytes in one statement. The list is now
-- written once per distinct list:
--
--   spider_recipient_sets: id, organization_id, hash (a stable hash of the list), recipients (the list, as the alert
--     row held it) and created_at; unique per company on the hash, so a list already stored is found and reused.
--   spider_alerts.recipient_set_id: the set a row points at. New rows set it and leave `recipients` NULL; History reads
--     the list from the set when there is one, else from the old column, so an older row shows exactly what it showed.
--
-- Additive: one new table and one new nullable column. No data moves: older rows keep their own `recipients`. A backend
-- from before this never reads the new column or table, and the columns it keeps writing are untouched. The message
-- columns of spider_alerts were already nullable (a starting summary's rows have never written them).
--
-- The foreign key from an alert to its set is NO ACTION (not SET NULL): a set that vanished must fail loudly, not leave
-- an alert that silently lost the people it told. Deleting a company removes its alerts and its sets in one statement,
-- which NO ACTION allows.
--
-- Row-level security: the standard company policy, forced, no Supabase client-role grants (as the other Spider tables).
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, constraints in
-- duplicate_object guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards. No secrets.

CREATE TABLE IF NOT EXISTS "spider_recipient_sets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "recipients" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spider_recipient_sets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "spider_recipient_sets_organization_id_hash_key" ON "spider_recipient_sets"("organization_id", "hash");

DO $$ BEGIN
  ALTER TABLE "spider_recipient_sets" ADD CONSTRAINT "spider_recipient_sets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "spider_alerts" ADD COLUMN IF NOT EXISTS "recipient_set_id" UUID;

DO $$ BEGIN
  ALTER TABLE "spider_alerts" ADD CONSTRAINT "spider_alerts_recipient_set_id_fkey"
    FOREIGN KEY ("recipient_set_id") REFERENCES "spider_recipient_sets"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "spider_alerts_recipient_set_id_idx" ON "spider_alerts"("recipient_set_id");

ALTER TABLE "spider_recipient_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spider_recipient_sets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "spider_recipient_sets";
CREATE POLICY "tenant_isolation" ON "spider_recipient_sets"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_recipient_sets FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_recipient_sets FROM authenticated';
  END IF;
END $$;

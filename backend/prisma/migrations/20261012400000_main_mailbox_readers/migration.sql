-- Roles & Permissions Overhaul, PRD 10, slice S10.8: the people a holder of Company settings links to a mailbox so that
-- they read it. Only the company's main mailbox has readers today (the Sender Address page's "People who read the main
-- mailbox"); the table names the mailbox so a later shared mailbox needs no new table.
--
-- PURE EXPAND. One new table, nothing existing is touched, so the previous backend still serving for the few minutes after
-- Render applies this file never names anything that has changed. NO BACKFILL: the list starts empty at release, and
-- while nobody active is linked the holders of Manage roles and permissions read the main mailbox instead.
--
-- A link is not a switch: it says who handles one mailbox, as a company number's links do. The person owns the row
-- (deleted with the person) and so does the company (deleted with the company), so the purge and the tenant RLS backstop
-- both reach it through organization_id. `linked_by_user_id` keeps who ticked them; it is cleared if that person goes.
-- A deactivated person's row is kept and ignored while they are inactive.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS everywhere, FKs in duplicate_object
-- guards, DROP POLICY before CREATE POLICY, Supabase roles behind pg_roles guards. NEVER run `prisma migrate` from a
-- worktree.

CREATE TABLE IF NOT EXISTS "mailbox_readers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "linked_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_readers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_readers_mailbox_id_user_id_key" ON "mailbox_readers"("mailbox_id", "user_id");
CREATE INDEX IF NOT EXISTS "mailbox_readers_organization_id_idx" ON "mailbox_readers"("organization_id");
CREATE INDEX IF NOT EXISTS "mailbox_readers_user_id_idx" ON "mailbox_readers"("user_id");

DO $$ BEGIN
  ALTER TABLE "mailbox_readers" ADD CONSTRAINT "mailbox_readers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailbox_readers" ADD CONSTRAINT "mailbox_readers_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailbox_readers" ADD CONSTRAINT "mailbox_readers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailbox_readers" ADD CONSTRAINT "mailbox_readers_linked_by_user_id_fkey"
    FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Row-level security: the standard company policy, forced, no Supabase client-role grants.
ALTER TABLE "mailbox_readers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_readers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mailbox_readers";
CREATE POLICY "tenant_isolation" ON "mailbox_readers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailbox_readers FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailbox_readers FROM authenticated';
  END IF;
END $$;

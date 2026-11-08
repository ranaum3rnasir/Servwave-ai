-- Email slice 8b (conversation assignment) + 8c (per-user read state).
--
-- 8b: EmailThread is the new normalised home for per-CONVERSATION workflow
-- state (assignee, shared snooze, archive) - Email.thread_id used to be a bare,
-- FK-less TEXT column left over from the deleted Gmail integration; nothing
-- wrote it (verified live: 0 of 130 rows on staging carried a non-null value),
-- so there was no real thread to hang assignment off. Also adds
-- emails.sent_by_user_id (who sent it, stamped at send by the compose path).
--
-- 8c: EmailReadState replaces the shared Email.unread column as the source of
-- truth for "has THIS user read this message" - a row's existence means read,
-- absence means unread for that user. `unread` is left in the table as dead
-- weight for a later cleanup pass; nothing this slice touches reads or writes
-- it as truth any more (see the Prisma model comments).
--
-- BACKFILL (verified against live staging data, project redacted-staging-ref,
-- before writing this):
--   select count(*), count(*) filter (where thread_id is not null),
--          count(*) filter (where direction is null)
--   from emails;
--   -> 130 total, 0 with a thread_id, 130 with direction IS NULL. So every
--   existing row gets its OWN EmailThread (no real grouping to preserve),
--   exactly the plan's documented fallback for a near-zero thread_id count.
--
--   The plan's assumption that every direction-null row is ServWave-sent
--   ('out') does NOT hold: two rows are genuine inbound mail (folder='inbox',
--   external senders - a COI request and a vendor shipment update, both
--   predating the Gmail-integration deletion). Blindly setting every row to
--   'out' would mislabel those two as sent-by-us. `folder` is the actual
--   authoritative signal already recorded on every row (only 'inbox'/'sent'
--   values exist), so the backfill derives direction FROM folder instead of
--   assuming the plan's flat default.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; FKs behind pg_constraint
--   existence checks; ADD COLUMN IF NOT EXISTS; every backfill UPDATE/INSERT
--   is guarded so a second run touches nothing.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - the only Supabase-role
--   touches are the anon/authenticated REVOKEs, guarded behind pg_roles checks.

-- ─── 1. email_threads ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_threads" (
  "id"                  UUID NOT NULL,
  "assigned_to_user_id" UUID,
  "snoozed_until"       TIMESTAMP(3),
  "archived"            BOOLEAN NOT NULL DEFAULT false,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  "organization_id"     UUID NOT NULL,
  CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_threads_organization_id_idx"     ON "email_threads"("organization_id");
CREATE INDEX IF NOT EXISTS "email_threads_assigned_to_user_id_idx" ON "email_threads"("assigned_to_user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_threads_assigned_to_user_id_fkey') THEN
    ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_assigned_to_user_id_fkey"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_threads_organization_id_fkey') THEN
    ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 2. email_read_states ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "email_read_states" (
  "id"              UUID NOT NULL,
  "email_id"        UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "read_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "email_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_read_states_email_id_user_id_key" ON "email_read_states"("email_id", "user_id");
CREATE INDEX IF NOT EXISTS "email_read_states_organization_id_idx"          ON "email_read_states"("organization_id");
CREATE INDEX IF NOT EXISTS "email_read_states_user_id_idx"                  ON "email_read_states"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_read_states_email_id_fkey') THEN
    ALTER TABLE "email_read_states" ADD CONSTRAINT "email_read_states_email_id_fkey"
      FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_read_states_user_id_fkey') THEN
    ALTER TABLE "email_read_states" ADD CONSTRAINT "email_read_states_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_read_states_organization_id_fkey') THEN
    ALTER TABLE "email_read_states" ADD CONSTRAINT "email_read_states_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 3. emails.sent_by_user_id ──────────────────────────────────────────────
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "sent_by_user_id" UUID;
CREATE INDEX IF NOT EXISTS "emails_sent_by_user_id_idx" ON "emails"("sent_by_user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_sent_by_user_id_fkey') THEN
    ALTER TABLE "emails" ADD CONSTRAINT "emails_sent_by_user_id_fkey"
      FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
-- No backfill: there is no reliable source of truth sender for pre-existing
-- rows, so they are left NULL rather than guessed (per the approved plan).

-- ─── 4. emails.thread_id: TEXT -> UUID, becomes a real FK ───────────────────
-- Safe unconditionally: every existing value is NULL (verified above), and
-- re-running this against an already-UUID column is a harmless no-op cast.
ALTER TABLE "emails" ALTER COLUMN "thread_id" TYPE UUID USING "thread_id"::uuid;

-- ─── 5. Backfill: one EmailThread per existing Email row ────────────────────
-- Reuses the EMAIL's OWN id as the new thread's id - a deliberate bootstrap
-- shortcut (not a schema coupling): it sidesteps needing a temp mapping table
-- to correlate "which new thread belongs to which email" in a set-based
-- INSERT, while still producing a perfectly ordinary, independent EmailThread
-- primary key. Every row backfilled this way gets assigned_to_user_id = NULL
-- (Unassigned) - there is no reliable "who owns this historical conversation"
-- signal to backfill either.
INSERT INTO "email_threads" ("id", "organization_id", "archived", "created_at", "updated_at")
SELECT "id", "organization_id", false, "created_at", "created_at"
FROM "emails"
WHERE "thread_id" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "emails"
SET "thread_id" = "id"
WHERE "thread_id" IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_thread_id_fkey') THEN
    ALTER TABLE "emails" ADD CONSTRAINT "emails_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 6. Backfill: direction, derived from folder (NOT a flat 'out' default -
--     see the header comment for why the plan's assumption was wrong) ───────
UPDATE "emails"
SET "direction" = CASE WHEN "folder" = 'inbox' THEN 'in' ELSE 'out' END
WHERE "direction" IS NULL;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "email_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_threads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_threads";
CREATE POLICY "tenant_isolation" ON "email_threads"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "email_read_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_read_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_read_states";
CREATE POLICY "tenant_isolation" ON "email_read_states"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from both new
--     tables (email_attachments precedent). pg_roles guards keep this valid
--     on CI's vanilla postgres. ─────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_threads, public.email_read_states FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.email_threads, public.email_read_states FROM authenticated';
  END IF;
END $$;

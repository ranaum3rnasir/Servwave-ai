-- #2049 - per-user read state for SMS threads (the SMS mirror of
-- 20260805140000_email_thread_and_read_state's EmailReadState half). A row's
-- EXISTENCE + `read_at` means that (thread, user) pair has read the thread as
-- of that moment; absence means unread FOR THAT USER. Unlike the email
-- marker (per MESSAGE, existence-only), `read_at` here IS load-bearing - the
-- app compares it against the latest visible inbound message's `ts` per
-- requester (comm-threads.controller.ts::attachCallerUnread), because a
-- thread keeps receiving messages after it is marked read.
--
-- `message_threads.unread` is left in place as dead weight for a later
-- cleanup pass, exactly like `emails.unread` - nothing this slice reads or
-- writes as truth any more; the CTM inbound-ingest increment keeps writing it.
--
-- BACKFILL, per-org join (never a bare cross join - see the header comment on
-- 20260805140000 for why that matters): every ACTIVE user of an org gets a
-- read marker on every thread in THAT SAME ORG whose shared `unread` column
-- is 0 today, so nothing that reads as read today becomes unread for anyone.
-- A thread with `unread > 0` stays unread for everyone until each user opens
-- it. Two accepted consequences (spec "Migration + backfill", Lead ruling 5):
-- (a) a user created AFTER this migration sees old threads as unread - they
-- never read them; (b) a thread whose shared counter is 0 but which holds
-- inbound messages reads as read for pre-existing users - the whole point.
--
-- Measured on the DB `backend/.env` points at (staging, project
-- <staging project>), verified live before writing this:
--   select sum(u.n*t.n) from
--     (select organization_id o, count(*) n from users where is_active group by 1) u
--     join (select organization_id o, count(*) n from message_threads where unread=0 group by 1) t
--     on u.o=t.o;
--   -> 242 (matches the reviewer's own measurement, re-verified 2026-09-13).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; FKs behind pg_constraint
--   existence checks; the backfill INSERT is ON CONFLICT DO NOTHING.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - the only Supabase-role
--   touches (anon/authenticated REVOKEs) are guarded behind pg_roles checks.
--   `gen_random_uuid()` is core in postgres 13+ (no extension statement
--   needed) - Prisma's `@default(uuid())` is client-side only, so the
--   backfill INSERT cannot rely on a column default (email_read_states'
--   "id" column has none either, for the same reason).

-- ─── 1. message_thread_read_states ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "message_thread_read_states" (
  "id"              UUID NOT NULL,
  "thread_id"       UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "read_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "message_thread_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_thread_read_states_thread_id_user_id_key" ON "message_thread_read_states"("thread_id", "user_id");
CREATE INDEX IF NOT EXISTS "message_thread_read_states_organization_id_idx"          ON "message_thread_read_states"("organization_id");
CREATE INDEX IF NOT EXISTS "message_thread_read_states_user_id_idx"                  ON "message_thread_read_states"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_thread_read_states_thread_id_fkey') THEN
    ALTER TABLE "message_thread_read_states" ADD CONSTRAINT "message_thread_read_states_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "message_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_thread_read_states_user_id_fkey') THEN
    ALTER TABLE "message_thread_read_states" ADD CONSTRAINT "message_thread_read_states_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_thread_read_states_organization_id_fkey') THEN
    ALTER TABLE "message_thread_read_states" ADD CONSTRAINT "message_thread_read_states_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 2. Backfill (R7 - per-org join, gen_random_uuid(), ON CONFLICT DO NOTHING) ─
INSERT INTO "message_thread_read_states" ("id", "thread_id", "user_id", "read_at", "organization_id")
SELECT gen_random_uuid(), t.id, u.id, now(), t.organization_id
FROM "message_threads" t
JOIN "users" u ON u.organization_id = t.organization_id AND u.is_active
WHERE t.unread = 0
ON CONFLICT ("thread_id", "user_id") DO NOTHING;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "message_thread_read_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_thread_read_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "message_thread_read_states";
CREATE POLICY "tenant_isolation" ON "message_thread_read_states"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants (email_read_states
--     precedent). pg_roles guards keep this valid on CI's vanilla postgres. ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.message_thread_read_states FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.message_thread_read_states FROM authenticated';
  END IF;
END $$;

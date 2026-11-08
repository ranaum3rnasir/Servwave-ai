-- #2049 slice 2 - per-user read state for WhatsApp chats (the WhatsApp mirror
-- of 20260913120000_message_thread_read_state's SMS half). A row's EXISTENCE +
-- `read_at` means that (chat, user) pair has read the chat as of that moment;
-- absence means unread FOR THAT USER. `read_at` IS load-bearing here - the app
-- compares it against the latest visible inbound message's `created_at` per
-- requester (comm-whatsapp-email.controller.ts::attachCallerUnreadWhatsApp).
--
-- ONE DELIBERATE DIFFERENCE FROM THE SMS PREDICATE (does not port mechanically,
-- Reviewer amendment R10): WhatsAppMessage has no `direction` column, so
-- inbound is `from <> 'us'` (the send path hard-codes `from: 'us'`), and the
-- recency comparison uses `created_at`, never `at` - `WhatsAppMessage.at` is a
-- display STRING ("9:32 AM"), not sortable/comparable.
--
-- `whatsapp_chats.unread` is left in place as dead weight for a later cleanup
-- pass, exactly like `message_threads.unread` - nothing this slice reads or
-- writes as truth any more (nothing in the backend writes it at all; only the
-- seed does).
--
-- BACKFILL, per-org join (never a bare cross join - see the header comment on
-- 20260805140000 for why that matters): every ACTIVE user of an org gets a
-- read marker on every chat in THAT SAME ORG whose shared `unread` column is 0
-- today, so nothing that reads as read today becomes unread for anyone. A chat
-- with `unread > 0` stays unread for everyone until each user opens it. Same
-- two accepted consequences as the SMS migration (Lead ruling 5): (a) a user
-- created AFTER this migration sees old chats as unread - they never read
-- them; (b) a chat whose shared counter is 0 but which holds inbound messages
-- reads as read for pre-existing users - the whole point of the backfill.
--
-- Measured on the DB `backend/.env` points at (staging, project
-- <staging project>), verified live before writing this:
--   select sum(u.n*t.n) from
--     (select organization_id o, count(*) n from users where is_active group by 1) u
--     join (select organization_id o, count(*) n from whatsapp_chats where unread=0 group by 1) t
--     on u.o=t.o;
--   -> 21.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; FKs behind pg_constraint
--   existence checks; the backfill INSERT is ON CONFLICT DO NOTHING.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - the only Supabase-role
--   touches (anon/authenticated REVOKEs) are guarded behind pg_roles checks.
--   `gen_random_uuid()` is core in postgres 13+ (no extension statement
--   needed) - Prisma's `@default(uuid())` is client-side only, so the
--   backfill INSERT cannot rely on a column default (message_thread_read_states'
--   "id" column has none either, for the same reason).

-- ─── 1. whatsapp_chat_read_states ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "whatsapp_chat_read_states" (
  "id"              UUID NOT NULL,
  "chat_id"         UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "read_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "whatsapp_chat_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_chat_read_states_chat_id_user_id_key" ON "whatsapp_chat_read_states"("chat_id", "user_id");
CREATE INDEX IF NOT EXISTS "whatsapp_chat_read_states_organization_id_idx"        ON "whatsapp_chat_read_states"("organization_id");
CREATE INDEX IF NOT EXISTS "whatsapp_chat_read_states_user_id_idx"                ON "whatsapp_chat_read_states"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_chat_read_states_chat_id_fkey') THEN
    ALTER TABLE "whatsapp_chat_read_states" ADD CONSTRAINT "whatsapp_chat_read_states_chat_id_fkey"
      FOREIGN KEY ("chat_id") REFERENCES "whatsapp_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_chat_read_states_user_id_fkey') THEN
    ALTER TABLE "whatsapp_chat_read_states" ADD CONSTRAINT "whatsapp_chat_read_states_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_chat_read_states_organization_id_fkey') THEN
    ALTER TABLE "whatsapp_chat_read_states" ADD CONSTRAINT "whatsapp_chat_read_states_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 2. Backfill (R7 - per-org join, gen_random_uuid(), ON CONFLICT DO NOTHING) ─
INSERT INTO "whatsapp_chat_read_states" ("id", "chat_id", "user_id", "read_at", "organization_id")
SELECT gen_random_uuid(), c.id, u.id, now(), c.organization_id
FROM "whatsapp_chats" c
JOIN "users" u ON u.organization_id = c.organization_id AND u.is_active
WHERE c.unread = 0
ON CONFLICT ("chat_id", "user_id") DO NOTHING;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "whatsapp_chat_read_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_chat_read_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "whatsapp_chat_read_states";
CREATE POLICY "tenant_isolation" ON "whatsapp_chat_read_states"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants (email_read_states
--     precedent). pg_roles guards keep this valid on CI's vanilla postgres. ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.whatsapp_chat_read_states FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.whatsapp_chat_read_states FROM authenticated';
  END IF;
END $$;

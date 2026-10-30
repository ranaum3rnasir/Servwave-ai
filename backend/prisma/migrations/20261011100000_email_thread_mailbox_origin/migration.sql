-- Roles & Permissions Overhaul, PRD 10, slice S10.4: every email conversation belongs to a mailbox,
-- with an origin.
--
-- An email conversation is a row of `email_threads`. It gains:
--   mailbox_id   the mailbox it belongs to (the company's main mailbox for everything that exists today);
--   origin       how it got there: 'started' (started here), 'migrated' (there before go-live),
--                'moved' (moved in from another mailbox) or 'record' (opened by a send to a customer
--                about one record);
--   record_type, record_id   the record a 'record' conversation belongs to, taken from the reply token
--                that names it (the same vocabulary as reply_tokens.entity_type).
-- The person who sent a document by hand needs no column: emails.sent_by_user_id and
-- reply_tokens.created_by_user_id already exist and are written by the sender code.
--
-- Then, once, every existing conversation is placed:
--   * it goes into its own company's main mailbox (made by S10.1), its assignee kept;
--   * a conversation with a reply token that names a record becomes origin 'record' with that record
--     (the oldest such token decides, so the answer does not depend on row order); every other one is
--     'migrated';
--   * loose system email (an email with no conversation) is not touched: it stays in no mailbox.
--
-- A DRY RUN reports the counts and writes nothing:
--   SET s10_4.dry_run = 'on';  then run this file in the same session.
-- A real run prints the same counts before it writes and per-environment counts after, and stops with an
-- error (rolling the migration back) if a conversation is left without a mailbox. Only conversations
-- without a mailbox are touched, so a second run changes nothing. Notices carry counts only, never an
-- address, a subject or a name.
--
-- IDEMPOTENT + portable plain PostgreSQL. Runs on CI's vanilla postgres:16, on the Render deploy, and
-- possibly twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "email_threads" ADD COLUMN IF NOT EXISTS "mailbox_id" UUID;
ALTER TABLE "email_threads" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'started';
ALTER TABLE "email_threads" ADD COLUMN IF NOT EXISTS "record_type" TEXT;
ALTER TABLE "email_threads" ADD COLUMN IF NOT EXISTS "record_id" UUID;

CREATE INDEX IF NOT EXISTS "email_threads_mailbox_id_idx" ON "email_threads"("mailbox_id");

-- A mailbox goes with its company; a conversation row outliving its mailbox reads as unplaced rather
-- than blocking the purge.
DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- The conversations and the reply tokens are read and written below; both carry RLS.
SELECT set_config('app.bypass_rls', 'on', true);

DO $$
DECLARE
  dry_run boolean := coalesce(current_setting('s10_4.dry_run', true), '') = 'on';
  thread_total integer;
  to_place integer;
  record_total integer;
  migrated_total integer;
  placed_total integer;
  unplaced integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp.s10_4_plan;
  -- Every conversation not yet in a mailbox, with the record its oldest record-naming token names.
  CREATE TEMP TABLE s10_4_plan ON COMMIT DROP AS
  SELECT t.id AS thread_id,
         m.id AS mailbox_id,
         r.entity_type AS record_type,
         r.entity_id AS record_id
  FROM "email_threads" t
  LEFT JOIN "mailboxes" m ON m.organization_id = t.organization_id AND m.kind = 'main'
  LEFT JOIN LATERAL (
    SELECT rt.entity_type, rt.entity_id
    FROM "reply_tokens" rt
    WHERE rt.thread_id = t.id AND rt.entity_type IS NOT NULL AND rt.entity_id IS NOT NULL
    ORDER BY rt.created_at, rt.token
    LIMIT 1
  ) r ON true
  WHERE t.mailbox_id IS NULL;

  SELECT count(*) INTO thread_total FROM "email_threads";
  SELECT count(*) INTO to_place FROM s10_4_plan;
  SELECT count(*) INTO record_total FROM s10_4_plan WHERE record_id IS NOT NULL;
  migrated_total := to_place - record_total;
  RAISE NOTICE 'S10.4 % conversations, % to place, % record, % migrated%',
    thread_total, to_place, record_total, migrated_total, CASE WHEN dry_run THEN ' (DRY RUN, nothing written)' ELSE '' END;

  IF dry_run THEN
    RETURN;
  END IF;

  UPDATE "email_threads" t
  SET mailbox_id = p.mailbox_id,
      origin = CASE WHEN p.record_id IS NOT NULL THEN 'record' ELSE 'migrated' END,
      record_type = p.record_type,
      record_id = p.record_id
  FROM s10_4_plan p
  WHERE t.id = p.thread_id AND p.mailbox_id IS NOT NULL;

  SELECT count(*) INTO placed_total FROM "email_threads" WHERE mailbox_id IS NOT NULL;
  SELECT count(*) INTO unplaced FROM "email_threads" WHERE mailbox_id IS NULL;
  RAISE NOTICE 'S10.4 done: % conversations, % in a mailbox, % record, % migrated, % without a main mailbox',
    thread_total, placed_total, record_total, migrated_total, unplaced;

  IF unplaced > 0 THEN
    RAISE EXCEPTION 'S10.4: % conversations are left without a mailbox (their company has no main mailbox)', unplaced;
  END IF;
END $$;

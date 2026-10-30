-- Roles & Permissions Overhaul, PRD 10, slice S10.18: the Needs review folder. A received message the router will not deliver
-- (sender authentication failed, automatic mail, a reply from an address we did not send to, a reply on an address that no
-- longer resolves) is held in a mailbox's Needs review list. It needs a reason, the mailbox it is filed under and, for a reply,
-- the conversation its reply address belongs to (who may see a held reply to an invoice or an estimate follows that
-- conversation's record).
--
-- EXPAND ONLY, plus one scoped backfill. Three nullable columns, two foreign keys (SET NULL: a deleted mailbox or conversation
-- must never delete the held message), two indexes. Nothing existing is renamed or dropped, so the previous backend still
-- serving for the few minutes after Render applies this file never names anything that has changed.
--
--   emails.review_reason       failed_authentication | automatic | sender_mismatch | unknown_reply. Null on every other row.
--   emails.review_mailbox_id   the mailbox the held message is filed under.
--   emails.review_thread_id    the conversation the reply address it arrived on belongs to, when it has one.
--
-- BACKFILL (set-based, idempotent): the messages the old unmatched queue already holds (a reply the router refused to attach:
-- inbound_match UNMATCHED_*, no conversation) get a reason, are filed under the mailbox their reply address's conversation sits
-- in, else the company's main mailbox, and move to the folder "needs_review" like every held message, so they stop counting as
-- inbox mail. Only rows that are still unfiled (review_reason is null) are touched, so a second run changes nothing.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS throughout, constraints added inside a guarded
-- block, no Supabase-only objects. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "review_reason" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "review_mailbox_id" UUID;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "review_thread_id" UUID;

DO $$ BEGIN
  ALTER TABLE "emails" ADD CONSTRAINT "emails_review_mailbox_id_fkey"
    FOREIGN KEY ("review_mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "emails" ADD CONSTRAINT "emails_review_thread_id_fkey"
    FOREIGN KEY ("review_thread_id") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "emails_review_mailbox_id_ts_idx" ON "emails"("review_mailbox_id", "ts");
CREATE INDEX IF NOT EXISTS "emails_review_thread_id_idx" ON "emails"("review_thread_id");

UPDATE "emails" e
SET "review_reason" = CASE WHEN e."inbound_auth" = 'FAIL' THEN 'failed_authentication' ELSE 'sender_mismatch' END,
    "review_thread_id" = (SELECT rt."thread_id" FROM "reply_tokens" rt WHERE rt."token" = e."reply_token"),
    "review_mailbox_id" = COALESCE(
      (SELECT th."mailbox_id" FROM "reply_tokens" rt JOIN "email_threads" th ON th."id" = rt."thread_id" WHERE rt."token" = e."reply_token"),
      (SELECT m."id" FROM "mailboxes" m WHERE m."organization_id" = e."organization_id" AND m."kind" = 'main' LIMIT 1)
    ),
    "folder" = 'needs_review'
WHERE e."review_reason" IS NULL
  AND e."thread_id" IS NULL
  AND e."direction" = 'in'
  AND e."inbound_match" IN ('UNMATCHED_SENDER', 'UNMATCHED_NO_TOKEN');

-- Roles & Permissions Overhaul, PRD 10, slice S10.21: deactivating a person hands their mailbox on.
--
-- Two columns, no rows written:
--   mailboxes.merged_into_mailbox_id     the mailbox a merged mailbox was handed to (the company's main mailbox).
--                                        A merged mailbox keeps its owner (user_id) and its address rows, so the
--                                        inbound router can follow the address to the mailbox it was merged into,
--                                        and a reactivated person's old address and mailbox can be found again.
--   email_threads.moved_from_mailbox_id  the mailbox a conversation was moved in from. The conversation's origin says
--                                        THAT it was moved ('moved'; a record conversation keeps origin 'record', so
--                                        it still follows its record); this says from where, for the label and for
--                                        handing a merged mailbox on later.
--
-- Both are plain references that go empty if the mailbox row is ever removed, never a block.
--
-- IDEMPOTENT + portable plain PostgreSQL. Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice
-- against the shared staging DB. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "merged_into_mailbox_id" UUID;
ALTER TABLE "email_threads" ADD COLUMN IF NOT EXISTS "moved_from_mailbox_id" UUID;

DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_merged_into_mailbox_id_fkey"
    FOREIGN KEY ("merged_into_mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_moved_from_mailbox_id_fkey"
    FOREIGN KEY ("moved_from_mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Handing a merged mailbox on later (S10.22) finds the conversations that came from it.
CREATE INDEX IF NOT EXISTS "email_threads_moved_from_mailbox_id_idx" ON "email_threads"("moved_from_mailbox_id");

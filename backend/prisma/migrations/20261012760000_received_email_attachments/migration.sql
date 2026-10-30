-- Roles & Permissions Overhaul, PRD 10, slice S10.17: attachments on RECEIVED mail are brought over from the mail provider
-- and stored the way a composed email's attachments are (the same email_attachments table and storage bucket).
--
-- PURE EXPAND. Three new columns with defaults and two indexes; nothing existing is touched, so the previous backend still
-- serving for the few minutes after Render applies this file never names anything that has changed. NO BACKFILL: mail that
-- arrived before this file keeps the attachments it has (none) and is never retried (attachments_pending defaults to false).
--
--   email_attachments.provider_attachment_id  the provider's id for the attachment on a received message (null for a file a
--                                             person attached when composing). Unique within its email, so a retry or two
--                                             overlapping runs can never store the same attachment twice. Postgres treats
--                                             nulls as distinct, so compose rows are not affected by the index.
--   emails.attachments_pending                true while a received message still has attachments on their way. Set in the
--                                             write that stores the message; cleared once each is stored or permanently
--                                             skipped. The message shows either way.
--   emails.attachment_attempts                how many times bringing them over has been tried; the retry sweep gives up at
--                                             a fixed count and leaves the flag set so the failure stays visible.
--
-- Idempotent and portable per .claude/skills/writing-migrations: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS, no
-- Supabase-only objects. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "email_attachments" ADD COLUMN IF NOT EXISTS "provider_attachment_id" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "attachments_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "attachment_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "email_attachments_email_id_provider_attachment_id_key"
  ON "email_attachments"("email_id", "provider_attachment_id");
CREATE INDEX IF NOT EXISTS "emails_attachments_pending_idx" ON "emails"("attachments_pending");

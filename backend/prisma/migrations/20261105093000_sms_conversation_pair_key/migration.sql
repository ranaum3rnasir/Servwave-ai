-- One conversation per pair of numbers (#3019, parent #3013).
--
-- An SMS conversation with a customer or an unknown number is identified by the organisation, the
-- other party's number and our number. Two nullable columns on message_threads hold that pair:
--
--   other_party_e164: the customer's (or unknown sender's) number, normalized E.164.
--   our_number_e164:  the organisation's number the conversation is on, normalized E.164. Null when
--                     the organisation has no number at all.
--
-- Both stay empty on staff, vendor and group conversations (unchanged), and on a customer
-- conversation until the split script keys it (scripts/sms-conversation-pair-split.ts, dry run
-- first). The code reads an un-keyed conversation exactly as before, so nothing depends on the
-- script having run.
--
-- The index answers "the conversation for this pair in this organisation":
--   WHERE organization_id = $1 AND other_party_e164 = $2 AND our_number_e164 = $3
-- Not UNIQUE (not approved): the find-or-create and the split script keep one conversation per pair.
--
-- Additive only, no data moves. IF NOT EXISTS everywhere, so a second apply is a no-op.
-- No CONCURRENTLY: Prisma runs a migration inside a transaction, where it cannot run.
-- Portable: no Supabase-only objects, no secrets.

ALTER TABLE "message_threads" ADD COLUMN IF NOT EXISTS "other_party_e164" TEXT;
ALTER TABLE "message_threads" ADD COLUMN IF NOT EXISTS "our_number_e164" TEXT;

CREATE INDEX IF NOT EXISTS "message_threads_organization_id_other_party_e164_our_number_idx"
  ON "message_threads" ("organization_id", "other_party_e164", "our_number_e164");

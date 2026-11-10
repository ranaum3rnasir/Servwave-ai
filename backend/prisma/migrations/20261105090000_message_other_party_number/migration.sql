-- Every text remembers the other party's number (#3014).
--
-- messages.other_party_e164: the customer's (or other party's) number, normalized E.164, beside the
-- company number a text already stores (phone_number_id). Nullable: a text whose other side is no
-- single number keeps it empty, and so does an older text until the fill-in places it.
--
-- The index answers "the latest text we sent to this number in this organisation":
--   WHERE organization_id = $1 AND other_party_e164 = $2 [AND direction = 'out'] ORDER BY ts DESC LIMIT 1
--
-- Additive only. No data moves here: past rows are filled by a script run by hand, dry run first
-- (scripts/text-other-party-number-fill-in.ts). IF NOT EXISTS on both, so a second apply is a no-op.
-- No CONCURRENTLY: Prisma runs a migration inside a transaction, where it cannot run.
--
-- Portable: no Supabase-only objects, no secrets.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "other_party_e164" TEXT;

CREATE INDEX IF NOT EXISTS "messages_organization_id_other_party_e164_ts_idx"
  ON "messages" ("organization_id", "other_party_e164", "ts");

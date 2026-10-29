-- MessageThread.user_id - a FOURTH counterparty for a message thread: a user.
--
-- Spec C (staff SMS) needs a thread keyed on a member of staff rather than on a
-- customer. The thread model already addresses three counterparties - customer,
-- lead and vendor - each as a nullable id with a relation and an index, so the
-- user follows that shape exactly. Nothing writes a user-keyed thread yet; this
-- migration only makes one expressible.
--
-- Expand-only: a nullable column, an index and an FK. No backfill (no row has
-- ever carried a value to backfill from) and nothing dropped or rewritten, so a
-- code rollback leaves a harmless unused column behind and loses nothing.
--
-- No RLS work is needed: the policy on message_threads is row-level on
-- organization_id and is column-agnostic.

-- 1. Column (nullable; a customer/lead/vendor thread legitimately has no user).
ALTER TABLE "message_threads" ADD COLUMN IF NOT EXISTS "user_id" UUID;

-- 2. Index, matching the three sibling counterparty indexes - every read that
--    addresses a staff thread filters on it.
CREATE INDEX IF NOT EXISTS "message_threads_user_id_idx" ON "message_threads"("user_id");

-- 3. FK. ON DELETE SET NULL, the same as customer_id / lead_id / vendor_id: a
--    conversation outlives the person it was held with, and losing the pointer
--    must never delete the thread or block deleting the user. Guarded on
--    pg_constraint because ADD CONSTRAINT has no IF NOT EXISTS form, so a re-run
--    on the shared staging database is a no-op.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_threads_user_id_fkey'
  ) THEN
    ALTER TABLE "message_threads"
      ADD CONSTRAINT "message_threads_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Drop the Gmail inbox mirror: the email_accounts table plus the two emails
-- columns that only ever existed to serve it.
--
-- Reverses 20260716210000_gmail_inbox_integration. Inbound and outbound email
-- both move to Resend in later slices, so this code was stale scaffolding for
-- something that will not be built. Verified against the live staging DB before
-- writing this: email_accounts held 0 rows, and of 285 emails rows both
-- gmail_message_id and email_account_id were NULL on every single one. No org
-- ever completed a Gmail connect, so nothing is orphaned by these drops.
--
-- The provider-neutral emails columns STAY (direction, rfc822_message_id,
-- in_reply_to, references_header, cc, bcc, body_html) - they describe a message,
-- not a provider, and the Resend slices reuse them as-is.
--
-- IDEMPOTENT: every statement is IF EXISTS-guarded, so a second application
--   against the shared staging DB is a no-op. DROP CONSTRAINT IF EXISTS and
--   DROP INDEX IF EXISTS never error on an already-clean database.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects.
--   DROP TABLE takes the table's RLS policy and role grants down with it, so
--   there is nothing role-specific left to guard here.

-- 1. emails -> email_accounts foreign key (must go before the column).
ALTER TABLE "emails" DROP CONSTRAINT IF EXISTS "emails_email_account_id_fkey";

-- 2. Indexes on the two doomed columns.
DROP INDEX IF EXISTS "emails_email_account_id_idx";
DROP INDEX IF EXISTS "emails_gmail_message_id_key";

-- 3. The columns themselves.
ALTER TABLE "emails" DROP COLUMN IF EXISTS "email_account_id";
ALTER TABLE "emails" DROP COLUMN IF EXISTS "gmail_message_id";

-- 4. The connected-mailbox table (0 rows everywhere; CASCADE is deliberately
--    NOT used - the only inbound dependency was the FK dropped in step 1, and a
--    bare DROP failing loudly is the right outcome if that is ever untrue).
DROP TABLE IF EXISTS "email_accounts";

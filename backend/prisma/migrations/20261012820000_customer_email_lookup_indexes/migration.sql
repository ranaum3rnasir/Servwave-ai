-- Roles & Permissions, PRD 10 (S10.20): mail links to a customer by its address.
--
-- A received message on a mailbox address, and an email a person sends from their own mailbox, is matched to the customer whose
-- address it came from or went to, case aside: one lookup per message, "which customers of this company have this address, lower-
-- cased". The customers' email columns are indexed as written (case and all), which that comparison cannot use, so without these
-- two indexes the lookup would read every customer of the company for every message. They index exactly the expression the lookup
-- compares, nothing else.
--
-- Indexes only: NO schema change and NO data is written or backfilled. Earlier mail is deliberately left as it is: mailbox mail
-- exists only from the release of this programme, and an email sent by hand before it was linked by the rules of its day (the
-- record it was written on). Re-linking old mail by address would change what already appears on customers' tabs, which no
-- one asked for.
--
-- The expression indexes are not something schema.prisma can model (the same note as task_categories_organization_id_name_key's),
-- so the schema file carries nothing for them.
--
-- IDEMPOTENT: IF NOT EXISTS, so a second run changes nothing. Portable plain PostgreSQL (no vendor roles). Runs on CI's vanilla
-- postgres:16, on the Render deploy, and possibly twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.

CREATE INDEX IF NOT EXISTS "customers_organization_id_lower_email_idx"
  ON "customers" ("organization_id", lower("email"));

CREATE INDEX IF NOT EXISTS "customer_emails_lower_email_idx"
  ON "customer_emails" (lower("email"));

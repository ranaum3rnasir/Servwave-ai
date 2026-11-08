-- The local part of an org's business From address (`northwind@mail.servwave.com`)
-- has always been derived from `organizations.name` with no way to override it.
-- This column lets an org choose its own.
--
-- DELIBERATELY NULLABLE AND NOT BACKFILLED. NULL means "derive from the name",
-- which is exactly the behaviour that predates this column, so every existing
-- org keeps the address it has today and a company rename still moves that
-- address. Only an org that explicitly sets a value opts out of that.
--
-- Backfilling the derived value instead would have silently changed behaviour
-- for every org at once: a later rename would no longer update the address, and
-- nobody asked for it to freeze.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "email_sender_local_part" TEXT;

-- UNIQUE over the orgs that have set one. NULLs do not conflict with each other
-- in Postgres, so every org still on the derived default is exempt - which is
-- what makes the nullable design work at all.
--
-- Two companies sending as the same address on one shared domain would confuse
-- any recipient who replied to the From instead of the Reply-To, and reply
-- routing is per-thread by token, so the From is nobody's inbox.
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_email_sender_local_part_key"
  ON "organizations" ("email_sender_local_part");

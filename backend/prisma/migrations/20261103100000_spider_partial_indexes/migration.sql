-- Two partial indexes for the Spider sweep (#2994).
--
--   leads_open_org_idx: the sweep reads a company's OPEN leads (not won, lost or cancelled) every run.
--   notification_recipients_unread_org_notification_idx: the sweep, and every unread-alert lookup,
--     reads a company's UNREAD recipient rows.
--
-- Partial, so Prisma's schema cannot express them (see mailboxes_one_main_per_org for the earlier
-- example); this file is where they live. They are left out of schema.prisma on purpose, and
-- `prisma migrate diff` against the schema will list them as drops. `prisma migrate status` (what CI
-- checks) reads only migration history and is unaffected.
--
-- Production gets these first, built by hand with CREATE INDEX CONCURRENTLY (no table lock) and then
-- recorded with `prisma migrate resolve --applied`, using the SAME names as below. So this file must be
-- safe where they already exist: IF NOT EXISTS makes a second run a no-op.
-- It must NOT use CONCURRENTLY: Prisma runs a migration inside a transaction, and CONCURRENTLY cannot
-- run in one. Everywhere else (new environments, CI, staging) the tables are small enough for a plain build.
--
-- Portable: no Supabase-only objects, no secrets.

CREATE INDEX IF NOT EXISTS "leads_open_org_idx"
  ON "leads" ("organization_id")
  WHERE "won_at" IS NULL AND "lost_at" IS NULL AND "cancelled_at" IS NULL;

CREATE INDEX IF NOT EXISTS "notification_recipients_unread_org_notification_idx"
  ON "notification_recipients" ("organization_id", "notification_id")
  WHERE "read_at" IS NULL;

-- Open-lead index for the Spider sweep's paging read (#3058).
--
--   leads_open_org_id_idx: ("organization_id", "id") over a company's OPEN leads (not won, lost or cancelled).
--
-- The sweep reads a company's open leads in keyset pages of 500 by lead id: organization_id = X, the open-lead
-- condition, id > <last id read>, ORDER BY id, LIMIT 500 (services/spider/sweep.ts, currentStageVisits). With only
-- leads_open_org_idx (organization_id alone) every page started again from the front of the company's entries and the
-- total work grew with the square of the open leads. With "id" as the second column each page starts where the last one
-- ended, already in lead id order.
--
-- The predicate is exactly leads_open_org_idx's (migration 20261103100000) and the sweep's read, so the planner can use
-- it. leads_open_org_idx is KEPT here; it is dropped later, once this index is in place in production.
--
-- Partial, so Prisma's schema cannot express it (see 20261103100000_spider_partial_indexes for the same case): it is left
-- out of schema.prisma on purpose. Prisma's comparison skips partial indexes, so `prisma migrate diff` does not list it
-- either way, and `prisma migrate status` (what CI checks) reads only migration history.
--
-- Production gets this first, built by hand with CREATE INDEX CONCURRENTLY (no table lock) and then recorded with
-- `prisma migrate resolve --applied`, using the SAME name as below, as #2994 did. So this file must be safe where the
-- index already exists: IF NOT EXISTS makes a second run a no-op.
-- It must NOT use CONCURRENTLY: Prisma runs a migration inside a transaction, and CONCURRENTLY cannot run in one.
-- Everywhere else (new environments, CI, staging) the table is small enough for a plain build.
--
-- Portable: no Supabase-only objects, no secrets.

CREATE INDEX IF NOT EXISTS "leads_open_org_id_idx"
  ON "leads" ("organization_id", "id")
  WHERE "won_at" IS NULL AND "lost_at" IS NULL AND "cancelled_at" IS NULL;

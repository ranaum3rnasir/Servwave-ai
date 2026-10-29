-- Lead marketing attribution, web-form lead intake slice 2 (plan:
-- md_files/plans/communication/2026-09-18-web-form-lead-intake.md §3e).
--
-- One nullable JSONB column on `leads`, mirroring `call_sessions.attribution` key for key
-- (source, medium, campaign, keyword, referrer, landing_page, gclid). The point is the SHARED
-- vocabulary: with the same keys on both tables, "which campaign produced revenue" is one UNION
-- over calls and forms instead of two schemas that have to be reconciled by hand.
--
-- NOT a source column. Source is a first-touch CUSTOMER attribute (`customers.ad_source`) - see
-- md_files/plans/communication/2026-09-18-source-is-a-first-touch-customer-attribute.md R1/R2.
-- This holds the PER-SUBMISSION detail, including for a returning customer whose origin must not
-- be rewritten. `leads.source` stays dead and gains no writer.
--
-- PURE EXPAND, and its own migration rather than an edit to
-- 20260918120000_web_form_integrations: two independent changes, so a revert of either is a
-- revert of one. (Slice 1's file has since been corrected in place - its unique key was missing
-- the org - which was safe only because it had never been applied to a shared database. Once it
-- has, editing it would leave the ledger's checksum disagreeing with the file, and a new
-- migration is the only option.)
--
-- Nothing is dropped or renamed, and the column is nullable with no default, so the OLD instance
-- running during a deploy overlap is unaffected: it never names the column, and Prisma's generated
-- column list for `leads` does not include it until the new build is live.
--
-- IDEMPOTENT + portable: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, plain DDL, no
-- Supabase-only objects. Runs on CI's vanilla postgres:16, on Render deploy, and possibly twice
-- against the shared staging DB. NEVER run `prisma migrate` from a worktree.
--
-- No RLS/GRANT block: `leads` is an existing table that already carries the tenant_isolation
-- policy and the PostgREST revokes. Adding a column does not change either, and an index is
-- invisible to row-level security.

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "attribution" JSONB;

-- The twin of `call_sessions_attribution_idx` (20260807120000_call_attribution), statement for
-- statement. Reports will filter on individual keys (source/campaign), which is what GIN on
-- jsonb_path_ops is for. PARTIAL because the column is null and never `{}` when nothing survived
-- (lib/web-form/process.ts returns null deliberately), so the index covers only rows that carry
-- attribution rather than every lead in the system - which is exactly what the schema comment on
-- `Lead.attribution` already promised. Indexing one half of a two-table union and not the other
-- is how the planner ends up sequentially scanning the other half.
--
-- NOW rather than later: the column is brand new and every row is NULL, so this build is instant.
--
-- NOT CONCURRENTLY: Prisma runs each migration inside a transaction, and CREATE INDEX
-- CONCURRENTLY cannot run in one (20260819140000_visits_scheduled_at_index_multi_visit_s6 records
-- the same constraint; re-verified against a real postgres:16 for this change).
--
-- ZERO schema drift: Prisma cannot model a partial index, so it does not emit the call side's
-- either and `prisma migrate diff` stays silent about both.
CREATE INDEX IF NOT EXISTS "leads_attribution_idx"
  ON "leads" USING GIN ("attribution" jsonb_path_ops)
  WHERE "attribution" IS NOT NULL;

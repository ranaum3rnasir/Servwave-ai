-- SERV10X-61 - per-container estimate numbering counters + reverse the one-WON-per-lead invariant.
-- Portable: runs on vanilla postgres:16 in CI migration-check (no Supabase-only objects).
-- Idempotent: may re-run on the shared staging DB (IF NOT EXISTS / IF EXISTS guards).

-- Per-container estimate sequence counters. Feed allocateContainerEstimateNumber →
-- L00005-1 (lead) / C00010-1 (customer) / J00007-1 (job). Legacy E00001 numbers are untouched.
ALTER TABLE "leads"     ADD COLUMN IF NOT EXISTS "estimate_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "estimate_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs"      ADD COLUMN IF NOT EXISTS "estimate_seq" INTEGER NOT NULL DEFAULT 0;

-- Reverse the entity-redesign D2 "one WON estimate per lead" DB invariant (spec §5.9): this
-- feature deliberately allows several simultaneously-WON estimates on one lead. The app-level
-- assertSingleApprovedPerLead guard is removed in the same PR (Task 6); the e2e-org schema
-- fingerprint is flipped from asserting this index PRESENT to asserting leads.estimate_seq present.
DROP INDEX IF EXISTS "estimates_org_lead_approved_key";

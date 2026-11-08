-- Remove a third party's identity from the DEMO org row on databases that already ran
-- 20260424181841_organization_and_tenant_fks.
--
-- THE OTHER HALF. 20260424181841 seeded org 00000000-0000-0000-0000-000000000001 with a real
-- customer's legal name, support address and domain. That file has now been de-branded in place
-- (its header explains why that is safe), but an edit to an applied migration only changes what a
-- FRESH database gets: `applyMigrations` skips any folder already recorded in `_prisma_migrations`,
-- so staging, production, the contractor sandbox and every developer database still carry the
-- original values. This file is what reaches those. The two ship together.
--
-- WHY IT MATTERS. That UUID is no longer the real tenant - it moved to
-- 11111111-2222-4333-8444-555555555555, and 20260619000000_org_is_demo_flag flags this row
-- `is_demo = true`. `email`, `website` and `brand_color` are served verbatim by
-- `estimate.controller.ts` getPublic and the invoice equivalent, so they render to anyone holding
-- a public token, unauthenticated, on the public estimate/invoice pages and in the public PDFs.
-- Spec: md_files/plans/branding/2026-09-18-demo-org-public-branding-remediation.md (§4 fixes the
-- replacement values; §3 is Ran's ruling on each one).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THE REAL TENANT IS EXCLUDED BY CONSTRUCTION, THREE TIMES OVER.
--   1. `is_demo = true`. 11111111-... is `is_demo = false` and always has been; 20260619000000
--      only ever set the flag on ...0001. This alone excludes the paying tenant.
--   2. Every statement matches the EXACT frozen value 20260424181841 wrote. A demo org that has
--      already been corrected by hand (staging was, 2026-09-18) matches nothing and is left
--      alone, so this cannot clobber a deliberate later choice.
--   3. Nothing here is keyed on the row's id, so a database whose ...0001 was renamed is still
--      matched on content - and a database where the real tenant somehow sits at ...0001 is still
--      protected by clause 1.
-- The name/email/website predicates are md5 comparisons rather than literals because CLAUDE.md
-- bans real customer names everywhere in the repo, comments included. Each hash is
-- md5(lower(<the exact string in 20260424181841's original INSERT>)); recompute from that file's
-- git history if you ever need to verify one.
--
-- NOT TOUCHED HERE:
--   - `logo_url`. `allowedLogoHost()` (backend/src/lib/pdf/index.ts) resolves to the environment's
--     own SUPABASE_URL host, so a logo URL is per-environment by construction and cannot be
--     written from a migration that runs on all of them. It stays a data task (PRD §5.1).
--   - `estimate_notes` / `estimate_terms` / `estimate_payment_terms`. 20260424181841 inserted
--     those as '' - the branded warranty text came from seed-organization.ts, not from here, and
--     PR #2198 stops the seeder re-writing it. Clearing existing text is PRD §5.2's job (already
--     run on staging; production measured clean).
--   - The postal address. It is ServWave's own (Ran, 2026-09-18).
--
-- PORTABLE: vanilla postgres:16 runs this unchanged. No Supabase-only roles, no auth.*, no
-- extensions, no SECURITY DEFINER. md5() is core postgres.
--
-- IDEMPOTENT: every statement matches only the frozen pre-fix value and writes a different one,
-- so a second application matches zero rows. Safe on the shared staging DB and safe if replayed.
--
-- DEPLOY OVERLAP: this is four single-row UPDATEs of existing scalar columns. No DDL, so no
-- ACCESS EXCLUSIVE lock and no column-list drift - the old instance still serving during the
-- overlap keeps selecting the same columns and simply starts returning ServWave's identity
-- instead of the third party's, which is the desired end state at every instant. There is no
-- window in which either build reads a column the other does not have.

-- 1. Legal name.
UPDATE "organizations"
SET "name" = 'Demo Organization'
WHERE "is_demo" = true
  AND md5(lower("name")) = '607460f9b2373db1f194b6e94da37081';

-- 2. Support address. `email` is NOT NULL, so it is replaced rather than nulled.
UPDATE "organizations"
SET "email" = 'info@servwave.com'
WHERE "is_demo" = true
  AND md5(lower("email")) = 'edc95c3f2a79fb2b74f2c830b5e1d477';

-- 3. Marketing domain. Renders as a clickable link in the public estimate footer, so it points at
--    ServWave's own site rather than being nulled (PRD §3 decision 5).
UPDATE "organizations"
SET "website" = 'https://www.servwave.com'
WHERE "is_demo" = true
  AND md5(lower("website")) = '4525bf2a1fb4ad4c2a12b3cdc95f076d';

-- 4. Brand colour. Not a name, so the frozen value is matched literally. '#0C2D3A' is --ocean-800,
--    what --primary resolves to in the frontend theme (PRD §4).
UPDATE "organizations"
SET "brand_color" = '#0C2D3A'
WHERE "is_demo" = true
  AND "brand_color" = '#E11D2E';

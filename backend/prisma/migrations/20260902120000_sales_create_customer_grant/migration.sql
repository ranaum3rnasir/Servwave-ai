-- #1472 slice 2 — SALES gains `create Customer` directly (019's designed row, Ran's call
-- 2026-09-02: "Pair the fix with the 019 SALES create Customer grant"). Slice 1 repoints the
-- estimate dialog's "Add new client" from /leads/new to /customers/new, which is gated
-- `canDo('create','Customer')` instead of `canDo('create','Lead')`. Without this backfill every
-- existing org's SALES rows still 403 at Save even though defaultGrants.ts (which only seeds NEW
-- orgs) already carries the row.
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts;
-- backend/src/__tests__/permissions-sales-customer-create-backfill.test.ts pins the two together.
--
-- WHY THIS ADDS NO NEW CAPABILITY. POST /api/leads already writes a `customers` row from its
-- `new_customer` block (lead.controller.ts:759-779) for anyone holding `create Lead` — so a role
-- that can create a lead could always create a customer, only ever by wrapping it in one. This
-- migration only removes that wrapper requirement.
--
-- WHY THE GATE IS A SHAPE, NOT A ROLE NAME. SRVW-138/139 custom roles write their own `key` into
-- role_permissions.role, so a role cloned from SALES is invisible to a hardcoded 'SALES' (same
-- reasoning as 20260901120000_sales_scoped_job_assign). The derived shape is `create Lead` AND
-- `read Customer`: `create Lead` is the honest proxy for "this role can already create a customer
-- through the lead form", and the `read Customer` EXISTS clause is a conservative narrowing that
-- refuses to hand a role write-without-read on a subject it cannot see. Keeping the custom-role
-- widening is a measured no-op on both databases today (see below) — hardcoding 'SALES' would also
-- fail permissions-sales-job-assign-backfill.test.ts's pinned literal-role-name ban, which this
-- migration's own backfill test mirrors.
--
-- `conditions` is written as SQL NULL (unconditional), matching the DEFAULT_GRANTS row exactly.
-- This is the OPPOSITE of the row-020 migration (which copied the read row's condition): a
-- condition on `create` is structurally inert (roleViewModel.ts:142-143 excludes `create` from
-- scope conditions — there is no existing row to condition a creation against), so copying one
-- across here would only produce permanent drift.
--
-- CONDITIONS SHAPE NOTE (§3 of the spec). An unconditional row may be stored as SQL NULL *or* as
-- JSONB null — the Roles-editor / "Reset role to defaults" path writes `Prisma.JsonNull` (JSONB
-- null; role.controller.ts:321,387,396,481), while a migration's literal NULL below is SQL NULL.
-- Both are equivalent for the ability layer (CASL only cares that the value is falsy) and any
-- verification query must treat `conditions IS NULL OR jsonb_typeof(conditions) = 'null'` as
-- "unconditional" — testing `IS NULL` alone would false-flag a perfectly healthy org that later had
-- its role reset from the Roles editor.
--
-- LIMITATION, do not copy-paste this shape past 019 (C8). The EXISTS clause below does NOT inspect
-- `r2.conditions` — it only checks that a `read Customer` row exists, not what it is scoped to.
-- That is safe today because `Customer` is absent from SCOPE_ENTITIES (roleViewModel.ts:25-30), so
-- no `read Customer` row anywhere carries a condition; this migration runs once, before 019, so it
-- is not a live risk. After 019 lands and `read Customer` can be row-scoped, this same shape would
-- hand a role with a SCOPED `read Customer` an UNCONDITIONAL `create Customer` — do not reuse it in
-- a post-019 migration without adding a condition check to the EXISTS.
--
-- NO DELETE HALF. Read-only pre-flight on both databases (2026-09-02) found no over-grant that
-- warrants one. TWO PRE-EXISTING over-grants were found and are deliberately left alone: staging's
-- `ServWave Test` org holds `TECHNICIAN create Customer` and `TECHNICIAN read Customer`, neither in
-- DEFAULT_GRANTS, neither created by this migration, neither SALES; and production's
-- `11111111-...` org holds `TECHNICIAN create Customer` (created 2026-09-02 02:09, updated
-- 02:43), likewise not in DEFAULT_GRANTS and not SALES. Revoking either is a permission decision
-- nobody has made — both are recorded here (and in the PR body) as findings for Ran, not acted on.
--
-- MEASURED DERIVED SET, by role name, per database, 2026-09-02:
--   staging:    8 rows, all SALES, across 8 of 9 orgs (the three real tenants, the three
--               `e2e-qa-*` orgs, `Onboarding Demo HVAC` and `Stripe Test Plumbing`).
--               `ServWave Test` is excluded — its SALES
--               role (and its custom role `qa-office-manager`) already holds `create Customer`, so
--               ON CONFLICT DO NOTHING is exercised for real on staging.
--   production: 4 rows, all SALES, `11111111-...` excluded (already holds the row).
-- No custom role is in either derived set. Expected effect: staging +8 rows / 8 of 9 orgs;
-- production +4 rows. All SALES. All unconditional. 0 deletes on either database.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING makes a second apply a no-op — the shared staging DB may see a
-- migration twice. PORTABLE: plain SQL only, no auth.*, no TO authenticated|anon|service_role, no
-- policies — runs unchanged on CI's vanilla postgres:16. gen_random_uuid()/NOW() are supplied
-- explicitly: `id @default(uuid())` is a Prisma-side default and `updated_at @updatedAt` has no DB
-- default at all, so raw SQL must fill both in. NO SECRETS in this file.
--
-- POST-DEPLOY VERIFICATION MUST BE THE AC5 QUERY, NOT THE LEDGER. `role_permissions` carries FORCE
-- ROW LEVEL SECURITY; measured directly, a NOSUPERUSER NOBYPASSRLS role running this file reports
-- `INSERT 0 0` silently where a BYPASSRLS role reports `INSERT 0 1` for the identical row. The
-- precedent migrations share this property and their rows are live in production, so the deploy
-- role evidently has BYPASSRLS today — but a green `_prisma_migrations` ledger entry is not itself
-- evidence the rows landed. Confirm with AC5's per-(org, role) query after every deploy.

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  src.organization_id,
  src.role,
  'create',
  'Customer',
  NULL,
  NOW(),
  NOW()
FROM role_permissions src
WHERE src.subject = 'Lead'
  AND src.action  = 'create'
  AND EXISTS (
    SELECT 1 FROM role_permissions r2
    WHERE r2.organization_id = src.organization_id
      AND r2.role           = src.role
      AND r2.subject        = 'Customer'
      AND r2.action         = 'read'
  )
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

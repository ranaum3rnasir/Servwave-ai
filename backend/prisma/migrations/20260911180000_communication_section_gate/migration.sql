-- #2046 — Communication SECTION gate backfill (Ran's decision, 2026-09-11, QA row 025).
--
-- SALES must not reach the org-wide Communication section (inbox, call log, phone settings) -
-- only the per-record Communication TAB on a lead/job/customer it may already read. The fix adds
-- a new action, `access_inbox` on the EXISTING `Communication` subject (same shape as the
-- `log_past` precedent), and this migration backfills it onto every EXISTING org for the roles
-- that already reach the section today.
--
-- 1. DERIVATION, STATED AS A SHAPE, NEVER A ROLE NAME. Custom roles write their own `key` into
--    role_permissions.role (no custom_role_id column — schema.prisma:2522-2536), so a hardcoded
--    'DISPATCHER'/'TECHNICIAN' would miss every role cloned from one. The derived set is every
--    (organization_id, role) that:
--      (a) holds `read Communication` (any conditions), AND
--      (b) whose OWN `read Job` row is NOT the exact OWN_JOB_VIA_ESTIMATE predicate — the SALES
--          shape, the same predicate #2042 (20260911120000_sales_purchasing_grants) used.
--    A role with NO `read Job` row at all satisfies (b) and is IN the set — it cannot be the
--    SALES shape, so this is intended, not an oversight.
--
-- 2. THE TWO-PART PREDICATE, VERBATIM. Part (b) is an EXACT `=` comparison against the jsonb
--    literal below, never a `LIKE '%lead_assignees%'` proxy (#2042 R6: a hand-widened `OR`
--    condition matches the LIKE and not the equality, and would silently change sides):
--
--      SELECT 1 FROM role_permissions j
--      WHERE j.organization_id = rp.organization_id AND j.role = rp.role
--        AND j.subject = 'Job' AND j.action = 'read'
--        AND j.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
--
-- 3. PRE-FLIGHT (read-only, both DBs, this migration's own exact-equality predicate,
--    organization_id only — never an org name; CLAUDE.md bans real customer names in the repo,
--    migration headers included): see evidence/preflight-communication-grants.md
--    (runs/issue-2046). Every pair holding `read Communication` was DISPATCHER, TECHNICIAN or a
--    known custom role derived from one of those two shapes; no SALES-shaped pair was in the set.
--
-- 4. EXPECTED COUNTS (R9, ratified — do not re-argue with the evidence file): prod 13 rows
--    (8 DISPATCHER + 5 TECHNICIAN — the 3 create-only TECHNICIAN pairs hold no `read Communication`
--    and so are correctly excluded); staging 22 rows (9 DISPATCHER + 4 TECHNICIAN(read) +
--    5 TECHNICIAN(create,read) + qa-office-manager + qa-bug-repro + qa-bug-repro-2 +
--    zz-reachability-probe). RE-MEASURE AT APPLY TIME with this file's own exact-equality
--    predicate — do not trust a recorded number. If a SALES-shaped pair lands in the set, or a
--    role appears that is neither DISPATCHER, TECHNICIAN nor a known custom role, ESCALATE —
--    never hardcode a role name to work around it.
--
-- 5. RLS HAZARD. `role_permissions` carries FORCE ROW LEVEL SECURITY
--    (20260703000100_tenant_rls/migration.sql:184). A NOBYPASSRLS role running this file reports
--    "INSERT 0 0" SILENTLY — a green `_prisma_migrations` ledger row is NOT evidence the rows
--    landed. Run the verification query below (or `recipes/migration-check.sh <DATABASE_URL>`,
--    runs/issue-2046/recipes/migration-check.sh) after every apply, never the ledger.
--
-- VERIFICATION QUERY (per org — never a global count):
--
--   SELECT rp.organization_id, rp.role,
--          bool_or(rp.action = 'read')         AS has_read,
--          bool_or(rp.action = 'access_inbox') AS has_section,
--          bool_or(rp.action = 'access_inbox' AND rp.conditions IS NOT NULL
--                  AND jsonb_typeof(rp.conditions) <> 'null') AS section_conditioned
--   FROM role_permissions rp
--   WHERE rp.subject = 'Communication'
--   GROUP BY 1, 2
--   ORDER BY 1, 2;
--
-- Expected per (organization_id, role): has_section true for exactly those pairs with has_read
-- true whose `read Job` is not the OWN_JOB_VIA_ESTIMATE predicate; false for every SALES-shaped
-- pair; section_conditioned false everywhere (access_inbox is never conditioned — `Communication`
-- is not a ScopeResource, so a condition on it is inert; defaultGrants.ts:422-423).
--
-- 6. IDEMPOTENT. A second apply is a no-op `ON CONFLICT ... DO UPDATE SET conditions = NULL` —
--    verified against the throwaway local DB (bfd_issue_2046), see
--    recipes/migration-check.sh and evidence/fixture-run-2-idempotent.log's sibling migration
--    check. INSERT-only, additive: nothing is being revoked (SALES never holds `access_inbox`, so
--    there is no DELETED-half or drifted population to replace). `DO UPDATE` rather than
--    `DO NOTHING`: the conflict target ignores `conditions`, so `DO NOTHING` would let a
--    hand-edited conditioned row survive while the migration still reports success (memory:
--    an-over-grant-hides-behind-on-conflict-do-nothing); `DO UPDATE SET conditions = NULL`
--    converges instead. Portable plain SQL on vanilla postgres:16 (CI's `Database (migrations +
--    RLS)` gate) — no Supabase roles, policies or auth.*. No secrets.
--
-- 7. R8 — THE #2042 INTERPLAY IS ORDER-INDEPENDENT. #2042
--    (20260911120000_sales_purchasing_grants, on origin/staging, not on main as of this
--    migration's authoring) writes only PurchaseOrder / Vendor / LogisticOrder rows and never a
--    Job or Communication row (see its own header), so this file's derived set is identical
--    whether or not #2042 has been applied, and #2042's SALES `read` grants are untouched here.
--    Both migrations are additive, neither shares a target row. This file's own timestamp
--    (20260911180000) sorts after #2042's (20260911120000) by construction.

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT gen_random_uuid(), rp.organization_id, rp.role, 'access_inbox', 'Communication', NULL, NOW(), NOW()
FROM role_permissions rp
WHERE rp.subject = 'Communication' AND rp.action = 'read'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions j
    WHERE j.organization_id = rp.organization_id AND j.role = rp.role
      AND j.subject = 'Job' AND j.action = 'read'
      AND j.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
  )
ON CONFLICT (organization_id, role, action, subject) DO UPDATE SET conditions = NULL, updated_at = NOW();

-- #2042 — SALES purchasing grants (Ran's decision, 2026-09-10, QA row 023).
--
-- SALES reads the whole inventory/purchasing module (stock, price book, vendors) and writes
-- nothing in it, except logistic orders on jobs that are theirs:
--   read Vendor                                   — UNCONDITIONAL (reference data, org-wide)
--   read PurchaseOrder                            — job-scoped, no write row
--   read/create/update/delete/submit LogisticOrder — job-scoped (create/edit/delete their own)
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts (which seeds NEW orgs);
-- backend/src/__tests__/permissions-sales-purchasing-backfill.test.ts pins the two together, so
-- editing one without the other is a red test rather than silent drift.
--
-- WHY THE GATE IS A SHAPE, NOT A ROLE NAME. SRVW-138/139 custom roles write their own `key` into
-- role_permissions.role (no custom_role_id column — schema.prisma), so a hardcoded 'SALES' would
-- miss every role cloned from SALES. The derived set (same derivation
-- 20260901120000_sales_scoped_job_assign used) is: every (organization_id, role) whose OWN
-- `read Job` row carries OWN_JOB_VIA_ESTIMATE, verbatim:
--
--   SELECT rp.organization_id, rp.role
--   FROM role_permissions rp
--   WHERE rp.subject = 'Job' AND rp.action = 'read'
--     AND rp.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
--
-- Two-part change, DELETE before INSERT, for every (organization_id, role) in that derived set:
--   1. DELETE every existing row on subject 'PurchaseOrder' and 'Vendor' (all actions — per Ran's
--      decision this population may write nothing in the module), and every row on subject
--      'LogisticOrder' with action IN ('read','create','update','delete','submit') — deliberately
--      NOT 'approve'/'process'/'cancel' (nobody decided those). The predicate does not look at
--      `conditions` at all, so it catches SQL NULL, the JSON text 'null' (one prod org stores it
--      that way — evidence/prod-sales-grants-snapshot.md) and any object alike; ON CONFLICT alone
--      cannot fix a wider hand-edited row surviving a backfill (memory: an over-grant hides behind
--      ON CONFLICT DO NOTHING), so the DELETE runs first and the INSERT's own
--      ON CONFLICT ... DO UPDATE is belt-and-braces, not the only guard.
--   2. INSERT the seven correct rows per pair: read PurchaseOrder + condition, read Vendor NULL,
--      read/create/update/delete/submit LogisticOrder + condition — with gen_random_uuid(), NOW(),
--      NOW() supplied explicitly (`id @default(uuid())` is a Prisma-side default and
--      `updated_at @updatedAt` has no DB default). Condition text is byte-equal to
--      defaultGrants.ts's OWN_VIA_JOB, or check-role-permission-drift --strict reddens for every
--      org. No `ON CONFLICT DO NOTHING` — since the DELETE runs first there is nothing to
--      conflict with in the normal case, but `DO UPDATE SET conditions = EXCLUDED.conditions`
--      guards a re-run that lands between an admin's own hand-edit and a repeat apply.
--
-- IDEMPOTENT: delete-then-insert converges on the same final state on a second apply — verified
-- against the throwaway local DB (bfd_issue_2042), see recipes/migration-check.sh.
-- PORTABLE: plain SQL, vanilla postgres:16 (CI's `Database (migrations + RLS)` gate) — no
-- Supabase roles, policies or auth.*. No secrets.
--
-- RLS HAZARD: role_permissions carries FORCE ROW LEVEL SECURITY
-- (20260703000100_tenant_rls/migration.sql). A NOBYPASSRLS role running this file reports
-- "INSERT 0 0" SILENTLY — a green `_prisma_migrations` ledger row is NOT evidence the rows
-- landed. Run the verification query below after every apply, not the ledger.
--
-- VERIFICATION QUERY (per org — never a global count; organization_id only, never an org name —
-- CLAUDE.md bans real customer names anywhere in the repo, migration headers included):
--
--   SELECT rp.organization_id, rp.role, rp.action, rp.subject,
--          (rp.conditions IS NULL OR jsonb_typeof(rp.conditions) = 'null') AS unconditional
--   FROM role_permissions rp
--   WHERE rp.subject IN ('PurchaseOrder','Vendor','LogisticOrder')
--     AND EXISTS (SELECT 1 FROM role_permissions r2
--                 WHERE r2.organization_id = rp.organization_id AND r2.role = rp.role
--                   AND r2.subject = 'Job' AND r2.action = 'read'
--                   AND r2.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb)
--   ORDER BY 1, 2, 4, 3;
--
-- Expected per (org, derived role): exactly 7 rows — read PurchaseOrder (unconditional = false),
-- read Vendor (unconditional = true, the only one), read/create/update/delete/submit LogisticOrder
-- (all false).
--
-- PRE-FLIGHT, read-only, both DBs, run with this migration's OWN exact-equality predicate
-- (2026-09-11, organization_id only — R5, never an org name):
--
--   prod (8 pairs, all role SALES): 00000000-0000-0000-0000-000000000001,
--     00000000-0000-0000-0000-0000bcab0001, <org>,
--     <org>, 11111111-2222-4333-8444-555555555555,
--     <org>, <org>,
--     <org>.
--     Every org that holds PurchaseOrder/Vendor/LogisticOrder rows today is in the set; no role
--     other than SALES appears. EXPECTED EFFECT: 56 rows (8 x 7).
--   staging (9 pairs, all role SALES): 00000000-0000-0000-0000-000000000001,
--     00000000-0000-0000-0000-0000bcab0001, <org>, <org>, <org>,
--     <org>, 11111111-2222-4333-8444-555555555555, <org>, <org>.
--     EXPECTED EFFECT: 63 rows (9 x 7).
--
-- Neither pre-flight was blocked (8/9 orgs present, SALES only) — see
-- runs/issue-2042/evidence/prod-sales-grants-snapshot.md for the full read-only record (org names
-- appear there only, never here or in the PR body).

-- Part 1 — remove the population this migration REPLACES (irrespective of `conditions`, so SQL
-- NULL, the JSON text 'null', and any object are all caught alike).
DELETE FROM role_permissions target
USING role_permissions src
WHERE src.organization_id = target.organization_id
  AND src.role            = target.role
  AND src.subject         = 'Job'
  AND src.action           = 'read'
  AND src.conditions      = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
  AND (
    target.subject IN ('PurchaseOrder', 'Vendor')
    OR (target.subject = 'LogisticOrder' AND target.action IN ('read', 'create', 'update', 'delete', 'submit'))
  );

-- Part 2 — insert the seven correct rows per (organization_id, role) in the same derived set.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  v.action,
  v.subject,
  v.conditions::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
CROSS JOIN (VALUES
  ('read',   'PurchaseOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}'),
  ('read',   'Vendor',        NULL),
  ('read',   'LogisticOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}'),
  ('create', 'LogisticOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}'),
  ('update', 'LogisticOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}'),
  ('delete', 'LogisticOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}'),
  ('submit', 'LogisticOrder', '{"job": {"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}}')
) AS v(action, subject, conditions)
WHERE rp.subject = 'Job'
  AND rp.action  = 'read'
  AND rp.conditions = '{"estimate": {"lead": {"lead_assignees": {"some": {"user_id": "{{userId}}"}}}}}'::jsonb
ON CONFLICT (organization_id, role, action, subject) DO UPDATE SET
  conditions = EXCLUDED.conditions,
  updated_at = NOW();

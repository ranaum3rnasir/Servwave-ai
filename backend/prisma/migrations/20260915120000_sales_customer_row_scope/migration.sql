-- #2041 — SALES row-scoped Customer read/update (Ran's decision, 2026-09-10, QA 019).
--
-- A SALES user sees, reads and writes only the customers they are ASSOCIATED with: reached via a
-- lead they are assigned to, a job whose visit they are on, or one they created directly
-- (OWN_CUSTOMER — see backend/src/lib/permissions/defaultGrants.ts). `create Customer` is left
-- alone (unconditional — no existing row exists to condition a create against). The create-form
-- pickers stay org-wide by design (#2041 slice 1's GET /api/customers/picker), which does not
-- touch this grant at all.
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts (which seeds NEW orgs);
-- backend/src/__tests__/permissions-sales-customer-scope-backfill.test.ts pins the two together,
-- so editing one without the other is a red test rather than silent drift.
--
-- WHY THE GATE IS A SHAPE, NOT A ROLE NAME. SRVW-138/139 custom roles write their own `key` into
-- role_permissions.role (no custom_role_id column on that table — schema.prisma), so a hardcoded
-- 'SALES' would miss every role cloned from SALES. Modelled line for line on
-- 20260911120000_sales_purchasing_grants. The derived set is every (organization_id, role) whose
-- OWN `read Lead` row carries OWN_LEAD verbatim:
--
--   SELECT rp.organization_id, rp.role
--   FROM role_permissions rp
--   WHERE rp.subject = 'Lead' AND rp.action = 'read'
--     AND rp.conditions = '{"lead_assignees": {"some": {"user_id": "{{userId}}"}}}'::jsonb
--
-- WHY read-Lead/OWN_LEAD, not read-Job/OWN_JOB_VIA_ESTIMATE (the prior-art gate
-- 20260911120000_sales_purchasing_grants used). Verified (R7) against the shipped defaults:
-- DISPATCHER's `read Lead` is UNCONDITIONAL (defaultGrants.ts:~223, no `conditions` key at all),
-- and TECHNICIAN's `read Lead` carries OWN_WALKTHROUGH (`{"visits":{"some":{"assignees":{"some":
-- {"user_id":"{{userId}}"}}}}}`) — a DIFFERENT shape from OWN_LEAD's `lead_assignees` literal, so
-- neither collides with the exact-equality predicate. `read Lead`/OWN_LEAD selects SALES and
-- SALES-cloned roles only, the same population `read Job`/OWN_JOB_VIA_ESTIMATE would — either
-- gate is correct; this one is chosen because it is the shortest, least-nested literal to match
-- byte-for-byte, and because the Customer grant this migration writes is itself built by
-- composing OWN_LEAD (not OWN_JOB_VIA_ESTIMATE) as its first OR-arm — see defaultGrants.ts's
-- OWN_CUSTOMER comment.
--
-- EXPLICIT REPLACE, never ON CONFLICT DO NOTHING: an UPDATE ... SET conditions = '<literal>'::jsonb
-- for subject='Customer' AND action IN ('read','update') over the derived set, IRRESPECTIVE of the
-- current value — SQL NULL, the JSON text 'null' (one prod org stores it that way — same class of
-- drift #2042's evidence recorded for other subjects), or any other object alike. `create Customer`
-- is untouched (no WHERE clause here ever matches it — action IN ('read','update') excludes it by
-- construction). No DELETE-then-INSERT (unlike 20260911120000's population, subject='Customer'
-- rows for read/update already exist in every org from org-creation time; there is nothing to
-- delete-then-recreate, only to correct).
--
-- POST-CONDITION, in the same file, that FAILS the apply (R7's stronger predicate — the spec
-- body's original `IS NULL OR jsonb_typeof = 'null'` version is too weak: a row hand-widened to a
-- DIFFERENT object, not NULL, would pass it silently):
--
--   rp.conditions IS DISTINCT FROM '<OWN_CUSTOMER literal>'::jsonb
--
-- over the derived set. jsonb equality is key-order independent, so this doubles as the drift
-- check (a row whose JSON differs in key order from the literal below still compares equal).
--
-- THIS POST-CONDITION IS NOT THE RLS GUARD. `role_permissions` carries FORCE ROW LEVEL SECURITY
-- (20260703000100_tenant_rls/migration.sql). Under a NOBYPASSRLS role, EVERY SELECT in this file
-- — the UPDATE's own row count AND this DO block's SELECT — sees ZERO ROWS, so the post-condition
-- passes VACUOUSLY (bad=0 because the SELECT itself returned nothing) while the UPDATE silently
-- wrote nothing either. That is exactly the failure #2042 documented and is why this header does
-- not claim the post-condition is sufficient evidence on its own. AC10's per-`organization_id`
-- OUT-OF-BAND verification query (run with a role that CAN see the table, e.g. via `psql` as the
-- migration user outside this transaction) is the real evidence — never a global count.
--
-- IDEMPOTENT: the UPDATE's WHERE has no `conditions <> …` guard, so a second apply reissues the
-- identical value — a no-op in effect, convergent. PORTABLE: plain SQL, vanilla postgres:16 (CI's
-- `Database (migrations + RLS)` gate) — no Supabase roles, policies or auth.*. No secrets.
--
-- VERIFICATION QUERY (per org — never a global count; organization_id only, never an org name —
-- CLAUDE.md bans real customer names anywhere in the repo, migration headers included):
--
--   SELECT rp.organization_id, rp.role, rp.action,
--          (rp.conditions IS DISTINCT FROM
--             '{"OR":[{"leads":{"some":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}},{"jobs":{"some":{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}}},{"created_by_id":"{{userId}}"}]}'::jsonb
--          ) AS unconditional_or_wrong
--   FROM role_permissions rp
--   WHERE rp.subject = 'Customer' AND rp.action IN ('read', 'update')
--     AND EXISTS (SELECT 1 FROM role_permissions r2
--                 WHERE r2.organization_id = rp.organization_id AND r2.role = rp.role
--                   AND r2.subject = 'Lead' AND r2.action = 'read'
--                   AND r2.conditions = '{"lead_assignees": {"some": {"user_id": "{{userId}}"}}}'::jsonb)
--   ORDER BY 1, 2, 3;
--
-- Expected: zero rows with unconditional_or_wrong = true, for every organization_id.
--
-- PRE-FLIGHT: this migration was authored and reviewed against the local throwaway DB only
-- (recipes/migration-check.sh, bfd_issue_2041) — it has NOT been run against staging or prod by
-- this session. A read-only pre-flight (the derived-set query above, minus the join to Customer)
-- MUST be run against both DBs before this migration is applied there, and its own per-org
-- verification query (above) is the required post-apply evidence — neither is optional. Staging
-- applies it via deploy; the `main` PR stays open for Ran (main-ancestor gate is deliberately not
-- enforced — see the topic file `back-merge-is-optional-ran-declined.md`).

UPDATE role_permissions AS target
SET conditions = '{"OR":[{"leads":{"some":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}},{"jobs":{"some":{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}}},{"created_by_id":"{{userId}}"}]}'::jsonb,
    updated_at = NOW()
WHERE target.subject = 'Customer'
  AND target.action IN ('read', 'update')
  AND EXISTS (
    SELECT 1 FROM role_permissions src
    WHERE src.organization_id = target.organization_id
      AND src.role            = target.role
      AND src.subject         = 'Lead'
      AND src.action           = 'read'
      AND src.conditions      = '{"lead_assignees": {"some": {"user_id": "{{userId}}"}}}'::jsonb
  );

-- Post-condition — NOT the RLS guard (see header). Fails the migration if any row-scoped-SALES
-- read/update Customer row was left unconditional or wrong after the UPDATE above.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM role_permissions rp
  WHERE rp.subject = 'Customer' AND rp.action IN ('read', 'update')
    AND rp.conditions IS DISTINCT FROM
      '{"OR":[{"leads":{"some":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}},{"jobs":{"some":{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}}},{"created_by_id":"{{userId}}"}]}'::jsonb
    AND EXISTS (SELECT 1 FROM role_permissions r2
                WHERE r2.organization_id = rp.organization_id AND r2.role = rp.role
                  AND r2.subject = 'Lead' AND r2.action = 'read'
                  AND r2.conditions = '{"lead_assignees": {"some": {"user_id": "{{userId}}"}}}'::jsonb);
  IF bad > 0 THEN
    RAISE EXCEPTION 'sales_customer_row_scope: % row-scoped read/update Customer row(s) left unconditional or wrong', bad;
  END IF;
END $$;

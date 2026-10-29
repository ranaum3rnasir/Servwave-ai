-- Follow-up to 20260721210000_repair_drifted_sales_role_conditions (#918): finish the half of
-- that migration which silently matched nothing.
--
-- WHAT WENT WRONG: the two fail-open rows (SALES read Invoice, SALES update Lead) were targeted
--   with `conditions IS NULL`. They do not hold SQL NULL — they hold the JSONB `null` LITERAL,
--   which Prisma writes for `Prisma.JsonNull`. For a jsonb column those are different values:
--
--     SELECT conditions IS NULL, jsonb_typeof(conditions) FROM role_permissions ...
--     -> is_sql_null = false, jsonb_typeof = 'null'
--
--   `IS NULL` is false for a JSONB 'null', so both UPDATEs matched zero rows. The migration still
--   reported success (applied_steps_count = 1, finished_at set), so the failure was silent: the
--   two CRASH rows were repaired and the two FAIL-OPEN rows were left exactly as they were.
--
-- WHY THAT MATTERS: `scopeWhereFor` widens ANY read grant it considers unconditional to org-wide.
--   It reads the column through Prisma, where a JSONB 'null' also arrives as JS `null`, so the
--   fail-open is fully live: SALES can still list every invoice in the organization and update
--   any lead. Verified against staging after the first migration applied.
--
-- THE FIX: match both representations. `conditions IS NULL OR jsonb_typeof(conditions) = 'null'`
--   covers SQL NULL and the JSONB literal alike, so this is correct regardless of which one a
--   given row happens to carry.
--
-- IDEMPOTENT: once applied, `conditions` is a jsonb object on these rows, so `jsonb_typeof` is
--   'object' and the predicate no longer matches. Re-running is a no-op.
-- PORTABLE: plain UPDATEs plus the standard `jsonb_typeof` function. No Supabase-only objects,
--   so this behaves identically on CI's vanilla postgres:16 and on Supabase.

-- SALES read Invoice — unconditional (org-wide) -> OWN_INVOICE_VIA_LEAD
UPDATE role_permissions
SET conditions = '{"job":{"estimate":{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Invoice'
  AND (conditions IS NULL OR jsonb_typeof(conditions) = 'null');

-- SALES update Lead — unconditional (any lead) -> OWN_LEAD
UPDATE role_permissions
SET conditions = '{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'update'
  AND subject = 'Lead'
  AND (conditions IS NULL OR jsonb_typeof(conditions) = 'null');

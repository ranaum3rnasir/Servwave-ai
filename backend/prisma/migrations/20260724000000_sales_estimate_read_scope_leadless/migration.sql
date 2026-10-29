-- SERV10X-61 Task 8 - propagate the broadened SALES `read Estimate` scope to existing orgs.
--
-- WHY THIS IS NEEDED: DEFAULT_GRANTS is only consulted when an organization is SEEDED. Changing
-- a condition there does NOT rewrite the `role_permissions` rows of orgs that already exist, and
-- the additive `--emit-sql` sync in check-role-permission-drift.ts cannot help either: it is an
-- INSERT ... ON CONFLICT DO NOTHING, which fills MISSING grants and never updates an existing
-- row. `SALES read Estimate` already exists on every org, so only an UPDATE can move it. This is
-- the "changed conditions" class the drift script's --strict mode exists to catch (#918).
--
-- WHAT CHANGED: a customer-anchored estimate has `lead_id = NULL`, so the old own-via-lead-only
-- condition matched zero rows for it and a SALES rep could not see an estimate they had created
-- themselves. The new condition is an OR: own-via-lead (byte-for-byte the old arm, so no
-- lead-anchored row changes visibility) OR lead-less-and-created-by-me. The `lead_id IS NULL`
-- guard keeps the creator arm from widening scope on lead-anchored rows. This mirrors
-- canAccessEstimate's detail gate so LIST and detail agree.
--
-- IDEMPOTENT: matches on the exact historical condition value, so a row already migrated - or one
-- an org deliberately customized away from the default - no longer matches and is left untouched.
-- Re-running is a no-op. Qualified on role/action/subject so nothing else is touched.
-- PORTABLE: plain UPDATE, no Supabase-only constructs.

UPDATE role_permissions
SET conditions = '{"OR":[{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}},{"AND":[{"lead_id":null},{"created_by":"{{userId}}"}]}]}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Estimate'
  AND conditions = '{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}'::jsonb;

-- Repair drifted SALES `role_permissions.conditions` rows (#918).
--
-- WHY: `conditions` is a JSON template that `scopeWhereFor` substitutes and spreads straight
--   into a Prisma `where`. Four SALES rows drifted away from DEFAULT_GRANTS and broke in two
--   different directions:
--
--   (a) CRASH — two rows still reference `assigned_user`, a relation dropped when leads moved
--       to the `lead_assignees` M2M (and jobs to `assignees`). Prisma raises
--       `PrismaClientValidationError: Unknown argument 'assigned_user'`, which the controllers'
--       catch-all turns into a 500. Verified live on staging as a SALES user:
--         GET /api/estimates            -> 500
--         GET /api/jobs                 -> 500
--         DELETE /api/estimates/:id     -> 500   (via canAccessRow)
--       Both list pages rendered "No results found.", so the failure was invisible in the UI.
--
--   (b) FAIL-OPEN — two rows hold NULL where DEFAULT_GRANTS mandates an own-scoped condition.
--       `scopeWhereFor` widens ANY unconditional read grant to org-wide (it returns `{}`), so
--       SALES could list EVERY invoice in the organization and update ANY lead, not just their
--       own. That is a data-exposure bug, not merely config drift.
--
-- WHY THE EXISTING SYNC DOES NOT FIX THIS: 20260707130000_sync_role_permission_defaults (and
--   the --emit-sql output of check-role-permission-drift.ts) are additive — INSERT ... ON
--   CONFLICT DO NOTHING. They only fill in MISSING grants and never update an existing row's
--   conditions. These rows exist; their payload is wrong. Only an explicit UPDATE repairs them.
--
-- TARGETING: matched by the drifted SHAPE, not by organization id, so any org carrying the same
--   drift is repaired. On the current staging DB only the demo org "Servwave Test" matches;
--   Northwind Services, Riverbend Septic and Lakeside Cabinets already hold the correct conditions.
--
-- JUDGMENT CALL on (b): narrowing a permission is the safe direction, but it is still a
--   behavioural change for anyone who intended SALES to see org-wide invoices. The NULL rows are
--   only touched where DEFAULT_GRANTS explicitly mandates an own-scoped condition — i.e. where
--   the DB says "unconditional" and the product says "own-only". An org that deliberately wants
--   SALES to read every invoice should express that via a per-user override or an explicit
--   custom grant, not via a NULL that silently contradicts the default.
--
-- IDEMPOTENT: each UPDATE's WHERE no longer matches once applied (the JSON no longer contains
--   `assigned_user`; the NULLs are no longer NULL), so a re-run is a no-op.
-- PORTABLE: plain UPDATEs against role_permissions. No Supabase-only roles, policies or auth.*
--   references, so this runs identically on the vanilla postgres:16 image used by CI's
--   migration-check and on Supabase.

-- (a1) SALES read Estimate — stale `lead.assigned_user` -> OWN_ESTIMATE_VIA_LEAD
UPDATE role_permissions
SET conditions = '{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Estimate'
  AND conditions::text LIKE '%assigned_user%';

-- (a2) SALES read Job — stale top-level `assigned_user` -> OWN_JOB_VIA_ESTIMATE
UPDATE role_permissions
SET conditions = '{"estimate":{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Job'
  AND conditions::text LIKE '%assigned_user%';

-- (b1) SALES read Invoice — NULL (org-wide) -> OWN_INVOICE_VIA_LEAD
UPDATE role_permissions
SET conditions = '{"job":{"estimate":{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Invoice'
  AND conditions IS NULL;

-- (b2) SALES update Lead — NULL (any lead) -> OWN_LEAD
UPDATE role_permissions
SET conditions = '{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'update'
  AND subject = 'Lead'
  AND conditions IS NULL;

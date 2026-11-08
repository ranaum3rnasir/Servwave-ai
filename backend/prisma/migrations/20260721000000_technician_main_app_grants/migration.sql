-- Spec A (retire the technician view) — admit TECHNICIAN to the main app.
--
-- Grants are read at RUNTIME from role_permissions (middleware/attachAbility.ts), not from
-- DEFAULT_GRANTS, so every new role grant needs a backfill or existing orgs never receive it.
--
-- Five rows per org:
--   TECHNICIAN update Job   — one gate on notes, line items and job field edits (D3).
--                             Rescheduling is additionally guarded field-level (D14).
--   TECHNICIAN start Job    — pre-grant for Spec B1's Start button. No caller exists yet.
--   TECHNICIAN arrive Job   — pre-grant for Spec B1's On Site node. No caller exists yet.
--   TECHNICIAN read User    — unconditional (ruled 2026-07-21): a technician seeing their
--                             coworkers is a company directory, not a leak, and `User` is not
--                             a ScopeResource so a conditional grant would be inert anyway.
--                             Resolves crew-name labels on the technician's own calendar.
--                             tenantWhere keeps it org-local.
--   DISPATCHER reschedule Job — D14's field-level guard checks `can('reschedule','Job')`, a
--                             brand-new action nobody held by default. DISPATCHER already has
--                             unconditional `update Job`; without this row every dispatcher
--                             would 403 rescheduling their own jobs. ADMIN passes via
--                             manage-all, no row needed.
--
-- NOTE: `read PriceBook` for TECHNICIAN is NOT included here — it already shipped via
-- 20260717120000_technician_pricebook_read_backfill (Inventory P3, #855).
--
-- PLUS pre-existing drift: `complete Job` has been in defaultGrants.ts since the Phase B RBAC
-- overhaul but appears in NO migration (it was inserted by 20260528204625_add_role_permissions
-- and then DELETEd by 20260618000000_technician_strict_default, which gated it on `update Lead`
-- + `create Job` — TECHNICIAN never held either). check-role-permission-drift reports it missing
-- for every existing org today. Backfilled here so DB and code agree.
--
-- Idempotent (ON CONFLICT DO NOTHING) — safe on the shared staging DB, which may run it twice.
-- Portable — no Supabase-only roles or auth.* references; runs on vanilla postgres:16 in CI.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  g.role,
  g.action,
  g.subject,
  g.conditions::jsonb,
  NOW(),
  NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('TECHNICIAN','update','Job','{"assignees":{"some":{"user_id":"{{userId}}"}}}'),
  ('TECHNICIAN','start','Job','{"assignees":{"some":{"user_id":"{{userId}}"}}}'),
  ('TECHNICIAN','arrive','Job','{"assignees":{"some":{"user_id":"{{userId}}"}}}'),
  ('TECHNICIAN','complete','Job','{"assignees":{"some":{"user_id":"{{userId}}"}}}'),
  ('TECHNICIAN','read','User',NULL),
  ('DISPATCHER','reschedule','Job',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

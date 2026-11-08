-- Backfill the TECHNICIAN `read PriceBook` role default for every existing organization.
--
-- Inventory P3 (plan Phase 3 — truck stock & field): technicians need the shared catalog as a
-- picker feed on the tech mobile add-part flow, and GET /api/inventory/my-van gates on
-- `read PriceBook`. The row was added to DEFAULT_GRANTS (backend/src/lib/permissions/
-- defaultGrants.ts) so NEW orgs seed it automatically; without this migration existing orgs'
-- technicians would keep 403ing on the picker + my-van.
--
-- Cost exposure: none — every catalog read strips unit_cost/list_price for requesters without
-- `read Invoice` (canSeePricing), which a bare technician lacks. `read Inventory` (stock pages,
-- movements) is NOT granted here and stays admin/dispatcher/sales.
--
-- Mirrors the 20260618000000 task_grants_backfill skeleton (the canonical form for a brand-new
-- role default — no pre-split source rows to derive from, unlike 20260717040000). The canonical
-- grant set lives in defaultGrants.ts; this SQL must match it (pinned by
-- backend/src/__tests__/permissions-technician-pricebook-backfill.test.ts).
--
-- Portable (no Supabase-only objects) + idempotent via ON CONFLICT DO NOTHING — safe to re-run,
-- and safe on the shared staging DB.
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
  ('TECHNICIAN','read','PriceBook',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

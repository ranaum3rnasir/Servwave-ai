-- SRVW-140 - backfill the new `read Pricing` role grant for every existing organization.
--
-- The Roles UI "See financial data" switch used to write `read Report`, which gates only the
-- /api/reports routes and the Reports/Billing nav. The predicate that actually strips every cost,
-- price and margin - canSeePricing (backend/src/lib/permissions/enforce.ts) - keyed on
-- `read Invoice`, a completely different control. canSeePricing now keys on a dedicated
-- `read Pricing` grant of which the switch is the single writer.
--
-- BEHAVIOUR-PRESERVING BY CONSTRUCTION. The set is DERIVED from role_permissions itself rather
-- than hardcoded: every (organization_id, role) that holds `read Invoice` can see costs today, so
-- granting exactly that set `read Pricing` means nobody loses cost visibility on deploy. Measured
-- on staging 2026-08-03: 32 rows (SALES 16, DISPATCHER 16). TECHNICIAN holds no `read Invoice`
-- anywhere, so it receives nothing - a bare technician stays cost-blind, as before.
--
-- The source rows are unique per (organization_id, role) by the same unique index this statement
-- conflicts on, so the derived set cannot collide with itself.
--
-- schema.prisma:1953-1967 (model RolePermission): @@map("role_permissions"),
-- @@unique([organization_id, role, action, subject]) - the index ON CONFLICT binds to - plus
-- `id @default(uuid())` (a PRISMA-side default, so gen_random_uuid() is required here, not
-- decorative) and `updated_at @updatedAt` with no DB default (so NOW() is required too).
-- No schema.prisma change: `subject` is a plain String column.
--
-- Portable (no Supabase-only objects) + idempotent via ON CONFLICT DO NOTHING - safe to re-run,
-- and safe on the shared staging DB. Pinned by
-- backend/src/__tests__/permissions-pricing-grant-backfill.test.ts.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  'read', 'Pricing',
  -- Cost visibility is never row-scoped. Cast made explicit, mirroring 20260717120000's
  -- `g.conditions::jsonb`, so the target column type is never inferred.
  NULL::jsonb,
  NOW(),
  NOW()
FROM role_permissions rp
WHERE rp.action = 'read'
  AND rp.subject = 'Invoice'
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

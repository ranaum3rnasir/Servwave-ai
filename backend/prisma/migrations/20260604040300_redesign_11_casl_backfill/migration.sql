-- Entity-redesign Phase 5 — CASL grant catch-up backfill (UNAPPLIED).
--
-- STATUS: hand-authored, COMMITTED UNAPPLIED. Apply during the Phase-D human window
-- (plan calls the Phase-D twin _redesign_D6_casl_backfill — this Phase-5 file IS that
-- migration, authored now / applied later). Do NOT run prisma migrate/generate from a
-- worktree (.env points at STAGING).
--
-- SOURCE OF TRUTH: backend/src/lib/permissions/defaultGrants.ts. This SQL is the single
-- "catch-up" that makes EVERY existing organization's role_permissions rows match the
-- current defaultGrants.ts. Pinned by backend/src/__tests__/permissions-casl-backfill.test.ts
-- (mirrors how 20260602000000 is pinned by permissions-emanuel-modules.test.ts).
--
-- IDEMPOTENT: the DELETE is naturally idempotent; the INSERT uses ON CONFLICT DO NOTHING.
-- Safe to re-run. ADMIN has no rows (code-level "manage all"), so no ADMIN rows here.
--
-- ─── Part 1: DELETE the Phase-5 FOLDED Estimate deposit actions for every org ───
-- The legacy refund_deposit + reactivate_deposit Estimate actions are folded into the
-- unified Invoice refund (POST /api/invoices/:id/refund on the kind=DEPOSIT invoice).
-- reactivate_deposit was DISPATCHER-seeded by 20260528204625; refund_deposit was never
-- seeded (admin-only by absence). No org filter needed — these (action,subject) pairs exist
-- for no other entity.
DELETE FROM role_permissions
WHERE (action, subject) IN (
  ('refund_deposit', 'Estimate'),
  ('reactivate_deposit', 'Estimate')
);

-- ─── Part 2: INSERT the non-admin defaultGrants rows added AFTER the prior seeds ───
-- Cumulative prior seeds: 20260528204625 (original) + 20260602000000 (Inventory/Communication).
-- Diffing defaultGrants.ts against those seeds, existing orgs lack these non-admin grants:
--   SALES      -> revise Estimate, delete Lead (own-scoped)
--   DISPATCHER -> archive Customer, delete Lead, read Location (org-settings merge)
-- (force_purge / anonymize / refund / credit / void_payment / reopen / void are ADMIN-only
--  => zero rows; ADMIN has no rows by convention. Location create/update/delete + Role
--  read/update are ADMIN-only too => not seeded here.)
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
  -- SALES
  ('SALES','revise','Estimate',NULL),
  ('SALES','delete','Lead','{"assigned_to":"{{userId}}"}'),
  -- DISPATCHER
  ('DISPATCHER','archive','Customer',NULL),
  ('DISPATCHER','delete','Lead',NULL),
  -- Settings (org-settings merge): DISPATCHER reads the org's company locations
  ('DISPATCHER','read','Location',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

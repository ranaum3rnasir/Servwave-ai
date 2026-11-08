-- Subject split (inventory integration P0, plan D11): PurchaseOrder + Vendor split out of the
-- coarse Inventory CASL subject. The same PR flips the route gates:
--   /purchase-orders, /rfqs, /estimate-reservations, /jobs/:jobId/material-cost -> PurchaseOrder
--   /vendors                                                                    -> Vendor
--
-- This backfill DERIVES each org's PurchaseOrder/Vendor rows from its EXISTING Inventory rows
-- (same role, same action, same conditions) so custom-tuned orgs lose no effective access when
-- the routes flip subjects. Outcomes on a default-posture org:
--   DISPATCHER -> read/create/update/delete on both new subjects (mirrors full Inventory CRUD)
--   SALES      -> read on both (mirrors read Inventory: preserves what Sales can reach TODAY
--                 through the coarse subject; NEW orgs get the tighter defaults where SALES
--                 has neither -- defaultGrants.ts is the per-new-org source of truth)
--   TECHNICIAN -> nothing (no Inventory rows exist by default)
-- ADMIN has no rows (code-level `manage all`).
--
-- Deliberately NOT a DEFAULT_GRANTS-style cross-join over orgs: that would re-grant PO/Vendor
-- to orgs whose admins deliberately removed dispatcher Inventory access. Derivation respects
-- both custom widening and custom tightening.
--
-- Idempotent via NOT EXISTS (re-runnable on the shared staging DB; the unique index
-- (organization_id, role, action, subject) also backstops it). Portable: plain INSERT..SELECT,
-- no Supabase-only objects, so no pg_roles guard is needed. gen_random_uuid() is built into
-- Postgres 13+ (already relied on by 20260528204625 in CI's vanilla postgres:16).
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rp.organization_id,
  rp.role,
  rp.action,
  s.subject,
  rp.conditions,
  NOW(),
  NOW()
FROM role_permissions rp
CROSS JOIN (VALUES ('PurchaseOrder'), ('Vendor')) AS s(subject)
WHERE rp.subject = 'Inventory'
  AND NOT EXISTS (
    SELECT 1
    FROM role_permissions t
    WHERE t.organization_id = rp.organization_id
      AND t.role = rp.role
      AND t.action = rp.action
      AND t.subject = s.subject
  );

-- Same derivation for per-user overrides (allow/deny layered on the role grant), keyed by
-- (user_id, action, subject). DEFENSIVE: the write endpoint only accepts USER_CAPABILITIES
-- pairs (user.controller.ts isManagedCapability), which contain no Inventory entries, so no
-- rows should match today -- but a manually-seeded Inventory deny must keep denying after the
-- flip, and this makes that invariant hold regardless of how a row got there.
INSERT INTO user_permission_overrides (id, organization_id, user_id, action, subject, effect, created_at, updated_at)
SELECT
  gen_random_uuid(),
  po.organization_id,
  po.user_id,
  po.action,
  s.subject,
  po.effect,
  NOW(),
  NOW()
FROM user_permission_overrides po
CROSS JOIN (VALUES ('PurchaseOrder'), ('Vendor')) AS s(subject)
WHERE po.subject = 'Inventory'
  AND NOT EXISTS (
    SELECT 1
    FROM user_permission_overrides t
    WHERE t.user_id = po.user_id
      AND t.action = po.action
      AND t.subject = s.subject
  );

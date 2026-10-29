-- Drop the SALES PriceBook WRITE default grants from EXISTING organizations (#590).
--
-- WHY: saving to the shared Price Book becomes admin-only by default, grantable per user
--   via Settings → user permissions (USER_CAPABILITIES now carries create/update/delete
--   PriceBook as managed org-wide toggles). Editing defaultGrants.ts only affects NEW orgs;
--   effective grants are persisted role_permissions rows, so this removes the SALES write
--   rows from EXISTING orgs. KEEPS `SALES read PriceBook` (catalog browsing/search).
--
-- ORDERING: must run AFTER 20260707130000_sync_role_permission_defaults, which re-inserts
--   these exact rows for every org (its lines 55-58) — the 20260710000000 timestamp
--   guarantees that on a fresh CI database and on the shared staging DB alike.
--
-- IDEMPOTENT + re-runnable: a re-run deletes nothing once applied. Portable: plain DELETE,
-- no Supabase-only objects.
DELETE FROM role_permissions
WHERE role = 'SALES' AND subject = 'PriceBook' AND action IN ('create','update','delete');

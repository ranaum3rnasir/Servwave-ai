-- Drop the SALES `read Dashboard` default grant from EXISTING organizations (MISS-1, RBAC QA).
--
-- WHY: GET /api/dashboard returns org-wide financials (invoiced/collected MTD, AR aging,
--   deposits awaiting, average ticket, revenue charts, pipeline value, and a per-technician
--   revenue scoreboard). SALES is row-scoped on every other surface, so a SALES rep was
--   receiving the whole company's financials via the dashboard — the same leak class as the
--   jobs/leads/invoice stat-card fixes. Decision: SALES loses dashboard access entirely
--   (admin/dispatcher-only), matching the updated DEFAULT_GRANTS (lib/permissions/defaultGrants.ts).
--
-- Effective grants are persisted role_permissions rows, so editing defaultGrants.ts only changes
-- NEW orgs; this migration catches EXISTING orgs. The route guard is canDo('read','Dashboard'),
-- so removing the grant makes SALES 403 on the endpoint; the frontend redirects SALES off the
-- root dashboard route to their first permitted page.
--
-- IDEMPOTENT + re-runnable on the shared staging DB: a re-run deletes nothing once applied.
-- Removes ALL SALES read-Dashboard grants regardless of conditions (the grant is unconditional;
-- an org that wants a sales dashboard can re-add it via Settings).
DELETE FROM role_permissions
WHERE role = 'SALES' AND action = 'read' AND subject = 'Dashboard';

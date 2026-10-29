-- Backfill the DISPATCHER `CalendarEntry` role default (read/create/update/delete) for every
-- existing organization.
--
-- Calendar Entries (2026-08-24 plan, slice 01 - permission subject and backfill): "Default grant:
-- ADMIN + DISPATCHER." This PR only adds the permission plumbing for a NOT-YET-BUILT capability -
-- the `calendar_entries` table and its API ship in a later slice. ADMIN reaches it automatically
-- via the manage-all bypass (no row needed, no backfill needed). DISPATCHER needs an explicit row
-- per org, which was added to DEFAULT_GRANTS (backend/src/lib/permissions/defaultGrants.ts) so
-- NEW orgs seed it automatically; without this migration, existing orgs' dispatchers would not
-- see the "Events" row ticked on the Roles & Permissions screen until someone manually re-saved
-- the role.
--
-- Mirrors the 20260819230000_editable_record_ids_dispatcher_backfill skeleton (the canonical form
-- for a brand-new role default - no pre-split source rows to derive from). The canonical grant set
-- lives in defaultGrants.ts; this SQL must match it (pinned by
-- backend/src/__tests__/permissions-calendar-entry-backfill.test.ts), generated with
-- `cd backend && npx tsx src/scripts/check-role-permission-drift.ts --emit-sql` and filtered to
-- the CalendarEntry subject rather than hand-transcribed.
--
-- Portable (no Supabase-only objects) + idempotent via ON CONFLICT DO NOTHING - safe to re-run,
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
  ('DISPATCHER','read','CalendarEntry',NULL),
  ('DISPATCHER','create','CalendarEntry',NULL),
  ('DISPATCHER','update','CalendarEntry',NULL),
  ('DISPATCHER','delete','CalendarEntry',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

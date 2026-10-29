-- Scheduling-notifications slice 10 (user stories 24/25): TECHNICIAN `en_route Job` backfill.
--
-- The default TECHNICIAN role gains "on the way" on their own job, matching the existing start
-- and arrive rows (20260721000000_technician_main_app_grants). Grants are read at RUNTIME from
-- role_permissions (middleware/attachAbility.ts), not from DEFAULT_GRANTS, so a new role default
-- reaches an EXISTING org only through a backfill like this one. Without it a technician in an
-- org provisioned before this release 403s on the first milestone of their own visit while a
-- technician in a fresh org does not.
--
-- CANONICAL SOURCE is backend/src/lib/permissions/defaultGrants.ts (which seeds NEW orgs);
-- backend/src/__tests__/permissions-technician-en-route-backfill.test.ts pins the two together,
-- so editing one without the other is a red test rather than silent drift.
--
-- SHAPE, and why each part is the way it is:
--   FROM organizations o          every existing org, the same population the start/arrive rows
--                                 were backfilled across. Role is the literal 'TECHNICIAN', so a
--                                 custom role (which writes its own key into role_permissions.role)
--                                 is never touched: an admin who cloned TECHNICIAN decides for
--                                 themselves whether the clone gets the verb.
--   conditions = OWN_JOB          byte-equal to defaultGrants.ts's OWN_JOB (the S8 visits path), so
--                                 check-role-permission-drift --strict reports no "changed" finding
--                                 for the row this file writes.
--   ON CONFLICT ... DO NOTHING    insert only where absent. An org whose admin already toggled the
--                                 verb on for TECHNICIAN keeps whatever row they wrote, wider or
--                                 not; this file never narrows a hand-edited row. That is the
--                                 spec's rule, and it is the one case where DO NOTHING (rather than
--                                 DO UPDATE) is the correct guard. A wider hand-edited row would be
--                                 a "changed conditions" finding for --strict; see PRE-FLIGHT.
--
-- IDEMPOTENT: guarded on the (organization_id, role, action, subject) unique, so a second apply
--   changes nothing. Safe to re-run against the shared staging DB and safe if migrate deploy
--   replays it.
-- PORTABLE: plain SQL on vanilla postgres:16 (CI's migrations + RLS gate). No hosted-database-only
--   roles, policies or auth schema references. No secrets.
--
-- RLS HAZARD: role_permissions carries FORCE ROW LEVEL SECURITY
-- (20260703000100_tenant_rls/migration.sql:184). A NOBYPASSRLS role running this file reports
-- "INSERT 0 0" SILENTLY, so a green _prisma_migrations ledger row is NOT evidence the rows landed.
-- Run the verification query below after every apply, never the ledger.
--
-- VERIFICATION QUERY (per org, never a global count; organization_id only, never an org name):
--
--   SELECT o.id AS organization_id,
--          bool_or(rp.action = 'start')    AS has_start,
--          bool_or(rp.action = 'arrive')   AS has_arrive,
--          bool_or(rp.action = 'en_route') AS has_en_route,
--          max(rp.conditions::text) FILTER (WHERE rp.action = 'en_route') AS en_route_conditions
--   FROM organizations o
--   LEFT JOIN role_permissions rp
--     ON rp.organization_id = o.id AND rp.role = 'TECHNICIAN' AND rp.subject = 'Job'
--   GROUP BY o.id
--   ORDER BY o.id;
--
-- Expected per org: has_en_route true everywhere; en_route_conditions equal to the OWN_JOB literal
-- below for every org this file inserted into (a pre-existing hand-edited row may differ, and is
-- left as it was).
--
-- PRE-FLIGHT (read-only, staging, 2026-09-13, organization_id only): 9 organizations; 9 TECHNICIAN
-- `start Job` rows, all carrying the OWN_JOB visits literal; 0 TECHNICIAN `en_route Job` rows.
-- EXPECTED EFFECT on staging: 9 rows inserted, 0 conflicts. RE-MEASURE ON PRODUCTION AT APPLY TIME
-- with the query below; if it returns a TECHNICIAN `en_route Job` row whose conditions are not the
-- OWN_JOB literal, that org keeps its row (DO NOTHING) and --strict will name it, which is the
-- intended outcome, not a failure of this file:
--
--   SELECT organization_id, conditions::text
--   FROM role_permissions
--   WHERE role = 'TECHNICIAN' AND action = 'en_route' AND subject = 'Job';
--
-- gen_random_uuid()/NOW() are supplied explicitly because `id @default(uuid())` is a Prisma-side
-- default and `updated_at @updatedAt` has no DB default at all; raw SQL must fill both in.

INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'TECHNICIAN',
  'en_route',
  'Job',
  '{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb,
  NOW(),
  NOW()
FROM organizations o
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;

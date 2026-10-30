-- Roles & Permissions security, ticket 36b, M17: the Company settings switch retires.
--
-- Setting up the company's settings is the Admin flag's alone (Ran, 2026-10-29: "Setting up the company settings is for admins
-- only. No one else can reach this page under settings"; confirmed "Admin-only, no switch"). Every route that the switch opened
-- now checks users.is_admin, never a switch, so the switch is gone from the catalog and this migration deletes its stored rows
-- from both switch tables:
--
--   company_settings
--
-- Each deleted value writes one permission_change_log row with the reason 'migration' (the value it held, and nothing after it).
-- The history already in the log keeps the key it was written under; the change log screens show a key the catalog no longer
-- holds as "A switch that no longer exists". Same form as M13 (20261028130000_retire_user_role_switches).
--
-- IDEMPOTENT: a second run finds no row to delete. SET-BASED. Portable plain PostgreSQL (no extension, no role, no schema
-- outside public). Takes row locks on the deleted rows only. Touches no other switch key. NEVER run `prisma migrate` from a worktree.

DO $m17$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);
  -- Never queue every switch write behind this one: give up after 5 seconds instead (a failed run changes nothing).
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TEMP TABLE m17_key (switch_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO m17_key (switch_key) VALUES ('company_settings');

  WITH deleted AS (
    DELETE FROM permission_role_switches r
     USING m17_key k
     WHERE r.switch_key = k.switch_key
    RETURNING r.organization_id, r.role_key, r.switch_key, r.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'ROLE', d.role_key, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;

  WITH deleted AS (
    DELETE FROM permission_user_switches u
     USING m17_key k
     WHERE u.switch_key = k.switch_key
    RETURNING u.organization_id, u.user_id, u.switch_key, u.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'USER', d.user_id::text, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;
END
$m17$;

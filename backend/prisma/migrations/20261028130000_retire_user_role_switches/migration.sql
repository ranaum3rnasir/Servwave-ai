-- Roles & Permissions security, AL-18 (ticket 28), M13: the five user and role switches retire.
--
-- User and role management is the Admin flag's alone (ruling 10, 2026-10-27): every role route, every person-switch route
-- and every user-management route checks users.is_admin, never a switch. So the five switches that stood for it are gone
-- from the catalog and this migration deletes their stored rows from both switch tables:
--
--   create_users, invite_users, edit_users, delete_users, manage_roles_and_permissions
--
-- View users stays (names in pickers and on records). Each deleted value writes one permission_change_log row with the reason
-- 'migration' (the value it held, and nothing after it). The history already in the log keeps the key it was written under;
-- the change log screens show a key the catalog no longer holds as "A switch that no longer exists".
--
-- IDEMPOTENT: a second run finds no row to delete. SET-BASED. Portable plain PostgreSQL (no extension, no role, no schema
-- outside public). Takes row locks on the deleted rows only. NEVER run `prisma migrate` from a worktree.

DO $al_18$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);
  -- Never queue every switch write behind this one: give up after 5 seconds instead (a failed run changes nothing).
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TEMP TABLE al_18_key (switch_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO al_18_key (switch_key) VALUES
    ('create_users'), ('invite_users'), ('edit_users'), ('delete_users'), ('manage_roles_and_permissions');

  WITH deleted AS (
    DELETE FROM permission_role_switches r
     USING al_18_key k
     WHERE r.switch_key = k.switch_key
    RETURNING r.organization_id, r.role_key, r.switch_key, r.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'ROLE', d.role_key, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;

  WITH deleted AS (
    DELETE FROM permission_user_switches u
     USING al_18_key k
     WHERE u.switch_key = k.switch_key
    RETURNING u.organization_id, u.user_id, u.switch_key, u.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'USER', d.user_id::text, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;
END
$al_18$;

-- Roles & Permissions alignment, AL-06b (P6; M6): the Estimates scope and the Invoices scope retire.
--
-- Who reaches which estimates, invoices and payments follows the Jobs scope and the Leads scope: an estimate is reached the way
-- its lead or job is, an invoice the way its job is (a deposit invoice with no job yet, through its estimate). So the two scope
-- switches are gone and this migration deletes their stored rows from both switch tables:
--
--   estimates_scope, invoices_scope
--
-- Each deleted value writes one permission_change_log row with the reason 'migration' (the value it held, and nothing after
-- it). The history already in the log keeps the key it was written under; the change log screens show a key the catalog no
-- longer holds as "A switch that no longer exists".
--
-- IDEMPOTENT: a second run finds no row to delete. SET-BASED. Portable plain PostgreSQL. NEVER run `prisma migrate` from a
-- worktree.

DO $al_06b$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  CREATE TEMP TABLE al_06b_key (switch_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO al_06b_key (switch_key) VALUES ('estimates_scope'), ('invoices_scope');

  WITH deleted AS (
    DELETE FROM permission_role_switches r
     USING al_06b_key k
     WHERE r.switch_key = k.switch_key
    RETURNING r.organization_id, r.role_key, r.switch_key, r.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'ROLE', d.role_key, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;

  WITH deleted AS (
    DELETE FROM permission_user_switches u
     USING al_06b_key k
     WHERE u.switch_key = k.switch_key
    RETURNING u.organization_id, u.user_id, u.switch_key, u.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'USER', d.user_id::text, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;
END
$al_06b$;

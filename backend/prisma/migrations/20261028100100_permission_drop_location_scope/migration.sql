-- Roles & Permissions alignment, AL-02 (P6, M2): the scope switches offer Attached, Team and All. There is no Location
-- scope any more.
--
-- The editor could store 'location' on a scope switch (Leads, Jobs, Estimates, Invoices scope) until now, and the
-- earlier migrations never wrote it, so none is expected. This migration CHECKS first (a NOTICE with the counts, ids
-- never printed) and then rewrites any stored 'location' value on a role or a person to 'attached', the narrowest
-- choice, so nobody gains reach. Each rewritten value writes one permission_change_log row with the reason
-- 'migration'.
--
-- IDEMPOTENT: a second run finds nothing to rewrite. Portable plain PostgreSQL. NEVER run `prisma migrate` from a
-- worktree.

DO $al_02$
DECLARE
  role_rows bigint;
  user_rows bigint;
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);

  SELECT count(*) INTO role_rows FROM permission_role_switches WHERE value = '"location"'::jsonb;
  SELECT count(*) INTO user_rows FROM permission_user_switches WHERE value = '"location"'::jsonb;
  RAISE NOTICE 'al_02: % role rows and % person rows hold the retired Location scope', role_rows, user_rows;

  WITH changed AS (
    UPDATE permission_role_switches
       SET value = '"attached"'::jsonb, updated_at = now()
     WHERE value = '"location"'::jsonb
    RETURNING organization_id, role_key, switch_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), c.organization_id, 'ROLE', c.role_key, c.switch_key, '"location"'::jsonb, '"attached"'::jsonb, NULL, 'migration', NULL
  FROM changed c;

  WITH changed AS (
    UPDATE permission_user_switches
       SET value = '"attached"'::jsonb, updated_at = now()
     WHERE value = '"location"'::jsonb
    RETURNING organization_id, user_id, switch_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), c.organization_id, 'USER', c.user_id::text, c.switch_key, '"location"'::jsonb, '"attached"'::jsonb, NULL, 'migration', NULL
  FROM changed c;
END
$al_02$;

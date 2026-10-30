-- Roles & Permissions alignment, AL-05 (P11, E7; M4): the three money classes, one chain. See prices is the root; See costs
-- (once See financial data) and See company figures stand on it.
--
-- M4, part 1. Every stored role gets See prices on. Today a price follows the record: whoever can open an estimate, an
-- invoice or a job sees its prices. Turning the root on for every stored role keeps exactly that, so nobody gains or loses
-- a price here; it only gives the new chain (See costs and See company figures need it, and so do Record payments and
-- Create/Edit estimates and invoices) something to stand on. A role whose value is already stored, on or off, is left as
-- it is. Each insert writes one permission_change_log row with the reason 'migration'.
--
-- M4, part 2. The old See financial data switch becomes See costs (the second money class, which now needs See prices). Its
-- stored value moves to the new key in both switch tables, and its history in the change log is renamed with it, so the
-- Roles page and a person's page read the same history under the new name. Part 1 runs first, so a role that holds See costs
-- never lacks its root. A role or a person that somehow already has a See costs row keeps it: their old row is dropped, not
-- renamed over it. The renamed rows keep their value and their date, so no value changes and nothing new is logged.
--
-- IDEMPOTENT: a second run finds every role holding the row, and no row under the old key. SET-BASED. Portable plain PostgreSQL. NEVER run `prisma migrate`
-- from a worktree.

DO $al_05$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  WITH added AS (
    INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, created_at, updated_at)
    SELECT gen_random_uuid(), r.organization_id, r.role_key, 'see_prices', 'true'::jsonb, now(), now()
      FROM (SELECT DISTINCT organization_id, role_key FROM permission_role_switches) r
     WHERE NOT EXISTS (
       SELECT 1 FROM permission_role_switches x
        WHERE x.organization_id = r.organization_id AND x.role_key = r.role_key AND x.switch_key = 'see_prices'
     )
    ON CONFLICT (organization_id, role_key, switch_key) DO NOTHING
    RETURNING organization_id, role_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), a.organization_id, 'ROLE', a.role_key, 'see_prices', NULL, 'true'::jsonb, NULL, 'migration', NULL
    FROM added a;

  -- Part 2, roles: rename where the role holds no See costs row yet, then drop an old row that lost to an existing one.
  UPDATE permission_role_switches r
     SET switch_key = 'see_costs'
   WHERE r.switch_key = 'see_financial_data'
     AND NOT EXISTS (
       SELECT 1 FROM permission_role_switches x
        WHERE x.organization_id = r.organization_id AND x.role_key = r.role_key AND x.switch_key = 'see_costs'
     );
  DELETE FROM permission_role_switches WHERE switch_key = 'see_financial_data';

  -- Part 2, people: the same.
  UPDATE permission_user_switches u
     SET switch_key = 'see_costs'
   WHERE u.switch_key = 'see_financial_data'
     AND NOT EXISTS (
       SELECT 1 FROM permission_user_switches x WHERE x.user_id = u.user_id AND x.switch_key = 'see_costs'
     );
  DELETE FROM permission_user_switches WHERE switch_key = 'see_financial_data';

  -- Part 2, history: every entry about the old key reads under the new one.
  UPDATE permission_change_log SET switch_key = 'see_costs' WHERE switch_key = 'see_financial_data';
END
$al_05$;

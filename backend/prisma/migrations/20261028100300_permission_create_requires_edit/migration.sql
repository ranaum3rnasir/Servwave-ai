-- Roles & Permissions alignment, AL-04 (P2, A3, A7, A8; M7 and M8): Create requires Edit, and the built-in presets obey
-- the chain.
--
-- M7. Wherever a role or a person holds Create on and Edit off, Edit is turned on. Nobody can create a record they could not
-- edit, and nobody who could create loses that. Each change writes one permission_change_log row with the reason
-- 'migration'. What a role or a person holds is read the way the app reads it: the person's own row, else the role's stored
-- row, else the built-in preset behind the role (the role itself if built-in, the base a custom role records, nothing on for a
-- role made from blank). 100000 deleted every person row equal to the role or its preset, and a role made from a base stores
-- nothing, so an Edit "off" often lives only in the preset (pre-PR review CR-8).
--
-- The preset table below is a SNAPSHOT of the catalog presets of this release for sixteen of the Create/Edit pairs. In
-- every preset a pair's Create and Edit are equal, so one row per pair says which presets have the pair on; any other preset
-- (and a role made from blank) has it off. Users has no preset row (its switches retire in 20261028130000), so its pair is
-- read from stored rows only, as before.
--
-- M8. The stored rows of the built-in Dispatcher and Technician roles that still equal the OLD preset take the new one:
--   Technician  Edit leads, Edit estimates, Edit jobs on; Record payments, Send payment links off.
--   Dispatcher  Edit customers, Edit estimates on.
-- (Create customers is already off for Technician.) A row someone changed by hand no longer equals the old preset and is
-- left alone. People on those roles follow the role (P14); a person's own value is never touched here.
--
-- IDEMPOTENT: a second run finds nothing to change. SET-BASED. Portable plain PostgreSQL. NEVER run `prisma migrate`
-- from a worktree.

DO $al_04$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  CREATE TEMP TABLE al_04_pair (create_key text NOT NULL, edit_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO al_04_pair (create_key, edit_key) VALUES
    ('create_customers', 'edit_customers'), ('create_leads', 'edit_leads'), ('create_jobs', 'edit_jobs'),
    ('create_estimates', 'edit_estimates'), ('create_invoices', 'edit_invoices'), ('create_service_plans', 'edit_service_plans'),
    ('create_automations', 'edit_automations'), ('create_tasks', 'edit_tasks'), ('create_events', 'edit_events'),
    ('create_users', 'edit_users'), ('create_departments', 'edit_departments'), ('create_locations', 'edit_locations'),
    ('create_stock', 'edit_stock'), ('create_purchase_orders', 'edit_purchase_orders'), ('create_vendors', 'edit_vendors'),
    ('create_logistic_orders', 'edit_logistic_orders'), ('create_price_book_items', 'edit_price_book_items');

  -- Which presets have each pair on (Create and Edit are equal in every preset).
  CREATE TEMP TABLE al_04_preset_on (edit_key text NOT NULL, on_in text[] NOT NULL) ON COMMIT DROP;
  INSERT INTO al_04_preset_on (edit_key, on_in) VALUES
    ('edit_customers',        ARRAY['ADMIN', 'SALES', 'DISPATCHER']),
    ('edit_leads',            ARRAY['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']),
    ('edit_jobs',             ARRAY['ADMIN', 'DISPATCHER', 'TECHNICIAN']),
    ('edit_estimates',        ARRAY['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']),
    ('edit_invoices',         ARRAY['ADMIN', 'DISPATCHER']),
    ('edit_service_plans',    ARRAY['ADMIN', 'DISPATCHER']),
    ('edit_automations',      ARRAY['ADMIN']),
    ('edit_tasks',            ARRAY['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']),
    ('edit_events',           ARRAY['ADMIN', 'DISPATCHER']),
    ('edit_departments',      ARRAY['ADMIN']),
    ('edit_locations',        ARRAY['ADMIN']),
    ('edit_stock',            ARRAY['ADMIN']),
    ('edit_purchase_orders',  ARRAY['ADMIN']),
    ('edit_vendors',          ARRAY['ADMIN']),
    ('edit_logistic_orders',  ARRAY['ADMIN', 'SALES', 'DISPATCHER']),
    ('edit_price_book_items', ARRAY['ADMIN']);

  -- M7, roles: every stored role, with the preset behind it (NULL for a key that is neither built-in nor a custom role: only
  -- its stored rows are read, as before).
  CREATE TEMP TABLE al_04_role ON COMMIT DROP AS
  SELECT DISTINCT rs.organization_id, rs.role_key,
         CASE
           WHEN rs.role_key IN ('ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN') THEN rs.role_key
           WHEN cr.id IS NULL THEN NULL
           WHEN cr.made_from_blank THEN 'BLANK'
           ELSE cr.base_role::text
         END AS preset_role
  FROM permission_role_switches rs
  LEFT JOIN custom_roles cr ON cr.organization_id = rs.organization_id AND cr.key = rs.role_key;

  -- A role that holds Create on and Edit off, each read from its stored row, else its preset.
  CREATE TEMP TABLE al_04_role_violation ON COMMIT DROP AS
  SELECT r.organization_id, r.role_key, p.edit_key, re.id AS edit_row_id
  FROM al_04_role r
  CROSS JOIN al_04_pair p
  LEFT JOIN al_04_preset_on po ON po.edit_key = p.edit_key
  LEFT JOIN permission_role_switches rc
         ON rc.organization_id = r.organization_id AND rc.role_key = r.role_key AND rc.switch_key = p.create_key
  LEFT JOIN permission_role_switches re
         ON re.organization_id = r.organization_id AND re.role_key = r.role_key AND re.switch_key = p.edit_key
  WHERE COALESCE(rc.value, CASE WHEN po.edit_key IS NULL OR r.preset_role IS NULL THEN NULL ELSE to_jsonb(r.preset_role = ANY(po.on_in)) END) = 'true'::jsonb
    AND COALESCE(re.value, CASE WHEN po.edit_key IS NULL OR r.preset_role IS NULL THEN NULL ELSE to_jsonb(r.preset_role = ANY(po.on_in)) END) = 'false'::jsonb;

  -- Its Edit becomes on: a stored "off" row is turned on, a missing row (off in the preset) is added.
  WITH turned AS (
    UPDATE permission_role_switches e
       SET value = 'true'::jsonb, updated_at = now()
      FROM al_04_role_violation v
     WHERE e.id = v.edit_row_id
    RETURNING e.organization_id, e.role_key, e.switch_key
  ), added AS (
    INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, created_at, updated_at)
    SELECT gen_random_uuid(), v.organization_id, v.role_key, v.edit_key, 'true'::jsonb, now(), now()
      FROM al_04_role_violation v
     WHERE v.edit_row_id IS NULL
    ON CONFLICT (organization_id, role_key, switch_key) DO UPDATE SET value = 'true'::jsonb, updated_at = now()
    RETURNING organization_id, role_key, switch_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), x.organization_id, 'ROLE', x.role_key, x.switch_key, 'false'::jsonb, 'true'::jsonb, NULL, 'migration', NULL
  FROM (SELECT * FROM turned UNION ALL SELECT * FROM added) x;

  -- M7, people: what each person holds once their own values sit on their role's (roles are fixed above), with the preset
  -- behind that role worked out the way 100000 works it out. The Admin holds no set.
  CREATE TEMP TABLE al_04_person ON COMMIT DROP AS
  SELECT u.id AS user_id, u.organization_id,
         COALESCE(u.based_on_role_key, cr.key, u.role::text) AS role_key,
         CASE
           WHEN COALESCE(u.based_on_role_key, cr.key, u.role::text) IN ('ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN')
             THEN COALESCE(u.based_on_role_key, cr.key, u.role::text)
           WHEN bcr.id IS NULL THEN u.role::text
           WHEN bcr.made_from_blank THEN 'BLANK'
           ELSE bcr.base_role::text
         END AS preset_role
  FROM users u
  LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
  LEFT JOIN custom_roles bcr
         ON bcr.organization_id = u.organization_id
        AND bcr.key = COALESCE(u.based_on_role_key, cr.key, u.role::text)
  WHERE NOT u.is_admin;

  -- `role_edit_value` is what the role holds for Edit (its row, else its preset).
  CREATE TEMP TABLE al_04_violation ON COMMIT DROP AS
  SELECT pe.user_id, pe.organization_id, pr.edit_key,
         COALESCE(role_edit.value, CASE WHEN po.edit_key IS NULL THEN NULL ELSE to_jsonb(pe.preset_role = ANY(po.on_in)) END) AS role_edit_value,
         own_edit.id AS own_edit_id
  FROM al_04_person pe
  CROSS JOIN al_04_pair pr
  LEFT JOIN al_04_preset_on po ON po.edit_key = pr.edit_key
  LEFT JOIN permission_user_switches own_create ON own_create.user_id = pe.user_id AND own_create.switch_key = pr.create_key
  LEFT JOIN permission_user_switches own_edit   ON own_edit.user_id   = pe.user_id AND own_edit.switch_key   = pr.edit_key
  LEFT JOIN permission_role_switches role_create
         ON role_create.organization_id = pe.organization_id AND role_create.role_key = pe.role_key AND role_create.switch_key = pr.create_key
  LEFT JOIN permission_role_switches role_edit
         ON role_edit.organization_id = pe.organization_id AND role_edit.role_key = pe.role_key AND role_edit.switch_key = pr.edit_key
  WHERE COALESCE(own_create.value, role_create.value, CASE WHEN po.edit_key IS NULL THEN NULL ELSE to_jsonb(pe.preset_role = ANY(po.on_in)) END) = 'true'::jsonb
    AND COALESCE(own_edit.value, role_edit.value, CASE WHEN po.edit_key IS NULL THEN NULL ELSE to_jsonb(pe.preset_role = ANY(po.on_in)) END) = 'false'::jsonb;

  -- A person who follows a role whose Edit is on: their own Edit "off" is dropped, so they follow the role.
  WITH dropped AS (
    DELETE FROM permission_user_switches us
     USING al_04_violation v
     WHERE us.id = v.own_edit_id AND v.role_edit_value = 'true'::jsonb
    RETURNING us.organization_id, us.user_id, us.switch_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'USER', d.user_id::text, d.switch_key, 'false'::jsonb, 'true'::jsonb, NULL, 'migration', NULL
  FROM dropped d;

  -- Anyone else: their own Edit becomes on (an existing "off" row is turned on, a missing row is added).
  WITH turned AS (
    UPDATE permission_user_switches us
       SET value = 'true'::jsonb, updated_at = now()
      FROM al_04_violation v
     WHERE us.id = v.own_edit_id AND (v.role_edit_value IS NULL OR v.role_edit_value <> 'true'::jsonb)
    RETURNING us.organization_id, us.user_id, us.switch_key
  ), added AS (
    INSERT INTO permission_user_switches (id, organization_id, user_id, switch_key, value, created_at, updated_at)
    SELECT gen_random_uuid(), v.organization_id, v.user_id, v.edit_key, 'true'::jsonb, now(), now()
      FROM al_04_violation v
     WHERE v.own_edit_id IS NULL AND (v.role_edit_value IS NULL OR v.role_edit_value <> 'true'::jsonb)
    ON CONFLICT (user_id, switch_key) DO UPDATE SET value = 'true'::jsonb, updated_at = now()
    RETURNING organization_id, user_id, switch_key
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), x.organization_id, 'USER', x.user_id::text, x.switch_key, 'false'::jsonb, 'true'::jsonb, NULL, 'migration', NULL
  FROM (SELECT * FROM turned UNION SELECT * FROM added) x;

  -- M8: the built-in rows that still equal the old preset take the new one.
  CREATE TEMP TABLE al_04_preset (role_key text NOT NULL, switch_key text NOT NULL, old_value jsonb NOT NULL, new_value jsonb NOT NULL) ON COMMIT DROP;
  INSERT INTO al_04_preset (role_key, switch_key, old_value, new_value) VALUES
    ('TECHNICIAN', 'edit_leads',          'false'::jsonb, 'true'::jsonb),
    ('TECHNICIAN', 'edit_estimates',      'false'::jsonb, 'true'::jsonb),
    ('TECHNICIAN', 'edit_jobs',           'false'::jsonb, 'true'::jsonb),
    ('TECHNICIAN', 'record_payments',     'true'::jsonb,  'false'::jsonb),
    ('TECHNICIAN', 'send_payment_links',  'true'::jsonb,  'false'::jsonb),
    ('DISPATCHER', 'edit_customers',      'false'::jsonb, 'true'::jsonb),
    ('DISPATCHER', 'edit_estimates',      'false'::jsonb, 'true'::jsonb);

  WITH moved AS (
    UPDATE permission_role_switches rs
       SET value = p.new_value, updated_at = now()
      FROM al_04_preset p
     WHERE rs.role_key = p.role_key AND rs.switch_key = p.switch_key AND rs.value = p.old_value
    RETURNING rs.organization_id, rs.role_key, rs.switch_key, p.old_value, p.new_value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), m.organization_id, 'ROLE', m.role_key, m.switch_key, m.old_value, m.new_value, NULL, 'migration', NULL
  FROM moved m;
END
$al_04$;

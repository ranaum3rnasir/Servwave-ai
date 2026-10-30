-- Roles & Permissions alignment, AL-08 (P6, A8a; M9a): the See-all toggles of Tasks, Events, Stock and Time tracking become
-- each module's one scope switch, and Communication scope takes the same three choices.
--
--   see_all_tasks            -> tasks_scope        true -> 'all'   false -> 'attached'
--   see_all_calendar_entries -> events_scope       (same mapping)
--   see_all_assets           -> assets_scope       (same mapping)
--   see_everyones_timesheets -> timesheets_scope   (same mapping)
--   communication_scope      'linked_to_me' -> 'attached' ('all' is unchanged)
--
-- Off was "only the rows the person is on" and on was "every row", which is exactly Attached and All, so nobody gains or
-- loses a row. The built-in presets map the same way, so a stored row that equalled the old preset still equals the new one.
-- The stored keys and values are rewritten in permission_role_switches and permission_user_switches, and the rows already in
-- the log are rewritten to the new key and value so a switch's history reads under the name it has now. The rewrite itself
-- writes NO permission_change_log row: nobody's access changes, and a row such as "Tasks scope: Off -> All" would record a
-- change that never happened (a boolean "from" on a choice switch reads as Off). 100400 logs its own rename the same way: not
-- at all (pre-PR review CR-19).
--
-- IDEMPOTENT: a second run finds no old key and no old value. SET-BASED. Portable plain PostgreSQL. NEVER run
-- `prisma migrate` from a worktree.

DO $al_08$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  CREATE TEMP TABLE al_08_key (old_key text NOT NULL, new_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO al_08_key (old_key, new_key) VALUES
    ('see_all_tasks', 'tasks_scope'),
    ('see_all_calendar_entries', 'events_scope'),
    ('see_all_assets', 'assets_scope'),
    ('see_everyones_timesheets', 'timesheets_scope');

  -- The history first: the rows already in the log read under the new key and value.
  UPDATE permission_change_log l
     SET switch_key = k.new_key,
         from_value = CASE WHEN l.from_value = 'true'::jsonb THEN '"all"'::jsonb
                           WHEN l.from_value = 'false'::jsonb THEN '"attached"'::jsonb ELSE l.from_value END,
         to_value   = CASE WHEN l.to_value = 'true'::jsonb THEN '"all"'::jsonb
                           WHEN l.to_value = 'false'::jsonb THEN '"attached"'::jsonb ELSE l.to_value END
    FROM al_08_key k
   WHERE l.switch_key = k.old_key;
  UPDATE permission_change_log
     SET from_value = CASE WHEN from_value = '"linked_to_me"'::jsonb THEN '"attached"'::jsonb ELSE from_value END,
         to_value   = CASE WHEN to_value = '"linked_to_me"'::jsonb THEN '"attached"'::jsonb ELSE to_value END
   WHERE switch_key = 'communication_scope'
     AND (from_value = '"linked_to_me"'::jsonb OR to_value = '"linked_to_me"'::jsonb);

  -- Roles: the four toggles become their scope switch (a rename: nothing is logged).
  UPDATE permission_role_switches r
     SET switch_key = k.new_key,
         value = CASE WHEN r.value = 'true'::jsonb THEN '"all"'::jsonb ELSE '"attached"'::jsonb END,
         updated_at = now()
    FROM al_08_key k
   WHERE k.old_key = r.switch_key;

  -- People: the same for each person's own value.
  UPDATE permission_user_switches u
     SET switch_key = k.new_key,
         value = CASE WHEN u.value = 'true'::jsonb THEN '"all"'::jsonb ELSE '"attached"'::jsonb END,
         updated_at = now()
    FROM al_08_key k
   WHERE k.old_key = u.switch_key;

  -- Communication scope: "Linked to me" is Attached (the same choice under its new name: nothing is logged).
  UPDATE permission_role_switches
     SET value = '"attached"'::jsonb, updated_at = now()
   WHERE switch_key = 'communication_scope' AND value = '"linked_to_me"'::jsonb;

  UPDATE permission_user_switches
     SET value = '"attached"'::jsonb, updated_at = now()
   WHERE switch_key = 'communication_scope' AND value = '"linked_to_me"'::jsonb;
END
$al_08$;

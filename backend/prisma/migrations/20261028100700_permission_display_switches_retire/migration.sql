-- Roles & Permissions alignment, AL-10 (P1, A1; M9b): display-only switches retire.
--
-- A page opens for a person who has its module's View (and the plan feature), and the sidebar follows View, so the fifteen
-- "Show ... page" switches and the Phone usage bar are gone (a display is not a switch). This migration deletes their stored
-- rows from both switch tables:
--
--   show_customers_page, show_leads_page, show_jobs_page, show_estimates_page, show_invoices_page, show_payments_page,
--   show_service_plans_page, show_automations_page, show_tasks_page, show_users_teams_page, show_stock_page,
--   show_purchase_orders_page, show_vendors_page, show_logistic_orders_page, show_price_book_page, phone_usage_bar
--
-- Each deleted value writes one permission_change_log row with the reason 'migration' (the value it held, and nothing after
-- it). The history already in the log keeps the key it was written under; the change log screens show a key the catalog no
-- longer holds as "A switch that no longer exists".
--
-- IDEMPOTENT: a second run finds no row to delete. SET-BASED. Portable plain PostgreSQL. NEVER run `prisma migrate` from a
-- worktree.

DO $al_10$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  CREATE TEMP TABLE al_10_key (switch_key text NOT NULL) ON COMMIT DROP;
  INSERT INTO al_10_key (switch_key) VALUES
    ('show_customers_page'), ('show_leads_page'), ('show_jobs_page'), ('show_estimates_page'), ('show_invoices_page'),
    ('show_payments_page'), ('show_service_plans_page'), ('show_automations_page'), ('show_tasks_page'),
    ('show_users_teams_page'), ('show_stock_page'), ('show_purchase_orders_page'), ('show_vendors_page'),
    ('show_logistic_orders_page'), ('show_price_book_page'), ('phone_usage_bar');

  WITH deleted AS (
    DELETE FROM permission_role_switches r
     USING al_10_key k
     WHERE r.switch_key = k.switch_key
    RETURNING r.organization_id, r.role_key, r.switch_key, r.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'ROLE', d.role_key, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;

  WITH deleted AS (
    DELETE FROM permission_user_switches u
     USING al_10_key k
     WHERE u.switch_key = k.switch_key
    RETURNING u.organization_id, u.user_id, u.switch_key, u.value
  )
  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, role_label)
  SELECT gen_random_uuid(), d.organization_id, 'USER', d.user_id::text, d.switch_key, d.value, NULL, NULL, 'migration', NULL
  FROM deleted d;
END
$al_10$;

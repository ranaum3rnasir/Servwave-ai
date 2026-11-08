-- Tenant isolation RLS backstop.
--
-- ENABLE + FORCE ROW LEVEL SECURITY + a tenant_isolation policy on every
-- org-scoped table. Policies key off two transaction-local session vars the app
-- sets (lib/tenant-guard.ts): app.current_org_id (scope to one org) and
-- app.bypass_rls='on' (controlled cross-tenant escape hatch for cron/webhook/
-- bootstrap). With no session var set, a policy matches NO rows (fail-closed).
--
-- INERT until the app connects as a non-BYPASSRLS role AND DB_TENANT_GUARD=on:
-- a BYPASSRLS role (today's postgres) ignores RLS entirely, so applying this
-- migration does not change app behavior. See docs/rls-activation-runbook.md.
--
-- Portable (vanilla Postgres: current_setting/NULLIF/uuid are core; policies are
-- TO public so no Supabase role is required) and idempotent (DROP POLICY IF
-- EXISTS before CREATE; ENABLE/FORCE are no-ops on re-run).
--
-- Excluded by design: organizations (scoped by id below), audit_logs (scoped by
-- org_id below), state_tax_rates + stripe_events (global, no org column).

-- ─── Org-scoped tables (organization_id) ───
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "users";
CREATE POLICY "tenant_isolation" ON "users"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "departments";
CREATE POLICY "tenant_isolation" ON "departments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "job_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_assignees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_assignees";
CREATE POLICY "tenant_isolation" ON "job_assignees"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "lead_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_assignees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lead_assignees";
CREATE POLICY "tenant_isolation" ON "lead_assignees"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "lead_walkthrough_performers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_walkthrough_performers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lead_walkthrough_performers";
CREATE POLICY "tenant_isolation" ON "lead_walkthrough_performers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "locations";
CREATE POLICY "tenant_isolation" ON "locations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "customers";
CREATE POLICY "tenant_isolation" ON "customers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "leads";
CREATE POLICY "tenant_isolation" ON "leads"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "estimates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimates";
CREATE POLICY "tenant_isolation" ON "estimates"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "jobs";
CREATE POLICY "tenant_isolation" ON "jobs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "invoices";
CREATE POLICY "tenant_isolation" ON "invoices"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "service_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_plans" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_plans";
CREATE POLICY "tenant_isolation" ON "service_plans"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "service_plan_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_plan_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_plan_line_items";
CREATE POLICY "tenant_isolation" ON "service_plan_line_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "plan_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_visits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "plan_visits";
CREATE POLICY "tenant_isolation" ON "plan_visits"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "service_plan_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_plan_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_plan_templates";
CREATE POLICY "tenant_isolation" ON "service_plan_templates"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "service_plan_template_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_plan_template_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_plan_template_line_items";
CREATE POLICY "tenant_isolation" ON "service_plan_template_line_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "refunds";
CREATE POLICY "tenant_isolation" ON "refunds"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "credits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "credits";
CREATE POLICY "tenant_isolation" ON "credits"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "deposit_credit_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deposit_credit_applications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "deposit_credit_applications";
CREATE POLICY "tenant_isolation" ON "deposit_credit_applications"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "attachments";
CREATE POLICY "tenant_isolation" ON "attachments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "notes";
CREATE POLICY "tenant_isolation" ON "notes"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "timeline_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timeline_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "timeline_events";
CREATE POLICY "tenant_isolation" ON "timeline_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tags";
CREATE POLICY "tenant_isolation" ON "tags"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "tag_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tag_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tag_assignments";
CREATE POLICY "tenant_isolation" ON "tag_assignments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "price_book_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_book_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "price_book_categories";
CREATE POLICY "tenant_isolation" ON "price_book_categories"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "price_book_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_book_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "price_book_items";
CREATE POLICY "tenant_isolation" ON "price_book_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "app_settings";
CREATE POLICY "tenant_isolation" ON "app_settings"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "role_permissions";
CREATE POLICY "tenant_isolation" ON "role_permissions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "user_permission_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permission_overrides" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_permission_overrides";
CREATE POLICY "tenant_isolation" ON "user_permission_overrides"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brands" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "brands";
CREATE POLICY "tenant_isolation" ON "brands"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendors";
CREATE POLICY "tenant_isolation" ON "vendors"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "vendor_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_contacts";
CREATE POLICY "tenant_isolation" ON "vendor_contacts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "branches";
CREATE POLICY "tenant_isolation" ON "branches"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "inventory_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "inventory_locations";
CREATE POLICY "tenant_isolation" ON "inventory_locations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "stock_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_balances";
CREATE POLICY "tenant_isolation" ON "stock_balances"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_movements";
CREATE POLICY "tenant_isolation" ON "stock_movements"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "purchase_orders";
CREATE POLICY "tenant_isolation" ON "purchase_orders"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "purchase_order_lines";
CREATE POLICY "tenant_isolation" ON "purchase_order_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "rfqs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rfqs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rfqs";
CREATE POLICY "tenant_isolation" ON "rfqs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "rfq_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rfq_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rfq_lines";
CREATE POLICY "tenant_isolation" ON "rfq_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "rfq_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rfq_quotes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rfq_quotes";
CREATE POLICY "tenant_isolation" ON "rfq_quotes"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "estimate_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_reservations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_reservations";
CREATE POLICY "tenant_isolation" ON "estimate_reservations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "reservation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservation_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "reservation_lines";
CREATE POLICY "tenant_isolation" ON "reservation_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "inventory_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_emails" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "inventory_emails";
CREATE POLICY "tenant_isolation" ON "inventory_emails"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "job_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_stages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_stages";
CREATE POLICY "tenant_isolation" ON "job_stages"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "job_stage_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_stage_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_stage_lines";
CREATE POLICY "tenant_isolation" ON "job_stage_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "job_stage_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_stage_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "job_stage_attachments";
CREATE POLICY "tenant_isolation" ON "job_stage_attachments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "stage_audit_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stage_audit_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stage_audit_entries";
CREATE POLICY "tenant_isolation" ON "stage_audit_entries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "stock_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_approvals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_approvals";
CREATE POLICY "tenant_isolation" ON "stock_approvals"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "stock_approval_modifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_approval_modifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_approval_modifications";
CREATE POLICY "tenant_isolation" ON "stock_approval_modifications"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "item_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "item_groups";
CREATE POLICY "tenant_isolation" ON "item_groups"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "item_group_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_group_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "item_group_lines";
CREATE POLICY "tenant_isolation" ON "item_group_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "call_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "call_sessions";
CREATE POLICY "tenant_isolation" ON "call_sessions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "contacts";
CREATE POLICY "tenant_isolation" ON "contacts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "channel_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_identities" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "channel_identities";
CREATE POLICY "tenant_isolation" ON "channel_identities"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "phone_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "phone_agents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "phone_agents";
CREATE POLICY "tenant_isolation" ON "phone_agents"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "blocked_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blocked_numbers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "blocked_numbers";
CREATE POLICY "tenant_isolation" ON "blocked_numbers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "message_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_threads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "message_threads";
CREATE POLICY "tenant_isolation" ON "message_threads"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "messages";
CREATE POLICY "tenant_isolation" ON "messages"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "text_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "text_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "text_templates";
CREATE POLICY "tenant_isolation" ON "text_templates"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "text_automations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "text_automations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "text_automations";
CREATE POLICY "tenant_isolation" ON "text_automations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "whatsapp_chats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_chats" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "whatsapp_chats";
CREATE POLICY "tenant_isolation" ON "whatsapp_chats"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "whatsapp_messages";
CREATE POLICY "tenant_isolation" ON "whatsapp_messages"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emails" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "emails";
CREATE POLICY "tenant_isolation" ON "emails"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "email_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_groups";
CREATE POLICY "tenant_isolation" ON "email_groups"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "email_forward_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_forward_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "email_forward_rules";
CREATE POLICY "tenant_isolation" ON "email_forward_rules"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "call_flows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_flows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "call_flows";
CREATE POLICY "tenant_isolation" ON "call_flows"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "call_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "call_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "call_groups";
CREATE POLICY "tenant_isolation" ON "call_groups"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "training_scenarios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "training_scenarios" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "training_scenarios";
CREATE POLICY "tenant_isolation" ON "training_scenarios"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "training_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "training_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "training_sessions";
CREATE POLICY "tenant_isolation" ON "training_sessions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "copilot_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_conversations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "copilot_conversations";
CREATE POLICY "tenant_isolation" ON "copilot_conversations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "copilot_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "copilot_messages";
CREATE POLICY "tenant_isolation" ON "copilot_messages"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "copilot_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "copilot_audit_events";
CREATE POLICY "tenant_isolation" ON "copilot_audit_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "time_entries";
CREATE POLICY "tenant_isolation" ON "time_entries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "geofence_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "geofence_configs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "geofence_configs";
CREATE POLICY "tenant_isolation" ON "geofence_configs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "geofence_stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "geofence_stores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "geofence_stores";
CREATE POLICY "tenant_isolation" ON "geofence_stores"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "tasks";
CREATE POLICY "tenant_isolation" ON "tasks"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "timeclock_ot_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "timeclock_ot_reviews" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "timeclock_ot_reviews";
CREATE POLICY "tenant_isolation" ON "timeclock_ot_reviews"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications";
CREATE POLICY "tenant_isolation" ON "notifications"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE "notification_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_recipients" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_recipients";
CREATE POLICY "tenant_isolation" ON "notification_recipients"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Child tables (scoped via their parent's organization_id) ───
ALTER TABLE "mfa_email_challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_email_challenge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mfa_email_challenge";
CREATE POLICY "tenant_isolation" ON "mfa_email_challenge"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "users" par WHERE par."id" = "mfa_email_challenge"."user_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "users" par WHERE par."id" = "mfa_email_challenge"."user_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "customer_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_emails" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_emails";
CREATE POLICY "tenant_isolation" ON "customer_emails"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "customer_emails"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "customer_emails"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "customer_phones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_phones" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_phones";
CREATE POLICY "tenant_isolation" ON "customer_phones"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "customer_phones"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "customer_phones"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "service_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_locations";
CREATE POLICY "tenant_isolation" ON "service_locations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "service_locations"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "customers" par WHERE par."id" = "service_locations"."customer_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "estimate_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_line_items";
CREATE POLICY "tenant_isolation" ON "estimate_line_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_line_items"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_line_items"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "estimate_send_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "estimate_send_configs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "estimate_send_configs";
CREATE POLICY "tenant_isolation" ON "estimate_send_configs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_send_configs"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "estimates" par WHERE par."id" = "estimate_send_configs"."estimate_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "invoice_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "invoice_line_items";
CREATE POLICY "tenant_isolation" ON "invoice_line_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "invoices" par WHERE par."id" = "invoice_line_items"."invoice_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "invoices" par WHERE par."id" = "invoice_line_items"."invoice_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payments";
CREATE POLICY "tenant_isolation" ON "payments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "invoices" par WHERE par."id" = "payments"."invoice_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "invoices" par WHERE par."id" = "payments"."invoice_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "lead_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lead_tags";
CREATE POLICY "tenant_isolation" ON "lead_tags"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "leads" par WHERE par."id" = "lead_tags"."lead_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "leads" par WHERE par."id" = "lead_tags"."lead_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "user_table_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_table_preferences" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_table_preferences";
CREATE POLICY "tenant_isolation" ON "user_table_preferences"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "users" par WHERE par."id" = "user_table_preferences"."user_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "users" par WHERE par."id" = "user_table_preferences"."user_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
ALTER TABLE "task_subtasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_subtasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "task_subtasks";
CREATE POLICY "tenant_isolation" ON "task_subtasks"
  USING (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "tasks" par WHERE par."id" = "task_subtasks"."task_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR EXISTS (SELECT 1 FROM "tasks" par WHERE par."id" = "task_subtasks"."task_id" AND par."organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid));

-- ─── Organization root (scoped by its own id) ───
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "organizations";
CREATE POLICY "tenant_isolation" ON "organizations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Audit log (column is org_id; adds an app-role policy alongside the
--     existing authenticated-role SELECT policy) ───
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "audit_logs";
CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

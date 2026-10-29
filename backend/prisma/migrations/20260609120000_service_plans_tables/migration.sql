-- Service Plans: 5 new tables. Idempotent + additive (shared staging DB).
DO $$ BEGIN
  CREATE TYPE "ServicePlanStatus" AS ENUM ('DRAFT','ACTIVE','EXPIRED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "VisitCadence" AS ENUM ('WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  CREATE TYPE "PlanVisitStatus" AS ENUM ('SCHEDULED','COMPLETED','SKIPPED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "service_plan_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "job_type" TEXT,
  "default_visit_cadence" "VisitCadence" NOT NULL,
  "term_months" INTEGER NOT NULL,
  "default_visit_count" INTEGER,
  "default_price" DECIMAL(12,2) NOT NULL,
  "accent_color" TEXT,
  "auto_renew" BOOLEAN NOT NULL DEFAULT false,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_plan_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "service_plan_templates_organization_id_idx" ON "service_plan_templates"("organization_id");
CREATE INDEX IF NOT EXISTS "service_plan_templates_archived_idx" ON "service_plan_templates"("archived");

CREATE TABLE IF NOT EXISTS "service_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "service_plan_number" TEXT NOT NULL,
  "customer_id" UUID NOT NULL,
  "service_location_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ServicePlanStatus" NOT NULL DEFAULT 'DRAFT',
  "visit_cadence" "VisitCadence" NOT NULL,
  "start_date" TIMESTAMP(3) NOT NULL,
  "end_date" TIMESTAMP(3) NOT NULL,
  "contract_price" DECIMAL(12,2) NOT NULL,
  "sold_by" UUID,
  "renewals_count" INTEGER NOT NULL DEFAULT 0,
  "template_id" UUID,
  "organization_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_plans_organization_id_service_plan_number_key" ON "service_plans"("organization_id","service_plan_number");
CREATE INDEX IF NOT EXISTS "service_plans_customer_id_idx" ON "service_plans"("customer_id");
CREATE INDEX IF NOT EXISTS "service_plans_status_idx" ON "service_plans"("status");
CREATE INDEX IF NOT EXISTS "service_plans_organization_id_idx" ON "service_plans"("organization_id");
CREATE INDEX IF NOT EXISTS "service_plans_service_location_id_idx" ON "service_plans"("service_location_id");

CREATE TABLE IF NOT EXISTS "service_plan_line_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "service_plan_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "position" INTEGER NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "service_plan_line_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "service_plan_line_items_service_plan_id_idx" ON "service_plan_line_items"("service_plan_id");
CREATE INDEX IF NOT EXISTS "service_plan_line_items_organization_id_idx" ON "service_plan_line_items"("organization_id");

CREATE TABLE IF NOT EXISTS "plan_visits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "service_plan_id" UUID NOT NULL,
  "job_id" UUID,
  "visit_number" INTEGER NOT NULL,
  "scheduled_date" TIMESTAMP(3) NOT NULL,
  "status" "PlanVisitStatus" NOT NULL DEFAULT 'SCHEDULED',
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plan_visits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "plan_visits_service_plan_id_idx" ON "plan_visits"("service_plan_id");
CREATE INDEX IF NOT EXISTS "plan_visits_job_id_idx" ON "plan_visits"("job_id");
CREATE INDEX IF NOT EXISTS "plan_visits_organization_id_idx" ON "plan_visits"("organization_id");

CREATE TABLE IF NOT EXISTS "service_plan_template_line_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "template_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "position" INTEGER NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "service_plan_template_line_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "service_plan_template_line_items_template_id_idx" ON "service_plan_template_line_items"("template_id");
CREATE INDEX IF NOT EXISTS "service_plan_template_line_items_organization_id_idx" ON "service_plan_template_line_items"("organization_id");

-- FKs (guarded so re-runs don't error).
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_service_location_id_fkey" FOREIGN KEY ("service_location_id") REFERENCES "service_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_sold_by_fkey" FOREIGN KEY ("sold_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "service_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plan_line_items" ADD CONSTRAINT "service_plan_line_items_service_plan_id_fkey" FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plan_line_items" ADD CONSTRAINT "service_plan_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_visits" ADD CONSTRAINT "plan_visits_service_plan_id_fkey" FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_visits" ADD CONSTRAINT "plan_visits_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "plan_visits" ADD CONSTRAINT "plan_visits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plan_templates" ADD CONSTRAINT "service_plan_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plan_template_line_items" ADD CONSTRAINT "service_plan_template_line_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "service_plan_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "service_plan_template_line_items" ADD CONSTRAINT "service_plan_template_line_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

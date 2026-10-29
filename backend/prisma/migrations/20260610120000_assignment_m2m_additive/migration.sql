-- PR A — assignment M2M spine (additive only). Idempotent + nullable-safe.
-- Shared staging DB auto-runs `prisma migrate deploy`; backfill + FK drop are a SEPARATE
-- later migration (…_assignment_drop_fks) so they apply only after all code reads the joins.

CREATE TABLE IF NOT EXISTS "job_assignees" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "job_assignees_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "lead_assignees" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "lead_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_assignees_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "lead_walkthrough_performers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "lead_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_walkthrough_performers_pkey" PRIMARY KEY ("id")
);

-- Unique + secondary indexes (IF NOT EXISTS — re-runnable)
CREATE UNIQUE INDEX IF NOT EXISTS "job_assignees_job_id_user_id_key" ON "job_assignees" ("job_id","user_id");
CREATE INDEX IF NOT EXISTS "job_assignees_user_id_idx" ON "job_assignees" ("user_id");
CREATE INDEX IF NOT EXISTS "job_assignees_organization_id_idx" ON "job_assignees" ("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_assignees_lead_id_user_id_key" ON "lead_assignees" ("lead_id","user_id");
CREATE INDEX IF NOT EXISTS "lead_assignees_user_id_idx" ON "lead_assignees" ("user_id");
CREATE INDEX IF NOT EXISTS "lead_assignees_organization_id_idx" ON "lead_assignees" ("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_walkthrough_performers_lead_id_user_id_key" ON "lead_walkthrough_performers" ("lead_id","user_id");
CREATE INDEX IF NOT EXISTS "lead_walkthrough_performers_user_id_idx" ON "lead_walkthrough_performers" ("user_id");
CREATE INDEX IF NOT EXISTS "lead_walkthrough_performers_organization_id_idx" ON "lead_walkthrough_performers" ("organization_id");

-- FKs (guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS; use a DO block)
DO $$ BEGIN
  ALTER TABLE "job_assignees" ADD CONSTRAINT "job_assignees_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "job_assignees" ADD CONSTRAINT "job_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "job_assignees" ADD CONSTRAINT "job_assignees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_assignees" ADD CONSTRAINT "lead_assignees_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_assignees" ADD CONSTRAINT "lead_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_assignees" ADD CONSTRAINT "lead_assignees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_walkthrough_performers" ADD CONSTRAINT "lead_walkthrough_performers_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_walkthrough_performers" ADD CONSTRAINT "lead_walkthrough_performers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lead_walkthrough_performers" ADD CONSTRAINT "lead_walkthrough_performers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lead.commission_owner_id + walkthrough customer-email flag
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "commission_owner_id" UUID;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "walkthrough_customer_email_sent_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "leads_commission_owner_id_idx" ON "leads" ("commission_owner_id");
DO $$ BEGIN
  ALTER TABLE "leads" ADD CONSTRAINT "leads_commission_owner_id_fkey" FOREIGN KEY ("commission_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Job customer-email flag
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "customer_scheduled_email_sent_at" TIMESTAMP(3);

-- Organization scheduling defaults (mirror the timezone idempotent-additive template)
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "default_job_duration_min" INTEGER;
ALTER TABLE "organizations" ALTER COLUMN "default_job_duration_min" SET DEFAULT 120;
UPDATE "organizations" SET "default_job_duration_min" = 120 WHERE "default_job_duration_min" IS NULL;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "default_walkthrough_duration_min" INTEGER;
ALTER TABLE "organizations" ALTER COLUMN "default_walkthrough_duration_min" SET DEFAULT 60;
UPDATE "organizations" SET "default_walkthrough_duration_min" = 60 WHERE "default_walkthrough_duration_min" IS NULL;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "default_schedule_start_time" VARCHAR(5);
ALTER TABLE "organizations" ALTER COLUMN "default_schedule_start_time" SET DEFAULT '08:00';
UPDATE "organizations" SET "default_schedule_start_time" = '08:00' WHERE "default_schedule_start_time" IS NULL;

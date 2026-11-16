-- Bee Task Notification Logs with row-level security
-- Migration: add_bee_task_notification_logs

CREATE TABLE IF NOT EXISTS "bee_task_notification_logs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "task_id" UUID REFERENCES "tasks"("id") ON DELETE SET NULL,
  "task_number" TEXT NOT NULL,
  "call_log_id" UUID REFERENCES "bee_call_logs"("id") ON DELETE SET NULL,
  "customer_id" UUID REFERENCES "customers"("id") ON DELETE SET NULL,
  "customer_name" TEXT NOT NULL,
  "customer_phone" TEXT,
  "job_id" UUID REFERENCES "jobs"("id") ON DELETE SET NULL,
  "job_number" TEXT,
  "outcome" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'HIGH',
  "summary" TEXT,
  "channels" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "recipients" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "email_subject" TEXT,
  "email_body" TEXT,
  "sms_message" TEXT,
  "in_app_message" TEXT,
  "status" TEXT NOT NULL DEFAULT 'SENT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "bee_task_notification_logs_organization_id_created_at_idx"
  ON "bee_task_notification_logs"("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "bee_task_notification_logs_task_id_idx"
  ON "bee_task_notification_logs"("task_id");

CREATE INDEX IF NOT EXISTS "bee_task_notification_logs_call_log_id_idx"
  ON "bee_task_notification_logs"("call_log_id");

ALTER TABLE "bee_task_notification_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bee_task_notification_logs" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bee_task_notification_logs' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY "tenant_isolation" ON "bee_task_notification_logs"
      USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
  END IF;
END $$;


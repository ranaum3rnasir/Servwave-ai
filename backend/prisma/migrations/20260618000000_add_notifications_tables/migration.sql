-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB. NEVER run `prisma migrate` from a worktree (it mutates
-- staging silently). Apply out-of-band via the Supabase SQL editor / MCP:
-- STAGING first, then PROD. Safe to re-run.

DO $$ BEGIN
  CREATE TYPE "NotificationCategory" AS ENUM
    ('LEAD','ESTIMATE','DISPATCH','JOB','BILLING','TASK','TEAM','INVENTORY','SECURITY','SERVICE_PLAN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationPriority" AS ENUM ('INTERRUPT','FEED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "actor_id"        UUID,
  "verb"            TEXT NOT NULL,
  "category"        "NotificationCategory" NOT NULL,
  "priority"        "NotificationPriority" NOT NULL,
  "needs_action"    BOOLEAN NOT NULL DEFAULT false,
  "object_type"     TEXT NOT NULL,
  "object_id"       TEXT NOT NULL,
  "object_label"    TEXT,
  "title"           TEXT NOT NULL,
  "body"            TEXT,
  "data"            JSONB NOT NULL DEFAULT '{}',
  "action_type"     TEXT,
  "dedup_key"       TEXT,
  "group_key"       TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_recipients" (
  "id"              UUID NOT NULL,
  "notification_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "recipient_id"    UUID NOT NULL,
  "priority"        "NotificationPriority" NOT NULL,
  "needs_action"    BOOLEAN NOT NULL DEFAULT false,
  "seen_at"         TIMESTAMP(3),
  "read_at"         TIMESTAMP(3),
  "acted_at"        TIMESTAMP(3),
  "dismissed_at"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_recipients" ADD COLUMN IF NOT EXISTS "needs_action" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_organization_id_dedup_key_key"
  ON "notifications"("organization_id","dedup_key");
CREATE INDEX IF NOT EXISTS "notifications_organization_id_created_at_idx"
  ON "notifications"("organization_id","created_at");
CREATE INDEX IF NOT EXISTS "notification_recipients_recipient_id_read_at_created_at_idx"
  ON "notification_recipients"("recipient_id","read_at","created_at");
CREATE INDEX IF NOT EXISTS "notification_recipients_recipient_id_seen_at_idx"
  ON "notification_recipients"("recipient_id","seen_at");
CREATE INDEX IF NOT EXISTS "notification_recipients_notification_id_idx"
  ON "notification_recipients"("notification_id");

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

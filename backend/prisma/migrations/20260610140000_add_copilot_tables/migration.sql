-- Copilot (Servy) — conversations, messages, content-free audit events.
--
-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB, so every statement must converge from either starting
-- state without P3009 drift. Apply out-of-band via Supabase MCP if needed.
-- NEVER run `prisma migrate` from a worktree (it mutates staging silently).

-- ─── Enums ───
DO $$ BEGIN
  CREATE TYPE "CopilotRole" AS ENUM ('USER', 'ASSISTANT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CopilotModality" AS ENUM ('TEXT', 'VOICE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CopilotMsgStatus" AS ENUM ('FINAL', 'STOPPED', 'FALLBACK');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── Tables ───
CREATE TABLE IF NOT EXISTS "copilot_conversations" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "title"           TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "copilot_messages" (
  "id"              UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "role"            "CopilotRole" NOT NULL,
  "modality"        "CopilotModality" NOT NULL,
  "content"         TEXT NOT NULL,
  "status"          "CopilotMsgStatus" NOT NULL DEFAULT 'FINAL',
  "label_key"       TEXT,
  "capability_id"   TEXT,
  "execution_mode"  TEXT,
  "meta"            JSONB,
  "feedback"        TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "copilot_audit_events" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "ts"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "event_type"      TEXT NOT NULL,
  "capability_id"   TEXT,
  "execution_mode"  TEXT,
  "allowed"         BOOLEAN NOT NULL,
  "reason"          TEXT,
  CONSTRAINT "copilot_audit_events_pkey" PRIMARY KEY ("id")
);

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS "copilot_conversations_organization_id_user_id_idx"
  ON "copilot_conversations"("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "copilot_messages_conversation_id_idx"
  ON "copilot_messages"("conversation_id");
CREATE INDEX IF NOT EXISTS "copilot_messages_organization_id_user_id_idx"
  ON "copilot_messages"("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "copilot_audit_events_organization_id_user_id_idx"
  ON "copilot_audit_events"("organization_id", "user_id");

-- ─── FK: messages → conversations (cascade on hard-delete) ───
DO $$ BEGIN
  ALTER TABLE "copilot_messages"
    ADD CONSTRAINT "copilot_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

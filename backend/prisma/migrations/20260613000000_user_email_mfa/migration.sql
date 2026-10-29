-- Email-OTP 2FA: per-user enrollment flag + short-lived challenge rows.
--
-- Idempotent by design. The ServWave test-env backend SHARES the staging
-- Supabase DB with prod/main, so a `prisma migrate deploy` from any branch may
-- replay this against a DB where these objects already exist (or partially
-- exist). Every statement is guarded so re-runs are no-ops:
--   * enums   -> CREATE TYPE inside a DO/EXCEPTION block (Postgres has no
--                CREATE TYPE IF NOT EXISTS)
--   * columns -> ADD COLUMN IF NOT EXISTS (NOT NULL with a DEFAULT so existing
--                rows + concurrent inserts on the shared DB keep working)
--   * tables  -> CREATE TABLE IF NOT EXISTS
--   * indexes -> CREATE INDEX IF NOT EXISTS
--   * FKs     -> added inside DO/EXCEPTION blocks (no ADD CONSTRAINT IF NOT EXISTS)
-- The "users" PK is UUID, so the challenge FK column matches that type.
-- Authored by hand (DB-free) — never run `prisma migrate` from a worktree.

-- AlterTable: users — email-2FA enrollment flag (NOT NULL + DEFAULT so shared-DB inserts keep working)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_email_enrolled" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum: MfaChallengePurpose
DO $$ BEGIN
  CREATE TYPE "MfaChallengePurpose" AS ENUM ('LOGIN', 'ENROLL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable: mfa_email_challenge (short-lived email-OTP challenges)
CREATE TABLE IF NOT EXISTS "mfa_email_challenge" (
    "id"                UUID NOT NULL,
    "user_id"           UUID NOT NULL,
    "code_hmac"         TEXT NOT NULL,
    "enc_refresh_token" TEXT,
    "purpose"           "MfaChallengePurpose" NOT NULL DEFAULT 'LOGIN',
    "attempts"          INTEGER NOT NULL DEFAULT 0,
    "expires_at"        TIMESTAMP(3) NOT NULL,
    "consumed_at"       TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_email_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mfa_email_challenge_user_id_idx" ON "mfa_email_challenge"("user_id");
CREATE INDEX IF NOT EXISTS "mfa_email_challenge_expires_at_idx" ON "mfa_email_challenge"("expires_at");

-- Foreign key (Postgres has no ADD CONSTRAINT IF NOT EXISTS — guard in a DO block)
DO $$ BEGIN
  ALTER TABLE "mfa_email_challenge" ADD CONSTRAINT "mfa_email_challenge_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Timeclock module: GPS-gated punch clock with geofencing + per-week OT review.
--
-- Idempotent by design. The ServWave test-env backend SHARES the staging
-- Supabase DB with prod/main, so a `prisma migrate deploy` from any branch may
-- replay this against a DB where these objects already exist (or partially
-- exist). Every statement is guarded so re-runs are no-ops:
--   * enums   -> CREATE TYPE inside a DO/EXCEPTION block (Postgres has no
--                CREATE TYPE IF NOT EXISTS)
--   * tables  -> CREATE TABLE IF NOT EXISTS
--   * columns -> ADD COLUMN IF NOT EXISTS (the two new users columns are
--                NOT NULL with a DEFAULT, so existing rows + concurrent inserts
--                on the shared DB keep working)
--   * indexes -> CREATE INDEX / CREATE UNIQUE INDEX IF NOT EXISTS
--   * FKs     -> added inside DO/EXCEPTION blocks (no ADD CONSTRAINT IF NOT EXISTS)
-- Authored by hand (DB-free) — never run `prisma migrate` from a worktree.

-- CreateEnum: PunchType
DO $$ BEGIN
  CREATE TYPE "PunchType" AS ENUM ('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum: PunchZoneKind
DO $$ BEGIN
  CREATE TYPE "PunchZoneKind" AS ENUM ('STORE', 'JOB');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum: PunchStatus
DO $$ BEGIN
  CREATE TYPE "PunchStatus" AS ENUM ('IN_ZONE', 'OVERRIDE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum: PunchReview
DO $$ BEGIN
  CREATE TYPE "PunchReview" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum: OtReviewState
DO $$ BEGIN
  CREATE TYPE "OtReviewState" AS ENUM ('APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AlterTable: users — timeclock policy flags (NOT NULL + DEFAULT so shared-DB inserts keep working)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "enforce_clock_in_location"   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "can_approve_clock_overrides" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: time_entries (append-only punch log)
CREATE TABLE IF NOT EXISTS "time_entries" (
    "id"                 UUID NOT NULL,
    "organization_id"    UUID NOT NULL,
    "user_id"            UUID NOT NULL,
    "type"               "PunchType" NOT NULL,
    "ts"                 TIMESTAMPTZ NOT NULL,
    "lat"                DOUBLE PRECISION NOT NULL,
    "lng"                DOUBLE PRECISION NOT NULL,
    "accuracy_m"         DOUBLE PRECISION,
    "matched_zone_id"    TEXT,
    "matched_zone_label" TEXT,
    "matched_zone_kind"  "PunchZoneKind",
    "matched_job_number" TEXT,
    "distance_m"         DOUBLE PRECISION,
    "status"             "PunchStatus" NOT NULL,
    "review"             "PunchReview" NOT NULL DEFAULT 'NONE',
    "reviewed_by"        UUID,
    "reviewed_at"        TIMESTAMPTZ,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable: geofence_configs (per-org singleton)
CREATE TABLE IF NOT EXISTS "geofence_configs" (
    "id"              UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "radius_m"        INTEGER NOT NULL DEFAULT 150,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geofence_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: geofence_stores (multi-store zones)
CREATE TABLE IF NOT EXISTS "geofence_stores" (
    "id"              UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "label"           TEXT NOT NULL,
    "lat"             DOUBLE PRECISION NOT NULL,
    "lng"             DOUBLE PRECISION NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geofence_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable: timeclock_ot_reviews (per-week OT approval)
CREATE TABLE IF NOT EXISTS "timeclock_ot_reviews" (
    "id"              UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id"         UUID NOT NULL,
    "period_key"      TEXT NOT NULL,
    "state"           "OtReviewState" NOT NULL,
    "reviewed_by"     UUID NOT NULL,
    "reviewed_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeclock_ot_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "time_entries_organization_id_user_id_ts_idx" ON "time_entries"("organization_id", "user_id", "ts");
CREATE INDEX IF NOT EXISTS "time_entries_organization_id_review_idx" ON "time_entries"("organization_id", "review");
CREATE UNIQUE INDEX IF NOT EXISTS "geofence_configs_organization_id_key" ON "geofence_configs"("organization_id");
CREATE INDEX IF NOT EXISTS "geofence_stores_organization_id_idx" ON "geofence_stores"("organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "timeclock_ot_reviews_organization_id_user_id_period_key_key" ON "timeclock_ot_reviews"("organization_id", "user_id", "period_key");
CREATE INDEX IF NOT EXISTS "timeclock_ot_reviews_organization_id_idx" ON "timeclock_ot_reviews"("organization_id");

-- Foreign keys (Postgres has no ADD CONSTRAINT IF NOT EXISTS — guard each in a DO block)
DO $$ BEGIN
  ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "geofence_configs" ADD CONSTRAINT "geofence_configs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "geofence_stores" ADD CONSTRAINT "geofence_stores_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "timeclock_ot_reviews" ADD CONSTRAINT "timeclock_ot_reviews_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "timeclock_ot_reviews" ADD CONSTRAINT "timeclock_ot_reviews_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S0, decision D24:
-- JobStatus.UNASSIGNED -> UNSCHEDULED.
--
-- Rationale: under multi-visit, crew lives on the visit, so a job with no visits has no crew and
-- "unassigned" describes nothing. The frontend has displayed this value as "Unscheduled" for a
-- while already (design-system/status-registry.ts, layout/search-shared.tsx) - this makes the
-- stored value match the word the product has been using.
--
-- Portable: no Supabase-only roles or auth.* references, so vanilla postgres:16 in CI runs it
-- unchanged. Idempotent: guarded on the label actually being present, so a second application on
-- the shared staging DB is a no-op rather than an error.

-- 1. The enum label itself. RENAME VALUE rewrites the pg_enum row in place, so every existing
--    jobs.status value follows automatically - no row rewrite, no downtime, no backfill.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'JobStatus'
      AND e.enumlabel = 'UNASSIGNED'
  ) THEN
    ALTER TYPE "JobStatus" RENAME VALUE 'UNASSIGNED' TO 'UNSCHEDULED';
  END IF;
END $$;

-- 2. The column default. Postgres stores an enum default as a Const carrying the pg_enum row's
--    OID, so step 1 already updated it transparently - but re-stating it makes the migration
--    self-evident and keeps `prisma migrate diff` from reporting drift against the schema file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'status') THEN
    ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'UNSCHEDULED'::"JobStatus";
  END IF;
END $$;

-- 3. Saved job-table filters. user_table_preferences.config is free-form JSON holding, among
--    other things, a saved multi-select of JobStatus literals. Those are stored as plain strings,
--    NOT as the enum type, so step 1 does not reach them: a user with a saved "Unassigned" filter
--    would silently get an empty jobs list after this ships.
--
--    Scoped to the jobs table_key and matched on the exact quoted token, so a free-text column
--    value containing the word elsewhere (or the unrelated lead-owner 'UNASSIGNED' sentinel, which
--    lives under the leads table_key) is not touched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_table_preferences') THEN
    UPDATE "user_table_preferences"
    SET "config" = REPLACE("config"::text, '"UNASSIGNED"', '"UNSCHEDULED"')::jsonb
    WHERE "table_key" = 'jobs'
      AND "config"::text LIKE '%"UNASSIGNED"%';
  END IF;
END $$;

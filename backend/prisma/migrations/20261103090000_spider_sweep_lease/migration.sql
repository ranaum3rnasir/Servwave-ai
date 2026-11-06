-- The Spider sweep's lease (#2993).
--
-- The sweep kept one run at a time across servers with a transaction-scoped advisory lock, held in a transaction open
-- for the whole run (up to 55 minutes) on a client it opened for each run. It now claims a row here instead: a run
-- inserts the row, or takes over a row whose expires_at has passed, renews expires_at while it works, and deletes its
-- row at the end. Each of those is one statement, so no transaction is held for the run; a killed run's row expires on
-- its own. One row per sweep name ('spider.sweep').
--
-- Global by design, like stripe_events and ctm_events: no company data and no organization_id, so no tenant policy.
-- Row-level security stays OFF on purpose: switched on with no policy, it would deny the app's runtime role (app_rls,
-- NOBYPASSRLS) every row and stop every sweep. That role reaches the table through the schema's default privileges, as
-- it does every table. The hosted database's outside roles are given nothing (guarded: CI's plain Postgres may lack them).
--
-- Additive: a new table only. A backend from before this never reads it.
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS, and the Supabase roles behind pg_roles
-- guards. Never run `prisma migrate` from a worktree.

CREATE TABLE IF NOT EXISTS "spider_sweep_leases" (
    "name"       TEXT NOT NULL,
    "holder"     TEXT NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "spider_sweep_leases_pkey" PRIMARY KEY ("name")
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_sweep_leases FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.spider_sweep_leases FROM authenticated';
  END IF;
END $$;

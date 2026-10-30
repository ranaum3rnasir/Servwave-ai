-- The hosted database's two outside roles, for a test database (Roles & Permissions security, ticket 37, spec story 66).
--
-- On the hosted database the public data door serves callers from outside as `anon` (nobody signed in) and `authenticated`.
-- The migrations take every table away from them, but only where the roles exist (a plain Postgres has neither), so without
-- them a test database can never show a table opened to them, and the checks for that (permission-outside-roles-db.test.ts,
-- rls-coverage.test.ts) could not fail. CI runs this after it makes its database and before the migrations, so they meet the
-- roles as they would on the hosted database, and drops the roles again when the job ends.
--
-- With `authenticated` present, the oldest guarded migration (20260623120000_add_audit_logs) writes a policy naming the
-- hosted database's auth.uid(), so this database also gets the stub auth helpers the migration tests already give theirs
-- (attachment-source-migration-db.test.ts and its siblings): each answers NULL. Only what is missing is made.
--
-- The roles cannot sign in and are given nothing. Roles belong to the whole cluster, so their part is idempotent and safe to
-- run concurrently: a role already there, or made by a parallel run a moment ago, is left as it is. One statement, so it runs
-- through psql -f and through a client's single-statement call alike. Never run against a hosted database: it has them.
DO $outside_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    BEGIN
      CREATE ROLE anon NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    BEGIN
      CREATE ROLE authenticated NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;

  CREATE SCHEMA IF NOT EXISTS auth;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
  END IF;
  IF to_regprocedure('auth.role()') IS NULL THEN
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
  END IF;
  IF to_regprocedure('auth.jwt()') IS NULL THEN
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
  END IF;
END
$outside_roles$;

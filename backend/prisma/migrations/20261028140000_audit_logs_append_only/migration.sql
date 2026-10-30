-- Roles & Permissions, ticket 25 (finding M6, decision D2), migration M14: the audit table is addition-only, and so is the
-- switch history, permission_change_log (re-audit N13, corrected before it reached staging; same file, same name).
--
-- What it does. One statement-level trigger on audit_logs, audit_logs_append_only, refuses every UPDATE, DELETE and TRUNCATE
-- with "audit_logs is append-only: <statement> is refused". INSERT is untouched, so every writer keeps working.
--   - Statement-level, so a statement is refused whether or not it would have matched a row: there is no "it changed nothing"
--     way through, and the cost is one function call per refused statement, none per row and none on INSERT.
--   - It fires for every role: the app's runtime role (app_rls), the table owner and a superuser alike. A trigger is not a
--     grant, so a later GRANT ... ON ALL TABLES does not undo it.
--   - ENABLE ALWAYS: it also fires when a session sets session_replication_role = replica, the usual way to skip triggers.
--   - What can still remove it: a role that may ALTER the table (its owner, or a superuser) dropping or disabling the trigger.
--     That is a schema change, visible in the catalog and in the migration history. The app's runtime role cannot do it.
--
-- No exception. Nothing in the app removes or edits an audit row:
--   - Erase personal data (P19) keeps the audit rows (Ran, 2026-10-26) and never touches the table.
--   - The company purge (lib/purge.ts) keeps them by rule: audit_logs is in PURGE_EXEMPT ("RETAINED BY RULE"). audit_logs has
--     no foreign key either way, so deleting a person or a company cascades nothing into it.
--   - The e2e cleanup route (/api/test/cleanup) and the e2e company never touch the table.
--   So no purge-only switch is needed, and none is offered: a session setting the purge could set is one any request could set.
--
-- The switch history, permission_change_log (who gave which switch to whom, and when), gets the same rule with ONE difference:
--   - UPDATE and TRUNCATE are refused for every statement, as on audit_logs (statement-level trigger
--     permission_change_log_append_only, function permission_change_log_refuse_change()).
--   - DELETE is refused row by row unless the row's company is gone (row-level trigger permission_change_log_delete_with_company,
--     function permission_change_log_refuse_delete()). Its rows hang off organizations with ON DELETE CASCADE, so removing a
--     company (lib/purge.ts, the e2e teardown) must still take its history with it; nothing else may. By the time the cascade
--     deletes the rows, the company row is gone, so the check passes for the cascade and for nothing else. The two tables'
--     row rules (RLS) are the same company test, so a session that can see a history row can also see its company.
--   - Nothing in the app edits or deletes these rows: the switch store only inserts (lib/permissions/switches/store.ts), and
--     the later migrations that write it (M13, M17) only insert.
--   - Both triggers are ENABLE ALWAYS, for the same reason as above.
--
-- IDEMPOTENT and portable plain PostgreSQL (no auth schema, no Supabase role). The functions are CREATE OR REPLACE; each trigger
-- is created only when missing and switched to ALWAYS only when it is not, so a re-run takes no lock on either table. The locks
-- taken on the first run (SHARE ROW EXCLUSIVE on audit_logs and on permission_change_log, for milliseconds) wait at most 5
-- seconds, then the migration fails and changes nothing, rather than queueing every audit or switch write behind it. One DO block, so it runs as one statement anywhere.
-- NEVER run `prisma migrate` from a worktree.

DO $m14$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  -- When a rule is missing or not ALWAYS, both tables are locked up front, before any trigger is made, in the order the switch
  -- store writes them (the history, then the audit row): a request doing that waits behind the migration, at most lock_timeout.
  -- A writer in the other order could still meet the migration in Postgres's deadlock check, which ends one side within about
  -- a second. When every rule is already in place (a re-run), nothing is locked.
  IF (SELECT count(*) FROM pg_trigger
       WHERE NOT tgisinternal AND tgenabled = 'A'
         AND ((tgrelid = 'audit_logs'::regclass AND tgname = 'audit_logs_append_only')
           OR (tgrelid = 'permission_change_log'::regclass
               AND tgname IN ('permission_change_log_append_only', 'permission_change_log_delete_with_company')))) < 3 THEN
    LOCK TABLE permission_change_log, audit_logs IN SHARE ROW EXCLUSIVE MODE;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION audit_logs_refuse_change() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only: % is refused', TG_OP
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Audit rows are never edited or deleted (Roles & Permissions M14).';
    END
    $body$
  $fn$;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND tgname = 'audit_logs_append_only'
  ) THEN
    CREATE TRIGGER audit_logs_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_refuse_change();
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND tgname = 'audit_logs_append_only' AND tgenabled <> 'A'
  ) THEN
    ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER audit_logs_append_only;
  END IF;

  -- ─── The switch history (re-audit N13) ───
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION permission_change_log_refuse_change() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'permission_change_log is append-only: % is refused', TG_OP
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Switch history rows are never edited or deleted (Roles & Permissions M14).';
    END
    $body$
  $fn$;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION permission_change_log_refuse_delete() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    DECLARE
      company_still_there boolean;
    BEGIN
      -- A row goes only with its company: once the company row is gone (the ON DELETE CASCADE from organizations), it may.
      -- The companies table is named in the schema of the history table itself (TG_TABLE_SCHEMA), never through the session's
      -- search_path: a session's own temporary table called "organizations" would otherwise answer for it.
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.organizations WHERE id = $1)', TG_TABLE_SCHEMA)
        INTO company_still_there USING OLD.organization_id;
      IF company_still_there THEN
        RAISE EXCEPTION 'permission_change_log is append-only: DELETE is refused'
          USING ERRCODE = 'insufficient_privilege',
                HINT = 'Switch history rows go only when their company is removed (Roles & Permissions M14).';
      END IF;
      RETURN OLD;
    END
    $body$
  $fn$;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'permission_change_log'::regclass AND tgname = 'permission_change_log_append_only'
  ) THEN
    CREATE TRIGGER permission_change_log_append_only
      BEFORE UPDATE OR TRUNCATE ON permission_change_log
      FOR EACH STATEMENT EXECUTE FUNCTION permission_change_log_refuse_change();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'permission_change_log'::regclass AND tgname = 'permission_change_log_delete_with_company'
  ) THEN
    CREATE TRIGGER permission_change_log_delete_with_company
      BEFORE DELETE ON permission_change_log
      FOR EACH ROW EXECUTE FUNCTION permission_change_log_refuse_delete();
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'permission_change_log'::regclass AND tgname = 'permission_change_log_append_only' AND tgenabled <> 'A'
  ) THEN
    ALTER TABLE permission_change_log ENABLE ALWAYS TRIGGER permission_change_log_append_only;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'permission_change_log'::regclass AND tgname = 'permission_change_log_delete_with_company' AND tgenabled <> 'A'
  ) THEN
    ALTER TABLE permission_change_log ENABLE ALWAYS TRIGGER permission_change_log_delete_with_company;
  END IF;
END
$m14$;

-- Spider's watch list, kept by the database in the same save as the lead (#3468; Ran approved 12 Nov).
--
-- Spider had no list of "which lead is in which stage since when": every sweep re-read every open lead of every Spider
-- company and worked it out in memory (services/spider/config.ts spiderStageOf). Now the database keeps it:
--
--   spider_lead_watch: one row per lead.
--     lead_id          the lead (primary key; the row goes with its lead: ON DELETE CASCADE, in the same statement).
--     organization_id  the lead's company (the tenant policy reads it).
--     stage            NEW | CONTACTED | WALKTHROUGH_COMPLETED, or NULL when the lead is in no Spider stage (Won, Lost,
--                      cancelled, past Estimate, Walkthrough Scheduled). Plain text with a CHECK, not a Prisma enum.
--     entered_at       the instant the lead entered that stage (NULL with no stage). TIMESTAMP(3) without time zone, the
--                      type of the lead clocks it is copied from, so no session time zone ever takes part.
--     pending          no alert or summary claim yet for this stay in the current switched-on period. Set true here on
--                      every new stay; cleared only by the claim (#3469), in the claim's own statement.
--     changed_at       when stage or entered_at last changed (UTC, as every TIMESTAMP(3) column holds it).
--   The due time is NOT stored: the check computes entered_at + limit in its query, so a limit change writes 0 rows.
--
--   spider_lead_watch_due_idx (organization_id, stage, entered_at) WHERE pending AND stage IS NOT NULL: the due check.
--   spider_lead_watch_organization_id_changed_at_idx (organization_id, changed_at): the ending check.
--
--   spider_stage_of(the 10 lead columns of SPIDER_LEAD_TIMES_SELECT) -> (stage, entered_at): spiderStageOf's rules in SQL,
--     IMMUTABLE, reading only its arguments. spider-lead-watch-parity-db.test.ts holds the two to the same answer on every
--     combination of the 10 columns.
--
--   spider_lead_watch_sync(): the trigger function. Its body is ONE statement, an upsert: the lead's stage and entry
--     instant from spider_stage_of; a new stage or a new entry instant sets pending = true and changed_at = now; anything
--     else leaves the row exactly as it is (no write at all). No EXCEPTION block (no subtransaction per row), no lookup of
--     any other table ("is Spider on?" is not asked: the list is kept for every company), not SECURITY DEFINER: it writes
--     as the user saving the lead, so the table's tenant policy applies to it like any other write.
--
--   The triggers on leads, AFTER and FOR EACH ROW, both calling that function:
--     spider_lead_watch_on_insert  AFTER INSERT: every new lead gets its row.
--     spider_lead_watch_on_update  AFTER UPDATE, WHEN one of the 10 columns IS DISTINCT FROM its old value: any other
--                                  save of a lead (a note, an owner, updated_at) does not call the function at all.
--     DELETE is the foreign key's ON DELETE CASCADE above, in the same statement as the lead's delete.
--   These are the approved "AFTER INSERT OR UPDATE OR DELETE row trigger" split by event, because Postgres refuses one
--   trigger for all three events with that WHEN clause ("INSERT trigger's WHEN condition cannot reference OLD values").
--
-- Row-level security: the standard company policy, forced, no Supabase client-role grants (as the other Spider tables). A
-- scoped save (app.current_org_id = the lead's company) and an unscoped one (app.bypass_rls = on) both pass it.
-- The app's runtime role (app_rls) is granted the table explicitly where it exists, besides the schema's default
-- privileges: every lead save now writes here, so a missing grant would refuse every lead save.
--
-- Nothing else on leads changes: no new column, no rewrite, no new index. The rows for leads that exist already are NOT
-- written here: that is the backfill, a resumable job of its own (services/spider/watchList.ts), started on purpose after
-- this release (SPIDER_WATCH_LIST=backfill). Until it has run, a lead has a row once it is created or its stage changes.
--
-- Locks: adding the foreign keys and the triggers takes SHARE ROW EXCLUSIVE on leads and organizations (lead and company
-- writes wait; reads do not). They are taken first, together, each try waiting at most lock_timeout (2 s), so a long
-- transaction on leads never queues every lead save behind this migration for long. A busy try is given up and tried again
-- after 1, 2, 3 and 4 seconds; after 5 tries the migration fails and changes nothing. Prisma then records it as failed,
-- so the next deploy needs `prisma migrate resolve --rolled-back` first (vault Learnings/Shared-Staging-DB-Migration-Drift).
-- Everything else here touches only the new table. One DO block, so it runs as one statement (one transaction) anywhere.
--
-- Idempotent and portable per .claude/skills/writing-migrations: IF NOT EXISTS / CREATE OR REPLACE everywhere, each
-- constraint and trigger made only when missing, DROP POLICY before CREATE POLICY, the hosted database's roles (anon,
-- authenticated, app_rls) behind pg_roles guards. No CONCURRENTLY (Prisma runs a migration in a transaction). No secrets.
-- NEVER run `prisma migrate` from a worktree.

DO $spider_lead_watch$
DECLARE
  attempt integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);

  -- ─── The stage rules (services/spider/config.ts spiderStageOf), in the same order ───
  CREATE OR REPLACE FUNCTION public.spider_stage_of(
    status public."LeadStatus",
    created_at timestamp,
    contacted_at timestamp,
    returned_to_new_at timestamp,
    walkthrough_first_booked_at timestamp,
    last_visit_completed_at timestamp,
    first_estimate_sent_at timestamp,
    won_at timestamp,
    lost_at timestamp,
    cancelled_at timestamp,
    OUT stage text,
    OUT entered_at timestamp
  ) RETURNS record
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $stage_of$
    SELECT w.stage,
           CASE w.stage
             WHEN 'NEW' THEN coalesce(returned_to_new_at, created_at)
             WHEN 'CONTACTED' THEN coalesce(contacted_at, created_at)
             WHEN 'WALKTHROUGH_COMPLETED' THEN last_visit_completed_at
           END
      FROM (
        SELECT CASE
          -- Won, Lost and cancelled leads are in no stage.
          WHEN status IN ('WON', 'LOST') OR won_at IS NOT NULL OR lost_at IS NOT NULL OR cancelled_at IS NOT NULL
            THEN NULL
          -- New: no contact, status New, no walkthrough booked or completed, not past Estimate.
          WHEN contacted_at IS NULL AND status = 'NEW'
               AND walkthrough_first_booked_at IS NULL AND last_visit_completed_at IS NULL
               AND status <> 'ESTIMATED' AND first_estimate_sent_at IS NULL
            THEN 'NEW'
          -- Contacted: contacted (or status Contacted), status New or Contacted, no walkthrough, not past Estimate.
          WHEN (contacted_at IS NOT NULL OR status <> 'NEW') AND status IN ('NEW', 'CONTACTED')
               AND walkthrough_first_booked_at IS NULL AND last_visit_completed_at IS NULL
               AND status <> 'ESTIMATED' AND first_estimate_sent_at IS NULL
            THEN 'CONTACTED'
          -- Walkthrough Completed: a visit completed and no estimate sent.
          WHEN last_visit_completed_at IS NOT NULL AND first_estimate_sent_at IS NULL
            THEN 'WALKTHROUGH_COMPLETED'
        END AS stage
      ) w
  $stage_of$;

  -- ─── The trigger function: one statement ───
  CREATE OR REPLACE FUNCTION public.spider_lead_watch_sync() RETURNS trigger
  LANGUAGE plpgsql
  AS $sync$
  BEGIN
    INSERT INTO public.spider_lead_watch AS w (lead_id, organization_id, stage, entered_at, pending, changed_at)
    SELECT NEW.id, NEW.organization_id, s.stage, s.entered_at, true, (now() AT TIME ZONE 'UTC')
      FROM public.spider_stage_of(
             status => NEW.status,
             created_at => NEW.created_at,
             contacted_at => NEW.contacted_at,
             returned_to_new_at => NEW.returned_to_new_at,
             walkthrough_first_booked_at => NEW.walkthrough_first_booked_at,
             last_visit_completed_at => NEW.last_visit_completed_at,
             first_estimate_sent_at => NEW.first_estimate_sent_at,
             won_at => NEW.won_at,
             lost_at => NEW.lost_at,
             cancelled_at => NEW.cancelled_at) s
    ON CONFLICT (lead_id) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           stage = EXCLUDED.stage,
           entered_at = EXCLUDED.entered_at,
           pending = true,
           changed_at = EXCLUDED.changed_at
     WHERE w.stage IS DISTINCT FROM EXCLUDED.stage
        OR w.entered_at IS DISTINCT FROM EXCLUDED.entered_at;
    RETURN NULL;
  END
  $sync$;

  -- ─── The locks, with a time limit per try and retries ───
  LOOP
    attempt := attempt + 1;
    BEGIN
      LOCK TABLE public.leads, public.organizations IN SHARE ROW EXCLUSIVE MODE;
      -- On a second run the table exists, and the policy statements below need it to themselves. Taken after leads, the
      -- order a lead save takes them in (the lead, then its watch row), so the two can never wait on each other.
      IF to_regclass('public.spider_lead_watch') IS NOT NULL THEN
        LOCK TABLE public.spider_lead_watch IN ACCESS EXCLUSIVE MODE;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempt >= 5 THEN
        RAISE EXCEPTION 'spider_lead_watch: leads stayed busy for 5 tries of 2 s; nothing was changed. Mark it rolled back (prisma migrate resolve --rolled-back 20261112090000_spider_lead_watch), then deploy again';
      END IF;
      RAISE NOTICE 'spider_lead_watch: leads is busy (try % of 5); trying again in % s', attempt, attempt;
      PERFORM pg_sleep(attempt);
    END;
  END LOOP;

  -- ─── The table ───
  CREATE TABLE IF NOT EXISTS public.spider_lead_watch (
    "lead_id"         UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "stage"           TEXT,
    "entered_at"      TIMESTAMP(3) WITHOUT TIME ZONE,
    "pending"         BOOLEAN NOT NULL DEFAULT true,
    "changed_at"      TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spider_lead_watch_pkey" PRIMARY KEY ("lead_id"),
    CONSTRAINT "spider_lead_watch_stage_check" CHECK ("stage" IN ('NEW', 'CONTACTED', 'WALKTHROUGH_COMPLETED'))
  );

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spider_lead_watch_lead_id_fkey'
                   AND conrelid = 'public.spider_lead_watch'::regclass) THEN
    ALTER TABLE public.spider_lead_watch ADD CONSTRAINT "spider_lead_watch_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES public.leads("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spider_lead_watch_organization_id_fkey'
                   AND conrelid = 'public.spider_lead_watch'::regclass) THEN
    ALTER TABLE public.spider_lead_watch ADD CONSTRAINT "spider_lead_watch_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES public.organizations("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  CREATE INDEX IF NOT EXISTS "spider_lead_watch_due_idx"
    ON public.spider_lead_watch ("organization_id", "stage", "entered_at")
    WHERE "pending" AND "stage" IS NOT NULL;
  CREATE INDEX IF NOT EXISTS "spider_lead_watch_organization_id_changed_at_idx"
    ON public.spider_lead_watch ("organization_id", "changed_at");

  -- ─── Row-level security ───
  ALTER TABLE public.spider_lead_watch ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.spider_lead_watch FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "tenant_isolation" ON public.spider_lead_watch;
  CREATE POLICY "tenant_isolation" ON public.spider_lead_watch
    USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON public.spider_lead_watch FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON public.spider_lead_watch FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.spider_lead_watch TO app_rls;
  END IF;

  -- ─── The triggers on leads (made last: the table and its policy exist before the first lead save reaches them) ───
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.leads'::regclass AND tgname = 'spider_lead_watch_on_insert') THEN
    CREATE TRIGGER spider_lead_watch_on_insert
      AFTER INSERT ON public.leads
      FOR EACH ROW EXECUTE FUNCTION public.spider_lead_watch_sync();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.leads'::regclass AND tgname = 'spider_lead_watch_on_update') THEN
    CREATE TRIGGER spider_lead_watch_on_update
      AFTER UPDATE ON public.leads
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status
         OR OLD.created_at IS DISTINCT FROM NEW.created_at
         OR OLD.contacted_at IS DISTINCT FROM NEW.contacted_at
         OR OLD.returned_to_new_at IS DISTINCT FROM NEW.returned_to_new_at
         OR OLD.walkthrough_first_booked_at IS DISTINCT FROM NEW.walkthrough_first_booked_at
         OR OLD.last_visit_completed_at IS DISTINCT FROM NEW.last_visit_completed_at
         OR OLD.first_estimate_sent_at IS DISTINCT FROM NEW.first_estimate_sent_at
         OR OLD.won_at IS DISTINCT FROM NEW.won_at
         OR OLD.lost_at IS DISTINCT FROM NEW.lost_at
         OR OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at)
      EXECUTE FUNCTION public.spider_lead_watch_sync();
  END IF;
END
$spider_lead_watch$;

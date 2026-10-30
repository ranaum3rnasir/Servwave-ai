-- S05.18 (Roles & Permissions, PRD 5, "Leads close one way: Lost"): every Cancelled lead becomes Lost.
-- Data only for the leads; the one schema object it adds is a CHECK constraint (below).
--
-- A lead closes one way now, as Lost with a typed reason, and "Cancelled" is a job and visit word only. So every lead
-- that is Cancelled when this runs moves to Lost, in every company:
--   - its cancel reason becomes its lost reason. A lead cancelled from the status menu never had one; it keeps an
--     empty reason (NULL) and the lead page says "No reason recorded";
--   - its lost date is the date it was cancelled: leads.cancelled_at, else the History entry that cancelled it, else
--     the lead's last-changed date;
--   - leads.updated_at is NOT written (it is stamped by the client, never by the database, and the UPDATE below does
--     not name it), so the dashboard's Close Rate (counted by last change) and the Leads page's "Lost this month"
--     (counted by lost date) do not pull a single old cancelled lead into the current month;
--   - each moved lead gets ONE timeline_events STATUS_CHANGE row: from CANCELLED, to LOST, no actor, the old reason and
--     the cancel date in its metadata, and the reason in its words (no clock time in the words). It is dated at the
--     cancel, and always AFTER the lead's last existing STATUS_CHANGE row, so the entry that cancelled the lead stays the
--     one before it: Reopen (S05.19) reads back past a closed-to-closed entry to the entry that closed the lead;
--   - no alert is sent and no automation fires: this file writes leads and timeline_events and nothing else, so a
--     reminder already stopped on a migrated lead stays stopped;
--   - leads.cancelled_at / cancelled_reason, History already written ("Lead cancelled") and walkthroughs already
--     cancelled with the reason "Lead cancelled" stay exactly as written.
--
-- WHY THE POSTGRES VALUE IS NOT DROPPED HERE. The "LeadStatus" type still carries CANCELLED after this file. Postgres
-- has no DROP VALUE, so removing it means building a narrower type and swapping leads.status and spider_alerts.status
-- onto it. That is not safe in this release: Render applies this file while the PREVIOUS backend is still serving for a
-- few minutes, and that backend names CANCELLED in queries (status lists on the dashboard, the Leads list, the
-- estimate lead picker, the communication link list). Against a type without the value Postgres refuses the literal,
-- so each of those requests would fail until the new backend takes over, and every prepared statement that holds the
-- old type's id would break with the swap. The value is therefore left in the type, unused and unofferable (the
-- Prisma enum, the status options, the filters and every list no longer name it), and the constraint below makes the
-- database itself refuse it. A LATER migration, shipped once only the new backend is running, must: (1) drop
-- leads_status_not_cancelled, (2) move any lead or spider_alerts row still at CANCELLED (none can exist), (3) rebuild
-- "LeadStatus" without CANCELLED for leads.status and spider_alerts.status (the 20260729100000 shape), and keep this
-- constraint's absence in mind: it names the value, so it has to go first.
--
-- THE CONSTRAINT. leads_status_not_cancelled CHECK (status <> 'CANCELLED'), added NOT VALID FIRST and validated last.
-- Added first it is in force before the move reads anything, so the previous backend, if a user cancels a lead during
-- the deploy, is refused by the database (a failed request) instead of leaving a Cancelled lead the new backend
-- cannot read. Because it is in force when the UPDATE takes its snapshot, no Cancelled lead can appear after the move.
--
-- IDEMPOTENT: a second run finds no Cancelled lead, so it updates nothing and inserts nothing; the constraint is added
-- only when it is absent. Portable plain PostgreSQL 16 (gen_random_uuid() is built in from 13, no vendor roles).
-- Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice against the shared staging DB.
-- NEVER run `prisma migrate` from a worktree.

DO $$
DECLARE
  org_counts record;
  planned_total integer;
  moved_total integer;
  written_total integer;
BEGIN
  -- leads and timeline_events carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would move 0 rows. Set
  -- inside the block so it holds for these writes even when a client (psql -f) runs each statement in its own
  -- transaction.
  PERFORM set_config('app.bypass_rls', 'on', true);

  -- 1. The database refuses a new Cancelled lead from here on. NOT VALID: no scan now, existing rows are moved below.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leads_status_not_cancelled' AND conrelid = 'leads'::regclass
  ) THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_status_not_cancelled" CHECK ("status" <> 'CANCELLED') NOT VALID;
  END IF;

  -- 2. The plan: what moves, with the date and reason each one carries.
  DROP TABLE IF EXISTS pg_temp.lead_cancelled_to_lost_plan;
  CREATE TEMP TABLE lead_cancelled_to_lost_plan ON COMMIT DROP AS
  SELECT l.id,
         l.organization_id,
         CASE WHEN btrim(coalesce(l.cancelled_reason, '')) = '' THEN NULL ELSE l.cancelled_reason END AS reason,
         coalesce(
           l.cancelled_at,
           (SELECT max(te.created_at) FROM "timeline_events" te
             WHERE te.entity_type = 'LEAD' AND te.entity_id = l.id AND te.event_type = 'STATUS_CHANGE'
               AND (te.metadata->>'to' = 'CANCELLED' OR te.description ILIKE '%cancelled%')),
           l.updated_at
         ) AS cancelled_on,
         (SELECT max(te.created_at) FROM "timeline_events" te
           WHERE te.entity_type = 'LEAD' AND te.entity_id = l.id AND te.event_type = 'STATUS_CHANGE') AS last_status_change
  FROM "leads" l
  WHERE l.status = 'CANCELLED';

  -- Before writing: how many leads each org will see move.
  FOR org_counts IN
    SELECT organization_id, count(*) AS will_move
    FROM lead_cancelled_to_lost_plan
    GROUP BY organization_id
    ORDER BY organization_id
  LOOP
    RAISE NOTICE 'S05.18 org %: % Cancelled leads will move to Lost', org_counts.organization_id, org_counts.will_move;
  END LOOP;
  SELECT count(*) INTO planned_total FROM lead_cancelled_to_lost_plan;

  -- 3. The move and its History rows. The status guard sits in the write itself, so a lead that left Cancelled since the
  --    plan is never overwritten; the rows come from exactly the leads the UPDATE moved.
  WITH moved AS (
    UPDATE "leads" l
    SET status = 'LOST', lost_reason = p.reason, lost_at = p.cancelled_on
    FROM lead_cancelled_to_lost_plan p
    WHERE l.id = p.id AND l.status = 'CANCELLED'
    RETURNING l.id, l.organization_id, p.reason, p.cancelled_on, p.last_status_change
  ), written AS (
    INSERT INTO "timeline_events"
      (id, organization_id, entity_type, entity_id, event_type, description, metadata, created_by, created_at)
    SELECT gen_random_uuid(), m.organization_id, 'LEAD', m.id, 'STATUS_CHANGE',
           'Lead was Cancelled before Cancelled was retired, and is now Lost. Old reason: '
             || coalesce(m.reason, 'none recorded'),
           jsonb_build_object(
             'from', 'CANCELLED', 'to', 'LOST', 'via', 'lead_cancelled_retired',
             -- the column is a timestamp without a zone that holds UTC, so it is printed as it is, never shifted
             'cancelled_at', to_char(m.cancelled_on, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'cancelled_reason', m.reason),
           NULL,
           greatest(m.cancelled_on, coalesce(m.last_status_change, m.cancelled_on)) + interval '1 millisecond'
    FROM moved m
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM moved), (SELECT count(*) FROM written) INTO moved_total, written_total;

  RAISE NOTICE 'S05.18 all orgs: % of % Cancelled leads moved to Lost, % History rows written',
    moved_total, planned_total, written_total;
  IF moved_total < planned_total THEN
    RAISE NOTICE 'S05.18: % planned leads left Cancelled while this ran and were not moved', planned_total - moved_total;
  END IF;

  DROP TABLE IF EXISTS pg_temp.lead_cancelled_to_lost_plan;

  -- 4. Nothing is Cancelled now, so the constraint can be marked as checked against every row.
  ALTER TABLE "leads" VALIDATE CONSTRAINT "leads_status_not_cancelled";
END $$;

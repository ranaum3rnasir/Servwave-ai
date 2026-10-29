-- #2618: one-time move of existing New leads that already have a recorded contact to Contacted.
-- Data only: no schema change.
--
-- From #2618 on, the first outbound contact on a New lead moves it to Contacted. This catches up the
-- leads contacted before that: a lead moves when it is NEW and has a recorded contact time
-- (leads.contacted_at IS NOT NULL). Every other status is never touched. Leads with a booked or finished
-- walkthrough or a sent estimate are already past New (20261006200200_lead_status_walkthrough_backfill
-- moved them). Leads have no soft-delete column (a deleted lead is gone), so "not deleted" needs no
-- predicate.
--
-- A lead whose History shows a move back to New dated AFTER its recorded contact stays New: someone set it
-- back by hand, and a hand reset stays until the next qualifying contact (#2618). Moving it would also end
-- its History on a "-> Contacted" row dated before the reset.
--
-- Each moved lead gets one timeline_events STATUS_CHANGE row: from NEW, to CONTACTED, created_by NULL
-- (no actor), via 'contacted_status_backfill', dated at the lead's recorded contact time (not now()), so
-- time in Contacted is measured from the real contact. The contact time itself is never written.
--
-- Before it writes, it prints per-org counts of the leads that will move; after it writes, it prints how
-- many moved. The History rows are written from exactly the leads the UPDATE moved (UPDATE ... RETURNING
-- feeds the INSERT), so a lead that left New while this ran is simply not moved and gets no row; the
-- difference is reported as a notice, never a failed deploy.
--
-- IDEMPOTENT: a second run finds no New lead with a recorded contact left to move, so it updates nothing
-- and inserts nothing. A lead this update already moved once (it carries a 'contacted_status_backfill'
-- row) is never moved again, even if someone set it back to New by hand in between.
-- Portable plain PostgreSQL 16 (gen_random_uuid() is built in from 13, no vendor roles). Runs on CI's
-- vanilla postgres:16, on the Render deploy, and possibly twice against the shared staging DB.
-- NEVER run `prisma migrate` from a worktree.

DO $$
DECLARE
  org_counts record;
  planned_total integer;
  moved_total integer;
  written_total integer;
BEGIN
  -- leads and timeline_events carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would
  -- move 0 rows. Set inside the block so it holds for these writes even when a client (psql -f) runs
  -- each statement in its own transaction.
  PERFORM set_config('app.bypass_rls', 'on', true);

  DROP TABLE IF EXISTS pg_temp.lead_contacted_backfill_plan;
  CREATE TEMP TABLE lead_contacted_backfill_plan ON COMMIT DROP AS
  SELECT l.id, l.organization_id, l.contacted_at
  FROM "leads" l
  WHERE l.status = 'NEW'
    AND l.contacted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "timeline_events" te
      WHERE te.entity_type = 'LEAD'
        AND te.entity_id = l.id
        AND te.event_type = 'STATUS_CHANGE'
        AND te.metadata->>'via' = 'contacted_status_backfill')
    AND NOT EXISTS (
      SELECT 1 FROM "timeline_events" te
      WHERE te.entity_type = 'LEAD'
        AND te.entity_id = l.id
        AND te.event_type = 'STATUS_CHANGE'
        AND te.metadata->>'to' = 'NEW'
        AND te.created_at > l.contacted_at);

  -- Before writing: how many leads each org will see move.
  FOR org_counts IN
    SELECT organization_id, count(*) AS will_move
    FROM lead_contacted_backfill_plan
    GROUP BY organization_id
    ORDER BY organization_id
  LOOP
    RAISE NOTICE '#2618 org %: % New leads with a recorded contact will move to Contacted',
      org_counts.organization_id, org_counts.will_move;
  END LOOP;
  SELECT count(*) INTO planned_total FROM lead_contacted_backfill_plan;

  -- The status guard sits in the write itself, so a lead that left New since the plan is never overwritten.
  WITH moved AS (
    UPDATE "leads" l
    SET status = 'CONTACTED', updated_at = now()
    FROM lead_contacted_backfill_plan p
    WHERE l.id = p.id AND l.status = 'NEW'
    RETURNING l.id, l.organization_id, p.contacted_at
  ), written AS (
    INSERT INTO "timeline_events"
      (id, organization_id, entity_type, entity_id, event_type, description, metadata, created_by, created_at)
    SELECT gen_random_uuid(), m.organization_id, 'LEAD', m.id, 'STATUS_CHANGE',
           'Lead moved to Contacted (set from its recorded contact)',
           jsonb_build_object('from', 'NEW', 'to', 'CONTACTED', 'via', 'contacted_status_backfill'),
           NULL, m.contacted_at
    FROM moved m
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM moved), (SELECT count(*) FROM written) INTO moved_total, written_total;

  -- After writing: what moved. History rows come from the moved leads, so the two always match.
  RAISE NOTICE '#2618 all orgs: % of % planned leads moved to Contacted, % History rows written',
    moved_total, planned_total, written_total;
  IF moved_total < planned_total THEN
    RAISE NOTICE '#2618: % planned leads left New while this ran and were not moved',
      planned_total - moved_total;
  END IF;

  DROP TABLE IF EXISTS pg_temp.lead_contacted_backfill_plan;
END $$;

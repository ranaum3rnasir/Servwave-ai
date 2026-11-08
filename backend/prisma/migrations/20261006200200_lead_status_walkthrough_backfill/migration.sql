-- One-time move of existing leads onto the two walkthrough statuses (walkthrough lead statuses,
-- slice 03; PRD 10.2). Data only: no schema change.
--
-- Which leads move: only leads that are NEW or CONTACTED and have NO estimate sent.
--   "estimate sent" = at least one estimate on the lead whose status is SENT, PENDING, WON,
--   DECLINED or EXPIRED, or SUPERSEDED with sent_at set (DRAFT and ARCHIVED do not count).
--   - at least one open visit (SCHEDULED, EN_ROUTE, ON_SITE, IN_PROGRESS) -> WALKTHROUGH_SCHEDULED
--   - else at least one COMPLETED visit                                    -> WALKTHROUGH_COMPLETED
--   Estimated, Won, Lost, Cancelled (and leads already in a walkthrough status) are never touched.
--
-- Each moved lead gets one timeline_events STATUS_CHANGE row (created_by NULL) so History and the
-- time-in-status record stay complete.
--
-- Uses the enum values added by 20261006200000_lead_status_add_walkthrough_values, which is a
-- separate migration file (a new enum value cannot be used in the transaction that adds it).
-- Idempotent: a second run finds no NEW/CONTACTED lead with a visit and no sent estimate left to
-- move, so it updates nothing and inserts nothing. Portable plain PostgreSQL 16 (gen_random_uuid()
-- is built in from 13).
WITH facts AS (
  SELECT l.id, l.organization_id, l.status AS from_status,
         COUNT(v.id) FILTER (WHERE v.status IN ('SCHEDULED','EN_ROUTE','ON_SITE','IN_PROGRESS')) AS open_visits,
         COUNT(v.id) FILTER (WHERE v.status = 'COMPLETED') AS finished_visits
  FROM leads l
  LEFT JOIN visits v ON v.lead_id = l.id AND v.organization_id = l.organization_id
  WHERE l.status IN ('NEW','CONTACTED')
    AND NOT EXISTS (
      SELECT 1 FROM estimates e
      WHERE e.lead_id = l.id
        AND (e.status IN ('SENT','PENDING','WON','DECLINED','EXPIRED')
             OR (e.status = 'SUPERSEDED' AND e.sent_at IS NOT NULL)))
  GROUP BY l.id, l.organization_id, l.status
), targets AS (
  SELECT id, organization_id, from_status,
         CASE WHEN open_visits > 0 THEN 'WALKTHROUGH_SCHEDULED'::"LeadStatus"
              ELSE 'WALKTHROUGH_COMPLETED'::"LeadStatus" END AS to_status
  FROM facts WHERE open_visits > 0 OR finished_visits > 0
), moved AS (
  UPDATE leads l SET status = t.to_status, updated_at = now()
  FROM targets t
  WHERE l.id = t.id AND l.status = t.from_status
  RETURNING l.id
)
INSERT INTO timeline_events (id, organization_id, entity_type, entity_id, event_type, description, metadata, created_by, created_at)
SELECT gen_random_uuid(), t.organization_id, 'LEAD', t.id, 'STATUS_CHANGE',
       CASE WHEN t.to_status = 'WALKTHROUGH_SCHEDULED'
            THEN 'Lead moved to Walkthrough Scheduled (set from its booked walkthroughs)'
            ELSE 'Lead moved to Walkthrough Completed (set from its finished walkthroughs)' END,
       jsonb_build_object('from', t.from_status, 'to', t.to_status, 'via', 'walkthrough_status_backfill'),
       NULL, now()
FROM targets t JOIN moved m ON m.id = t.id;

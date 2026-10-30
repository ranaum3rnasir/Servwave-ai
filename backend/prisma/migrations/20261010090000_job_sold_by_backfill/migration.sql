-- Roles & Permissions Overhaul, PRD 3, slice S03.8: the job's Sold By becomes a stored field.
--
-- The job's existing salesperson column (jobs.salesperson_id) IS the stored Sold By. No schema change:
-- nothing in the database is added, dropped or renamed. This migration fills it once for the jobs that
-- have none, so the Team card, access and the readers that follow it agree with what the Team card showed:
--
--   1. a service plan visit job (source_plan_id set) takes its plan's "Sold by" (service_plans.sold_by),
--      empty when the plan names nobody. It never falls back to a lead: a plan visit job has none.
--   2. any other job takes the Owner (leads.commission_owner_id) of the lead it came from, in this order:
--        the job's own lead reference (jobs.lead_id), else the lead of its anchor estimate
--        (jobs.estimate_id -> estimates.lead_id), else empty.
--      A job built from several estimates has no anchor estimate but does have its own lead reference.
--
-- The copy is as-is: no check that the person is still active or still allowed to be Sold By. A job that
-- already has a Sold By is never touched, so a second run changes nothing.
--
-- Before it writes, it prints per-org counts (jobs without a Sold By, how many will be filled, how many stay
-- empty); after it writes, it proves the rows landed (per-org filled counts, and a hard stop if any planned
-- row did not take its value, which rolls the whole migration back).
--
-- IDEMPOTENT + portable plain PostgreSQL (no vendor roles). Runs on CI's vanilla postgres:16, on the Render
-- deploy, and possibly twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.

-- jobs carries FORCE ROW LEVEL SECURITY; a role that does not bypass it would update 0 rows.
SELECT set_config('app.bypass_rls', 'on', true);

DO $$
DECLARE
  org_counts record;
  planned_total integer;
  landed_total integer;
  missing integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp.s03_8_sold_by_plan;
  CREATE TEMP TABLE s03_8_sold_by_plan ON COMMIT DROP AS
  SELECT j.id AS job_id,
         j.organization_id,
         CASE
           WHEN j.source_plan_id IS NOT NULL THEN sp.sold_by
           ELSE ol.commission_owner_id
         END AS sold_by
  FROM "jobs" j
  LEFT JOIN "service_plans" sp
         ON sp.id = j.source_plan_id AND sp.organization_id = j.organization_id
  LEFT JOIN "estimates" ae
         ON ae.id = j.estimate_id AND ae.organization_id = j.organization_id
  LEFT JOIN "leads" ol
         ON ol.id = COALESCE(j.lead_id, ae.lead_id) AND ol.organization_id = j.organization_id
  WHERE j.salesperson_id IS NULL;

  -- Before writing: what each org has, and what this run will do about it.
  FOR org_counts IN
    SELECT organization_id,
           count(*) AS without_sold_by,
           count(*) FILTER (WHERE sold_by IS NOT NULL) AS will_fill,
           count(*) FILTER (WHERE sold_by IS NULL) AS stay_empty
    FROM s03_8_sold_by_plan
    GROUP BY organization_id
    ORDER BY organization_id
  LOOP
    RAISE NOTICE 'S03.8 org %: % jobs without a Sold By, % will be filled, % stay empty',
      org_counts.organization_id, org_counts.without_sold_by, org_counts.will_fill, org_counts.stay_empty;
  END LOOP;

  UPDATE "jobs" j
  SET salesperson_id = p.sold_by
  FROM s03_8_sold_by_plan p
  WHERE j.id = p.job_id
    AND p.sold_by IS NOT NULL
    AND j.salesperson_id IS NULL;

  -- After writing: the rows landed.
  FOR org_counts IN
    SELECT p.organization_id,
           count(*) FILTER (WHERE p.sold_by IS NOT NULL) AS planned,
           count(*) FILTER (WHERE p.sold_by IS NOT NULL AND j.salesperson_id = p.sold_by) AS landed
    FROM s03_8_sold_by_plan p
    JOIN "jobs" j ON j.id = p.job_id
    GROUP BY p.organization_id
    ORDER BY p.organization_id
  LOOP
    RAISE NOTICE 'S03.8 org %: % of % planned Sold By values landed',
      org_counts.organization_id, org_counts.landed, org_counts.planned;
  END LOOP;

  SELECT count(*) FILTER (WHERE p.sold_by IS NOT NULL),
         count(*) FILTER (WHERE p.sold_by IS NOT NULL AND j.salesperson_id = p.sold_by)
    INTO planned_total, landed_total
  FROM s03_8_sold_by_plan p
  JOIN "jobs" j ON j.id = p.job_id;
  missing := planned_total - landed_total;
  RAISE NOTICE 'S03.8 all orgs: % of % planned Sold By values landed', landed_total, planned_total;
  IF missing <> 0 THEN
    RAISE EXCEPTION 'S03.8: % planned Sold By values did not land', missing;
  END IF;

  DROP TABLE IF EXISTS pg_temp.s03_8_sold_by_plan;
END $$;

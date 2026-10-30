-- Roles & Permissions, PRD 10 (scenario pass 3 fix): an email written by hand on a job's or lead's Communication tab
-- belongs to that record's customer.
--
-- The tab's composer posts only the id of the job or lead it was opened on, and the send used to stamp only that id, so
-- the stored row carried job_id (or lead_id) and no customer_id. The customer's own Communication tab lists the rows
-- stamped with the customer, so a job-tab email never showed there while the record's system emails did. The send now
-- stamps the record's customer; this catches up the rows written before.
--
-- Data only, no schema change. A row moves when it is a hand-written, sent email (account 'user', direction 'out', a
-- sender recorded), has no customer yet, and names a job or lead; its customer is the job's, else the lead's (the same
-- job > lead precedence every record read uses), and only when that record is in the row's own company. Received mail,
-- automated mail and rows that already carry a customer are never touched. Mail attached to a job by hand is not
-- touched either: whether it joins a customer's tab is decided by the customer link, not by this fix.
--
-- IDEMPOTENT: a second run finds no such row left without a customer, so it updates nothing. Portable plain PostgreSQL
-- (no vendor roles). Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice against the shared
-- staging DB. NEVER run `prisma migrate` from a worktree.

DO $$
DECLARE
  moved_total integer;
BEGIN
  -- emails carries FORCE ROW LEVEL SECURITY; a role that does not bypass it would update 0 rows. Set inside the block so
  -- it holds for this write even when a client (psql -f) runs each statement in its own transaction.
  PERFORM set_config('app.bypass_rls', 'on', true);

  WITH resolved AS (
    SELECT e."id",
      CASE
        WHEN e."job_id" IS NOT NULL THEN
          (SELECT j."customer_id" FROM "jobs" j WHERE j."id" = e."job_id" AND j."organization_id" = e."organization_id")
        ELSE
          (SELECT l."customer_id" FROM "leads" l WHERE l."id" = e."lead_id" AND l."organization_id" = e."organization_id")
      END AS "customer_id"
    FROM "emails" e
    WHERE e."customer_id" IS NULL
      AND e."account" = 'user'
      AND e."direction" = 'out'
      AND e."sent_by_user_id" IS NOT NULL
      AND (e."job_id" IS NOT NULL OR e."lead_id" IS NOT NULL)
  )
  UPDATE "emails"
  SET "customer_id" = resolved."customer_id"
  FROM resolved
  WHERE "emails"."id" = resolved."id"
    AND resolved."customer_id" IS NOT NULL
    AND "emails"."customer_id" IS NULL;

  GET DIAGNOSTICS moved_total = ROW_COUNT;
  RAISE NOTICE 'email_record_tab_customer_backfill: % hand-written record-tab emails given their record''s customer', moved_total;
END $$;

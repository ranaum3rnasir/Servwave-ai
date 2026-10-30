-- S06.32 (Roles & Permissions, PRD 6, "One-time migration of existing jobs"): every job that is Completed moves on, once.
-- Data only: this file adds no table, no column and no constraint.
--
-- Jobs finished under the old flow rest at Completed. Under the close-out flow a job is Done, or it waits Ready to close
-- for someone to collect or close it. So every job that is Completed when this runs, in every company, moves:
--   - to DONE when it is paid in full or its total is zero;
--   - to READY_TO_CLOSE when money is owed on it, work not yet invoiced included, so a job is never closed with a balance
--     in silence. When in doubt a job goes to READY_TO_CLOSE, never to DONE.
-- Jobs in Office review, Ready to close, Done, Cancelled or any other status are not touched, and a Cancelled job keeps its
-- written reason as the note with no reason code (this file never names jobs.cancel_reason_code).
--
-- THE MONEY-OWED RULE is the one Mark Done uses (backend/src/lib/job-money-owed.ts readJobMoneyOwed, the figure the job
-- page's Balance card shows), written once more here in set-based SQL:
--   - a service plan's visit job is never owed;
--   - the contract is the final invoice's total (the STANDARD invoice that is not voided and has the highest number), else
--     the estimate the job was made from, else the sum of the live estimates attached to the job (not Declined, Expired,
--     Archived or Superseded), else the job's own total from its lines and scopes with its tax and discount;
--   - the invoices counted are those on the job, those made from its estimate and those made from an attached estimate;
--   - the money paid is what the payment ledger counts: payments that succeeded and are not voided, the applied deposit
--     credit aside (it is the same cash as the deposit's own payment); a pending or failed payment, a voided one and a
--     refund change nothing;
--   - owed = contract less paid, never below zero, so a zero-total job is never owed.
-- The job's own total is worked out in double precision, in the same order of operations as lib/invoice-totals.ts, so it
-- agrees with the app to the cent. A real-database test (job-close-out-upgrade-migration-db.test.ts) builds a wide set of
-- jobs and asserts, job by job, that this plan and readJobMoneyOwed agree. The one case SQL cannot answer is a scope whose
-- price is not a number: that job cannot be priced, so it goes to READY_TO_CLOSE.
--
-- WHAT A MOVED JOB CARRIES.
--   - status: DONE or READY_TO_CLOSE; sub_status_id is cleared, as every status change clears it (a Completed job's
--     sub-status belongs to Completed and is invalid under the new status);
--   - closed_at: for a job moved to DONE, the day it was completed (else its last change), so no closed-by-date figure
--     moves an old job into the month of the release; closed_by_id stays NULL, because no person closed it and the History
--     entry says why. A job moved to READY_TO_CLOSE has no closed_at: it is not closed;
--   - updated_at is NOT written (the client stamps it, never the database, and the UPDATE below does not name it), so the
--     Jobs list does not reshuffle by last change;
--   - completed_at and every other column stay exactly as they were;
--   - ONE History entry (timeline_events, event JOB_CLOSE_OUT_UPGRADED) "Moved by the job close-out upgrade", no actor,
--     dated when the move ran, with the old and new status in its metadata. No money is written into it.
--   - NO review round opens (no job_reviews row), no alert or notification row is written, and nothing is enrolled in an
--     automation: this file writes jobs and timeline_events and nothing else.
--
-- WHAT A COMPANY SEES. Done jobs leave the default Jobs list (they stay one filter away and in every report); Ready to
-- close jobs join the queue that people who can Close jobs see in the Jobs menu count and on the Jobs page, all at once.
-- backend/src/scripts/job-close-out-upgrade-report.ts (npm run jobs:close-out-upgrade-dry-run) prints the per-company
-- counts of both, read-only, before this runs; `-proof` checks they landed afterwards.
--
-- IDEMPOTENT: a second run finds no Completed job, so it updates nothing and inserts nothing. A Completed job that an
-- older backend writes during the deploy overlap is moved by running this file again (psql -f).
-- Set-based: one plan, one UPDATE, one INSERT; no row-by-row loop. The UPDATE holds each job's row only for its own write.
-- Portable plain PostgreSQL 16 (gen_random_uuid() is built in from 13, no vendor roles): runs on CI's vanilla postgres:16,
-- on the Render deploy, and possibly twice against the shared staging DB. NEVER run `prisma migrate` from a worktree.
--
-- The plan is the one SELECT between the two marker comments below: the dry run reads it from this file, so what it
-- previews is exactly what runs.

DO $$
DECLARE
  org_counts record;
  moved_at timestamp(3) := date_trunc('milliseconds', now() AT TIME ZONE 'UTC');
  planned_total integer;
  moved_total integer;
  written_total integer;
  done_total integer;
  ready_total integer;
BEGIN
  -- jobs and timeline_events carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would move 0 rows. Set
  -- inside the block so it holds for these writes even when a client (psql -f) runs each statement in its own
  -- transaction.
  PERFORM set_config('app.bypass_rls', 'on', true);

  DROP TABLE IF EXISTS pg_temp.job_close_out_upgrade_plan;
  CREATE TEMP TABLE job_close_out_upgrade_plan ON COMMIT DROP AS
  -- @plan
  SELECT j.id,
         j.organization_id,
         j.job_number,
         coalesce(j.completed_at, j.updated_at) AS closed_on,
         CASE
           WHEN j.source_plan_id IS NOT NULL THEN 'plan visit'
           WHEN inv.final_total IS NOT NULL THEN 'invoice'
           WHEN est.own_total IS NOT NULL THEN 'estimate'
           WHEN est.live_count > 0 THEN 'attached estimates'
           ELSE 'job lines'
         END AS basis,
         h.owed_cents,
         h.undecided,
         CASE WHEN h.owed_cents > 0 OR h.undecided THEN 'READY_TO_CLOSE' ELSE 'DONE' END AS target
  FROM jobs j
  JOIN customers cu ON cu.id = j.customer_id
  -- The invoices on the job, made from its estimate, or made from an estimate attached to it; and the money paid on them.
  LEFT JOIN LATERAL (
    SELECT (array_agg(i.total_amount ORDER BY i.invoice_number COLLATE "C" DESC)
              FILTER (WHERE i.kind = 'STANDARD' AND i.voided_at IS NULL))[1] AS final_total,
           coalesce(sum(round(p.amount * 100)), 0) AS paid_cents
    FROM invoices i
    LEFT JOIN payments p
      ON p.invoice_id = i.id AND p.voided_at IS NULL AND p.state = 'SUCCEEDED'
     AND p.reference_number IS DISTINCT FROM 'DEPOSIT-CREDIT'
    WHERE i.organization_id = j.organization_id
      AND (i.job_id = j.id
           OR i.estimate_id = j.estimate_id
           OR i.estimate_id IN (SELECT e.id FROM estimates e WHERE e.job_id = j.id))
  ) inv ON true
  -- The estimate the job was made from, and the live estimates attached beside it.
  LEFT JOIN LATERAL (
    SELECT (SELECT pe.total_amount FROM estimates pe WHERE pe.id = j.estimate_id) AS own_total,
           count(*) FILTER (WHERE e.id IS DISTINCT FROM j.estimate_id
                              AND e.status::text NOT IN ('DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED')) AS live_count,
           sum(e.total_amount) FILTER (WHERE e.id IS DISTINCT FROM j.estimate_id
                                         AND e.status::text NOT IN ('DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED')) AS live_sum
    FROM estimates e
    WHERE e.job_id = j.id
  ) est ON true
  -- The job's own total (used only with no invoice and no estimate): lines, scopes, discount and tax, as invoice-totals.ts.
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(r.v), 0) AS amount,
           coalesce(sum(r.v) FILTER (WHERE r.is_taxable), 0) AS taxable
    FROM (SELECT floor(l.quantity::float8 * l.unit_price::float8 * 100 + 0.5) / 100 AS v, l.is_taxable
          FROM job_line_items l WHERE l.job_id = j.id) r
  ) ln ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(r.v), 0) AS amount,
           coalesce(sum(r.v) FILTER (WHERE r.is_taxable), 0) AS taxable,
           coalesce(bool_or(r.v IS NULL), false) AS unreadable
    FROM (SELECT CASE WHEN jsonb_typeof(s.value -> 'flat_price') = 'number'
                        OR (jsonb_typeof(s.value -> 'flat_price') = 'string'
                            AND s.value ->> 'flat_price' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$')
                      THEN floor((s.value ->> 'flat_price')::float8 * 100 + 0.5) / 100 END AS v,
                 coalesce((s.value -> 'is_taxable') = 'true'::jsonb, false) AS is_taxable
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.scopes) = 'array' THEN j.scopes ELSE '[]'::jsonb END) AS s(value)
          WHERE jsonb_typeof(s.value -> 'flat_price') IN ('number', 'string', 'boolean', 'object', 'array')) r
  ) sc ON true
  CROSS JOIN LATERAL (SELECT ln.amount + sc.amount AS raw_subtotal, ln.taxable + sc.taxable AS raw_taxable) a
  CROSS JOIN LATERAL (SELECT floor(a.raw_subtotal * 100 + 0.5) / 100 AS subtotal,
                             floor(j.discount_amount::float8 * 100 + 0.5) / 100 AS discount) b
  CROSS JOIN LATERAL (SELECT floor((b.subtotal - b.discount) * 100 + 0.5) / 100 AS discounted) c
  CROSS JOIN LATERAL (SELECT CASE WHEN b.discount > 0 AND b.subtotal > 0
                                  THEN floor(c.discounted * (a.raw_taxable / b.subtotal) * 100 + 0.5) / 100
                                  ELSE a.raw_taxable END AS taxable_subtotal) d
  CROSS JOIN LATERAL (SELECT CASE WHEN cu.tax_exempt THEN 0::float8
                                  ELSE floor(d.taxable_subtotal * j.tax_rate::float8 * 100 + 0.5) / 100 END AS tax) e
  CROSS JOIN LATERAL (SELECT floor((c.discounted + e.tax + 0) * 100 + 0.5) / 100 AS total) f
  -- The contract in whole cents, and what is owed on it.
  CROSS JOIN LATERAL (SELECT CASE
                                WHEN inv.final_total IS NOT NULL THEN round(inv.final_total * 100)
                                WHEN est.own_total IS NOT NULL THEN round(est.own_total * 100)
                                WHEN est.live_count > 0 THEN round(coalesce(est.live_sum, 0) * 100)
                                ELSE round(f.total::numeric * 100)
                              END AS contract_cents) g
  CROSS JOIN LATERAL (SELECT CASE WHEN j.source_plan_id IS NOT NULL THEN 0
                                  ELSE greatest(g.contract_cents - inv.paid_cents, 0) END::bigint AS owed_cents,
                             (j.source_plan_id IS NULL AND inv.final_total IS NULL AND est.own_total IS NULL
                              AND est.live_count = 0 AND sc.unreadable) AS undecided) h
  WHERE j.status = 'COMPLETED'
  -- @end
  ;

  -- Before writing: how many jobs each company will see move.
  FOR org_counts IN
    SELECT organization_id,
           count(*) FILTER (WHERE target = 'DONE') AS to_done,
           count(*) FILTER (WHERE target = 'READY_TO_CLOSE') AS to_ready
    FROM job_close_out_upgrade_plan
    GROUP BY organization_id
    ORDER BY organization_id
  LOOP
    RAISE NOTICE 'S06.32 org %: % Completed jobs will move to Done, % to Ready to close',
      org_counts.organization_id, org_counts.to_done, org_counts.to_ready;
  END LOOP;
  SELECT count(*) INTO planned_total FROM job_close_out_upgrade_plan;

  -- The move and its History rows. The status guard sits in the write itself, so a job that left Completed since the plan
  -- is never overwritten; the rows come from exactly the jobs the UPDATE moved.
  WITH moved AS (
    UPDATE jobs j
    SET status = p.target::"JobStatus",
        sub_status_id = NULL,
        closed_at = CASE WHEN p.target = 'DONE' THEN p.closed_on END
    FROM job_close_out_upgrade_plan p
    WHERE j.id = p.id AND j.status = 'COMPLETED'
    RETURNING j.id, j.organization_id, p.target
  ), written AS (
    INSERT INTO "timeline_events"
      (id, organization_id, entity_type, entity_id, event_type, description, metadata, created_by, created_at)
    SELECT gen_random_uuid(), m.organization_id, 'JOB', m.id, 'JOB_CLOSE_OUT_UPGRADED',
           'Moved by the job close-out upgrade',
           jsonb_build_object('from', 'COMPLETED', 'to', m.target, 'via', 'job_close_out_upgrade'),
           NULL,
           moved_at
    FROM moved m
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM moved),
         (SELECT count(*) FROM written),
         (SELECT count(*) FROM moved WHERE target = 'DONE'),
         (SELECT count(*) FROM moved WHERE target = 'READY_TO_CLOSE')
  INTO moved_total, written_total, done_total, ready_total;

  RAISE NOTICE 'S06.32 all orgs: % of % Completed jobs moved (% to Done, % to Ready to close), % History rows written',
    moved_total, planned_total, done_total, ready_total, written_total;
  IF moved_total < planned_total THEN
    RAISE NOTICE 'S06.32: % planned jobs left Completed while this ran and were not moved', planned_total - moved_total;
  END IF;

  DROP TABLE IF EXISTS pg_temp.job_close_out_upgrade_plan;
END $$;

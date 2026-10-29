-- Multi-visit spec (md_files/specs/scheduling/2026-08-17-multi-visit.md) slice S4, decisions
-- D7 (the four milestone timestamps move to the visit; completing the last visit does NOT
-- auto-complete the job), D12 (JobStatus becomes UNSCHEDULED / SCHEDULED / IN_PROGRESS /
-- COMPLETED / CANCELLED, with the first three derived from the visit set) and D17 (EN_ROUTE and
-- ON_SITE retire from JobStatus and live on VisitStatus; existing rows migrate to IN_PROGRESS).
--
-- Portable: no Supabase-only roles, no auth.* - vanilla postgres:16 in CI runs it unchanged.
-- Idempotent: every step is guarded on the state it is about to change, so a second application
-- on the shared staging DB is a no-op.
--
-- RLS: no table is created, renamed or replaced here. The tenant_isolation policies and grants
-- created by 20260703000100_tenant_rls stay attached to `visits`, `jobs` and `job_sub_statuses`
-- untouched - ADD COLUMN and ALTER COLUMN ... TYPE disturb neither, and authoring a duplicate
-- GRANT/POLICY would risk a non-idempotent re-run against staging.
--
-- VERIFIED NOT NEEDING A JSONB REWRITE, stated here so the next reader does not re-derive it:
-- `role_permissions.conditions` persists OWN_JOB as {"assignees":{"some":{"user_id":"{{userId}}"}}}
-- and OWN_WALKTHROUGH as a visits path - both name RELATIONS and user ids, never a JobStatus, and
-- S4 renames no relation. Repointing OWN_JOB at the visits path stays with S8's job_assignees
-- drop, exactly as the S3 migration header says. `automation_rules` and the workflow conditions
-- hold TRIGGER types (JOB_EN_ROUTE is a trigger, not a status); their job-status reads are
-- code-level, in stopIf.ts and terminalStale.ts, and are changed in the S4 code rather than here.
-- `user_table_preferences.config` was CHECKED and holds column layout only, never a JobStatus -
-- step 4 records the evidence and ships a guard rather than a repair.

-- ─── 1. The milestone stamps move onto the visit (D7) ─────────────────────────
--
-- `completed_at` already exists on `visits` (it came over with the walkthrough shape). These are
-- the other three. Nullable with no default: a visit that has not been driven to yet has no
-- arrival time, and NULL is the fact.
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "en_route_at" TIMESTAMP(3);
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "on_site_at" TIMESTAMP(3);
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3);

-- One-time backfill of the trip that already happened, onto the job's LOWEST visit_seq row.
--
-- Those three job columns described the SINGLE trip that existed before S2 minted the visit rows,
-- so visit 1 is the row they belong to. The `v.<col> IS NULL` guard is what makes a re-run a
-- no-op, and the `j.<col> IS NOT NULL` half keeps a job that never got there from stamping
-- anything at all.
--
-- REJECTED ALTERNATIVE: backfill the NEXT UPCOMING visit instead, mirroring how S2's step 3 chose
-- the row for the schedule window. After S2 the next-upcoming row can be a trip the office booked
-- AFTER the arrival happened, so this would date a future visit with a past arrival - and the
-- lifecycle bar would then read "on site" for a trip nobody has driven to.
-- CANCELLED rows are excluded from BOTH halves of the predicate - the MIN and the row filter.
-- The lowest visit_seq row can perfectly well be a called-off trip (start visit 1, cancel it,
-- rebook as visit 2; staging holds 263 cancelled job visits today), and stamping one writes a
-- start time onto a trip nobody made, which is then that job's per-visit history for ever.
-- Excluding it from only one half would be worse than neither: the MIN would pick a row the
-- filter refuses, and the job's stamps would be silently dropped instead of moved.
--
-- One statement per column rather than one three-column UPDATE: each is guarded on the exact
-- state it changes, so a job that got on site but never started re-runs cleanly.
UPDATE "visits" v
SET "en_route_at" = j."en_route_at"
FROM "jobs" j
WHERE v."job_id" = j."id"
  AND v."status" <> 'CANCELLED'
  AND v."visit_seq" = (
    SELECT MIN(v2."visit_seq") FROM "visits" v2
    WHERE v2."job_id" = j."id" AND v2."status" <> 'CANCELLED'
  )
  AND v."en_route_at" IS NULL
  AND j."en_route_at" IS NOT NULL;

UPDATE "visits" v
SET "on_site_at" = j."on_site_at"
FROM "jobs" j
WHERE v."job_id" = j."id"
  AND v."status" <> 'CANCELLED'
  AND v."visit_seq" = (
    SELECT MIN(v2."visit_seq") FROM "visits" v2
    WHERE v2."job_id" = j."id" AND v2."status" <> 'CANCELLED'
  )
  AND v."on_site_at" IS NULL
  AND j."on_site_at" IS NOT NULL;

UPDATE "visits" v
SET "started_at" = j."started_at"
FROM "jobs" j
WHERE v."job_id" = j."id"
  AND v."status" <> 'CANCELLED'
  AND v."visit_seq" = (
    SELECT MIN(v2."visit_seq") FROM "visits" v2
    WHERE v2."job_id" = j."id" AND v2."status" <> 'CANCELLED'
  )
  AND v."started_at" IS NULL
  AND j."started_at" IS NOT NULL;

-- ─── 2. Rows first, type second (D12's stated migration) ──────────────────────
--
-- Every job sitting at EN_ROUTE or ON_SITE moves to IN_PROGRESS. Guarded on the old type still
-- being in place, so a re-run after the swap in step 3 does nothing (and cannot: the literals no
-- longer parse).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE') THEN
    UPDATE "jobs" SET "status" = 'IN_PROGRESS' WHERE "status" IN ('EN_ROUTE', 'ON_SITE');
  END IF;
END $$;

-- The step that is easy to miss: JobSubStatus.parent is a USAGE of JobStatus, with
-- @@unique([organization_id, parent, label]). Re-parenting an EN_ROUTE/ON_SITE row onto
-- IN_PROGRESS can therefore COLLIDE with a row that already carries the same label in the same
-- org, and the ALTER in step 3 would fail on a live database while passing on an empty one.
--
-- TWO retired parents collapse onto ONE, so the collision is NOT only doomed-against-an-existing
-- -IN_PROGRESS-row. An org holding the same label under EN_ROUTE *and* under ON_SITE, with no
-- IN_PROGRESS row at all, has two doomed rows that collide WITH EACH OTHER. A rewrite keyed only
-- on an existing survivor repoints neither and deletes neither, so both fall through to step (c)
-- and the unique index aborts the migration - on a live database, while passing on an empty one.
--
-- So the survivor is ELECTED per (organization_id, label) across the union of every row that will
-- end up parented on IN_PROGRESS: the row already there wins, otherwise the lowest-id retired row.
-- Both the repoint and the delete key on that same election, which makes the two cases one case.
--
-- Order matters and each of the three steps is guarded on its own precondition:
--   (a) repoint every job that points at a losing row onto its elected survivor,
--   (b) delete the losing rows (now unreferenced),
--   (c) re-parent whatever is left - at most one row per (organization_id, label), so it cannot
--       collide.
--
-- REJECTED ALTERNATIVE: re-parent first and let the unique index reject the collisions. That
-- aborts the whole migration on exactly the orgs that customised their sub-statuses most, which is
-- the worst possible population to fail on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'job_sub_statuses') THEN

    -- (a)
    UPDATE "jobs" j
    SET "sub_status_id" = elected."survivor_id"
    FROM "job_sub_statuses" doomed
    JOIN LATERAL (
      SELECT s."id" AS "survivor_id"
      FROM "job_sub_statuses" s
      WHERE s."organization_id" = doomed."organization_id"
        AND s."label" = doomed."label"
        AND s."parent" IN ('EN_ROUTE', 'ON_SITE', 'IN_PROGRESS')
      ORDER BY (s."parent" = 'IN_PROGRESS') DESC, s."id"
      LIMIT 1
    ) elected ON TRUE
    WHERE j."sub_status_id" = doomed."id"
      AND doomed."parent" IN ('EN_ROUTE', 'ON_SITE')
      AND elected."survivor_id" <> doomed."id";

    -- (b)
    DELETE FROM "job_sub_statuses" doomed
    WHERE doomed."parent" IN ('EN_ROUTE', 'ON_SITE')
      AND doomed."id" <> (
        SELECT s."id"
        FROM "job_sub_statuses" s
        WHERE s."organization_id" = doomed."organization_id"
          AND s."label" = doomed."label"
          AND s."parent" IN ('EN_ROUTE', 'ON_SITE', 'IN_PROGRESS')
        ORDER BY (s."parent" = 'IN_PROGRESS') DESC, s."id"
        LIMIT 1
      );

    -- (c)
    UPDATE "job_sub_statuses" SET "parent" = 'IN_PROGRESS' WHERE "parent" IN ('EN_ROUTE', 'ON_SITE');
  END IF;
END $$;

-- ─── 3. The enum swap (D17) ───────────────────────────────────────────────────
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so retiring two labels means building the new type
-- and moving every column onto it. Same shape as 20260817130000's VisitStatus cutover.
--
-- BOTH columns that use the type are moved: jobs.status and job_sub_statuses.parent. Missing the
-- second leaves the old type undroppable and the two halves of the schema disagreeing.
--
-- RLS: no table is created or renamed, so the tenant_isolation policies from
-- 20260703000100_tenant_rls stay attached to both tables untouched. ALTER COLUMN ... TYPE does not
-- disturb a policy or a grant, and re-issuing either would risk a non-idempotent re-run.
-- EVERY block below is guarded on state the FIRST application consumes, which is what makes the
-- second one a no-op. `IF NOT EXISTS (typname = 'JobStatus_new')` alone would NOT: the rename at
-- the end of this step takes that name away again, so a second pass finds the guard true, re-creates
-- the temp type and rewrites `jobs` and `job_sub_statuses` under ACCESS EXCLUSIVE - and the moment
-- any later migration adds a second dependent on the enum, that second pass reaches DROP TYPE with
-- the dependency still attached and aborts, leaving `jobs.status` typed `JobStatus_new`, a name
-- Prisma does not recognise. So the create is guarded on the RETIRED LABEL still being present
-- (step 2's guard, verbatim) and the two column moves on the temp type actually existing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'JobStatus' AND e.enumlabel = 'ON_SITE')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new') THEN
    CREATE TYPE "JobStatus_new" AS ENUM
      ('UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new')
     AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jobs' AND column_name = 'status' AND udt_name = 'JobStatus'
  ) THEN
    ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "jobs" ALTER COLUMN "status" TYPE "JobStatus_new" USING "status"::text::"JobStatus_new";
    ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'UNSCHEDULED';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new')
     AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'job_sub_statuses' AND column_name = 'parent' AND udt_name = 'JobStatus'
  ) THEN
    ALTER TABLE "job_sub_statuses" ALTER COLUMN "parent" DROP DEFAULT;
    ALTER TABLE "job_sub_statuses" ALTER COLUMN "parent" TYPE "JobStatus_new" USING "parent"::text::"JobStatus_new";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus')
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'JobStatus_new') THEN
    DROP TYPE "JobStatus";
    ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
  END IF;
END $$;

-- ─── 4. Saved job-table filters (the JSONB class) ─────────────────────────────
--
-- CLAUDE.md flags this class - a value persisted as a JSON string is not reached by an enum or
-- column change - as having bitten this project three times, so it was checked rather than
-- assumed. WHAT WAS ACTUALLY FOUND, recorded so the next reader does not re-derive it:
--
--   user_table_preferences.config is the ONLY JSONB store that could hold a JobStatus, and its
--   written shape is { version, columns: { <colKey>: { width, visible, manuallySized } } } -
--   see tableViewConfigSchema in backend/src/controllers/table-view.controller.ts, the only
--   writer. It holds COLUMN LAYOUT, not filter values. There is no saved-view or saved-filter
--   model in the schema at all: the jobs list's status multi-select lives in the URL and in
--   client state, so a stale "ON_SITE" degrades to a dropped facet value (jobFacets in
--   backend/src/lib/query/registries/job.filters.ts filters unknown literals out rather than
--   passing them to Prisma), never to a broken query.
--
--   The S0 precedent at 20260817120000 step 3 rewrote this table on the assumption that it held
--   saved filters. That step was harmless but inert for the same reason.
--
-- So the statement below is a GUARD, not a repair: it fires only if a `filters.status` array ever
-- does appear under the jobs key, and does nothing today.
--
-- REJECTED ALTERNATIVE: copy the S0 precedent's REPLACE(config::text, '"EN_ROUTE"',
-- '"IN_PROGRESS"'). It would be WRONG here even if the data existed, and this is the reason worth
-- writing down: TWO values map onto ONE, so an array already containing IN_PROGRESS - or
-- containing both retired values - ends up with a duplicated token. The array is REBUILT instead:
-- explode it, map the two retired values onto IN_PROGRESS, take the distinct set, aggregate back.
-- Guarded on the tokens actually being present, so a re-run touches nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_table_preferences') THEN
    UPDATE "user_table_preferences" p
    SET "config" = jsonb_set(
      p."config",
      '{filters,status}',
      COALESCE(
        (
          SELECT jsonb_agg(DISTINCT mapped)
          FROM jsonb_array_elements_text(p."config" #> '{filters,status}') AS raw(value),
          LATERAL (
            SELECT CASE WHEN raw.value IN ('EN_ROUTE', 'ON_SITE') THEN 'IN_PROGRESS' ELSE raw.value END
          ) AS m(mapped)
        ),
        '[]'::jsonb
      )
    )
    WHERE p."table_key" = 'jobs'
      AND jsonb_typeof(p."config" #> '{filters,status}') = 'array'
      AND (p."config"::text LIKE '%"EN_ROUTE"%' OR p."config"::text LIKE '%"ON_SITE"%');
  END IF;
END $$;

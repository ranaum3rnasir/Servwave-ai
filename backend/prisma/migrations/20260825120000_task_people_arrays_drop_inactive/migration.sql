-- Backfill: drop dangling user ids out of tasks.assignee_ids / tasks.watcher_ids.
--
-- Both columns are uuid[]. An array carries no foreign key, so nothing ever removed a user's id
-- when that user was deactivated, and until this release nothing tried. The result is tasks
-- assigned to people who no longer work there - and, worse, tasks whose ONLY assignee is
-- deactivated: they satisfy the ">= 1 assignee" invariant while being assigned to nobody real, so
-- they fall off every workload view and nobody is accountable for them.
--
-- The source of the leak is closed in backend/src/lib/tasks/deactivation.ts, which runs on the
-- `is_active -> false` transition. This file repairs what accumulated before that existed, using
-- the SAME rule, written there as the pure `applyTaskPeopleRule`. What differs is the SCOPE, not
-- the rule: that function sees only the tasks naming the one user being deactivated, in that
-- user's org, and it also writes timeline entries and fires notifications, which a backfill has
-- no actor to attribute. Anything else that comes apart is a defect in one of the two;
-- backend/src/lib/tasks/__tests__/task-people-rule.test.ts re-reads the predicates below.
-- If you change one, change the other:
--
--   * remove from `watcher_ids` every id that is not an active user of the task's own org;
--   * remove the same ids from `assignee_ids`;
--   * if that empties `assignee_ids`, do NOT leave it empty - fall back to the task's `created_by`
--     when that person is still active in the same org, otherwise escalate to the org's
--     longest-serving active ADMIN (`role = 'ADMIN'`, `is_active`, ORDER BY created_at, id);
--   * if the org has no active ADMIN at all, leave `assignee_ids` exactly as it was. A dangling id
--     is bad; an empty list is worse, because it is invisible to every view rather than merely
--     wrong in one. These rows are counted and reported as "stranded".
--
-- ONE thing the two do differently, so the "same rule" above is not read as more than it is:
-- `ARRAY(SELECT ... unnest)` below preserves duplicates, while `toIdSet` on the TypeScript side
-- de-duplicates. `{a,a}` with `a` still active stays `{a,a}` here and becomes `[a]` there. Both
-- satisfy the ">= 1 assignee" invariant, no writer produces a duplicate in the first place, and a
-- DISTINCT here would also throw away the array's order - so it is left alone deliberately.
--
-- Org scoping is explicit throughout (`u.organization_id = t.organization_id`): an id that names
-- an active user of a DIFFERENT tenant is just as dangling as one that names nobody, and must not
-- be kept on the strength of being active somewhere else.
--
-- Portable (no Supabase-only objects) and idempotent: the predicate is "this task still names a
-- non-active user", which a successful first run makes false. A second run updates 0 rows and
-- re-reports the same stranded count. Runs in three places - CI's vanilla postgres, Render's
-- `migrate deploy`, and by hand via Supabase MCP - and the shared staging DB may see it twice.
DO $$
DECLARE
  v_watch_rows     bigint := 0;
  v_assign_rows    bigint := 0;
  v_keep_partial   bigint := 0;
  v_to_creator     bigint := 0;
  v_to_admin       bigint := 0;
  v_stranded       bigint := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    -- current_schema(), not any schema: the unqualified `tasks` below resolves through
    -- search_path, so a same-named table in another schema must not answer this guard.
    WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'assignee_ids'
  ) THEN
    RAISE NOTICE 'task people-array backfill: tasks.assignee_ids absent, nothing to do';
    RETURN;
  END IF;

  -- ── watcher_ids ─────────────────────────────────────────────────────────────────────────────
  -- Pure removal. Watchers are observers; there is no minimum and nothing to repair.
  WITH stale AS (
    SELECT t.id,
           ARRAY(
             SELECT w FROM unnest(t.watcher_ids) AS w
             WHERE EXISTS (
               SELECT 1 FROM users u
               WHERE u.id = w AND u.is_active AND u.organization_id = t.organization_id
             )
           ) AS keep
    FROM tasks t
    WHERE EXISTS (
      SELECT 1 FROM unnest(t.watcher_ids) AS w
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = w AND u.is_active AND u.organization_id = t.organization_id
      )
    )
  )
  UPDATE tasks t SET watcher_ids = s.keep
  FROM stale s
  WHERE t.id = s.id;
  GET DIAGNOSTICS v_watch_rows = ROW_COUNT;

  -- ── assignee_ids ────────────────────────────────────────────────────────────────────────────
  -- Materialised first so the counts below and the UPDATE agree by construction rather than by
  -- two hand-written copies of the same predicate.
  -- pg_temp-qualified: unqualified, this resolves through search_path, and on a FIRST run in a
  -- session that has no temp table yet it would find - and silently drop - a permanent table of
  -- the same name in the migration's own schema.
  DROP TABLE IF EXISTS pg_temp.tmp_task_assignee_backfill;
  CREATE TEMP TABLE tmp_task_assignee_backfill AS
  WITH candidate AS (
    SELECT t.id, t.created_by, t.organization_id,
           ARRAY(
             SELECT a FROM unnest(t.assignee_ids) AS a
             WHERE EXISTS (
               SELECT 1 FROM users u
               WHERE u.id = a AND u.is_active AND u.organization_id = t.organization_id
             )
           ) AS keep
    FROM tasks t
    WHERE EXISTS (
      SELECT 1 FROM unnest(t.assignee_ids) AS a
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = a AND u.is_active AND u.organization_id = t.organization_id
      )
    )
  )
  SELECT c.id,
         c.keep,
         f.fallback,
         CASE
           WHEN cardinality(c.keep) > 0   THEN 'kept'
           WHEN f.fallback IS NULL        THEN 'stranded'
           WHEN f.fallback = c.created_by THEN 'creator'
           ELSE 'admin'
         END AS reason
  FROM candidate c
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN cardinality(c.keep) > 0 THEN NULL::uuid
      WHEN EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = c.created_by AND u.is_active AND u.organization_id = c.organization_id
      ) THEN c.created_by
      ELSE (
        SELECT u.id FROM users u
        WHERE u.organization_id = c.organization_id AND u.role = 'ADMIN' AND u.is_active
        ORDER BY u.created_at ASC, u.id ASC
        LIMIT 1
      )
    END AS fallback
  ) f;

  SELECT count(*) FILTER (WHERE reason = 'kept'),
         count(*) FILTER (WHERE reason = 'creator'),
         count(*) FILTER (WHERE reason = 'admin'),
         count(*) FILTER (WHERE reason = 'stranded')
    INTO v_keep_partial, v_to_creator, v_to_admin, v_stranded
  FROM tmp_task_assignee_backfill;

  -- `reason = 'stranded'` rows are deliberately excluded: they keep their original array.
  UPDATE tasks t
  SET assignee_ids = CASE WHEN cardinality(b.keep) > 0 THEN b.keep ELSE ARRAY[b.fallback] END
  FROM tmp_task_assignee_backfill b
  WHERE t.id = b.id
    AND b.reason <> 'stranded';
  GET DIAGNOSTICS v_assign_rows = ROW_COUNT;

  DROP TABLE IF EXISTS pg_temp.tmp_task_assignee_backfill;

  RAISE NOTICE 'task people-array backfill: watcher_ids rewritten on % task(s); assignee_ids rewritten on % task(s) (% kept a surviving assignee, % handed to the creator, % escalated to an admin); % task(s) STRANDED with no active admin to escalate to and left unchanged',
    v_watch_rows, v_assign_rows, v_keep_partial, v_to_creator, v_to_admin, v_stranded;
END $$;

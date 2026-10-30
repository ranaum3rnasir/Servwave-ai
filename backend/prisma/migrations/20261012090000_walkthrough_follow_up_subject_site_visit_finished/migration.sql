-- S04.20 (Roles & Permissions, PRD 4): the walkthrough follow-up email's subject becomes "Site Visit Finished".
-- Data only: no schema change.
--
-- A walkthrough is a visit on a lead and takes the visit word, so the default follow-up email sent to the customer
-- after a walkthrough is finished (builtin_key 'default-walkthrough-completed', seeded into every company) has the
-- subject "Site Visit Finished" instead of "Site Visit Completed". defaultAutomations.ts carries the new subject for
-- a company seeded from now on; this file changes the copy every existing company already holds.
--
-- WHERE THE SUBJECT LIVES (the same two places as every automation's copy):
--   workflow_steps.config         jsonb {recipients, subject, body, fallbacks}: what the builder shows and the next
--                                 publish freezes.
--   workflow_versions.definition  jsonb {..., steps:[{position, step_type, config:{...}}]}: the frozen copy the
--                                 engine renders.
-- Both are rewritten, or the builder and the email would disagree.
--
-- A SUBJECT THE COMPANY EDITED STAYS AS WRITTEN. Only a subject that is still byte-identical to the old default is
-- rewritten; any other subject, including an edited one, never matches. The frozen versions of a workflow are
-- rewritten only when its live step still holds the old default, so a company that edited the subject keeps every
-- version exactly as it was, older ones included.
--
-- ONLY THE BUILT-IN. Matching is on workflows.builtin_key, so a gallery copy or a hand-built automation that happens
-- to share the words is never touched. workflow_step_runs.detail is history of mail already sent and is not touched.
--
-- IDEMPOTENT: after one run nothing holds the old subject on that built-in, so a second run matches nothing and
-- changes nothing. PORTABLE: plain SQL on vanilla postgres:16; no vendor roles, extensions or secrets. On CI the
-- tables are empty and every statement is a no-op.
-- RLS HAZARD: workflows, workflow_steps and workflow_versions carry FORCE ROW LEVEL SECURITY. A role that does not
-- bypass it would report "UPDATE 0" silently, so the bypass flag is set for this transaction and the post-condition
-- at the foot RAISES rather than passing quietly.
-- NEVER run `prisma migrate` from a worktree.

DO $$
DECLARE
  old_subject constant text := 'Site Visit Completed';
  new_subject constant text := 'Site Visit Finished';
  left_over integer;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);

  -- 1. The frozen versions first, while the live step still tells us which companies left the default alone.
  UPDATE workflow_versions v
  SET definition = jsonb_set(
        v.definition,
        '{steps}',
        (
          SELECT jsonb_agg(
                   CASE
                     WHEN e.step->'config'->>'subject' = old_subject
                       THEN jsonb_set(e.step, '{config,subject}', to_jsonb(new_subject))
                     ELSE e.step
                   END
                   ORDER BY e.ord
                 )
          FROM jsonb_array_elements(v.definition->'steps') WITH ORDINALITY AS e(step, ord)
        )
      )
  FROM workflows w
  WHERE v.workflow_id = w.id
    AND w.builtin_key = 'default-walkthrough-completed'
    AND jsonb_typeof(v.definition->'steps') = 'array'
    AND EXISTS (
      SELECT 1 FROM workflow_steps s
      WHERE s.workflow_id = w.id AND s.config->>'subject' = old_subject)
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v.definition->'steps') AS e(step)
      WHERE e.step->'config'->>'subject' = old_subject);

  -- 2. The live step rows.
  UPDATE workflow_steps s
  SET config = jsonb_set(s.config, '{subject}', to_jsonb(new_subject))
  FROM workflows w
  WHERE s.workflow_id = w.id
    AND w.builtin_key = 'default-walkthrough-completed'
    AND s.config->>'subject' = old_subject;

  -- 3. Post-condition: no live step of the built-in still holds the old default. A survivor would mean the rows were
  --    invisible to this transaction (row level security), and the deploy should stop rather than carry a green row.
  SELECT count(*) INTO left_over
  FROM workflow_steps s
  JOIN workflows w ON w.id = s.workflow_id
  WHERE w.builtin_key = 'default-walkthrough-completed'
    AND s.config->>'subject' = old_subject;

  IF left_over > 0 THEN
    RAISE EXCEPTION
      'walkthrough_follow_up_subject_site_visit_finished: % walkthrough follow-up step(s) still carry the old default subject',
      left_over;
  END IF;
END $$;

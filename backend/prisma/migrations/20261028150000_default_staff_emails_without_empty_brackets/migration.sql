-- Roles & Permissions security, M4 follow-up (ticket 35), M15: the two built-in staff emails stop carrying a total.
--
-- "Estimate approved - notify creator" and "Estimate declined - notify creator" (builtin_key default-estimate-approved-notify-creator
-- and default-estimate-declined-notify-creator) were seeded with a body that ends "... estimate {{estimate.number}} ({{estimate.total}})."
-- Ran ruled (2026-10-28) that these staff emails carry NO total for anyone: a teammate without See prices read "... estimate E-1 ()."
-- and a teammate with it was told a figure the notice never needed. The shipped wording is now
--
--     {{customer.full_name}} approved estimate {{estimate.number}}.
--
-- (and the same with "declined"), with no Total line and no fallback. This migration writes that into the copies companies already
-- hold, and ONLY where the copy still EXACTLY equals the old shipped text. A copy a company has edited (the body is different in any
-- way) is never touched.
--
-- What is rewritten, and why (seedDefaultAutomations.ts freezes the body in two places):
--   * workflow_steps.config for position 0: the step the builder opens and the next publish copies from.
--   * the workflow's PUBLISHED workflow_versions row: the frozen definition the engine actually sends from (enrollment.ts reads
--     enrollment.version.definition). A version is history, so it is never edited: a NEW version (max + 1) carrying the rewritten
--     definition is appended and workflows.published_version_id is pointed at it and published_at set, the way a publish does. Older versions, and any
--     run already enrolled on one, keep the text they were sent with. This is the workflow's own history; nothing is written to
--     audit_logs (append-only since M14) or any other table.
--   Step and version are judged separately: a copy edited as a draft but still published as shipped gets its published version
--   moved and its draft left alone, and the other way round.
--
-- DATA ONLY, no schema change. IDEMPOTENT: after one run no copy equals the old text, so a second run selects nothing. SET-BASED.
-- Times are written in UTC (the columns are timestamp without time zone, which Prisma reads as UTC whatever the session zone is).
-- Portable plain PostgreSQL (jsonb operators and gen_random_uuid(), core since PG 13). NEVER run `prisma migrate` from a worktree.

DO $m15$
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);
  -- Never queue every publish behind this one: give up after 5 seconds instead (a failed run changes nothing).
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TEMP TABLE m15_default (builtin_key text PRIMARY KEY, old_body text NOT NULL, new_body text NOT NULL) ON COMMIT DROP;
  INSERT INTO m15_default (builtin_key, old_body, new_body) VALUES
    ('default-estimate-approved-notify-creator',
     '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}).',
     '{{customer.full_name}} approved estimate {{estimate.number}}.'),
    ('default-estimate-declined-notify-creator',
     '{{customer.full_name}} declined estimate {{estimate.number}} ({{estimate.total}}).',
     '{{customer.full_name}} declined estimate {{estimate.number}}.');

  -- 1. The step each company's builder opens.
  UPDATE workflow_steps s
     SET config = jsonb_set(s.config, '{body}', to_jsonb(d.new_body))
    FROM workflows w
    JOIN m15_default d ON d.builtin_key = w.builtin_key
   WHERE s.workflow_id = w.id
     AND s.position = 0
     AND s.step_type = 'SEND_EMAIL'
     AND jsonb_typeof(s.config) = 'object'
     AND s.config ->> 'body' = d.old_body;

  -- 2. The published version each company sends from: append a new version and point the workflow at it.
  WITH due AS (
    SELECT w.id AS workflow_id, w.organization_id, v.definition, d.new_body,
           (SELECT max(x.version) FROM workflow_versions x WHERE x.workflow_id = w.id) + 1 AS next_version
      FROM workflows w
      JOIN m15_default d ON d.builtin_key = w.builtin_key
      JOIN workflow_versions v ON v.id = w.published_version_id
     WHERE jsonb_typeof(v.definition -> 'steps') = 'array'
       AND v.definition #>> '{steps,0,step_type}' = 'SEND_EMAIL'
       AND v.definition #>> '{steps,0,config,body}' = d.old_body
  ),
  added AS (
    INSERT INTO workflow_versions (id, workflow_id, version, definition, published_at, published_by_id, organization_id)
    SELECT gen_random_uuid(), due.workflow_id, due.next_version,
           jsonb_set(due.definition, '{steps,0,config,body}', to_jsonb(due.new_body)),
           now() AT TIME ZONE 'UTC', NULL, due.organization_id
      FROM due
    RETURNING id, workflow_id
  )
  UPDATE workflows w
     SET published_version_id = added.id, published_at = now() AT TIME ZONE 'UTC', updated_at = now() AT TIME ZONE 'UTC'
    FROM added
   WHERE w.id = added.workflow_id;
END
$m15$;

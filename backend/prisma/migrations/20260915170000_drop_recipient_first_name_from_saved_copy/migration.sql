-- Rewrite every saved automation body that still says {{recipient.first_name}} -- 2026-09-15.
--
-- WHY THIS FILE EXISTS AT ALL.
--
-- Ran removed the `{{recipient.first_name}}` merge field outright on 2026-09-15. The reasoning
-- is recorded on `BASE` in backend/src/services/automations/catalog.ts: the builder offers one
-- merge-field list per TRIGGER, a trigger has no audience (the audience is chosen per STEP), so
-- the field was offered on customer-facing copy as well as staff copy, and on the customer half
-- it is at best a duplicate of {{customer.first_name}} and at worst worse than it -- that field
-- carries a fallback ("there"), this one never did, so a company customer with no first name on
-- record read "Hi ,".
--
-- Removing it from the catalogue is a CODE change and it does not touch a single saved row.
-- Editing defaultAutomations.ts changes what a NEW organisation is seeded with; the nine bodies
-- already written into every existing organisation's database keep the token. Two things then
-- go wrong, and they go wrong in opposite directions:
--
--   RENDERING. `renderMergeFields` leaves an UNKNOWN field LITERAL by design -- that is what
--   stops {{constructor}} and {{__proto__}} resolving to functions. The field's value used to be
--   injected into the render context by executors.ts; that injection is gone with the field, so
--   the token is now unknown, and a saved body that still holds it MAILS THE RAW BRACES to a
--   real technician. Silently, with nothing red anywhere. This is the damaging half.
--
--   SAVING. `workflowValidation.ts` refuses a body referencing any field outside
--   TRIGGERS[t].mergeFields, so the same row is also UNPUBLISHABLE: the office opens their
--   automation, changes one word, and cannot save it, with an error naming a field the builder
--   no longer offers them. This is the baffling half.
--
-- Both are pinned by tests rather than described: executors.test.ts asserts the raw braces, and
-- workflowValidation.test.ts asserts the refusal. This file is what stops either being reached.
--
-- WHERE AUTOMATION COPY ACTUALLY LIVES, since it is not one place:
--
--   workflow_steps.config           jsonb {recipients, subject, body, fallbacks} -- the row the
--                                   BUILDER reads and the next publish freezes.
--   workflow_versions.definition    jsonb {..., steps:[{position, step_type, config:{...}}]} --
--                                   the FROZEN copy, and the one the engine actually renders
--                                   (enrollment.ts reads `enrollment.version.definition`).
--
-- Both are rewritten. Rewriting only the steps would leave every already-enrolled run sending
-- the raw braces; rewriting only the versions would leave the builder showing copy that cannot
-- be saved. A workflow can hold many versions and many steps, so nothing here assumes one of
-- either.
--
-- DELIBERATELY NOT REWRITTEN: workflow_step_runs.detail. That column holds a preview of a
-- message that ALREADY WENT OUT. It is history, not copy -- if a technician really did receive
-- "Hi {{recipient.first_name}}" last week, the run history must keep saying so.
--
-- ALSO NOT REWRITTEN: automation_rules.action_config, the pre-workflow legacy table. Nothing
-- reads it -- `foldRuleToWorkflow` in migrateRules.ts is a pure function with no non-test
-- caller -- so a token left there renders nowhere and validates nowhere. If that importer is
-- ever wired up again it must strip the token on the way through; there is a note on the
-- function saying so. Touching the rows here would be a write with no reader.
--
-- TWO PASSES, AND WHY THE ORDER MATTERS.
--
-- PASS 1 restores the nine BUILT-IN bodies to the exact new copy in defaultAutomations.ts, and
-- only where the stored body is still byte-identical to the old seeded string. An organisation
-- that EDITED their copy no longer matches, is left alone here, and falls through to pass 2 --
-- their wording is theirs, and a built-in key is not a licence to overwrite it. Pass 1 exists
-- so the overwhelmingly common case (nobody touched it) gets hand-written prose rather than
-- mechanical surgery: "You have been assigned to job J00042", not "Hi, you have been assigned".
--
-- PASS 2 is the generic, shape-agnostic removal for everything left: edited built-ins, bodies
-- copied out of the gallery recipes, and ordinary author-written automations. AUTHOR-WRITTEN
-- ROWS GENUINELY EXIST AND ARE NOT A HYPOTHETICAL: until this release the chip was offered in
-- the builder on EVERY trigger and the validator accepted it, so any admin could put it in any
-- body or subject of any automation. This file finds them the only way they can be found, by
-- the token text itself, and treats them the same way in both tables.
--
-- WHAT PASS 2 CANNOT DO, STATED PLAINLY RATHER THAN PAPERED OVER. It edits prose it did not
-- write. `_srvw_strip_recipient_field` deletes the token and repairs the punctuation and
-- spacing immediately around it, which is exactly right for the greeting shape that all nine
-- built-ins and every gallery recipe used ("Hi {{recipient.first_name}}, you..." becomes
-- "Hi, you...") and for a trailing one ("Hello {{recipient.first_name}}!" becomes "Hello!").
-- It CANNOT restore a sentence that was built around the name: "Task assigned to
-- {{recipient.first_name}}" becomes "Task assigned to", which is clipped English. That is
-- accepted knowingly, because every alternative is worse: leaving the row mails raw braces and
-- bricks the editor, substituting {{customer.first_name}} is wrong on a staff send and is not
-- even legal on a task trigger (TASK_BASE has no customer fields), and substituting a literal
-- word puts a name-shaped noun where the author's own name field was. A clipped sentence is
-- readable, saveable, and obvious to the admin who wrote it. THE ROWS THIS APPLIES TO ARE
-- LISTED BY THE PRE-FLIGHT QUERY BELOW so they can be read before the apply rather than
-- discovered after it.
--
-- IDEMPOTENT. Every statement is guarded on the token still being present, so a second apply
--   matches nothing and changes nothing -- which matters, because the shared staging database
--   can see a migration twice. Note this is also why the tidy-up regexes are inside the
--   function rather than applied table-wide: a row that never contained the token is never
--   touched, so no unrelated body has its spacing "corrected".
-- PORTABLE. Plain SQL on vanilla postgres:16 (CI's migrations + RLS gate). No hosted-only
--   roles, policies or auth schema references, no extensions, no secrets. On CI every table
--   involved is empty and every statement is a no-op.
-- RLS HAZARD. workflows/workflow_steps/workflow_versions carry FORCE ROW LEVEL SECURITY
--   (20260703000100_tenant_rls). A NOBYPASSRLS role running this file reports "UPDATE 0"
--   SILENTLY, so a green _prisma_migrations ledger row is NOT evidence the rows were rewritten.
--   The assertion at the foot is what makes that impossible to miss: it RAISES rather than
--   passing quietly, so a migration that saw nothing fails the deploy instead of leaving every
--   organisation mailing raw braces.
--
-- PRE-FLIGHT / VERIFICATION QUERY (read-only, organization_id only, never an org name). Run it
-- BEFORE the apply to see what pass 2 will touch, and AFTER to confirm it returns nothing:
--
--   SELECT w.organization_id, w.id AS workflow_id, w.builtin_key, s.position,
--          left(s.config->>'body', 120) AS body
--   FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
--   WHERE s.config->>'body'    LIKE '%{{recipient.first_name}}%'
--      OR s.config->>'subject' LIKE '%{{recipient.first_name}}%'
--   UNION ALL
--   SELECT w.organization_id, w.id, w.builtin_key, v.version,
--          left(v.definition::text, 120)
--   FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
--   WHERE v.definition::text LIKE '%{{recipient.first_name}}%'
--   ORDER BY 1, 2, 4;
--
-- A row whose builtin_key IS NULL, or whose body is not one of the nine strings below, is an
-- author-written or edited body and is the population pass 2 rewrites mechanically.

-- ── Helpers. Created here, used by both passes, and DROPPED at the foot of this file so the
--    migration leaves no objects behind. `CREATE OR REPLACE` rather than `CREATE`, so a
--    re-apply after a partial failure is clean.

-- Remove the retired token from one piece of copy and repair what its removal leaves behind.
--
-- The passes, innermost first, and each one exists for a shape that was really in the data:
--   1. token + the punctuation that followed it  -> keep the punctuation, drop the token.
--      "Hi {{recipient.first_name}}, you have"   -> "Hi, you have"      (all nine built-ins)
--      "Hello {{recipient.first_name}}!"         -> "Hello!"
--   2. any token left (nothing punctuated it)    -> a single space, tidied by 3-6.
--   3. runs of blanks left by 1 and 2            -> one blank. [[:blank:]] is space+tab and
--      deliberately NOT [[:space:]], which would eat the newlines that separate the paragraphs
--      of the multi-line gallery bodies.
--   4. blanks now stranded before a newline      -> dropped, same reason.
--   5. a separator orphaned at the very start    -> dropped. ("{{recipient.first_name}}, please"
--      would otherwise become ", please".)
--   6. horizontal whitespace at either end       -> trimmed, newlines left alone.
CREATE OR REPLACE FUNCTION _srvw_strip_recipient_field(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace($1,
                     '[[:blank:]]*\{\{recipient\.first_name\}\}[[:blank:]]*([,;:.!?])[[:blank:]]*', '\1 ', 'g'),
                   '[[:blank:]]*\{\{recipient\.first_name\}\}[[:blank:]]*', ' ', 'g'),
                 '[[:blank:]]{2,}', ' ', 'g'),
               '[[:blank:]]+(' || chr(10) || ')', '\1', 'g'),
             '^[[:blank:]]*[,;:][[:blank:]]*', '', ''),
           E' \t')
$fn$;

-- The same, over one send step's stored config object.
--
-- Guarded on jsonb_typeof rather than on `?`: `jsonb_set` returns NULL -- blanking the WHOLE
-- config -- if its new value is NULL, which is what a missing or non-string `body` would
-- produce. A SEND_SMS step legitimately has no `subject` at all, so that branch is reached on
-- real rows and not just defensively.
CREATE OR REPLACE FUNCTION _srvw_strip_recipient_config(cfg jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE out jsonb := cfg;
BEGIN
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' THEN
    RETURN cfg;
  END IF;
  IF jsonb_typeof(cfg->'body') = 'string' THEN
    out := jsonb_set(out, '{body}', to_jsonb(_srvw_strip_recipient_field(cfg->>'body')));
  END IF;
  IF jsonb_typeof(cfg->'subject') = 'string' THEN
    out := jsonb_set(out, '{subject}', to_jsonb(_srvw_strip_recipient_field(cfg->>'subject')));
  END IF;
  RETURN out;
END
$fn$;

-- The nine built-in bodies, old text and new, byte-exact.
--
-- CANONICAL SOURCE is backend/src/services/automations/defaultAutomations.ts -- this table is a
-- copy, and a copy of copy drifts. `automation-recipient-field-removal.test.ts` reads this file
-- and asserts every `new_body` here is byte-identical to the registry entry with that
-- builtin_key, so editing one without the other is a red test rather than an organisation left
-- on prose nobody chose.
CREATE OR REPLACE FUNCTION _srvw_recipient_builtin_bodies()
RETURNS TABLE (builtin_key text, old_body text, new_body text)
LANGUAGE sql IMMUTABLE AS $fn$
  VALUES
    ('default-tech-assigned',
     'Hi {{recipient.first_name}}, you have been assigned to job {{job.number}} for {{customer.full_name}} at {{job.address}}, scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Scope: {{job.scope_notes}}',
     'You have been assigned to job {{job.number}} for {{customer.full_name}} at {{job.address}}, scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Scope: {{job.scope_notes}}'),
    ('default-tech-unassigned',
     'Hi {{recipient.first_name}}, you have been removed from job {{job.number}} for {{customer.full_name}}. No further action is required.',
     'You have been removed from job {{job.number}} for {{customer.full_name}}. No further action is required.'),
    ('default-walkthrough-performer-assigned',
     'Hi {{recipient.first_name}}, you have been assigned a walkthrough for {{customer.full_name}} ({{lead.number}}) at {{lead.address}} on {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.',
     'You have been assigned a walkthrough for {{customer.full_name}} ({{lead.number}}) at {{lead.address}} on {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.'),
    ('default-walkthrough-performer-removed',
     'Hi {{recipient.first_name}}, you have been removed from the walkthrough for {{customer.full_name}} ({{lead.number}}). No further action is required.',
     'You have been removed from the walkthrough for {{customer.full_name}} ({{lead.number}}). No further action is required.'),
    ('default-task-created',
     'Hi {{recipient.first_name}}, a new task has been assigned to you at {{org.name}}: {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}',
     'A new task has been assigned to you at {{org.name}}: {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}'),
    ('default-task-assigned',
     'Hi {{recipient.first_name}}, you have been added to task {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}',
     'You have been added to task {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}'),
    ('default-task-comment-added',
     'Hi {{recipient.first_name}}, somebody has commented on task {{task.number}} - {{task.title}}. Read it and reply here: {{task.link}}',
     'Somebody has commented on task {{task.number}} - {{task.title}}. Read it and reply here: {{task.link}}'),
    ('default-task-deleted',
     'Hi {{recipient.first_name}}, task {{task.number}} - {{task.title}} has been deleted at {{org.name}}. There is no longer any work to do on it and no further action is required.',
     'Task {{task.number}} - {{task.title}} has been deleted at {{org.name}}. There is no longer any work to do on it and no further action is required.'),
    ('default-task-due-reminder',
     'Hi {{recipient.first_name}}, task {{task.number}} - {{task.title}} is due {{task.due_date}}. Open it here: {{task.link}}',
     'Task {{task.number}} - {{task.title}} is due {{task.due_date}}. Open it here: {{task.link}}')
$fn$;

-- ── PASS 1: the untouched built-ins, restored to the copy someone wrote. ─────────────────────

-- 1a. The live step rows (what the builder shows).
UPDATE workflow_steps s
SET config = jsonb_set(s.config, '{body}', to_jsonb(b.new_body))
FROM workflows w, _srvw_recipient_builtin_bodies() b
WHERE s.workflow_id = w.id
  AND w.builtin_key = b.builtin_key
  AND s.config->>'body' = b.old_body;

-- 1b. The frozen versions (what the engine renders). Every step of every version is walked,
--     because a workflow may hold several versions and an author may have added steps to one;
--     `jsonb_agg(... ORDER BY ord)` rebuilds the array in its original order, and a step
--     carrying no `config` key is passed through untouched rather than having one set to null.
UPDATE workflow_versions v
SET definition = jsonb_set(
      v.definition,
      '{steps}',
      (
        SELECT jsonb_agg(
                 CASE
                   WHEN e.step ? 'config' AND e.step->'config'->>'body' = b.old_body
                     THEN jsonb_set(e.step, '{config,body}', to_jsonb(b.new_body))
                   ELSE e.step
                 END
                 ORDER BY e.ord
               )
        FROM jsonb_array_elements(v.definition->'steps') WITH ORDINALITY AS e(step, ord)
      )
    )
FROM workflows w, _srvw_recipient_builtin_bodies() b
WHERE v.workflow_id = w.id
  AND w.builtin_key = b.builtin_key
  AND jsonb_typeof(v.definition->'steps') = 'array'
  AND v.definition::text LIKE '%' || b.old_body || '%';

-- ── PASS 2: everything still carrying the token -- edited built-ins, gallery copies, and
--    author-written bodies and subjects. Mechanical, and described at length in the header.

-- 2a. The live step rows.
UPDATE workflow_steps
SET config = _srvw_strip_recipient_config(config)
WHERE config->>'body'    LIKE '%{{recipient.first_name}}%'
   OR config->>'subject' LIKE '%{{recipient.first_name}}%';

-- 2b. The frozen versions.
UPDATE workflow_versions v
SET definition = jsonb_set(
      v.definition,
      '{steps}',
      (
        SELECT jsonb_agg(
                 CASE
                   WHEN e.step ? 'config'
                     THEN jsonb_set(e.step, '{config}', _srvw_strip_recipient_config(e.step->'config'))
                   ELSE e.step
                 END
                 ORDER BY e.ord
               )
        FROM jsonb_array_elements(v.definition->'steps') WITH ORDINALITY AS e(step, ord)
      )
    )
WHERE v.definition::text LIKE '%{{recipient.first_name}}%'
  AND jsonb_typeof(v.definition->'steps') = 'array';

-- ── POST-CONDITION. Loud, not quiet. ────────────────────────────────────────────────────────
--
-- A survivor here is a body that will mail raw braces to a real person and cannot be saved to
-- fix itself. The two ways to get one are a step config whose copy is not under `body`/`subject`
-- and a version whose `steps` is not an array -- neither is a shape anything in this codebase
-- writes, so either means an assumption above is wrong and the deploy should stop rather than
-- proceed on a guess. Zero survivors on staging and production when this was written.
DO $$
DECLARE
  bad_steps    integer;
  bad_versions integer;
BEGIN
  SELECT count(*) INTO bad_steps
  FROM workflow_steps
  WHERE config::text LIKE '%{{recipient.first_name}}%';

  SELECT count(*) INTO bad_versions
  FROM workflow_versions
  WHERE definition::text LIKE '%{{recipient.first_name}}%';

  IF bad_steps > 0 OR bad_versions > 0 THEN
    RAISE EXCEPTION
      'drop_recipient_first_name_from_saved_copy: % workflow_steps row(s) and % workflow_versions row(s) still reference {{recipient.first_name}}. The field no longer resolves, so these bodies would mail the literal braces and cannot be re-saved to fix it. Inspect them with the pre-flight query in this file and rewrite by hand before deploying.',
      bad_steps, bad_versions;
  END IF;
END $$;

DROP FUNCTION IF EXISTS _srvw_recipient_builtin_bodies();
DROP FUNCTION IF EXISTS _srvw_strip_recipient_config(jsonb);
DROP FUNCTION IF EXISTS _srvw_strip_recipient_field(text);

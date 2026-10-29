-- Fold every existing AutomationRule into a published, one-step Workflow so
-- the new workflow-builder engine (later tasks) can serve legacy rules from
-- day one with ZERO behavior change: same trigger, same send window, same
-- single action -- just re-homed as step 0 of a 1-step workflow.
--
-- Fold semantics MUST stay in lockstep with the pure TS mapper
-- (backend/src/services/automations/migrateRules.ts -- foldRuleToWorkflow +
-- mapActionToStepType). That file is the executable spec this SQL mirrors;
-- keep both in sync if the fold ever changes.
--
-- Idempotent: every INSERT is guarded by WHERE NOT EXISTS keyed on
-- legacy_rule_id / (workflow_id, position) / (workflow_id, version), and the
-- closing UPDATE only touches rows still missing published_version_id -- the
-- whole file is a no-op on a second run. Portable: no Supabase-only objects,
-- gen_random_uuid() is core Postgres (matches every prior migration's uuid
-- idiom, e.g. 20260101000000_init). NEVER touches automation_rules /
-- automation_runs -- both stay read-only; the legacy engine keeps running.

-- 1) One Workflow header per AutomationRule.
INSERT INTO "workflows" (id, name, status, is_enabled, trigger_type, trigger_config, send_window,
                         template_key, legacy_rule_id, trigger_count, last_triggered_at,
                         created_by_id, created_at, updated_at, organization_id, published_at)
SELECT gen_random_uuid(), r.name, 'PUBLISHED'::"WorkflowStatus", r.is_enabled, r.trigger_type,
       r.trigger_config, r.send_window, r.template_key, r.id, r.trigger_count, r.last_triggered_at,
       r.created_by_id, r.created_at, NOW(), r.organization_id, NOW()
FROM "automation_rules" r
WHERE NOT EXISTS (SELECT 1 FROM "workflows" w WHERE w.legacy_rule_id = r.id);

-- 2) The single position-0 step, holding the rule's action_config UNCHANGED
--    (the executors read it identically whether reached via the legacy
--    engine or the new one). action_type -> step_type mirrors
--    mapActionToStepType's switch exactly, branch for branch.
INSERT INTO "workflow_steps" (id, workflow_id, position, step_type, config, organization_id)
SELECT gen_random_uuid(), w.id, 0,
       CASE r.action_type
         WHEN 'SEND_EMAIL'  THEN 'SEND_EMAIL'::"WorkflowStepType"
         WHEN 'SEND_SMS'    THEN 'SEND_TEXT'::"WorkflowStepType"
         WHEN 'NOTIFY_TEAM' THEN 'NOTIFY_TEAM'::"WorkflowStepType"
       END,
       r.action_config, r.organization_id
FROM "automation_rules" r
JOIN "workflows" w ON w.legacy_rule_id = r.id
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_steps" s WHERE s.workflow_id = w.id AND s.position = 0
);

-- 3) The v1 definition snapshot -- mirrors FoldedWorkflow.versionDefinition
--    in migrateRules.ts: header trigger_type/trigger_config/send_window plus
--    the one step at position 0 (same CASE as step 2 above).
INSERT INTO "workflow_versions" (id, workflow_id, version, definition, organization_id)
SELECT gen_random_uuid(), w.id, 1,
       jsonb_build_object(
         'trigger_type', r.trigger_type,
         'trigger_config', r.trigger_config,
         'send_window', r.send_window,
         'steps', jsonb_build_array(
           jsonb_build_object(
             'position', 0,
             'step_type', CASE r.action_type
               WHEN 'SEND_EMAIL'  THEN 'SEND_EMAIL'::"WorkflowStepType"
               WHEN 'SEND_SMS'    THEN 'SEND_TEXT'::"WorkflowStepType"
               WHEN 'NOTIFY_TEAM' THEN 'NOTIFY_TEAM'::"WorkflowStepType"
             END,
             'config', r.action_config
           )
         )
       ),
       r.organization_id
FROM "automation_rules" r
JOIN "workflows" w ON w.legacy_rule_id = r.id
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_versions" v WHERE v.workflow_id = w.id AND v.version = 1
);

-- 4) Publish: point each folded workflow at its v1 as the published version.
--    Scoped to legacy-rule-derived workflows only (legacy_rule_id IS NOT
--    NULL) so this backfill never touches a builder-authored workflow.
UPDATE "workflows" w
SET published_version_id = v.id
FROM "workflow_versions" v
WHERE v.workflow_id = w.id
  AND v.version = 1
  AND w.legacy_rule_id IS NOT NULL
  AND w.published_version_id IS NULL;

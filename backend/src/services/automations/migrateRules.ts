/**
 * migrateRules.ts — pure fold of a legacy AutomationRule into a published,
 * one-step Workflow (+ its v1 definition).
 *
 * Every AutomationRule that existed before the workflow builder shipped folds
 * into an equivalent single-step Workflow, so the new engine can serve it
 * from day one with ZERO behavior change: same trigger, same send window,
 * same single action, just re-homed as step 0 of a 1-step workflow.
 *
 * This module is the executable spec for that fold. The idempotent SQL
 * backfill (prisma/migrations/<ts>_workflow_backfill_rules/migration.sql)
 * inserts the same three rows (workflow, step, version) directly in the DB
 * and must stay in lockstep with the semantics here — each file
 * cross-references the other.
 *
 * Step-type retirement exemption. NOTIFY_TEAM is no longer an authorable step:
 * every surface that creates, validates or offers a step now works in the
 * narrowed authorable type, so reintroducing it there is a compile error. This
 * module is deliberately exempt and keeps the full storage label, for the same
 * reason the Activity-tab label and icon maps do - it describes rows that
 * already exist. The backfill SQL is frozen in the migration history and, at
 * migration.sql:38 and :62, still writes 'NOTIFY_TEAM'::"WorkflowStepType";
 * this fold is the executable spec for exactly those rows, so it has to keep
 * emitting the same label or it would stop describing what that migration
 * actually wrote.
 *
 * The rejected alternative was to delete one half of a documented lockstep
 * pair - dropping the NOTIFY_TEAM branch here to satisfy the type rule while
 * the applied SQL twin goes on writing it - which buys a type-level tidiness
 * by leaving the two halves silently disagreeing about an applied migration.
 */

import { AutomationRule, WorkflowStepType, AutomationActionType } from '@prisma/client';

/** AutomationActionType → WorkflowStepType for the fold. Mirrored by the CASE in the backfill SQL. */
export function mapActionToStepType(action: AutomationActionType): WorkflowStepType {
  switch (action) {
    case 'SEND_EMAIL':
      return 'SEND_EMAIL';
    case 'SEND_SMS':
      return 'SEND_TEXT';
    // Retired as an authorable step, retained here by the exemption in the
    // module header: the frozen backfill SQL still writes this label, and the
    // two halves of the lockstep pair must agree.
    case 'NOTIFY_TEAM':
      return 'NOTIFY_TEAM';
    default: {
      const unhandled: never = action;
      throw new Error(`mapActionToStepType: unhandled AutomationActionType ${String(unhandled)}`);
    }
  }
}

export interface FoldedWorkflow {
  workflow: {
    name: string;
    status: 'PUBLISHED';
    is_enabled: boolean;
    trigger_type: AutomationRule['trigger_type'];
    trigger_config: unknown | null; // passthrough
    send_window: AutomationRule['send_window'];
    template_key: string | null;
    legacy_rule_id: string;
    trigger_count: number;
    last_triggered_at: Date | null;
    created_by_id: string | null;
    organization_id: string;
  };
  step: {
    position: 0;
    step_type: WorkflowStepType;
    config: unknown; // action_config passthrough, IDENTICAL shape
    organization_id: string;
  };
  versionDefinition: {
    trigger_type: AutomationRule['trigger_type'];
    trigger_config: unknown | null;
    send_window: AutomationRule['send_window'];
    steps: Array<{ position: 0; step_type: WorkflowStepType; config: unknown }>;
  };
}

/** Pure fold: one AutomationRule → one published 1-step Workflow (+ v1 definition). */
/**
 * CARRIES `action_config` ACROSS VERBATIM, which is a hazard if this is ever wired up again.
 *
 * `{{recipient.first_name}}` was a legal merge field until 2026-09-15 and was then removed
 * outright (see `BASE` in catalog.ts). A legacy `automation_rules` row written before that date
 * can still hold it in its body or subject, and this function would copy it straight into a new
 * workflow step - where it renders as raw braces in a real email and fails validation on the
 * next save. The data migration that cleaned the existing rows
 * (20260915170000_drop_recipient_first_name_from_saved_copy) deliberately did NOT touch
 * automation_rules: nothing reads that table today, this fold has no non-test caller, so a
 * token sitting there renders nowhere and a write would have had no reader.
 *
 * If the importer is revived, strip the token here (or re-run that migration's
 * `_srvw_strip_recipient_field` logic over the imported config) before the rows are published.
 */
export function foldRuleToWorkflow(rule: AutomationRule): FoldedWorkflow {
  const step_type = mapActionToStepType(rule.action_type);
  const step = {
    position: 0 as const,
    step_type,
    config: rule.action_config,
    organization_id: rule.organization_id,
  };

  return {
    workflow: {
      name: rule.name,
      status: 'PUBLISHED',
      is_enabled: rule.is_enabled,
      trigger_type: rule.trigger_type,
      trigger_config: rule.trigger_config,
      send_window: rule.send_window,
      template_key: rule.template_key,
      legacy_rule_id: rule.id,
      trigger_count: rule.trigger_count,
      last_triggered_at: rule.last_triggered_at,
      created_by_id: rule.created_by_id,
      organization_id: rule.organization_id,
    },
    step,
    versionDefinition: {
      trigger_type: rule.trigger_type,
      trigger_config: rule.trigger_config,
      send_window: rule.send_window,
      steps: [{ position: step.position, step_type: step.step_type, config: step.config }],
    },
  };
}

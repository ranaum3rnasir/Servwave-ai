import { describe, it, expect } from 'vitest';
import type { AutomationRule } from '@prisma/client';
import { mapActionToStepType, foldRuleToWorkflow } from '../migrateRules';

// Pins the fold semantics documented in migrateRules.ts. The SQL backfill
// migration (prisma/migrations/<ts>_workflow_backfill_rules/migration.sql)
// must produce the identical shape — this file is the executable spec.

function baseRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'a0000000-0000-0000-0000-0000000000aa',
    name: 'Job scheduled confirmation',
    is_enabled: true,
    trigger_type: 'JOB_SCHEDULED',
    trigger_config: null,
    action_type: 'SEND_EMAIL',
    action_config: { recipient: 'customer', subject: 'Hi', body: 'Your job is booked.' },
    send_window: 'ANYTIME',
    template_key: 'job-scheduled-confirmation',
    created_by_id: 'u0000000-0000-0000-0000-000000000001',
    last_triggered_at: null,
    trigger_count: 0,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    organization_id: 'o0000000-0000-0000-0000-000000000001',
    ...overrides,
  } as AutomationRule;
}

describe('mapActionToStepType', () => {
  it('maps SEND_EMAIL to SEND_EMAIL', () => {
    expect(mapActionToStepType('SEND_EMAIL')).toBe('SEND_EMAIL');
  });

  it('maps SEND_SMS to SEND_TEXT', () => {
    expect(mapActionToStepType('SEND_SMS')).toBe('SEND_TEXT');
  });

  it('maps NOTIFY_TEAM to NOTIFY_TEAM', () => {
    expect(mapActionToStepType('NOTIFY_TEAM')).toBe('NOTIFY_TEAM');
  });
});

describe('foldRuleToWorkflow — header fields', () => {
  it('copies every header field verbatim, sets legacy_rule_id = rule.id, and status is always PUBLISHED', () => {
    const rule = baseRule();
    const { workflow } = foldRuleToWorkflow(rule);
    expect(workflow).toEqual({
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
    });
  });

  it('carries a distinct trigger_count and last_triggered_at through verbatim', () => {
    const rule = baseRule({ trigger_count: 42, last_triggered_at: new Date('2026-06-15T12:00:00.000Z') });
    const { workflow } = foldRuleToWorkflow(rule);
    expect(workflow.trigger_count).toBe(42);
    expect(workflow.last_triggered_at).toEqual(new Date('2026-06-15T12:00:00.000Z'));
  });

  it('passes through null template_key and null created_by_id (from-scratch rule)', () => {
    const rule = baseRule({ template_key: null, created_by_id: null });
    const { workflow } = foldRuleToWorkflow(rule);
    expect(workflow.template_key).toBeNull();
    expect(workflow.created_by_id).toBeNull();
  });
});

describe('foldRuleToWorkflow — is_enabled passthrough', () => {
  it('an enabled rule folds into an enabled, published workflow', () => {
    const rule = baseRule({ is_enabled: true });
    const { workflow } = foldRuleToWorkflow(rule);
    expect(workflow.is_enabled).toBe(true);
    expect(workflow.status).toBe('PUBLISHED');
  });

  it('a disabled rule folds DISABLED but still PUBLISHED (not left as DRAFT)', () => {
    const rule = baseRule({ is_enabled: false });
    const { workflow } = foldRuleToWorkflow(rule);
    expect(workflow.is_enabled).toBe(false);
    expect(workflow.status).toBe('PUBLISHED');
  });
});

describe('foldRuleToWorkflow — step + action mapping', () => {
  it('folds a SEND_EMAIL rule into a SEND_EMAIL step at position 0 with config passed through unchanged', () => {
    const config = { recipient: 'customer', subject: 'S', body: 'B' };
    const rule = baseRule({ action_type: 'SEND_EMAIL', action_config: config });
    const { step } = foldRuleToWorkflow(rule);
    expect(step.position).toBe(0);
    expect(step.step_type).toBe('SEND_EMAIL');
    expect(step.config).toBe(config); // identical shape — the executors read it unchanged
    expect(step.organization_id).toBe(rule.organization_id);
  });

  it('folds a SEND_SMS rule into a SEND_TEXT step with config passed through unchanged', () => {
    const config = { recipient: 'customer', body: 'Text body' };
    const rule = baseRule({ action_type: 'SEND_SMS', action_config: config });
    const { step } = foldRuleToWorkflow(rule);
    expect(step.step_type).toBe('SEND_TEXT');
    expect(step.config).toBe(config);
  });

  it('folds a NOTIFY_TEAM rule into a NOTIFY_TEAM step with config passed through unchanged', () => {
    const config = { recipient: 'all_admins', body: 'Ping' };
    const rule = baseRule({ action_type: 'NOTIFY_TEAM', action_config: config });
    const { step } = foldRuleToWorkflow(rule);
    expect(step.step_type).toBe('NOTIFY_TEAM');
    expect(step.config).toBe(config);
  });
});

describe('foldRuleToWorkflow — trigger_config passthrough', () => {
  it('a timed trigger keeps its trigger_config.offset_minutes', () => {
    const rule = baseRule({ trigger_type: 'BEFORE_JOB_START', trigger_config: { offset_minutes: 1440 } });
    const { workflow, versionDefinition } = foldRuleToWorkflow(rule);
    expect(workflow.trigger_config).toEqual({ offset_minutes: 1440 });
    expect(versionDefinition.trigger_config).toEqual({ offset_minutes: 1440 });
  });

  it('an event trigger keeps trigger_config null', () => {
    const rule = baseRule({ trigger_type: 'JOB_SCHEDULED', trigger_config: null });
    const { workflow, versionDefinition } = foldRuleToWorkflow(rule);
    expect(workflow.trigger_config).toBeNull();
    expect(versionDefinition.trigger_config).toBeNull();
  });
});

describe('foldRuleToWorkflow — versionDefinition', () => {
  it('has exactly one step at position 0 mirroring the folded step', () => {
    const config = { recipient: 'customer', body: 'hi' };
    const rule = baseRule({ action_type: 'SEND_SMS', action_config: config });
    const { versionDefinition, step } = foldRuleToWorkflow(rule);
    expect(versionDefinition.steps).toHaveLength(1);
    expect(versionDefinition.steps[0]).toEqual({ position: 0, step_type: step.step_type, config: step.config });
  });

  it('mirrors the header trigger_type and send_window', () => {
    const rule = baseRule({ trigger_type: 'INVOICE_PAID', send_window: 'BUSINESS_HOURS' });
    const { versionDefinition } = foldRuleToWorkflow(rule);
    expect(versionDefinition.trigger_type).toBe('INVOICE_PAID');
    expect(versionDefinition.send_window).toBe('BUSINESS_HOURS');
  });
});

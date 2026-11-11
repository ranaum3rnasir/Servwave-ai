import { describe, it, expect } from 'vitest';
import {
  validateScriptVariables,
  isVariableUsedInText,
  getUsedJobContextKeys,
  JOB_CONTEXT_VARIABLES,
  CORE_DYNAMIC_VARIABLES,
  AVAILABLE_DYNAMIC_VARIABLE_SET,
} from '../dynamicVariables';

describe('Bee Dynamic Variables Validation', () => {
  it('allows scripts with valid registered dynamic variables', () => {
    const script =
      'Hi {{customer_name}}, this is {{agent_persona}} from {{company_name}} regarding job {{job_number}}. Notes: {{job_notes}}.';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validVariables).toContain('customer_name');
    expect(result.validVariables).toContain('agent_persona');
    expect(result.validVariables).toContain('company_name');
    expect(result.validVariables).toContain('job_number');
    expect(result.validVariables).toContain('job_notes');
  });

  it('allows plain text with no dynamic variables', () => {
    const script = 'Hello, this is a plain message without any brackets.';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags undefined / unsupported variables', () => {
    const script = 'Hi {{unknown_variable}}, your {{foo_bar}} is ready.';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(false);
    expect(result.invalidVariables).toContain('{{unknown_variable}}');
    expect(result.invalidVariables).toContain('{{foo_bar}}');
    expect(result.errors.some((e) => e.includes('unknown_variable'))).toBe(true);
  });

  it('flags empty double brackets {{}} or {{   }}', () => {
    const script = 'Hello {{}} and {{   }} how are you?';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('empty'))).toBe(true);
  });

  it('flags missing closing brace (e.g. {{first_name})', () => {
    const script = 'Hello {{first_name} how are you?';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing closing brace'))).toBe(true);
  });

  it('flags missing opening brace (e.g. {first_name}})', () => {
    const script = 'Hello {first_name}} how are you?';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing opening brace'))).toBe(true);
  });

  it('flags unclosed double braces at end or before another token', () => {
    const script = 'Hello {{customer_name and {{job_notes}}';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('customer_name') && e.includes('close'))).toBe(true);
  });

  it('supports repeated and adjacent variable insertions', () => {
    const script = '{{customer_name}}{{customer_name}} - {{job_notes}} {{job_notes}}';
    const result = validateScriptVariables(script);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('isVariableUsedInText', () => {
  it('correctly determines whether a variable token is present in section text', () => {
    const text = 'Hello {{first_name}}, we saw your {{job_notes}}.';

    expect(isVariableUsedInText(text, 'first_name')).toBe(true);
    expect(isVariableUsedInText(text, '{{first_name}}')).toBe(true);
    expect(isVariableUsedInText(text, 'job_notes')).toBe(true);
    expect(isVariableUsedInText(text, 'assigned_team')).toBe(false);
    expect(isVariableUsedInText(text, '{{assigned_team}}')).toBe(false);
  });
});

describe('getUsedJobContextKeys', () => {
  it('aggregates used job context variables across conversation flow sections', () => {
    const flow = {
      greeting_pitch: 'Hi {{customer_name}}, {{job_notes}}',
      checkin_flow: 'Checking on {{assigned_team}}',
      warranty_offer_pitch: 'We offer {{renewal_plans}}',
      new_work_pitch: '',
      objection_handling: '{{line_items}} info',
      custom_instructions: '',
    };

    const usedKeys = getUsedJobContextKeys(flow);
    expect(usedKeys).toContain('job_notes');
    expect(usedKeys).toContain('assigned_team');
    expect(usedKeys).toContain('line_items');
    expect(usedKeys).not.toContain('internal_costs');
  });
});

import { describe, it, expect } from 'vitest';
import { TOOL_SPECS } from '@/components/copilot/tools/toolRegistry';

describe('TOOL_SPECS.create_lead — new_customer no longer requires a location (2026-07-09)', () => {
  it('does not list "location" as required for a new customer', () => {
    const required = (
      TOOL_SPECS.create_lead.parametersJsonSchema.properties as Record<
        string,
        { required?: string[] }
      >
    ).new_customer.required;
    expect(required).not.toContain('location');
  });

  it('still requires first_name for a new customer', () => {
    const required = (
      TOOL_SPECS.create_lead.parametersJsonSchema.properties as Record<
        string,
        { required?: string[] }
      >
    ).new_customer.required;
    expect(required).toContain('first_name');
  });
});

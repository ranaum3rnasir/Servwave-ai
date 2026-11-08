import { describe, it, expect } from 'vitest';
import { createLeadFormSchema } from '@/lib/lead-form-schemas';
import { createJobFormSchema } from '@/lib/job-create-schema';

function baseLead(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Bob',
    phone: '5551234567',
    service_request: 'Fix the AC',
    ...overrides,
  };
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Bob',
    phone: '5551234567',
    service_request: 'Fix the AC',
    service_address_line1: '1 Main St',
    service_city: 'Austin',
    service_state: 'TX',
    service_zip: '78701',
    ...overrides,
  };
}

describe('createLeadFormSchema — first name OR company (unified-client-creation §4)', () => {
  it('is valid with only a company name (no first name)', () => {
    const result = createLeadFormSchema.safeParse(baseLead({ first_name: undefined, company_name: 'Chestnut' }));
    expect(result.success).toBe(true);
  });
  it('is still valid with only a first name (no company) — unchanged behavior', () => {
    const result = createLeadFormSchema.safeParse(baseLead());
    expect(result.success).toBe(true);
  });
  it('is invalid with neither a first name nor a company name', () => {
    const result = createLeadFormSchema.safeParse(baseLead({ first_name: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('first_name');
    }
  });
});

describe('createJobFormSchema — first name OR company (unified-client-creation §4)', () => {
  it('is valid with only a company name (no first name)', () => {
    const result = createJobFormSchema.safeParse(baseJob({ first_name: undefined, company_name: 'Chestnut' }));
    expect(result.success).toBe(true);
  });
  it('is invalid with neither a first name nor a company name', () => {
    const result = createJobFormSchema.safeParse(baseJob({ first_name: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('first_name');
    }
  });
});

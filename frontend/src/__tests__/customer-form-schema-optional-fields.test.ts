import { describe, it, expect } from 'vitest';
import { customerSchema } from '@/lib/customers/customerSchema';

// Minimal valid base: a person with a first name and a phone.
// account_type defaults to 'individual' via the schema itself.
function baseData(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Jane',
    phone: '5551234567',
    ...overrides,
  };
}

describe('customerSchema — service address optional (2026-07-09)', () => {
  it('is valid with a name + phone and NO address fields at all', () => {
    const result = customerSchema.safeParse(baseData());
    expect(result.success).toBe(true);
  });

  it('is valid with a name + email and NO address fields at all', () => {
    const result = customerSchema.safeParse(
      baseData({ phone: undefined, email: 'jane@example.com' }),
    );
    expect(result.success).toBe(true);
  });

  it('is valid with a full, complete, valid address', () => {
    const result = customerSchema.safeParse(
      baseData({
        address_line1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('is invalid with only a street address (city/state/zip missing)', () => {
    const result = customerSchema.safeParse(
      baseData({ address_line1: '123 Main St' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('city');
      expect(paths).toContain('state');
      expect(paths).toContain('zip');
    }
  });

  it('is invalid with a 1-letter state when an address is being entered', () => {
    const result = customerSchema.safeParse(
      baseData({
        address_line1: '123 Main St',
        city: 'Austin',
        state: 'T',
        zip: '78701',
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const stateIssue = result.error.issues.find((i) => i.path.join('.') === 'state');
      expect(stateIssue?.message).toMatch(/2-letter state code/i);
    }
  });

  it('is valid with a name + phone and NO source selected', () => {
    const result = customerSchema.safeParse(baseData({ source: undefined }));
    expect(result.success).toBe(true);
  });

  it('is valid with neither a source NOR an address', () => {
    const result = customerSchema.safeParse(
      baseData({ source: undefined, address_line1: undefined }),
    );
    expect(result.success).toBe(true);
  });

  it('regression: is still invalid with no first name (person)', () => {
    const result = customerSchema.safeParse(baseData({ first_name: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('first_name');
    }
  });

  it('regression: is still invalid with neither phone nor email', () => {
    const result = customerSchema.safeParse(baseData({ phone: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('phone');
    }
  });

  it('is valid with only a company name and NO first name (unified client model)', () => {
    const result = customerSchema.safeParse(
      baseData({ first_name: undefined, company_name: 'Chestnut' }),
    );
    expect(result.success).toBe(true);
  });
});

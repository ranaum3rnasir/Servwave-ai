import { describe, it, expect } from 'vitest';
import { hasNameOrCompany, deriveCustomerKind } from '../lib/customer-kind';

describe('hasNameOrCompany', () => {
  it('is true with only a first_name', () => {
    expect(hasNameOrCompany({ first_name: 'Bob' })).toBe(true);
  });
  it('is true with only a company_name', () => {
    expect(hasNameOrCompany({ company_name: 'Chestnut' })).toBe(true);
  });
  it('is false with neither', () => {
    expect(hasNameOrCompany({})).toBe(false);
  });
  it('is false with whitespace-only values', () => {
    expect(hasNameOrCompany({ first_name: '   ', company_name: '  ' })).toBe(false);
  });
});

describe('deriveCustomerKind', () => {
  it('derives COMPANY when company_name is present', () => {
    expect(deriveCustomerKind({ company_name: 'Chestnut' })).toBe('COMPANY');
  });
  it('derives PERSON when company_name is absent', () => {
    expect(deriveCustomerKind({ first_name: 'Bob' })).toBe('PERSON');
  });
  it('derives PERSON when company_name is whitespace-only', () => {
    expect(deriveCustomerKind({ company_name: '   ' })).toBe('PERSON');
  });
  it('derives COMPANY even when a first_name is ALSO present (company wins)', () => {
    expect(deriveCustomerKind({ company_name: 'Chestnut', first_name: 'Bob' })).toBe('COMPANY');
  });
});

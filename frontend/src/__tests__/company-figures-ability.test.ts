import { describe, it, expect } from 'vitest';
import { buildAbility, canSeeCompanyFigures, canSeePricing } from '@/lib/ability';

// Roles & Permissions S01.16 - "See company figures" reaches the browser as its own rule, apart from "See financial data".
describe('canSeeCompanyFigures', () => {
  it('is true for the rule the switch compiles into, and the Admin box', () => {
    expect(canSeeCompanyFigures(buildAbility([{ action: 'read', subject: 'CompanyFigures' }]))).toBe(true);
    expect(canSeeCompanyFigures(buildAbility([{ action: 'manage', subject: 'all' }]))).toBe(true);
  });

  it('is false without it, and See financial data does not stand in for it', () => {
    expect(canSeeCompanyFigures(buildAbility([]))).toBe(false);
    const financialOnly = buildAbility([{ action: 'read', subject: 'Pricing' }]);
    expect(canSeePricing(financialOnly)).toBe(true);
    expect(canSeeCompanyFigures(financialOnly)).toBe(false);
  });
});

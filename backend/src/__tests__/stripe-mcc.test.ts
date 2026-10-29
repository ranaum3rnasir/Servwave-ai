import { describe, it, expect } from 'vitest';
import { mccForIndustry } from '../lib/stripe-mcc';

describe('mccForIndustry', () => {
  it('maps hvac/plumbing/septic to 1711', () => {
    expect(mccForIndustry(['HVAC'])).toBe('1711');
    expect(mccForIndustry(['plumbing'])).toBe('1711');
  });
  it('maps electrical to 1731', () => {
    expect(mccForIndustry(['Electrical'])).toBe('1731');
  });
  it('defaults unknown/empty to 1799', () => {
    expect(mccForIndustry([])).toBe('1799');
    expect(mccForIndustry(null)).toBe('1799');
    expect(mccForIndustry(['landscaping'])).toBe('1799');
  });
  it('uses the first entry when several are present', () => {
    expect(mccForIndustry(['Electrical', 'HVAC'])).toBe('1731');
  });
});

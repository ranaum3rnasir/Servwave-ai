import { describe, it, expect, afterEach } from 'vitest';
import { formatCurrency } from '@/lib/utils';
import { setOrgFormattingPrefs } from '@/lib/org-format';

// #126 — org-aware currency formatting.
describe('formatCurrency', () => {
  afterEach(() => {
    setOrgFormattingPrefs({ currency: null, dateFormat: null });
  });

  it('defaults to USD before any org hydrates', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('accepts a numeric string', () => {
    expect(formatCurrency('99.9')).toBe('$99.90');
  });

  it('honors the org currency code (EUR)', () => {
    setOrgFormattingPrefs({ currency: 'EUR' });
    // Symbol is locale-derived; assert the value is present and not a $.
    const out = formatCurrency(1234.5);
    expect(out).toContain('1,234.50');
    expect(out).not.toContain('$');
  });

  it('honors the org currency code (CAD)', () => {
    setOrgFormattingPrefs({ currency: 'CAD' });
    const cad = formatCurrency(10);
    expect(cad).toContain('10.00');
    // CAD must render distinctly from plain USD ('$10.00').
    expect(cad).not.toBe('$10.00');
  });

  it('ignores a blank/invalid currency and keeps USD', () => {
    setOrgFormattingPrefs({ currency: '' });
    expect(formatCurrency(5)).toBe('$5.00');
  });
});

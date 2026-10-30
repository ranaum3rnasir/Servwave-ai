import { describe, it, expect } from 'vitest';

import { parseDollarsToCents, tipPresetCents } from '../public-pay-amounts';

describe('parseDollarsToCents', () => {
  it.each([
    ['40', 4000], ['40.5', 4050], ['$1,250.05', 125005], ['.5', 50], ['7.25', 725], ['0', 0], [' 12 ', 1200], ['10.', 1000],
  ])('reads %s as %i cents', (text, cents) => {
    expect(parseDollarsToCents(text)).toBe(cents);
  });

  it.each(['', 'abc', '-5', '1.234', '1.2.3', '$', '4e2'])('refuses %j', (text) => {
    expect(parseDollarsToCents(text)).toBeNull();
  });
});

describe('tipPresetCents: percentages of the pre-tax share of the amount being paid', () => {
  const invoice = { totalCents: 10875, taxCents: 875 };

  it('on the whole invoice, a preset is a percentage of the pre-tax subtotal', () => {
    expect(tipPresetCents({ presets: [10, 15, 20], payingCents: 10875, ...invoice })).toEqual([1000, 1500, 2000]);
  });

  it('on a part, a preset is a percentage of that part\'s share of the pre-tax subtotal', () => {
    // $40.00 x ($100.00 / $108.75) = $36.78 pre-tax; 15% = $5.52 (551.7 cents, rounded once).
    expect(tipPresetCents({ presets: [15], payingCents: 4000, ...invoice })).toEqual([552]);
  });

  it('is zero on a zero-total invoice', () => {
    expect(tipPresetCents({ presets: [10], payingCents: 0, totalCents: 0, taxCents: 0 })).toEqual([0]);
  });
});

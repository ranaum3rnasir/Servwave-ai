import { describe, it, expect } from 'vitest';
import {
  NO_FIGURE,
  PROFITABILITY_NOTE,
  calculateProfitability,
  formatProfitabilityPercent,
  type ProfitabilityState,
} from './profitability';

/**
 * The table IS the specification. Every consumer of this module branches on
 * `state`, so each row names the state it proves as well as the two figures.
 */
const cases: Array<{
  name: string;
  cost: number | string | null | undefined;
  price: number | string | null | undefined;
  state: ProfitabilityState;
  margin: number | null;
  markup: number | null;
}> = [
  {
    name: 'normal — a cost below the price',
    cost: 40,
    price: 178,
    state: 'normal',
    margin: 77.528,
    markup: 345,
  },
  {
    name: 'zero cost entered as a number — margin is real, markup has no base',
    cost: 0,
    price: 100,
    state: 'zero-cost',
    margin: 100,
    markup: null,
  },
  {
    name: 'zero cost entered as the string "0" — a truthy string, still a real entry',
    cost: '0',
    price: '100',
    state: 'zero-cost',
    margin: 100,
    markup: null,
  },
  {
    name: 'cost absent (empty string) — no figures may be invented',
    cost: '',
    price: 100,
    state: 'uncosted',
    margin: null,
    markup: null,
  },
  {
    name: 'cost absent (null) — no figures may be invented',
    cost: null,
    price: 100,
    state: 'uncosted',
    margin: null,
    markup: null,
  },
  {
    name: 'cost absent (undefined) — the shape a cost-stripped item arrives in',
    cost: undefined,
    price: 100,
    state: 'uncosted',
    margin: null,
    markup: null,
  },
  {
    name: 'cost of whitespace only — an empty field, not a zero',
    cost: '   ',
    price: 100,
    state: 'uncosted',
    margin: null,
    markup: null,
  },
  {
    name: 'cost that does not parse — absent, never NaN',
    cost: 'abc',
    price: 100,
    state: 'uncosted',
    margin: null,
    markup: null,
  },
  {
    name: 'price that does not parse — no price, and never NaN',
    cost: 40,
    price: 'abc',
    state: 'invalid-price',
    margin: null,
    markup: null,
  },
  {
    name: 'negative cost — a data error, distinct from an absent cost',
    cost: -5,
    price: 100,
    state: 'invalid-cost',
    margin: null,
    markup: null,
  },
  {
    name: 'negative cost as a string — the same data error',
    cost: '-5',
    price: '100',
    state: 'invalid-cost',
    margin: null,
    markup: null,
  },
  {
    name: 'a cost too small to divide by — unusable, never an infinite markup',
    cost: 1e-320,
    price: 1000,
    state: 'invalid-cost',
    margin: null,
    markup: null,
  },
  {
    name: 'zero price — nothing can be divided by it',
    cost: 40,
    price: 0,
    state: 'invalid-price',
    margin: null,
    markup: null,
  },
  {
    name: 'zero price as the string "0" — the truthiness trap',
    cost: '40',
    price: '0',
    state: 'invalid-price',
    margin: null,
    markup: null,
  },
  {
    name: 'price absent — no price, no figures',
    cost: 40,
    price: '',
    state: 'invalid-price',
    margin: null,
    markup: null,
  },
  {
    name: 'cost exceeding price — a loss, reported as a negative margin',
    cost: 150,
    price: 100,
    state: 'normal',
    margin: -50,
    markup: -33.333,
  },
  {
    name: 'equal cost and price — no profit, and that is a real answer',
    cost: 100,
    price: 100,
    state: 'normal',
    margin: 0,
    markup: 0,
  },
  {
    name: 'a very large markup — no ceiling exists',
    cost: 0.01,
    price: 1000,
    state: 'normal',
    margin: 99.999,
    markup: 9999900,
  },
];

describe('calculateProfitability', () => {
  it.each(cases)('$name', ({ cost, price, state, margin, markup }) => {
    const p = calculateProfitability(cost, price);

    expect(p.state).toBe(state);
    if (margin === null) expect(p.marginPercent).toBeNull();
    else expect(p.marginPercent).toBeCloseTo(margin, 2);
    if (markup === null) expect(p.markupPercent).toBeNull();
    else expect(p.markupPercent).toBeCloseTo(markup, 2);
  });

  it('does not clamp margin and does not cap markup', () => {
    // Margin is bounded at 100% by its own arithmetic, never by a clamp.
    expect(calculateProfitability(0.01, 1000).marginPercent).toBeLessThan(100);
    // Markup has no such bound, and nothing in the module imposes one.
    expect(calculateProfitability(0.01, 1000).markupPercent).toBeGreaterThan(1000);
  });
});

/**
 * Properties over inputs the table does not name, including the awkward edges
 * of IEEE arithmetic. These are the guarantees slices 09 and 10 are entitled to
 * branch on, so they are asserted over a generated cross product — a per-row
 * restatement of the table's own expectations could never fail on its own.
 */
describe('calculateProfitability — invariants over a generated cross product', () => {
  const values: Array<number | string | null | undefined> = [
    0,
    -0,
    1,
    -1,
    0.001,
    1e-320,
    -1e-320,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    1e308,
    -1e308,
    1e-12,
    99.995,
    12345.6789,
    Infinity,
    -Infinity,
    NaN,
    '0',
    '-0',
    '0.01',
    '1e-320',
    '1e308',
    '  ',
    '',
    'abc',
    '12,50',
    null,
    undefined,
  ];

  const pairs = values.flatMap((cost) => values.map((price) => ({ cost, price })));

  it('covers a meaningful number of pairs', () => {
    expect(pairs.length).toBeGreaterThan(700);
  });

  it('never returns a non-finite figure, whatever it is handed', () => {
    for (const { cost, price } of pairs) {
      const { marginPercent, markupPercent } = calculateProfitability(cost, price);
      for (const figure of [marginPercent, markupPercent]) {
        if (figure !== null) {
          expect(Number.isFinite(figure), `cost=${String(cost)} price=${String(price)}`).toBe(true);
        }
      }
    }
  });

  it('state "normal" always carries two real numbers — never a null, never an Infinity', () => {
    for (const { cost, price } of pairs) {
      const p = calculateProfitability(cost, price);
      if (p.state !== 'normal') continue;
      const where = `cost=${String(cost)} price=${String(price)}`;
      expect(p.marginPercent, where).not.toBeNull();
      expect(p.markupPercent, where).not.toBeNull();
      expect(Number.isFinite(p.marginPercent as number), where).toBe(true);
      expect(Number.isFinite(p.markupPercent as number), where).toBe(true);
    }
  });

  it('every state that carries no figures carries neither figure', () => {
    const figureless: ProfitabilityState[] = ['uncosted', 'invalid-cost', 'invalid-price'];
    for (const { cost, price } of pairs) {
      const p = calculateProfitability(cost, price);
      if (!figureless.includes(p.state)) continue;
      const where = `cost=${String(cost)} price=${String(price)}`;
      expect(p.marginPercent, where).toBeNull();
      expect(p.markupPercent, where).toBeNull();
    }
  });

  it('state "zero-cost" always means the whole price is margin and markup has no base', () => {
    for (const { cost, price } of pairs) {
      const p = calculateProfitability(cost, price);
      if (p.state !== 'zero-cost') continue;
      const where = `cost=${String(cost)} price=${String(price)}`;
      expect(p.marginPercent, where).toBe(100);
      expect(p.markupPercent, where).toBeNull();
    }
  });

  it('never clamps: margin reaches below zero and markup climbs past any ceiling', () => {
    const results = pairs.map(({ cost, price }) => calculateProfitability(cost, price));
    expect(results.some((p) => (p.marginPercent ?? 0) < 0)).toBe(true);
    expect(results.some((p) => (p.markupPercent ?? 0) > 1e6)).toBe(true);
  });
});

describe('formatProfitabilityPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatProfitabilityPercent(77.528)).toBe('78%');
  });

  it('shows a loss as a negative percentage rather than suppressing it', () => {
    expect(formatProfitabilityPercent(-50)).toBe('-50%');
  });

  it('shows an em dash when there is no figure', () => {
    expect(formatProfitabilityPercent(null)).toBe(NO_FIGURE);
    expect(NO_FIGURE).toBe('—');
  });

  it('prints a very large markup in full, with no ceiling', () => {
    expect(formatProfitabilityPercent(9999900)).toBe('9,999,900%');
  });
});

describe('PROFITABILITY_NOTE', () => {
  it('leaves a normal pair unqualified, and qualifies every other state', () => {
    expect(PROFITABILITY_NOTE.normal).toBeNull();
    expect(PROFITABILITY_NOTE['zero-cost']).toMatch(/zero/i);
    // The em dash must invite the operator to add a cost, not dead-end.
    expect(PROFITABILITY_NOTE.uncosted).toMatch(/add a unit cost/i);
    // A bad cost is a data error, and must never be described as a missing one.
    expect(PROFITABILITY_NOTE['invalid-cost']).toMatch(/not a usable/i);
    expect(PROFITABILITY_NOTE['invalid-cost']).not.toMatch(/add a unit cost/i);
    expect(PROFITABILITY_NOTE['invalid-price']).toMatch(/sell price/i);
  });
});

import { describe, it, expect } from 'vitest';
import { stripScopeMoney, stripScopeCost } from '../lib/scopes';

const scopes = [
  { id: 's1', title: 'Replace compressor', body: 'Swap unit', flat_price: 1200, is_taxable: true, internal_cost: 700 },
];

describe('stripScopeMoney', () => {
  it('removes internal_cost AND flat_price', () => {
    const [out] = stripScopeMoney(scopes) as unknown as Record<string, unknown>[];
    expect(out).not.toHaveProperty('internal_cost');
    expect(out).not.toHaveProperty('flat_price');
    expect(out.title).toBe('Replace compressor');
    expect(out.body).toBe('Swap unit');
  });

  it('leaves stripScopeCost untouched — it must still keep flat_price', () => {
    // Regression guard. stripScopeCost has other callers (invoice-lines.controller.ts,
    // estimate.controller.ts) that must still see flat_price. Widening it in place instead of
    // adding a sibling would change what an ESTIMATE or INVOICE reader sees, which is out of
    // scope for D13.
    const [out] = stripScopeCost(scopes) as unknown as Record<string, unknown>[];
    expect(out).not.toHaveProperty('internal_cost');
    expect(out.flat_price).toBe(1200);
  });
});

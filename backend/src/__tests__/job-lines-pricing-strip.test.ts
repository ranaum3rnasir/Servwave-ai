import { describe, it, expect } from 'vitest';
import { stripScopeCost } from '../lib/scopes';

const scopes = [
  { id: 's1', title: 'Replace compressor', body: 'Swap unit', flat_price: 1200, is_taxable: true, internal_cost: 700 },
];

describe('stripScopeCost', () => {
  it('removes internal_cost and keeps the scope\'s flat price: See financial data covers costs only', () => {
    const [out] = stripScopeCost(scopes) as unknown as Record<string, unknown>[];
    expect(out).not.toHaveProperty('internal_cost');
    expect(out.flat_price).toBe(1200);
    expect(out.title).toBe('Replace compressor');
    expect(out.body).toBe('Swap unit');
  });
});

import { describe, it, expect } from 'vitest';
import { columns } from '@/pages/CustomersPage';
import { DEFAULT_CUSTOMERS_SORTING } from '@/lib/customers/customersSorting';

// Issue #420: Customers list must default to NEWEST customers first.
// The default sort token must also match the backend allowlist
// (parseSortParams allowlists `created_at`, NOT `created`).

describe('Customers list default sort (issue #420)', () => {
  it('defaults to created_at descending (newest first)', () => {
    expect(DEFAULT_CUSTOMERS_SORTING).toEqual([{ id: 'created_at', desc: true }]);
  });

  it('has a "Member Since" column whose id matches the backend sort token', () => {
    const memberSince = columns.find((c) => c.id === 'created_at');
    expect(memberSince).toBeDefined();
    expect(memberSince?.header).toBe('Member Since');
  });

  it('derives sortBy/sortDir params that the backend will honour', () => {
    const sortBy = DEFAULT_CUSTOMERS_SORTING[0].id;
    const sortDir = DEFAULT_CUSTOMERS_SORTING[0].desc ? 'desc' : 'asc';
    expect(sortBy).toBe('created_at');
    expect(sortDir).toBe('desc');
  });
});

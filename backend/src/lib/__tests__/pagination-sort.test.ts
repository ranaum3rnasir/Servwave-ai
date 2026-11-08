/**
 * SRVW-89 - parseSortParams unit contract. Direct calls, no supertest/prisma.
 *
 * New shape: parseSortParams(query, fieldMap, defaultField?, defaultDir?) returns a
 * discriminated SortResult = { ok: true; orderBy } | { ok: false; field; allowed } so
 * TypeScript forces every one of the 9 call sites to check `.ok` before touching `orderBy` -
 * no caller can silently skip the 400. orderBy is always an array (never a bare object) so a
 * multi-field map entry (Customers "Customer" -> [first_name, last_name]) can be expressed
 * without a union return type.
 */
import { describe, it, expect } from 'vitest';
import { parseSortParams } from '../pagination';
import type { SortFieldMap } from '../sortFields';

const MAP: SortFieldMap = {
  customer_number: ['customer_number'],
  name: ['first_name', 'last_name'],
};

describe('parseSortParams', () => {
  it('absent sortBy resolves to the default field/direction', () => {
    const result = parseSortParams({}, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: true, orderBy: [{ created_at: 'desc' }] });
  });

  it('empty-string sortBy resolves to the default field/direction', () => {
    const result = parseSortParams({ sortBy: '' }, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: true, orderBy: [{ created_at: 'desc' }] });
  });

  it('a mapped single-field id resolves to a one-element orderBy array', () => {
    const result = parseSortParams({ sortBy: 'customer_number', sortDir: 'asc' }, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: true, orderBy: [{ customer_number: 'asc' }] });
  });

  it('a mapped multi-field id resolves to an array in declared order, same direction on every key', () => {
    const result = parseSortParams({ sortBy: 'name', sortDir: 'asc' }, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: true, orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }] });
  });

  it('an unmapped id is rejected with the allowed key list', () => {
    const result = parseSortParams({ sortBy: 'bogus' }, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: false, field: 'bogus', allowed: ['customer_number', 'name'] });
  });

  it('an invalid sortDir falls back to the default direction without rejecting (unchanged, deliberately out of scope)', () => {
    const result = parseSortParams({ sortBy: 'customer_number', sortDir: 'sideways' }, MAP, 'created_at', 'desc');
    expect(result).toEqual({ ok: true, orderBy: [{ customer_number: 'desc' }] });
  });
});

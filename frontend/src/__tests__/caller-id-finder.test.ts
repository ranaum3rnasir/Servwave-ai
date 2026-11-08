// Caller ID slice 04 - the search, filter, count and paging rules, at the edges
// the page tests do not reach. The page behaviour itself is covered in
// caller-id-search-filters.test.tsx.
import { describe, it, expect } from 'vitest';
import type { NumberAssignmentRow } from '@/lib/api/phoneNumbers';
import {
  callerIdCountLabel,
  filterCallerIdRows,
  pageOf,
} from '@/pages/v2/settings/components/callerIdFinder';

const row = (over: Partial<NumberAssignmentRow>): NumberAssignmentRow => ({
  id: 'n', e164: '+15552014410', label: null, is_org_default: false, sms_enabled: true,
  status: 'active', type: 'local', assignments: [], ...over,
});

const ROWS = [
  row({ id: 'a', e164: '+15552014410', label: 'Line 2' }),
  row({ id: 'b', e164: '+15552024420', label: 'Store' }),
  row({ id: 'c', e164: '+18005550199', label: null }),
];
const ids = (rows: NumberAssignmentRow[]) => rows.map((r) => r.id);

describe('filterCallerIdRows search', () => {
  it('a query with letters is not matched digit for digit, so "Line 2" does not match every number with a 2', () => {
    expect(ids(filterCallerIdRows(ROWS, { query: 'Line 2', filter: 'all' }))).toEqual(['a']);
  });

  it('phone punctuation is ignored in a digits search', () => {
    expect(ids(filterCallerIdRows(ROWS, { query: '(800) 555.0199', filter: 'all' }))).toEqual(['c']);
    expect(ids(filterCallerIdRows(ROWS, { query: '202-44', filter: 'all' }))).toEqual(['b']);
  });

  it('an empty or blank query matches everything', () => {
    expect(ids(filterCallerIdRows(ROWS, { query: '   ', filter: 'all' }))).toEqual(['a', 'b', 'c']);
  });

  it('punctuation alone matches nothing extra', () => {
    expect(ids(filterCallerIdRows(ROWS, { query: '()', filter: 'all' }))).toEqual([]);
  });
});

describe('filterCallerIdRows filters', () => {
  it('"Nobody assigned" keeps an org default that has people out too (it has people)', () => {
    const rows = [
      row({ id: 'def-empty', is_org_default: true }),
      row({ id: 'def-people', is_org_default: true, assignments: [{ user_id: 'u', user_name: 'U', is_default: false }] }),
      row({ id: 'free' }),
    ];
    expect(ids(filterCallerIdRows(rows, { query: '', filter: 'unassigned' }))).toEqual(['free']);
  });

  it('"Nobody assigned" lists an org default that cannot be used and has nobody on it (nobody uses it)', () => {
    const rows = [
      row({ id: 'def-active', is_org_default: true }),
      row({ id: 'def-paused', is_org_default: true, status: 'paused' }),
      row({ id: 'def-inactive', is_org_default: true, status: 'inactive' }),
      row({ id: 'def-pending', is_org_default: true, status: 'pending' }),
      row({
        id: 'def-paused-people', is_org_default: true, status: 'paused',
        assignments: [{ user_id: 'u', user_name: 'U', is_default: false }],
      }),
      row({ id: 'free' }),
    ];
    expect(ids(filterCallerIdRows(rows, { query: '', filter: 'unassigned' }))).toEqual([
      'def-paused', 'def-inactive', 'def-pending', 'free',
    ]);
  });

  it('"Calls only" is an active number that cannot text; paused and pending numbers are not', () => {
    const rows = [
      row({ id: 'calls', sms_enabled: false }),
      row({ id: 'paused', sms_enabled: false, status: 'paused' }),
      row({ id: 'pending', sms_enabled: false, status: 'pending' }),
      row({ id: 'texts' }),
    ];
    expect(ids(filterCallerIdRows(rows, { query: '', filter: 'calls-only' }))).toEqual(['calls']);
  });
});

describe('callerIdCountLabel', () => {
  it('reads "N numbers", or "N of M numbers" while narrowed', () => {
    expect(callerIdCountLabel(30, 30, false)).toBe('30 numbers');
    expect(callerIdCountLabel(1, 1, false)).toBe('1 number');
    expect(callerIdCountLabel(4, 30, true)).toBe('4 of 30 numbers');
    expect(callerIdCountLabel(0, 30, true)).toBe('0 of 30 numbers');
  });
});

describe('pageOf', () => {
  const items = Array.from({ length: 30 }, (_, i) => i);

  it('cuts 25 per page and counts the pages', () => {
    expect(pageOf(items, 1)).toEqual({ page: 1, pageCount: 2, items: items.slice(0, 25) });
    expect(pageOf(items, 2)).toEqual({ page: 2, pageCount: 2, items: [25, 26, 27, 28, 29] });
  });

  it('pulls a page past the end back to the last page, never an empty one', () => {
    expect(pageOf(items, 5)).toEqual({ page: 2, pageCount: 2, items: [25, 26, 27, 28, 29] });
    expect(pageOf(items.slice(0, 10), 2)).toEqual({ page: 1, pageCount: 1, items: items.slice(0, 10) });
  });

  it('an empty list is one page with nothing on it', () => {
    expect(pageOf([], 3)).toEqual({ page: 1, pageCount: 1, items: [] });
  });
});

// Slice 37b item 6: the manual reconcile script's argument handling.
import { describe, it, expect } from 'vitest';
import { parseOrgIds, unknownOrgLines } from '../services/payment-reconcile/org-args';

describe('parseOrgIds', () => {
  it('is undefined with no --org (every connected org)', () => {
    expect(parseOrgIds([])).toBeUndefined();
  });
  it('collects every --org value, in order', () => {
    expect(parseOrgIds(['--org', 'a', '--org', 'b'])).toEqual(['a', 'b']);
  });
  it('ignores a trailing --org with no value and unrelated flags', () => {
    expect(parseOrgIds(['--verbose', '--org', 'a', '--org'])).toEqual(['a']);
    expect(parseOrgIds(['--org'])).toBeUndefined();
  });
});

describe('unknownOrgLines', () => {
  it('says nothing when every requested org has a payout account', () => {
    expect(unknownOrgLines(['a', 'b'], ['b', 'a', 'c'])).toEqual([]);
  });
  it('names each requested org that does not', () => {
    expect(unknownOrgLines(['a', 'x'], ['a'])).toEqual(['no such org with a payout account: x']);
  });
});

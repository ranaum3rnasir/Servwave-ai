import { describe, it, expect } from 'vitest';
import { encodeFilters, decodeFilters } from './urlCodec';
import type { FacetConfig, FilterState } from './types';

const registry: FacetConfig[] = [
  { key: 'status', label: 'Status', icon: 'M0 0', kind: 'multi', param: 'status' },
  { key: 'estimates', label: '# of Estimates', icon: 'M0 0', kind: 'range', unit: 'estimates', min: 0, param: 'estimates' },
  { key: 'created', label: 'Created', icon: 'M0 0', kind: 'dateRange', param: 'created' },
];

describe('urlCodec', () => {
  it('encodes multi as a comma-joined param', () => {
    const state: FilterState = { status: { kind: 'multi', values: ['NEW', 'WON'] } };
    expect(encodeFilters(state, registry).get('status')).toBe('NEW,WON');
  });

  it('encodes an open-ended range with only the min bound', () => {
    const state: FilterState = { estimates: { kind: 'range', from: 3, to: null } };
    const params = encodeFilters(state, registry);
    expect(params.get('estimates_min')).toBe('3');
    expect(params.has('estimates_max')).toBe(false);
  });

  it('encodes dateRange using the facet param name', () => {
    const state: FilterState = { created: { kind: 'dateRange', from: '2026-01-01', to: '' } };
    expect(encodeFilters(state, registry).get('created_after')).toBe('2026-01-01');
  });

  it('decodes ignoring unknown keys and coercing per registry', () => {
    const params = new URLSearchParams('status=NEW,WON&estimates_min=1&unknown=x');
    const state = decodeFilters(params, registry);
    expect(state.status).toEqual({ kind: 'multi', values: ['NEW', 'WON'] });
    expect(state.estimates).toEqual({ kind: 'range', from: 1, to: null });
    expect(state.unknown).toBeUndefined();
  });

  it('omits a facet from the encoded URL entirely when it has no active value', () => {
    const state: FilterState = {};
    const params = encodeFilters(state, registry);
    expect(Array.from(params.keys())).toEqual([]);
  });

  it('omits a facet with an empty-but-present value (empty multi / null range / blank dateRange)', () => {
    const state: FilterState = {
      status: { kind: 'multi', values: [] },
      estimates: { kind: 'range', from: null, to: null },
      created: { kind: 'dateRange', from: '', to: '' },
    };
    const params = encodeFilters(state, registry);
    expect(Array.from(params.keys())).toEqual([]);
  });

  it('round-trips multi, range, and dateRange through encode -> decode', () => {
    const state: FilterState = {
      status: { kind: 'multi', values: ['NEW', 'WON'] },
      estimates: { kind: 'range', from: 2, to: 10 },
      created: { kind: 'dateRange', from: '2026-01-01', to: '2026-02-01' },
    };
    const decoded = decodeFilters(encodeFilters(state, registry), registry);
    expect(decoded).toEqual(state);
  });
});

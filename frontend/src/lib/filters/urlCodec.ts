/**
 * Encode/decode `FilterState` <-> `URLSearchParams`, driven by a page's
 * `FacetConfig[]` registry. This is the single source of truth for the wire
 * format shared with the backend registries (`backend/src/lib/query/registries/*.filters.ts`):
 * the param names produced here must match what the backend reads.
 *
 * Design choice: a facet with no active value (missing key, or a
 * present-but-empty value — `[]` / `{from: null, to: null}` / `{from: '', to: ''}`)
 * is omitted entirely from the URL rather than encoded as an empty param.
 * Keeps URLs clean and makes "facet not in params" the single source of truth
 * for "no filter applied" on decode.
 */
import type { FacetConfig, FilterState } from './types';

export function encodeFilters(state: FilterState, registry: FacetConfig[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const facet of registry) {
    const value = state[facet.key];
    if (!value) continue;
    if (value.kind === 'multi' && value.values.length > 0) {
      params.set(facet.param, value.values.join(','));
    } else if (value.kind === 'range') {
      if (value.from != null) params.set(`${facet.param}_min`, String(value.from));
      if (value.to != null) params.set(`${facet.param}_max`, String(value.to));
    } else if (value.kind === 'dateRange') {
      if (value.from) params.set(`${facet.param}_after`, value.from);
      if (value.to) params.set(`${facet.param}_before`, value.to);
    }
  }
  return params;
}

export function decodeFilters(params: URLSearchParams, registry: FacetConfig[]): FilterState {
  const state: FilterState = {};
  for (const facet of registry) {
    if (facet.kind === 'multi') {
      const raw = params.get(facet.param);
      if (raw) state[facet.key] = { kind: 'multi', values: raw.split(',').filter(Boolean) };
    } else if (facet.kind === 'range') {
      const min = params.get(`${facet.param}_min`);
      const max = params.get(`${facet.param}_max`);
      if (min != null || max != null) {
        state[facet.key] = {
          kind: 'range',
          from: min != null ? Number(min) : null,
          to: max != null ? Number(max) : null,
        };
      }
    } else if (facet.kind === 'dateRange') {
      const from = params.get(`${facet.param}_after`);
      const to = params.get(`${facet.param}_before`);
      if (from || to) state[facet.key] = { kind: 'dateRange', from: from ?? '', to: to ?? '' };
    }
  }
  return state;
}

/**
 * Binds a page's `FilterState` to the URL's search params via a `FacetConfig[]`
 * registry, so filters are shareable/bookmarkable/back-button-safe.
 *
 * @param registry A STABLE reference to the facet config array (must not be
 * an inline literal; use a module-level constant). The hook's useMemo/useCallback
 * calls depend on the registry reference's identity — a new array each render will
 * thrash all three memos (value, setValue, listParams), breaking referential
 * stability for children using React.memo or similar optimizations.
 *
 * `setValue` only touches the URL keys the registry knows about (each
 * facet's `param` and its `_min`/`_max`/`_after`/`_before` variants) — any
 * other param already on the URL (e.g. `page`, `sort`) passes through
 * untouched. It replaces history (`{ replace: true }`) rather than pushing,
 * so filter changes don't spam the browser back-stack.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FacetConfig, FilterState } from './types';
import { decodeFilters, encodeFilters } from './urlCodec';

export interface UseFilterStateResult {
  value: FilterState;
  setValue: (next: FilterState) => void;
  /** Encoded filter params only, as a plain object — ready to spread into a list-query call. */
  listParams: Record<string, string>;
}

export function useFilterState(registry: FacetConfig[]): UseFilterStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const value = useMemo(() => decodeFilters(searchParams, registry), [searchParams, registry]);

  const setValue = useCallback(
    (next: FilterState) => {
      const encoded = encodeFilters(next, registry);
      // Preserve non-filter params (page, sort, etc.) already on the URL —
      // only delete + re-set the specific keys this registry owns.
      const merged = new URLSearchParams(searchParams);
      for (const facet of registry) {
        merged.delete(facet.param);
        merged.delete(`${facet.param}_min`);
        merged.delete(`${facet.param}_max`);
        merged.delete(`${facet.param}_after`);
        merged.delete(`${facet.param}_before`);
      }
      encoded.forEach((v, k) => merged.set(k, v));
      setSearchParams(merged, { replace: true });
    },
    [registry, searchParams, setSearchParams],
  );

  const listParams = useMemo(
    () => Object.fromEntries(encodeFilters(value, registry)),
    [value, registry],
  );

  return { value, setValue, listParams };
}

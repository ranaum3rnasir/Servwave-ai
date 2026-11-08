import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { FacetOption } from '@/lib/filters/types';

export interface Tag {
  id: string;
  name: string;
  color: string;
}

/**
 * SRVW-58 - the org's tag vocabulary, for the Tags filter facet on the five
 * list pages.
 *
 * `queryKey` and the cached shape are deliberately identical to TagInput's own
 * inline `['tags']` query, so the two share one cache entry rather than
 * double-fetching. (Retiring that inline duplicate is out of scope here.)
 *
 * The `enabled` gate is load-bearing, not defensive: `GET /api/tags` is guarded
 * by `canDo('read', 'Tag')`, which defaultGrants gives to SALES/DISPATCHER/ADMIN
 * only, so an ungated hook would add a new 403 on every list page a TECHNICIAN
 * opens.
 *
 * `data.tags ?? []` is likewise required, not defensive - react-query v5 throws
 * "Query data cannot be undefined" when a queryFn resolves undefined, which is
 * exactly what a test-suite blanket `api.get` mock with no `tags` key returns.
 */
export function useTags() {
  const ability = useAppAbility();
  return useQuery({
    queryKey: ['tags'],
    queryFn: async () => {
      const { data } = await api.get('/api/tags');
      return (data.tags ?? []) as Tag[];
    },
    staleTime: 5 * 60_000,
    enabled: ability.can('read', 'Tag'),
  });
}

/**
 * SRVW-58 - `useTags()` results shaped for the Tags filter facet's `CheckboxFacet`, shared by
 * the five list pages instead of each re-deriving the value/label/swatch mapping.
 */
export function useTagFacetOptions(): FacetOption[] {
  const { data: tagOptions } = useTags();
  return useMemo(
    () => (tagOptions ?? []).map((t) => ({ value: t.id, label: t.name, swatch: t.color })),
    [tagOptions]
  );
}

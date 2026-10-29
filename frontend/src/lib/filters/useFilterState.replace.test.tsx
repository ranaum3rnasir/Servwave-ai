import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { FacetConfig } from './types';

// A pure contract-level check: mock react-router-dom's useSearchParams so we
// can assert exactly what useFilterState passes as the navigate options,
// independent of MemoryRouter's real history mechanics (covered behaviorally
// in useFilterState.test.tsx). This is the one place we pin down "replace,
// not push" per the plan's URL-state decision (filter changes must not spam
// browser history).
const setSearchParamsSpy = vi.fn();

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('page=2'), setSearchParamsSpy],
}));

import { useFilterState } from './useFilterState';

const registry: FacetConfig[] = [
  { key: 'status', label: 'Status', icon: 'M0 0', kind: 'multi', param: 'status' },
];

describe('useFilterState navigate contract', () => {
  it('calls setSearchParams with { replace: true } so filter changes do not push a new history entry', () => {
    const { result } = renderHook(() => useFilterState(registry));

    act(() => {
      result.current.setValue({ status: { kind: 'multi', values: ['NEW'] } });
    });

    expect(setSearchParamsSpy).toHaveBeenCalledTimes(1);
    const [nextParams, navigateOptions] = setSearchParamsSpy.mock.calls[0]!;
    expect(navigateOptions).toEqual({ replace: true });
    expect((nextParams as URLSearchParams).get('status')).toBe('NEW');
    // page=2 (present on the mocked initial searchParams) must survive.
    expect((nextParams as URLSearchParams).get('page')).toBe('2');
  });
});

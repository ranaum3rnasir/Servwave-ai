import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { FacetConfig } from './types';
import { useFilterState } from './useFilterState';

const registry: FacetConfig[] = [
  { key: 'status', label: 'Status', icon: 'M0 0', kind: 'multi', param: 'status' },
  { key: 'estimates', label: '# of Estimates', icon: 'M0 0', kind: 'range', unit: 'estimates', min: 0, param: 'estimates' },
];

function wrapperWithInitialSearch(initialSearch: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[`/leads${initialSearch}`]}>{children}</MemoryRouter>;
  };
}

describe('useFilterState', () => {
  it('decodes the initial FilterState from the URL', () => {
    const { result } = renderHook(() => useFilterState(registry), {
      wrapper: wrapperWithInitialSearch('?status=NEW,WON&page=2'),
    });
    expect(result.current.value).toEqual({ status: { kind: 'multi', values: ['NEW', 'WON'] } });
  });

  it('setValue encodes filters into the URL while preserving unrelated params (page, sort)', () => {
    const { result } = renderHook(
      () => {
        const filterState = useFilterState(registry);
        const [searchParams] = useSearchParams();
        return { ...filterState, searchParams };
      },
      { wrapper: wrapperWithInitialSearch('?page=2&sort=name') },
    );

    act(() => {
      result.current.setValue({ status: { kind: 'multi', values: ['NEW'] } });
    });

    expect(result.current.searchParams.get('page')).toBe('2');
    expect(result.current.searchParams.get('sort')).toBe('name');
    expect(result.current.searchParams.get('status')).toBe('NEW');
  });

  it('setValue clears a facet\'s URL params entirely when the new state omits it, without touching other params', () => {
    const { result } = renderHook(
      () => {
        const filterState = useFilterState(registry);
        const [searchParams] = useSearchParams();
        return { ...filterState, searchParams };
      },
      { wrapper: wrapperWithInitialSearch('?status=NEW,WON&estimates_min=1&page=3') },
    );

    act(() => {
      // Drop the status facet, keep estimates.
      result.current.setValue({ estimates: { kind: 'range', from: 1, to: null } });
    });

    expect(result.current.searchParams.has('status')).toBe(false);
    expect(result.current.searchParams.get('estimates_min')).toBe('1');
    expect(result.current.searchParams.get('page')).toBe('3');
  });

  it('listParams mirrors the encoded filter params only (no page/sort leakage)', () => {
    const { result } = renderHook(() => useFilterState(registry), {
      wrapper: wrapperWithInitialSearch('?status=NEW&page=5'),
    });
    expect(result.current.listParams).toEqual({ status: 'NEW' });
  });
});

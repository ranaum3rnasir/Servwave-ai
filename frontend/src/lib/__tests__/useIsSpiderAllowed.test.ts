import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useIsSpiderAllowed } from '../useIsSpiderAllowed';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: vi.fn(),
}));

describe('useIsSpiderAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for demo organizations', () => {
    vi.mocked(useAuthStore).mockImplementation((selector: any) =>
      selector({
        user: {
          id: 'u1',
          organization_id: 'org-demo',
          org_is_demo: true,
        },
      })
    );

    const { result } = renderHook(() => useIsSpiderAllowed());
    expect(result.current).toBe(true);
  });

  it('returns false for non-demo organizations without explicit allowance', () => {
    vi.mocked(useAuthStore).mockImplementation((selector: any) =>
      selector({
        user: {
          id: 'u1',
          organization_id: 'org-real-123',
          org_is_demo: false,
          org_features: ['leads', 'jobs'],
        },
      })
    );

    const { result } = renderHook(() => useIsSpiderAllowed());
    expect(result.current).toBe(false);
  });

  it('returns true for non-demo organizations explicitly allowed via org_features', () => {
    vi.mocked(useAuthStore).mockImplementation((selector: any) =>
      selector({
        user: {
          id: 'u1',
          organization_id: 'org-real-123',
          org_is_demo: false,
          org_features: ['spider'],
        },
      })
    );

    const { result } = renderHook(() => useIsSpiderAllowed());
    expect(result.current).toBe(true);
  });

  it('returns true for non-demo organizations explicitly allowed via feature_overrides', () => {
    vi.mocked(useAuthStore).mockImplementation((selector: any) =>
      selector({
        user: {
          id: 'u1',
          organization_id: 'org-real-123',
          org_is_demo: false,
          feature_overrides: { spider: true },
        },
      })
    );

    const { result } = renderHook(() => useIsSpiderAllowed());
    expect(result.current).toBe(true);
  });

  it('returns false when user is not logged in', () => {
    vi.mocked(useAuthStore).mockImplementation((selector: any) =>
      selector({
        user: null,
      })
    );

    const { result } = renderHook(() => useIsSpiderAllowed());
    expect(result.current).toBe(false);
  });
});

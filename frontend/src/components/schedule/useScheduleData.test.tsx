import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useScheduleData } from './useScheduleData';
import { asWallClock, toInstant } from '@/lib/schedule-tz';

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

// dateRange is wall-clock space (schedule-tz.ts) — the hook converts back to the real
// instant with `tz` right before it leaves the browser, so the expected params below are
// computed the same way, not by re-serialising the WallClock fixture directly.
const TZ = 'America/New_York';
const dateRange = {
  start: asWallClock(new Date('2026-06-01T00:00:00.000Z')),
  end: asWallClock(new Date('2026-06-07T23:59:59.999Z')),
};
const expectedAfter = toInstant(dateRange.start, TZ).toISOString();
const expectedBefore = toInstant(dateRange.end, TZ).toISOString();

/**
 * Set the org's resolved entitlements. Call this at the top of EVERY test, including the
 * ones that predate it: vitest.config.ts sets no clearMocks/mockReset, and vi.clearAllMocks()
 * clears CALLS but not a mockImplementation a previous test installed - an unset test would
 * silently inherit the previous test's org. Pass `undefined` for the unhydrated-cache case
 * (setup.ts's default user carries no org_features either, which is why this file ran
 * fail-open before).
 */
function mockOrgFeatures(features: string[] | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_features: features,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

describe('useScheduleData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: { jobs: [], leads: [] } });
  });

  it('queries scheduled jobs with the exact status + date params and adds department_id only when filtered', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'dept-9', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/jobs', {
        params: {
          status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
          scheduled_after: expectedAfter,
          scheduled_before: expectedBefore,
          department_id: 'dept-9',
          limit: 500,
        },
      }),
    );
  });

  it('omits department_id when departmentFilter is "all"', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/jobs', {
        params: {
          status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
          scheduled_after: expectedAfter,
          scheduled_before: expectedBefore,
          limit: 500,
        },
      }),
    );
  });

  it('queries walkthroughs for the calendar window with the exact date params', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: {
          walkthrough_after: expectedAfter,
          walkthrough_before: expectedBefore,
          limit: 500,
        },
      }),
    );
  });

  it('queries the unassigned bucket and unscheduled walkthroughs with their fixed params', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/jobs', { params: { status: 'UNSCHEDULED', limit: 100 } });
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: { walkthrough_status: 'needs_scheduling', limit: 100 },
      });
    });
  });

  // ── SRVW-102 - the same useFeature('leads') result that disables these queries is read
  //    directly by SchedulePage (not re-plumbed through this hook) to drive the bucket hide. ──
  it("org_features without 'leads' - neither /api/leads query fires", async () => {
    mockOrgFeatures(['jobs', 'scheduling']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), {
      wrapper: wrapper(qc),
    });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/jobs', { params: { status: 'UNSCHEDULED', limit: 100 } }),
    );
    expect(vi.mocked(api.get).mock.calls.filter(([url]) => String(url) === '/api/leads')).toEqual([]);
  });

  it("org_features WITH 'leads' - both lead queries fire with their exact current params", async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), {
      wrapper: wrapper(qc),
    });

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: {
          walkthrough_after: expectedAfter,
          walkthrough_before: expectedBefore,
          limit: 500,
        },
      });
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: { walkthrough_status: 'needs_scheduling', limit: 100 },
      });
    });
  });

  it('fail-open - org_features UNDEFINED (unhydrated auth cache) keeps both lead queries firing', async () => {
    mockOrgFeatures(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), {
      wrapper: wrapper(qc),
    });

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: {
          walkthrough_after: expectedAfter,
          walkthrough_before: expectedBefore,
          limit: 500,
        },
      });
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: { walkthrough_status: 'needs_scheduling', limit: 100 },
      });
    });
  });
});

// ─── Slice 03 — calendar entries (spec §4: core scheduler, every plan tier) ───────────────────
describe('useScheduleData — calendar entries (slice 03)', () => {
  it('queries /api/calendar-entries with start_after/start_before matching the window', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/calendar-entries', {
        params: { start_after: expectedAfter, start_before: expectedBefore },
      }),
    );
  });

  it('fires with NO leads feature — unlike the two lead queries, it is not useFeature-gated (spec §4)', async () => {
    mockOrgFeatures(['jobs', 'scheduling']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/calendar-entries', {
        params: { start_after: expectedAfter, start_before: expectedBefore },
      }),
    );
  });
});

describe('the board stops asking for statuses the API no longer has (multi-visit S4, D17)', () => {
  it('never sends EN_ROUTE or ON_SITE in the jobs query', async () => {
    mockOrgFeatures(['leads']);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useScheduleData({ dateRange, departmentFilter: 'all', tz: TZ }), { wrapper: wrapper(qc) });

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    // The jobs facet drops an unknown enum literal rather than 400ing, so sending these would not
    // break loudly - it would just quietly narrow nothing while looking deliberate. Asserted here
    // so the board's own contract stays honest about what a job status can be.
    const jobsCalls = vi.mocked(api.get).mock.calls.filter((c) => c[0] === '/api/jobs');
    expect(jobsCalls.length).toBeGreaterThan(0);
    for (const call of jobsCalls) {
      const status = (call[1] as { params?: { status?: unknown } } | undefined)?.params?.status;
      const values = Array.isArray(status) ? status : [status];
      expect(values).not.toContain('EN_ROUTE');
      expect(values).not.toContain('ON_SITE');
    }
  });
});

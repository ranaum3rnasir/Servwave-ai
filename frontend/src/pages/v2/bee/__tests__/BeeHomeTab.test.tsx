import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { BeeHomeTab } from '../tabs/BeeHomeTab';
import { useBeeStore } from '@/stores/beeStore';

vi.mock('@/stores/beeStore');

describe('BeeHomeTab', () => {
  const mockStore = {
    metrics: null,
    isLoading: false,
    error: null,
    toggleMasterStatus: vi.fn(),
    setActiveTab: vi.fn(),
    homeDateRange: '7d',
    setHomeDateRange: vi.fn(),
    homeAgentFilter: 'all',
    setHomeAgentFilter: vi.fn(),
    loadCalls: vi.fn(),
    openCallDetail: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT display misleading fallback numbers (184, 91, 28, 3) when metrics request fails with error', () => {
    vi.mocked(useBeeStore).mockReturnValue({
      ...mockStore,
      metrics: null,
      isLoading: false,
      error: 'Request failed with status code 404',
    } as any);

    render(<BeeHomeTab />);

    // Assert that placeholder numbers are NOT rendered
    expect(screen.queryByText('184')).toBeNull();
    expect(screen.queryByText('91')).toBeNull();
    expect(screen.queryByText('28')).toBeNull();
    expect(screen.queryByText('312 call attempts')).toBeNull();
    expect(screen.queryByText('49% reach rate')).toBeNull();
    expect(screen.queryByText('next call 3:30 PM')).toBeNull();

    // Assert that unavailable / dash indicators are rendered instead
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
    const unavailables = screen.getAllByText('Unavailable');
    expect(unavailables.length).toBeGreaterThanOrEqual(3);
  });

  it('displays loading state when metrics are loading and not yet available', () => {
    vi.mocked(useBeeStore).mockReturnValue({
      ...mockStore,
      metrics: null,
      isLoading: true,
      error: null,
    } as any);

    render(<BeeHomeTab />);

    // Assert that loading placeholders are rendered
    expect(screen.getAllByText('Loading...').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Loading metrics...').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('184')).toBeNull();
    expect(screen.queryByText('91')).toBeNull();
  });

  it('displays real metrics when metrics request succeeds', () => {
    vi.mocked(useBeeStore).mockReturnValue({
      ...mockStore,
      isLoading: false,
      error: null,
      metrics: {
        ok: true,
        isActive: true,
        callWindow: { start: '10:00', end: '19:00', timezone: 'America/New_York' },
        kpis: {
          customersCalled: { value: 42, subtitle: '55 call attempts' },
          reached: { value: 19, subtitle: '45% reach rate' },
          inQueue: { value: 12, subtitle: 'next call 4:00 PM' },
          needsHumanCount: { value: 2, subtitle: '2 open requiring action' },
        },
        funnel: { queued: 12, totalCalls: 42, reached: 19, reachRate: 45 },
        callsPerDay: [],
        needsHuman: [],
        upcomingExpirations: [],
        recentCalls: [],
        counts: { totalCalls: 42, answeredCalls: 19, queueCount: 12, activeAgentsCount: 1 },
      },
    } as any);

    render(<BeeHomeTab />);

    expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('55 call attempts')).toBeInTheDocument();
    expect(screen.getAllByText('19').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('45% reach rate').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('12').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});

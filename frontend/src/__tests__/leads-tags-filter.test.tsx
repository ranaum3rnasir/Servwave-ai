import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import LeadsPage from '@/pages/LeadsPage';

// SRVW-58 - the Tags read surface on a list page: the column, the rail facet and the
// KPI-active gate that a new facet key has to be added to by hand.
//
// The default test ability denies everything, which would leave useTags() disabled and
// the rail empty for the wrong reason, so `read Tag` is granted here.
vi.mock('@/contexts/AbilityContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/AbilityContext')>();
  return { ...actual, useAppAbility: () => ({ can: () => true }) };
});

const mockApi = vi.mocked(api);

// The shared setup mocks ResizeObserver with an arrow fn, which Radix's floating-ui
// calls with `new`. Mirrors customers-filter-no-state.test.tsx.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const TAG = { id: 'a0000000-0000-0000-0000-0000000000aa', name: 'Recurring billing', color: '#2F7D5D' };

const LEAD_ROW = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  status: 'NEW',
  service_request: 'AC not cooling',
  created_at: '2026-07-01T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'Lee', last_name: 'Adams', phone: '5125550001' },
  estimates: [],
  tags: [TAG],
};

function leadsResponse() {
  return {
    data: {
      leads: [LEAD_ROW],
      pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
      stats: { total: 1, new_this_week: 0, unassigned: 0, won: 0, lost: 0 },
    },
  };
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/leads') return Promise.resolve(leadsResponse());
    if (url === '/api/tags') return Promise.resolve({ data: { tags: [TAG] } });
    return Promise.resolve({ data: {} });
  });
});

describe('LeadsPage - tags read surface', () => {
  it('renders the tag name from the list payload in the Tags column', async () => {
    renderWithProviders(<LeadsPage />);
    expect(await screen.findByRole('columnheader', { name: 'Tags' })).toBeInTheDocument();
    expect(await screen.findByText(TAG.name)).toBeInTheDocument();
  });

  it('shows a Tags rail tab whose options come from /api/tags, and sends ?tags=<id>', async () => {
    renderWithProviders(<LeadsPage />);
    await screen.findByText('L00001');

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tags' }));

    const option = await screen.findByRole('checkbox', { name: TAG.name });
    fireEvent.click(option);

    await waitFor(() => {
      const leadCalls = mockApi.get.mock.calls.filter((c) => c[0] === '/api/leads');
      const last = leadCalls[leadCalls.length - 1]!;
      expect((last[1] as { params: Record<string, unknown> }).params.tags).toBe(TAG.id);
    });
  });

  it('a tags-only filter does not leave the Total KPI tile active', async () => {
    renderWithProviders(<LeadsPage />);
    await screen.findByText('L00001');

    const totalTile = screen.getByRole('button', { name: /total leads/i });
    // Baseline: nothing filtered, so the Total tile IS active (its ring class).
    expect(totalTile.className).toContain('ring-2');

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tags' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: TAG.name }));

    // With only a tags value applied the list is narrowed, so no tile may claim to
    // represent it. A falsely-active Total tile would route a click into
    // clearAllFilters() and silently drop the tag filter.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /total leads/i }).className).not.toContain('ring-2');
    });
  });
});

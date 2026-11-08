import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';

// #2011 — the v2 Estimates list's status tiles (Draft/Sent/Pending/Won/
// Declined/Archived) render the count only, though the list API's embedded
// `stats` already carries `{count, value}` per status (see
// EstimatesPage.tsx:43's `StatusStat` type and lines 490-524's `<StatCard>`s,
// which pass only `.count`). Only the 7th "Pending Deposits" tile shows
// money. Desired: every tile shows the count AND, beneath it, the formatted
// worth ("$1,250.25"; a zero-value status renders "$0.00").
const mockApi = vi.mocked(api);

const ESTIMATE_LIST_FIXTURE = {
  estimates: [],
  pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
  stats: {
    draft: { count: 2, value: 1250.25 },
    sent: { count: 1, value: 300 },
    pending: { count: 0, value: 0 },
    won: { count: 0, value: 0 },
    declined: { count: 0, value: 0 },
    archived: { count: 0, value: 0 },
    pending_deposits: { count: 1, total: 100 },
  },
  users: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: ESTIMATE_LIST_FIXTURE });
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

describe('repro #2011 — v2 Estimates status tiles omit worth', () => {
  it('shows the formatted worth ($1,250.25) beneath the Draft tile\'s count', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });

    // Observed behaviour on base: only the count ("2") renders for the Draft
    // tile; the tile's worth ($1,250.25, carried on stats.draft.value) is
    // nowhere in the document.
    expect(screen.getByText('$1,250.25')).toBeInTheDocument();
  });

  it('a zero-value status tile (Pending) still renders its worth as "$0.00"', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Pending', { selector: 'span' })).toBeInTheDocument();
    });

    // Scoped to the Pending tile: several statuses in the fixture are worth
    // $0.00, so a document-wide query would be ambiguous once they all render.
    const pendingTile = screen.getByText('Pending', { selector: 'span' }).closest('[data-slot="stat-card"]');
    expect(pendingTile).not.toBeNull();
    expect(within(pendingTile as HTMLElement).getByText('$0.00')).toBeInTheDocument();
  });
});

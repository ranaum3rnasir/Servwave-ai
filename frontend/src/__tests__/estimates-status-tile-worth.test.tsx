import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';

// #2011 — every status tile on the v2 Estimates list shows its count AND,
// beneath it, that status's worth (the API's `stats.<status>.value`, which
// arrives over the wire as a STRING for Prisma `Decimal` sums). Covers the
// string-wire-value case the frozen repro test does not (it uses numbers),
// a zero status's worth scoped to its own tile, the window caption's exact
// text appearing once, and the Pending Deposits tile staying detail-less.
const mockApi = vi.mocked(api);

const ESTIMATE_LIST_FIXTURE = {
  estimates: [],
  pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
  stats: {
    draft: { count: 11, value: '1357.19' },
    sent: { count: 1, value: '0' },
    pending: { count: 0, value: 0 },
    won: { count: 0, value: 0 },
    declined: { count: 0, value: 0 },
    archived: { count: 0, value: 0 },
    pending_deposits: { count: 2, total: '1190.20' },
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

const WINDOW_CAPTION =
  'Draft, Sent, Won, Declined and Archived cover estimates created this month. Pending and Pending Deposits are all time.';

describe('#2011 — Estimates status tiles show worth beneath count', () => {
  it("shows the Draft tile's worth from a STRING stats value", async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });

    const draftTile = screen.getByText('Draft', { selector: 'span' }).closest('[data-slot="stat-card"]');
    expect(draftTile).not.toBeNull();
    expect(within(draftTile as HTMLElement).getByText('$1,357.19')).toBeInTheDocument();
  });

  it("a zero status's worth (\"$0.00\") is scoped to its own tile", async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Won', { selector: 'span' })).toBeInTheDocument();
    });

    const wonTile = screen.getByText('Won', { selector: 'span' }).closest('[data-slot="stat-card"]');
    expect(wonTile).not.toBeNull();
    expect(within(wonTile as HTMLElement).getByText('$0.00')).toBeInTheDocument();
  });

  it('renders the window caption exactly once, verbatim', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });

    expect(screen.getAllByText(WINDOW_CAPTION)).toHaveLength(1);
  });

  it('the Pending Deposits tile has no detail node', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Pending Deposits', { selector: 'span' })).toBeInTheDocument();
    });

    const depositsTile = screen
      .getByText('Pending Deposits', { selector: 'span' })
      .closest('[data-slot="stat-card"]');
    expect(depositsTile).not.toBeNull();
    expect((depositsTile as HTMLElement).querySelector('[data-slot="stat-card-detail"]')).toBeNull();
  });
});

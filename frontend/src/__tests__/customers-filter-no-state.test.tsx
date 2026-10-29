import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomersPage from '@/pages/CustomersPage';

const mockApi = vi.mocked(api);

// The shared setup mocks ResizeObserver with an arrow fn, which Radix's
// floating-ui calls with `new` — a constructable class is needed to open the
// Filter Popover in jsdom. Mirrors data-table-visibility.test.tsx. Scoped here.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/customers/stats') {
      return Promise.resolve({
        data: { total: 0, newThisMonth: 0, activeLeads: 0, activeJobs: 0 },
      });
    }
    if (url === '/api/customers') {
      return Promise.resolve({
        data: { customers: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } },
      });
    }
    return Promise.resolve({ data: {} });
  });
});

describe('CustomersPage — filter panel has no State section', () => {
  it('renders the other filter rail tabs but not a State tab', async () => {
    renderWithProviders(<CustomersPage />);

    // Open the Filter popover. fireEvent (not userEvent) opens the Radix
    // popover reliably in jsdom — see data-table-visibility.test.tsx.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));

    // Task 17 replaced the old single-pane `FilterPopover`/`FilterSection`
    // chrome (which rendered each facet as its own `<h3>` heading) with the
    // generalized two-pane `FilterBar` (a `role="tablist"` rail, one
    // `role="tab"` per facet — see FilterBar.tsx). Sanity: the rail rendered
    // the registry's other facets.
    expect(await screen.findByRole('tab', { name: 'Source' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Payment Type' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tax Exempt' })).toBeInTheDocument();
    // has_leads/has_jobs — 2-option `multi` facets moved into the FilterBar
    // (formerly standalone tri-state SelectFields in the toolbar).
    expect(screen.getByRole('tab', { name: 'Leads' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '# of Leads' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '# of Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Created' })).toBeInTheDocument();

    // No State facet tab. Exact name match (not a substring) so it can't
    // accidentally match e.g. "Statement" — customersRegistry (Task 17)
    // deliberately excludes `state` (see customer.filters.ts's Task 16
    // report: `state` stays hand-rolled on the backend, coupled with the
    // non-facet `city` filter; the page never sends either).
    expect(screen.queryByRole('tab', { name: 'State' })).toBeNull();
  });
});

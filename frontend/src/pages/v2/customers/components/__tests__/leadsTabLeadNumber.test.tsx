/**
 * The customer page's Leads tab shows each lead's number, as the Leads list does: "Lead #" is the
 * leftmost column of the table, and a line on the phone card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { renderWithProviders as render } from '@/__tests__/helpers';
import { LeadsTab, type LeadSummary } from '../detailTabs';
import type { CustomerListView } from '../../useCustomerListPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ORG = 'America/Los_Angeles';
vi.mock('@/lib/api/shared/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/shared/organization')>();
  return { ...actual, useOrganization: () => ({ data: { id: 'org-1', timezone: ORG }, isLoading: false, isError: false }) };
});

function view<T>(rows: T[]): CustomerListView<T> {
  return {
    rows, status: 'ready', failedPage: null, onRetry: vi.fn(),
    pager: { page: 1, pageSize: 20, total: rows.length, onPageChange: vi.fn(), onPageSizeChange: vi.fn(), isFetching: false },
  };
}

const LEAD: LeadSummary = {
  id: 'lead-1', lead_number: 'L-1042', status: 'NEW', service_request: 'Front door rekey',
  created_at: '2026-09-01T12:00:00.000Z', commission_owner: null, estimates: [], next_walkthrough: null,
};

const originalMatchMedia = window.matchMedia;
function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe('customer Leads tab - the lead number', () => {
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it('table: Lead # is the leftmost column and each row shows its lead number there', () => {
    render(<LeadsTab view={view([LEAD])} timeZone={ORG} onNavigate={vi.fn()} />);

    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]).toHaveTextContent('Lead #');
    const row = screen.getByText('Front door rekey').closest('tr')!;
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('L-1042');
  });

  describe('cards (below lg)', () => {
    beforeEach(() => answerMedia((q) => q === MEDIA.belowLg));

    it('the card has a Lead # line with the lead number', () => {
      render(<LeadsTab view={view([LEAD])} timeZone={ORG} onNavigate={vi.fn()} />);

      const card = screen.getByRole('button', { name: 'Front door rekey' }).closest('li')!;
      expect(within(card).getByText('Lead #')).toBeInTheDocument();
      expect(within(card).getByText('L-1042')).toBeInTheDocument();
    });
  });
});

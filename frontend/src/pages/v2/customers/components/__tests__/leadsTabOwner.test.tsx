/**
 * Roles & Permissions PRD 3 - the customer page's Leads tab names a lead's Owner, as the Leads list does: the column
 * reads "Owner", the cell is the lead's Owner (not its walkthrough crew) and an empty one shows a dash. The words
 * "Assigned To" and "Unassigned" are not drawn for a lead.
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
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: { id: 'org-1', timezone: ORG }, isLoading: false, isError: false }) };
});

function view<T>(rows: T[]): CustomerListView<T> {
  return {
    rows, status: 'ready', failedPage: null, onRetry: vi.fn(),
    pager: { page: 1, pageSize: 20, total: rows.length, onPageChange: vi.fn(), onPageSizeChange: vi.fn(), isFetching: false },
  };
}

const OWNED: LeadSummary = {
  id: 'lead-1', status: 'CONTACTED', service_request: 'Front door rekey', created_at: '2026-09-01T12:00:00.000Z',
  commission_owner: { id: 'u1', first_name: 'Ana', last_name: 'Lee' },
  estimates: [], next_walkthrough: null,
};
const OWNERLESS: LeadSummary = {
  id: 'lead-2', status: 'NEW', service_request: 'Window lock', created_at: '2026-09-02T12:00:00.000Z',
  commission_owner: null,
  estimates: [], next_walkthrough: null,
};

const originalMatchMedia = window.matchMedia;
function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe('customer Leads tab - the lead Owner', () => {
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it('table: the column reads Owner, shows the Owner by name and a dash when there is none', () => {
    render(<LeadsTab view={view([OWNED, OWNERLESS])} timeZone={ORG} onNavigate={vi.fn()} />);

    expect(screen.getByRole('columnheader', { name: 'Owner' })).toBeInTheDocument();
    const owned = screen.getByText('Front door rekey').closest('tr')!;
    expect(within(owned).getByText('Ana Lee')).toBeInTheDocument();
    const ownerless = screen.getByText('Window lock').closest('tr')!;
    expect(within(ownerless).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Assigned To')).not.toBeInTheDocument();
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
  });

  describe('cards (below lg)', () => {
    beforeEach(() => answerMedia((q) => q === MEDIA.belowLg));

    it('the card line reads Owner with the same cell', () => {
      render(<LeadsTab view={view([OWNED, OWNERLESS])} timeZone={ORG} onNavigate={vi.fn()} />);

      const owned = screen.getByRole('button', { name: 'Front door rekey' }).closest('li')!;
      expect(within(owned).getByText('Owner')).toBeInTheDocument();
      expect(within(owned).getByText('Ana Lee')).toBeInTheDocument();
      const ownerless = screen.getByRole('button', { name: 'Window lock' }).closest('li')!;
      expect(within(ownerless).getByText('—')).toBeInTheDocument();
      expect(screen.queryByText('Assigned To')).not.toBeInTheDocument();
      expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
    });
  });
});

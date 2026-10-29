import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import CustomersPage from '@/pages/CustomersPage';
import { startOfMonthDay } from '@/lib/date-range';

const mockApi = vi.mocked(api);

const CUSTOMER_LIST_FIXTURE = {
  customers: [
    {
      id: 'c0000000-0000-0000-0000-000000000001',
      customer_number: 'C00001',
      first_name: 'John',
      last_name: 'Doe',
      company_name: null,
      email: 'john@example.com',
      phone: '5551234567',
      ad_source: 'Google',
      created_at: '2026-07-15T00:00:00.000Z',
      service_locations: [],
      _count: { leads: 1, jobs: 2 },
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
};

const CUSTOMER_STATS_FIXTURE = {
  total: 10,
  newThisMonth: 3,
  activeLeads: 2,
  activeJobs: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/customers/stats') {
      return Promise.resolve({ data: CUSTOMER_STATS_FIXTURE });
    }
    if (url === '/api/customers') {
      return Promise.resolve({ data: CUSTOMER_LIST_FIXTURE });
    }
    return Promise.resolve({ data: {} });
  });
});

// Radix Popover/Select need a real constructable ResizeObserver + fireEvent
// (not userEvent) to open in jsdom — mirrors FilterBar.test.tsx / jobs-page.test.tsx's
// established precedent.
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
});

/** Exposes the MemoryRouter's current path+search so tests can assert on the URL. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function customersApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/customers');
}

/** KpiTile renders its label in its own `<span>` — grabbing that exact node
 * and walking up to the `<button>` sidesteps accessible-name collisions with
 * other page text (mirrors invoices-page.test.tsx's `kpiButton` helper). */
function kpiButton(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: 'span' });
  const button = el.closest('button');
  if (!button) throw new Error(`No <button> ancestor found for KPI tile "${label}"`);
  return button;
}

describe('CustomersPage', () => {
  it('renders page heading', async () => {
    renderWithProviders(<CustomersPage />);
    expect(screen.getByText('Customers')).toBeInTheDocument();
  });

  it('renders KPI strip with tile labels', async () => {
    renderWithProviders(<CustomersPage />);
    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.getByText('New This Month', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Active Leads', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Active Jobs', { selector: 'span' })).toBeInTheDocument();
  });

  it('shows search placeholder', () => {
    renderWithProviders(<CustomersPage />);
    expect(screen.getByPlaceholderText('Search customers...')).toBeInTheDocument();
  });

  it('calls API with correct params on mount', async () => {
    renderWithProviders(<CustomersPage />);
    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/customers', {
        params: expect.objectContaining({ page: 1, limit: 25, ad_source: undefined }),
      });
    });
  });
});

describe('CustomersPage — generalized filter registry (Task 17)', () => {
  it('setting Source + Tax Exempt + # of Leads range + # of Jobs range updates both the URL query string and the /api/customers request params', async () => {
    renderWithProviders(
      <>
        <CustomersPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });

    // Open the Filter popover (Source/ad_source is the first/default facet pane)
    // and select the "Google" checkbox.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Google' }));

    // Switch to the "Tax Exempt" multi facet and select "Tax Exempt".
    fireEvent.click(screen.getByRole('tab', { name: /^tax exempt$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tax Exempt' }));

    // Switch to the "# of Leads" range facet and set From/To.
    fireEvent.click(screen.getByRole('tab', { name: /^# of leads$/i }));
    fireEvent.change(screen.getByLabelText('# of Leads From'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('# of Leads To'), { target: { value: '5' } });

    // Switch to the "# of Jobs" range facet and set From/To.
    fireEvent.click(screen.getByRole('tab', { name: /^# of jobs$/i }));
    fireEvent.change(screen.getByLabelText('# of Jobs From'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('# of Jobs To'), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    // URL reflects all four facets, using the frontend codec's multi + range
    // `_min`/`_max` suffix convention.
    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('ad_source=Google');
      expect(url).toContain('tax_exempt=true');
      expect(url).toContain('leads_min=1');
      expect(url).toContain('leads_max=5');
      expect(url).toContain('jobs_min=2');
      expect(url).toContain('jobs_max=10');
    });

    // The outgoing /api/customers request carries the matching (backend-aligned) param names.
    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            ad_source: 'Google',
            tax_exempt: 'true',
            leads_min: '1',
            leads_max: '5',
            jobs_min: '2',
            jobs_max: '10',
          }),
        })
      );
    });
  });

  it('clicking the "New This Month" KPI tile applies {created: monthStart..open} with other filters cleared', async () => {
    renderWithProviders(<CustomersPage />);

    await waitFor(() => {
      expect(screen.getByText('New This Month', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('New This Month'));

    const monthStart = startOfMonthDay();

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ created_after: monthStart }),
        })
      );
      expect(lastCall[1].params.created_before).toBeUndefined();
      expect(lastCall[1].params.ad_source).toBeUndefined();
      expect(lastCall[1].params.open_leads).toBeUndefined();
      expect(lastCall[1].params.active_jobs).toBeUndefined();
      expect(lastCall[1].params.has_leads).toBeUndefined();
    });

    // Clicking it again clears back to the default (Total) view.
    fireEvent.click(kpiButton('New This Month'));

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.created_after).toBeUndefined();
    });
  });

  it('clicking the "Active Leads" KPI tile applies the standalone open_leads=true param with no other filters', async () => {
    renderWithProviders(<CustomersPage />);

    await waitFor(() => {
      expect(screen.getByText('Active Leads', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Active Leads'));

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ open_leads: 'true' }) })
      );
      expect(lastCall[1].params.active_jobs).toBeUndefined();
      expect(lastCall[1].params.ad_source).toBeUndefined();
      expect(lastCall[1].params.created_after).toBeUndefined();
    });

    // Toggle off.
    fireEvent.click(kpiButton('Active Leads'));

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.open_leads).toBeUndefined();
    });
  });

  it('the Leads facet (has_leads) inside the FilterBar and the standalone "Show archived" checkbox reach the /api/customers request', async () => {
    renderWithProviders(<CustomersPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });

    // "Leads" (has_leads) is now a 2-option `multi` facet inside the FilterBar
    // popover — distinct from the "# of Leads" count-range facet also in
    // there. Open the popover, switch to the "Leads" tab, check "Has Leads".
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^leads$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Has Leads' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    // Standalone "Show archived" checkbox (include_archived) — the one
    // control that stays outside the FilterBar.
    fireEvent.click(screen.getByRole('checkbox', { name: /show archived/i }));

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ has_leads: 'true', include_archived: true }),
        })
      );
    });
  });

  it('checking both "Has Leads" and "No Leads" degrades has_leads to no filter (both-selected comma-join matches neither backend branch)', async () => {
    renderWithProviders(<CustomersPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^leads$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Has Leads' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'No Leads' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => {
      const calls = customersApiCalls();
      const lastCall = calls[calls.length - 1];
      // Both selected → comma-joined `has_leads=true,false` client-side; the
      // backend's `=== 'true'` / `=== 'false'` checks both miss, so this is
      // sent as a real param but resolves to "no filter" server-side.
      expect(lastCall[1].params.has_leads).toBe('true,false');
    });
  });
});

/**
 * Slice 018-b — the Export control's ability gate on the UNROUTED v1 page.
 *
 * `/customers` routes to `pages/v2/customers/CustomersPage.tsx` (see
 * `pages/v2/routes/customers.routes.tsx`; App.tsx routes nothing itself), and
 * that live page's gate is covered by
 * `pages/v2/customers/__tests__/customersExportGate.test.tsx`. This copy is kept
 * in lockstep so the two do not answer the same question differently, and these
 * two cases are what hold it there.
 *
 * The tests ABOVE deliberately keep rendering without an ability: they never
 * asserted on Export, so `emptyAbility`'s deny posture changes nothing for them.
 */
describe('CustomersPage — Export control ability gate', () => {
  it('renders the Export control for an ability that permits customer export', async () => {
    renderWithProviders(<CustomersPage />, {
      ability: buildAbility([{ action: 'export', subject: 'Customer' }]),
    });

    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^export$/i })).toBeInTheDocument();
  });

  it('hides the Export control — trigger and both menu items — for an ability that does not permit it', async () => {
    // Read + update, NOT empty: an empty ability would hide the button even if
    // the gate were wired to the wrong permission, which would make this pass
    // for the wrong reason.
    renderWithProviders(<CustomersPage />, {
      ability: buildAbility([
        { action: 'read', subject: 'Customer' },
        { action: 'update', subject: 'Customer' },
      ]),
    });

    await waitFor(() => {
      expect(screen.getByText('Total Customers', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/current page \(/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/all customers \(/i)).not.toBeInTheDocument();

    // Nothing else on the page moved.
    expect(screen.getByPlaceholderText('Search customers...')).toBeInTheDocument();
  });
});

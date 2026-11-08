import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoicesPage from '@/pages/InvoicesPage';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';

const mockApi = vi.mocked(api);

const INVOICE_LIST_FIXTURE = {
  invoices: [
    {
      id: 'i0000000-0000-0000-0000-000000000001',
      invoice_number: 'I00001',
      status: 'SENT',
      kind: 'STANDARD',
      subtotal: 100,
      discount_amount: 0,
      tax_amount: 10,
      deposit_credit: 0,
      total_amount: 110,
      amount_due: 110,
      due_date: '2026-08-01T00:00:00.000Z',
      sent_at: '2026-07-15T00:00:00.000Z',
      paid_at: null,
      created_at: '2026-07-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: null,
      },
      job: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    due: { total: 1500, count: 2 },
    overdue: { total: 500, count: 1 },
    collected_this_month: { total: 2000, count: 3 },
    unsent: 1,
    need_invoices: 4,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: INVOICE_LIST_FIXTURE });
});

// Radix Popover needs a real constructable ResizeObserver + fireEvent (not
// userEvent) to open in jsdom — mirrors FilterBar.test.tsx / estimates-page.test.tsx's
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

function invoicesApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/invoices');
}

/** KpiTile renders its label in its own `<span>` — grabbing that exact node
 * and walking up to the `<button>` sidesteps accessible-name collisions
 * with non-KPI text elsewhere on the page (e.g. the "Due Date" column
 * header vs the "Due" KPI tile). */
function kpiButton(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: 'span' });
  const button = el.closest('button');
  if (!button) throw new Error(`No <button> ancestor found for KPI tile "${label}"`);
  return button;
}

describe('InvoicesPage', () => {
  it('renders page heading', async () => {
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByText('Invoices')).toBeInTheDocument();
  });

  it('renders KPI strip with tile labels', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.getByText('Overdue', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Unsent Drafts', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('To Be Invoiced', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders invoice customer name in table', async () => {
    renderWithProviders(<InvoicesPage />);
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });
  });

  it('shows search placeholder', () => {
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByPlaceholderText('Search invoices...')).toBeInTheDocument();
  });

  it('calls API with correct params on mount', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/invoices', {
        params: expect.objectContaining({ page: 1, limit: 25, status: undefined }),
      });
    });
  });
});

describe('InvoicesPage — generalized filter registry (Task 15)', () => {
  it('setting Status + Total range + Balance range + Created date range updates both the URL query string and the /api/invoices request params', async () => {
    renderWithProviders(
      <>
        <InvoicesPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    // Open the Filter popover (Status is the first/default facet pane) and
    // select the "Sent" status checkbox.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sent' }));

    // Switch to the "Total" range facet (role="tab") and set From/To via its
    // number inputs.
    fireEvent.click(screen.getByRole('tab', { name: /^total$/i }));
    fireEvent.change(screen.getByLabelText('Total From'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Total To'), { target: { value: '5000' } });

    // Switch to the "Balance Due" range facet and set From/To.
    fireEvent.click(screen.getByRole('tab', { name: /^balance due$/i }));
    fireEvent.change(screen.getByLabelText('Balance Due From'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Balance Due To'), { target: { value: '2000' } });

    // Switch to the "Created" dateRange facet and pick the "This month" preset
    // from its `DateRangeField` (a Radix-style Select — `DateFacet.test.tsx`'s
    // established pattern: click the combobox, click the option).
    fireEvent.click(screen.getByRole('tab', { name: /^created$/i }));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'This month' }));

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    const monthStart = startOfMonthDay();
    const monthEnd = endOfMonthDay();

    // URL reflects all four facets, using the frontend codec's range `_min`/`_max`
    // and dateRange `_after`/`_before` suffixes.
    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('status=SENT');
      expect(url).toContain('total_min=500');
      expect(url).toContain('total_max=5000');
      expect(url).toContain('balance_min=100');
      expect(url).toContain('balance_max=2000');
      expect(url).toContain(`created_after=${monthStart}`);
      expect(url).toContain(`created_before=${monthEnd}`);
    });

    // The outgoing /api/invoices request carries the matching (backend-aligned) param names.
    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'SENT',
            total_min: '500',
            total_max: '5000',
            balance_min: '100',
            balance_max: '2000',
            created_after: monthStart,
            created_before: monthEnd,
          }),
        })
      );
    });
  });

  it('clicking the "Due" KPI tile applies {status:[SENT,PARTIAL]} with overdue off', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Due'));

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ status: 'SENT,PARTIAL' }) })
      );
      expect(lastCall[1].params.overdue).toBeUndefined();
      expect(lastCall[1].params.total_min).toBeUndefined();
      expect(lastCall[1].params.balance_min).toBeUndefined();
      expect(lastCall[1].params.created_after).toBeUndefined();
    });

    // The tile now shows itself as active; clicking it again clears back to the default view.
    fireEvent.click(kpiButton('Due'));

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.status).toBeUndefined();
    });
  });

  it('clicking the "Overdue" KPI tile applies the overdue facet (?overdue=true) with no status facet', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('Overdue', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Overdue'));

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ overdue: 'true' }) })
      );
      expect(lastCall[1].params.status).toBeUndefined();
    });

    // Toggle off
    fireEvent.click(kpiButton('Overdue'));

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.overdue).toBeUndefined();
    });
  });

  it('checking the "Overdue" facet in the Filter popover sends ?overdue=true, and it composes with a Status facet checked in the same session', async () => {
    renderWithProviders(
      <>
        <InvoicesPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    // Open the Filter popover, switch to the "Overdue" facet pane, and check it.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^overdue$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overdue' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('overdue=true');
    });

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ overdue: 'true' }) })
      );
    });

    // Re-opening the popover and ALSO checking a Status value composes onto
    // the still-checked Overdue facet (the two-pane popover accumulates every
    // checked facet across tabs into one submission on "Done" — confirms
    // `overdue` is NOT mutually exclusive with `status` at the UI level; the
    // backend's documented "overdue overwrites status" precedence (see
    // `buildInvoiceListWhere`) is free to apply server-side exactly as
    // before this change). The Filter button's accessible name now includes
    // the "1" selection-count badge (`totalSelected > 0`), so match on the
    // leading "Filter" prefix only — same precedent as `jobs-page.test.tsx`'s
    // second-click case.
    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^status$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Draft' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ status: 'DRAFT', overdue: 'true' }),
        })
      );
    });
  });

  it('the Overdue facet composes with the Due date-range facet (?overdue=true&due_after=...)', async () => {
    renderWithProviders(
      <>
        <InvoicesPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Due', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^overdue$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Overdue' }));

    fireEvent.click(screen.getByRole('tab', { name: /^due$/i }));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'This month' }));

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    const monthStart = startOfMonthDay();

    // Both facets survive together in one `setValue` call's encoded output —
    // confirms `overdue` isn't mutually exclusive with other facets at the UI
    // level (the backend's overdue+due_after merge / overdue-wins-over-status
    // semantics in `buildInvoiceListWhere` still get exercised from the
    // frontend exactly as before this change).
    await waitFor(() => {
      const calls = invoicesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({ overdue: 'true', due_after: monthStart }),
        })
      );
    });
  });
});

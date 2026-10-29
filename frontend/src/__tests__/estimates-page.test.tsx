import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import EstimatesPage from '@/pages/EstimatesPage';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { buildAbility } from '@/lib/ability';

// SRVW-105 step 17 - the bulk toolbar's Delete button is now gated on `can('delete','Estimate')`
// (it rendered unconditionally before), so the bulk-selection tests below need a full-access
// ability, mirroring how every other ability-gated page test does this (see estimate-detail-
// deposit.test.tsx's adminAbility).
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// Bulk-delete toast assertions (mirrors scope-of-work-card.test.tsx's minimal shape — this page
// only imports `{ toast }`, never the `useToast()` hook, and no Toaster is mounted by
// renderWithProviders, so a bare `toast: vi.fn()` mock is enough).
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
import { toast } from '@/components/ui/use-toast';

const mockApi = vi.mocked(api);

const ESTIMATE_LIST_FIXTURE = {
  estimates: [
    {
      id: 'e0000000-0000-0000-0000-000000000001',
      estimate_number: 'E00001',
      status: 'WON',
      subtotal: 100,
      tax_amount: 10,
      total_amount: 110,
      created_at: '2026-07-15T00:00:00.000Z',
      lead: {
        id: 'l0000000-0000-0000-0000-000000000001',
        customer: {
          id: 'c0000000-0000-0000-0000-000000000001',
          first_name: 'John',
          last_name: 'Doe',
          company_name: null,
          customer_number: 'C00001',
        },
      },
      creator: { id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Alex', last_name: 'Romero' },
      deposit: null,
    },
    // Second row (bulk-delete tests below select across rows to prove exact-id-set behavior).
    {
      id: 'e0000000-0000-0000-0000-000000000002',
      estimate_number: 'E00002',
      status: 'DRAFT',
      subtotal: 50,
      tax_amount: 5,
      total_amount: 55,
      created_at: '2026-07-16T00:00:00.000Z',
      lead: {
        id: 'l0000000-0000-0000-0000-000000000002',
        customer: {
          id: 'c0000000-0000-0000-0000-000000000002',
          first_name: 'Jane',
          last_name: 'Smith',
          company_name: null,
          customer_number: 'C00002',
        },
      },
      creator: { id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Alex', last_name: 'Romero' },
      deposit: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
  stats: {
    draft: { count: 2, value: 2000 },
    sent: { count: 5, value: 5000 },
    pending: { count: 1, value: 1000 },
    won: { count: 3, value: 3000 },
    declined: { count: 1, value: 500 },
    archived: { count: 0, value: 0 },
    pending_deposits: { count: 2, total: 2500 },
  },
  // Estimates page also fires a GET to /api/estimates/creators, whose
  // response shape reads `data.users` — a single resolver shape that
  // satisfies both endpoints is enough here (mirrors jobs-page.test.tsx's
  // JOB_LIST_FIXTURE precedent of folding every endpoint's shape into one
  // mockResolvedValue).
  users: [
    { id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Alex', last_name: 'Romero' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: ESTIMATE_LIST_FIXTURE });
});

// Radix Popover needs a real constructable ResizeObserver + fireEvent (not
// userEvent) to open in jsdom — mirrors FilterBar.test.tsx / jobs-page.test.tsx's
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

function estimatesApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/estimates');
}

/** KpiTile renders its label in its own `<span>` — grabbing that exact node
 * and walking up to the `<button>` sidesteps accessible-name collisions
 * between sibling tiles that share a word (e.g. "Pending" vs "Pending
 * Deposits", whose full accessible names both start with "Pending"). */
function kpiButton(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: 'span' });
  const button = el.closest('button');
  if (!button) throw new Error(`No <button> ancestor found for KPI tile "${label}"`);
  return button;
}

describe('EstimatesPage', () => {
  it('renders page heading', async () => {
    renderWithProviders(<EstimatesPage />);
    expect(screen.getByText('Estimates')).toBeInTheDocument();
  });

  it('renders KPI strip with tile labels', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });
    expect(screen.getByText('Sent', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Pending', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Won', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Declined', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Archived', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Pending Deposits', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders estimate customer name in table', async () => {
    renderWithProviders(<EstimatesPage />);
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });
  });

  it('shows search placeholder', () => {
    renderWithProviders(<EstimatesPage />);
    expect(screen.getByPlaceholderText('Search estimates...')).toBeInTheDocument();
  });

  it('calls API with correct params on mount', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/estimates', {
        params: expect.objectContaining({ page: 1, limit: 25, status: undefined }),
      });
    });
  });
});

describe('EstimatesPage — generalized filter registry (Task 13)', () => {
  it('setting Status + Total range + Deposit updates both the URL query string and the /api/estimates request params', async () => {
    renderWithProviders(
      <>
        <EstimatesPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });

    // Open the Filter popover (Status is the first/default facet pane) and
    // select the "Sent" status checkbox.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sent' }));

    // Switch to the "Total" range facet (role="tab", distinct from the
    // table's "Total" column header) and set From/To via its number inputs.
    fireEvent.click(screen.getByRole('tab', { name: /^total$/i }));
    fireEvent.change(screen.getByLabelText('Total From'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Total To'), { target: { value: '5000' } });

    // Switch to the "Deposit" facet and select "Paid".
    fireEvent.click(screen.getByRole('tab', { name: /^deposit$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Paid' }));

    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    // URL reflects all three facets, using the frontend codec's range `_min`/`_max` suffixes.
    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('status=SENT');
      expect(url).toContain('total_min=500');
      expect(url).toContain('total_max=5000');
      expect(url).toContain('deposit_status=PAID');
    });

    // The outgoing /api/estimates request carries the matching (backend-aligned) param names.
    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'SENT',
            total_min: '500',
            total_max: '5000',
            deposit_status: 'PAID',
          }),
        })
      );
    });
  });

  it('clicking the "Pending" (all-time) KPI tile applies {status:[PENDING]} with no date range', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Pending', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Pending'));

    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ status: 'PENDING' }) })
      );
      // Only the status facet is active — no leftover created range, created_by,
      // deposit, or total from a previous preset (guards the KPI preset's exact shape).
      expect(lastCall[1].params.created_after).toBeUndefined();
      expect(lastCall[1].params.created_before).toBeUndefined();
      expect(lastCall[1].params.created_by).toBeUndefined();
      expect(lastCall[1].params.deposit_status).toBeUndefined();
      expect(lastCall[1].params.total_min).toBeUndefined();
      expect(lastCall[1].params.total_max).toBeUndefined();
    });

    // The tile now shows itself as active; clicking it again clears back to the default view.
    fireEvent.click(kpiButton('Pending'));

    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.status).toBeUndefined();
    });
  });

  it('clicking the "Draft" (monthly) KPI tile applies {status:[DRAFT], created: current month}', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Draft'));

    const monthStart = startOfMonthDay();
    const monthEnd = endOfMonthDay();

    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'DRAFT',
            created_after: monthStart,
            created_before: monthEnd,
          }),
        })
      );
    });
  });

  it('clicking the "Pending Deposits" KPI tile applies deposit_status=[REQUESTED] with no status filter', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(screen.getByText('Pending Deposits', { selector: 'span' })).toBeInTheDocument();
    });

    fireEvent.click(kpiButton('Pending Deposits'));

    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ deposit_status: 'REQUESTED' }) })
      );
      expect(lastCall[1].params.status).toBeUndefined();
    });

    // Toggle off
    fireEvent.click(kpiButton('Pending Deposits'));

    await waitFor(() => {
      const calls = estimatesApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.deposit_status).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════
// Bulk delete (list-level row selection) — R7 tail
// ═══════════════════════════════════════════════════════
describe('EstimatesPage — bulk delete (row selection)', () => {
  it('selecting rows shows the "N selected" bar with a Delete action', async () => {
    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    expect(rowCheckboxes).toHaveLength(2);

    fireEvent.click(rowCheckboxes[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();

    fireEvent.click(rowCheckboxes[1]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('confirming delete calls POST /api/estimates/bulk-delete with exactly the selected ids', async () => {
    mockApi.post.mockResolvedValue({ data: { deleted: [ESTIMATE_LIST_FIXTURE.estimates[0].id], failed: [] } });

    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    // Select ONLY the first row — the request must carry exactly this one id, not both.
    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    // The prompt is the app's own ConfirmDialog now, so its copy is asserted on screen
    // rather than through a window.confirm spy.
    expect(await screen.findByText('Delete 1 draft estimate?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Delete estimates?$/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/estimates/bulk-delete', {
        ids: [ESTIMATE_LIST_FIXTURE.estimates[0].id],
      });
    });
  });

  it('declining the confirm dialog does not call the bulk-delete endpoint', async () => {
    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(mockApi.post).not.toHaveBeenCalled();
    // Selection is left intact so the user can retry.
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('a successful response clears the selection and shows a success toast', async () => {
    mockApi.post.mockResolvedValue({ data: { deleted: [ESTIMATE_LIST_FIXTURE.estimates[0].id], failed: [] } });

    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete estimates?$/ }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Estimates deleted', description: 'Deleted 1 estimate.' })
      );
    });
    // The toolbar disappears once the selection is cleared.
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('a response with partial failures reports the ACTUAL backend reason in the toast, not a hardcoded guess', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        deleted: [ESTIMATE_LIST_FIXTURE.estimates[1].id],
        failed: [{ id: ESTIMATE_LIST_FIXTURE.estimates[0].id, error: 'Only draft estimates can be deleted' }],
      },
    });

    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    fireEvent.click(rowCheckboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete estimates?$/ }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Some estimates could not be deleted',
          description: 'Deleted 1 estimate. 1 could not be deleted (Only draft estimates can be deleted).',
        })
      );
    });
  });

  it('surfaces a DIFFERENT failure reason verbatim (e.g. a concurrent delete elsewhere) rather than assuming "not a draft"', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        deleted: [ESTIMATE_LIST_FIXTURE.estimates[1].id],
        failed: [{ id: ESTIMATE_LIST_FIXTURE.estimates[0].id, error: 'Estimate not found' }],
      },
    });

    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    fireEvent.click(rowCheckboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete estimates?$/ }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Deleted 1 estimate. 1 could not be deleted (Estimate not found).',
        })
      );
    });
  });

  it('falls back to a generic phrase when failures in the same batch have different reasons', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        deleted: [],
        failed: [
          { id: ESTIMATE_LIST_FIXTURE.estimates[0].id, error: 'Only draft estimates can be deleted' },
          { id: ESTIMATE_LIST_FIXTURE.estimates[1].id, error: 'Estimate not found' },
        ],
      },
    });

    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    fireEvent.click(rowCheckboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete estimates?$/ }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Deleted 0 estimates. 2 could not be deleted (various reasons).',
        })
      );
    });
  });

  it('clicking a status KPI (a filter change) clears any existing selection', async () => {
    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.click(kpiButton('Draft'));

    await waitFor(() => {
      expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    });
  });

  it('changing the search query clears any existing selection', async () => {
    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });

    const rowCheckboxes = screen.getAllByRole('checkbox', { name: /^select row$/i });
    fireEvent.click(rowCheckboxes[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // DataTable debounces onSearchChange by 300ms before it reaches this page's `search` state.
    fireEvent.change(screen.getByPlaceholderText('Search estimates...'), { target: { value: 'foo' } });

    await waitFor(
      () => {
        expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  });
});

/**
 * SERV10X-61 - the estimates LIST for a customer-anchored (lead-less) estimate.
 *
 * Found by live QA on staging, not by the suite: a lead-less estimate showed a bare em dash in the
 * Customer column, and the CSV export dereferenced `e.lead.customer` with no guard, so exporting
 * any page containing one threw before it wrote a single row.
 *
 * The root cause was a lying type. `EstimatesPage`'s local `Estimate` interface declared `lead`
 * (and its nested `customer`) as NON-nullable, even though `lead_id` became nullable in R6, so tsc
 * could not flag the unguarded access. The interface is now honest and both call sites fall back
 * to the direct `customer` that `estimateListSelect` already returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import EstimatesPage from '@/pages/EstimatesPage';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/inventory/csv', () => ({
  toCSV: vi.fn(() => 'csv-text'),
  downloadCSV: vi.fn(),
}));
import { toCSV } from '@/lib/inventory/csv';

const mockApi = vi.mocked(api);
const mockToCSV = vi.mocked(toCSV);

/** A customer-anchored estimate: `lead` is null, the customer hangs off the row directly. */
const LEAD_LESS_ROW = {
  id: 'e0000000-0000-0000-0000-0000000000aa',
  estimate_number: 'C00001-1',
  status: 'SENT',
  subtotal: 1200,
  tax_amount: 75,
  total_amount: 1275,
  created_at: '2026-07-24T00:00:00.000Z',
  lead: null,
  lead_id: null,
  customer: {
    id: 'c0000000-0000-0000-0000-0000000000aa',
    first_name: 'Dana',
    last_name: 'Whitfield',
    company_name: 'Whitfield Plumbing',
    customer_number: 'C00042',
  },
  creator: { id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Alex', last_name: 'Romero' },
  deposit: null,
};

const FIXTURE = {
  estimates: [LEAD_LESS_ROW],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    draft: { count: 0, value: 0 },
    sent: { count: 1, value: 1275 },
    pending: { count: 0, value: 0 },
    won: { count: 0, value: 0 },
    declined: { count: 0, value: 0 },
    archived: { count: 0, value: 0 },
    pending_deposits: { count: 0, total: 0 },
  },
  users: [{ id: 'u0000000-0000-0000-0000-000000000001', first_name: 'Alex', last_name: 'Romero' }],
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: FIXTURE });
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe('EstimatesPage - customer-anchored (lead-less) row', () => {
  it('shows the customer in the Customer column instead of an em dash', async () => {
    renderWithProviders(<EstimatesPage />);

    // The row rendered at all (guards against this passing on an empty table).
    expect(await screen.findByText('C00001-1')).toBeInTheDocument();
    // Resolved from the direct `customer`, since there is no lead to hop through. Pre-fix the
    // column fell through to the em-dash placeholder.
    expect(await screen.findByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('C00042')).toBeInTheDocument();
  });

  it('exports a lead-less row without throwing, carrying its customer and company', async () => {
    renderWithProviders(<EstimatesPage />);
    expect(await screen.findByText('C00001-1')).toBeInTheDocument();

    // Radix DropdownMenu opens on pointerdown, not click, in jsdom.
    fireEvent.pointerDown(
      screen.getByRole('button', { name: /Export/i }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' },
    );
    fireEvent.click(await screen.findByText(/Current page/i));

    // Pre-fix this never ran: `e.lead.customer` threw inside the map.
    await waitFor(() => expect(mockToCSV).toHaveBeenCalled());
    const rows = mockToCSV.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]['Customer']).toBe('Dana Whitfield');
    expect(rows[0]['Company']).toBe('Whitfield Plumbing');
    expect(rows[0]['Estimate #']).toBe('C00001-1');
  });
});

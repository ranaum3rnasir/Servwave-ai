/**
 * standalone-invoice-catalog-seeding.test.tsx — the fifth seeding site.
 *
 * `components/crm/LineItemsEditor` has a price-book search of its own: it calls
 * `/api/price-book/items/search` directly and seeds a line from the raw row, so it had
 * the same under-pricing defect as the job / invoice / estimate editors and the same
 * image defect the picker had. An item the catalog prices at $500 went onto a standalone
 * invoice at $0.00, and the suggestion row the operator clicked said $0.00 too.
 *
 * The surface is exercised through the ROUTED page. `/invoices/new` resolves to
 * `pages/v2/invoices/StandaloneInvoiceFormPage` (declared in
 * `pages/v2/routes/invoices.routes.tsx`); the v1 `pages/StandaloneInvoiceFormPage` is
 * imported by no route file and is dead. Testing the live page means the assertion is
 * about the invoice a real operator would create, not about a component in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import StandaloneInvoiceFormPage from '@/pages/v2/invoices/StandaloneInvoiceFormPage';
import { buildAbility } from '@/lib/ability';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// Radix's floating-ui calls ResizeObserver with `new`; the shared setup's arrow-fn stub
// is not constructable. Same scoped workaround the sibling standalone-invoice test uses.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  first_name: 'Dana',
  last_name: 'Deposit',
  company_name: null,
  phone: '5125550100',
  email: 'dana@example.com',
  tax_exempt: false,
  service_locations: [],
};

/**
 * The defect's own shape, as `/api/price-book/items/search` returns it today: the picture
 * and the price reached the columns this editor did NOT read, so the raw `image_url` is
 * null and the raw `unit_price` is 0 while the resolved answers carry the truth.
 */
const COIL = {
  id: 'pb-coil',
  name: 'Condenser Coil',
  description: null,
  image_url: null,
  photoUrl: 'https://cdn.example.com/coil.png',
  type: 'MATERIAL',
  unit_cost: 200,
  unit_price: 0,
  sellPrice: 500,
  unitCost: 200,
  taxable: true,
  category: null,
};

describe('Standalone invoice (crm LineItemsEditor) — a line seeded from the catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/state-tax-rates') return Promise.resolve({ data: { data: [] } });
      if (url === '/api/customers' || url === '/api/customers/picker') {
        return Promise.resolve({ data: { customers: [CUSTOMER] } });
      }
      if (url.startsWith('/api/price-book/items/search')) {
        return Promise.resolve({ data: { data: [COIL] } });
      }
      // The editor loads price-book categories on mount.
      return Promise.resolve({ data: { data: [] } });
    });
    mockApi.post.mockResolvedValue({ data: { invoice: { id: 'inv-new' } } });
  });

  /** Customer first — the line editor does not render until one is selected. */
  async function pickCustomerAndSearch() {
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });

    const firstName = await screen.findByPlaceholderText('First name');
    fireEvent.focus(firstName);
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    fireEvent.click(await screen.findByText(/Dana Deposit/));

    const pbSearch = await screen.findByPlaceholderText('Search price book...');
    await userEvent.type(pbSearch, 'Coil');
    return screen.findByText('Condenser Coil');
  }

  it('offers the catalog item at its resolved price, not at the raw legacy column', async () => {
    const suggestion = await pickCustomerAndSearch();

    const row = suggestion.closest('button') as HTMLElement;
    expect(row).toHaveTextContent('$500.00');
    expect(row).not.toHaveTextContent('$0.00');
  });

  it('shows the catalog picture on the suggestion row', async () => {
    const suggestion = await pickCustomerAndSearch();

    const row = suggestion.closest('button') as HTMLElement;
    expect(row.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.com/coil.png');
  });

  it('creates the invoice at the catalog price, never at zero', async () => {
    const suggestion = await pickCustomerAndSearch();
    await userEvent.click(suggestion.closest('button') as HTMLElement);

    await userEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/invoices', expect.anything()));
    const body = mockApi.post.mock.calls.at(-1)?.[1] as {
      line_items: { description: string; unit_price: number }[];
    };
    const line = body.line_items.find((li) => li.description === 'Condenser Coil');
    expect(line?.unit_price).toBe(500);
    expect(line?.unit_price).not.toBe(0);
  });
});

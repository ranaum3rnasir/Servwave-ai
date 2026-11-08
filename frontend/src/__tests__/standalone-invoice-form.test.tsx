import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import StandaloneInvoiceFormPage from '@/pages/StandaloneInvoiceFormPage';
import { buildAbility } from '@/lib/ability';

// Standalone Invoices (slice 4): the page composes PickOrCreateCustomer +
// PickOrAccreteLocation + LineItemsEditor and POSTs the customer-anchored
// standalone body to /api/invoices, then navigates to the invoice detail page.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// The shared setup mocks ResizeObserver with an arrow fn, which Radix's
// floating-ui / react-use-size (the Checkbox + Select here) call with `new` —
// a constructable class is needed in jsdom. Scoped to this file.
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
  service_locations: [
    {
      id: 'l0000000-0000-0000-0000-000000000001',
      address_line1: '123 Main St',
      address_line2: null,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      is_primary: true,
    },
  ],
};

// An existing customer the duplicate-guard 409 points at (id differs from CUSTOMER).
const DUP = {
  id: 'c0000000-0000-0000-0000-000000000002',
  first_name: 'Dana',
  last_name: 'Existing',
  company_name: null,
  email: 'dupe@example.com',
  phone: '5125559999',
};

describe('StandaloneInvoiceFormPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    // state-tax-rates (preview) + customer search + price-book categories all go through api.get.
    // #2041 slice 1 - this page shares `components/crm/PickOrCreateCustomer.tsx` with the
    // (in-scope) v2 job form, whose search now hits the org-wide picker endpoint
    // (`/api/customers/picker`), not `/api/customers`. Serve both so this out-of-scope v1 page's
    // own coverage stays green.
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/state-tax-rates') {
        return Promise.resolve({ data: { data: [{ state_code: 'TX', state_name: 'Texas', tax_rate: 0.0625 }] } });
      }
      if (url === '/api/customers' || url === '/api/customers/picker') {
        return Promise.resolve({ data: { customers: [CUSTOMER] } });
      }
      // LineItemsEditor loads price-book categories on mount.
      return Promise.resolve({ data: { data: [] } });
    });
  });

  it('prompts to select a customer before any line items are shown', async () => {
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });
    expect(
      await screen.findByText(/select or create a customer/i),
    ).toBeInTheDocument();
  });

  // Regression for #259: the customer control used to render in BOTH a desktop sidebar
  // (`hidden lg:block`) and a mobile card (`lg:hidden`), so #email/#phone appeared twice and
  // (because the Radix duplicate dialog portals to <body>, escaping `lg:hidden`) two dialogs
  // stacked. We now pick one variant via a JS media query (jsdom matchMedia → false → desktop),
  // so the contact inputs must exist exactly once.
  it('renders the customer control exactly once (no portaled dual-render) — #259', async () => {
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });
    await screen.findByText(/select or create a customer/i);
    expect(document.querySelectorAll('#email')).toHaveLength(1);
    expect(document.querySelectorAll('#phone')).toHaveLength(1);
  });

  // #352 — storage is digits-only canonical and the phone input is masked, so
  // selecting an existing customer must hydrate the masked field with the
  // FORMATTED value, never the raw stored digits.
  it('hydrates the masked phone field as (xxx) xxx-xxxx when picking an existing customer — #352', async () => {
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });

    const firstName = (await screen.findAllByPlaceholderText('Search...'))[0];
    fireEvent.focus(firstName);
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    fireEvent.click(await screen.findByText(/Dana Deposit/));

    // CUSTOMER.phone is stored as '5125550100' (digits-only).
    expect((document.getElementById('phone') as HTMLInputElement).value).toBe('(512) 555-0100');
  });

  it('POSTs the standalone body (mapped line items + service_location_id) and navigates to the invoice', async () => {
    mockApi.post.mockResolvedValue({
      data: { invoice: { id: 'i0000000-0000-0000-0000-000000000009' } },
    });

    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });

    // Pick an existing customer via the contact-field typeahead.
    const firstName = screen.getAllByPlaceholderText('Search...')[0];
    fireEvent.focus(firstName);
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    const option = await screen.findByText(/Dana Deposit/);
    fireEvent.click(option);

    // The line-items editor now renders. Fill the first row's name + price.
    const nameInput = await screen.findByPlaceholderText('Item name');
    fireEvent.change(nameInput, { target: { value: 'Diagnostic fee' } });
    // The row has two '0.00' inputs (Price, then Cost) — Price is first.
    const priceInput = screen.getAllByPlaceholderText('0.00')[0];
    fireEvent.change(priceInput, { target: { value: '150' } });

    // Submit.
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/invoices', expect.anything()));

    const [, body] = mockApi.post.mock.calls.find((c) => c[0] === '/api/invoices')!;
    expect(body).toMatchObject({
      customer_id: CUSTOMER.id,
      service_location_id: CUSTOMER.service_locations[0].id,
      line_items: [
        expect.objectContaining({
          description: 'Diagnostic fee',
          quantity: 1,
          unit_price: 150,
          is_taxable: true,
          item_type: 'SERVICE',
        }),
      ],
    });
    // No price_book_item_id on a free-form line.
    expect(body.line_items[0]).not.toHaveProperty('price_book_item_id');

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/invoices/i0000000-0000-0000-0000-000000000009'),
    );
  });

  // ── #267: resolving the duplicate-customer dialog must clear the failed create-customer
  // mutation, or the bottom error region (gated on
  // `(createInvoice.isError || createCustomer.isError) && !dupExisting`) re-shows the stale 409
  // "duplicate" text once dupExisting clears. extractApiError surfaces data.error verbatim, so the
  // stale text is the exact string "duplicate" (distinct from the dialog title "Possible Duplicate
  // Customer"). dismissDuplicate() now also calls createCustomer.reset() at every dismiss site.

  // Enter a new (unselected) contact that collides, then submit to fire the create + 409.
  const triggerDuplicate = async () => {
    const firstName = (await screen.findAllByPlaceholderText('Search...'))[0];
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    fireEvent.change(document.getElementById('email')!, { target: { value: DUP.email } });
    fireEvent.change(document.getElementById('phone')!, { target: { value: DUP.phone } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('Possible Duplicate Customer')).toBeInTheDocument();
  };

  it('clears the stale duplicate error after "Open existing customer" — #267', async () => {
    // GET /api/customers/:id resolves the full existing record (handleOpenExisting reads data.customer).
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/state-tax-rates') {
        return Promise.resolve({ data: { data: [{ state_code: 'TX', state_name: 'Texas', tax_rate: 0.0625 }] } });
      }
      if (url.startsWith('/api/customers/')) {
        return Promise.resolve({ data: { customer: { ...CUSTOMER, id: DUP.id } } });
      }
      if (url === '/api/customers') {
        return Promise.resolve({ data: { customers: [CUSTOMER] } });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'duplicate', existing: DUP } } });

    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });
    await triggerDuplicate();

    fireEvent.click(screen.getByRole('button', { name: /open existing customer/i }));

    // Dialog closes, customer selected (button → "Create Invoice"), and the stale 409 is gone.
    await waitFor(() => expect(screen.queryByText('Possible Duplicate Customer')).toBeNull());
    expect(await screen.findByRole('button', { name: /create invoice/i })).toBeInTheDocument();
    expect(screen.queryByText('duplicate')).toBeNull();
  });

  it('returns focus to the edited field and clears the stale error on "Edit email" — #267', async () => {
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'duplicate', existing: DUP } } });

    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });
    await triggerDuplicate();

    fireEvent.click(screen.getByRole('button', { name: /edit email/i }));

    await waitFor(() => expect(screen.queryByText('Possible Duplicate Customer')).toBeNull());
    await waitFor(() => expect(document.activeElement?.id).toBe('email'));
    expect(screen.queryByText('duplicate')).toBeNull();
  });

  it('still surfaces a real (non-duplicate) create-customer error — #267', async () => {
    // A 500 with no `existing` → getDuplicateCustomer returns null → dupExisting never set → no dialog,
    // dismissDuplicate never runs, and the real error must still render.
    mockApi.post.mockRejectedValue({ response: { status: 500, data: { error: 'Server exploded' } } });

    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });
    const firstName = (await screen.findAllByPlaceholderText('Search...'))[0];
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    fireEvent.change(document.getElementById('email')!, { target: { value: 'real@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    expect(screen.queryByText('Possible Duplicate Customer')).toBeNull();
  });

  // ── #260: the standalone <form> now carries `noValidate`, so the qty Input's native min="0.01"
  // bubble no longer preempts onSubmit and the app's own "Quantity must be greater than 0" guard
  // (handleSubmit) is reachable. jsdom 28 enforces HTML5 constraint validation, so pre-fix this
  // message rendered 0× and submit was natively blocked — i.e. this is a genuine red→green guard.
  it('surfaces the app qty>0 message (not the native bubble) and does not POST — #260', async () => {
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility });

    // Pick the existing customer to reach the line-items editor.
    const firstName = screen.getAllByPlaceholderText('Search...')[0];
    fireEvent.focus(firstName);
    fireEvent.change(firstName, { target: { value: 'Dana' } });
    fireEvent.click(await screen.findByText(/Dana Deposit/));

    // Name a line, give it a price, then zero the quantity.
    fireEvent.change(await screen.findByPlaceholderText('Item name'), { target: { value: 'Diagnostic fee' } });
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '150' } });
    fireEvent.change(screen.getByPlaceholderText('1'), { target: { value: '0' } });

    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    // The app's own message renders (page summary + per-line = 2 nodes); no invoice POST fires.
    expect((await screen.findAllByText(/quantity must be greater than 0/i)).length).toBeGreaterThanOrEqual(1);
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

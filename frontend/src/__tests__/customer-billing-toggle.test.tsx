import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

// #438 — Billing Address must not pre-fill with the service address when the
// customer was saved with "same as service" (billing_* mirror the service
// location). Mirrored rows load collapsed; revealing the billing box opens blank.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

const SERVICE = {
  id: 'l0000000-0000-0000-0000-000000000001',
  address_line1: '500 Waverly Avenue',
  address_line2: null,
  city: 'Brooklyn',
  state: 'NY',
  zip: '11238',
  is_primary: true,
};

function baseCustomer(overrides: Record<string, unknown>) {
  return {
    id: 'c0000000-0000-0000-0000-000000000001',
    kind: 'PERSON',
    first_name: 'Ada',
    last_name: 'Lovelace',
    company_name: null,
    phone: '5125550100',
    email: 'ada@example.com',
    service_locations: [SERVICE],
    ...overrides,
  };
}

function renderEdit() {
  return renderWithProviders(
    <Routes>
      <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
    </Routes>,
    { initialEntries: ['/customers/c0000000-0000-0000-0000-000000000001/edit'] },
  );
}

function mockCustomer(customer: Record<string, unknown>) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url.startsWith('/api/customers/')) return Promise.resolve({ data: { customer } });
    return Promise.resolve({ data: {} });
  });
}

describe('CustomerFormPage — billing toggle (#438)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  it('(a) mirrored billing loads collapsed and reveals blank fields', async () => {
    mockCustomer(
      baseCustomer({
        // billing_* exactly mirror the primary service location (line2 omitted, as backend does).
        billing_address_line1: '500 Waverly Avenue',
        billing_address_line2: null,
        billing_city: 'Brooklyn',
        billing_state: 'NY',
        billing_zip: '11238',
      }),
    );
    const { container } = renderEdit();

    // Collapsed row shown, not the expanded box.
    expect(
      await screen.findByText('Billing address is the same as the service address'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Billing Address')).not.toBeInTheDocument();

    // Reveal → all billing fields empty (never the service address).
    fireEvent.click(screen.getByRole('button', { name: /use a different billing address/i }));
    await screen.findByText('Billing Address');

    const line1 = container.querySelector('#billing_address_line1') as HTMLInputElement;
    expect(line1.value).toBe('');
    // Billing City/State/ZIP are the 2nd occurrence (service address is 1st in DOM).
    expect((screen.getAllByPlaceholderText('City')[1] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByPlaceholderText('State')[1] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByPlaceholderText('ZIP')[1] as HTMLInputElement).value).toBe('');
  });

  it('(b) genuinely different billing still loads pre-filled and expanded', async () => {
    mockCustomer(
      baseCustomer({
        billing_address_line1: '1 Billing Plaza',
        billing_address_line2: 'Suite 200',
        billing_city: 'Albany',
        billing_state: 'NY',
        billing_zip: '12207',
      }),
    );
    const { container } = renderEdit();

    // Expanded box pre-filled with the billing (not service) address.
    await screen.findByText('Billing Address');
    const line1 = container.querySelector('#billing_address_line1') as HTMLInputElement;
    expect(line1.value).toBe('1 Billing Plaza');
    expect((screen.getAllByPlaceholderText('City')[1] as HTMLInputElement).value).toBe('Albany');
    // Collapsed "same as service" row not shown.
    expect(
      screen.queryByText('Billing address is the same as the service address'),
    ).not.toBeInTheDocument();
  });

  it('(c) toggling same-as-service then different yields blank fields', async () => {
    mockCustomer(
      baseCustomer({
        billing_address_line1: '1 Billing Plaza',
        billing_address_line2: 'Suite 200',
        billing_city: 'Albany',
        billing_state: 'NY',
        billing_zip: '12207',
      }),
    );
    const { container } = renderEdit();

    await screen.findByText('Billing Address');
    // Collapse via "Same as service address".
    fireEvent.click(screen.getByRole('button', { name: /same as service address/i }));
    await waitFor(() =>
      expect(
        screen.getByText('Billing address is the same as the service address'),
      ).toBeInTheDocument(),
    );
    // Reveal again → blank.
    fireEvent.click(screen.getByRole('button', { name: /use a different billing address/i }));
    await screen.findByText('Billing Address');

    const line1 = container.querySelector('#billing_address_line1') as HTMLInputElement;
    expect(line1.value).toBe('');
    expect((screen.getAllByPlaceholderText('City')[1] as HTMLInputElement).value).toBe('');
  });
});

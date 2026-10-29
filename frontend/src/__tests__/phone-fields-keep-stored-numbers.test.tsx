/**
 * Mobile slice 36: every phone field uses the phone input WITHOUT LOSING ANY STORED NUMBER.
 *
 * The old typing mask (formatPhoneInput) was also run over the STORED value when a form
 * opened, and it keeps the first ten digits. A customer saved with an international number
 * (447700900123) or a number longer than ten digits therefore opened as "(447) 700-9001",
 * and an unrelated edit (a note, a name) saved the truncated number over the real one.
 *
 * These open the live customer form with such numbers, change something else, save, and
 * read what the page sent.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import api from '@/lib/axios';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';

const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'cust-1',
  customer_number: 'd00512',
  first_name: 'Phone',
  last_name: 'Keeper',
  company_name: '',
  email: 'keeper@example.com',
  phone: '447700900123',
  phone_ext: '12',
  segment: null,
  extra_emails: [],
  phones: [{ phone: '5125550147214', label: 'Office', extension: null, is_primary: false }],
  ad_source: null,
  source: null,
  allow_billing: false,
  tax_exempt: false,
  parent_id: null,
  is_parent: false,
  billing_terms: null,
  billing_address_line1: null,
  billing_city: null,
  billing_state: null,
  billing_zip: null,
  notes: null,
  created_at: '2026-08-24T13:48:35.986Z',
  service_locations: [],
};

function renderEditForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/customers/cust-1/edit']}>
        <Routes>
          <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
          <Route path="/customers/:id" element={<div>customer detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('customer form: a stored international or long number survives an unrelated edit (mobile slice 36)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/customers/cust-1') return Promise.resolve({ data: { customer: CUSTOMER } });
      return Promise.resolve({ data: {} });
    });
    mockApi.patch.mockResolvedValue({ data: { customer: CUSTOMER } });
  });

  it('shows both numbers exactly as stored, as telephone fields', async () => {
    renderEditForm();
    await screen.findByTestId('customer-form');
    const primary = await screen.findByLabelText('Phone');
    await waitFor(() => expect(primary).toHaveValue('447700900123'));
    expect(primary).toHaveAttribute('type', 'tel');
    expect(screen.getByDisplayValue('5125550147214')).toHaveAttribute('type', 'tel');
  });

  it('saves them unchanged when only the name was edited', async () => {
    renderEditForm();
    await screen.findByTestId('customer-form');
    await waitFor(() => expect(screen.getByLabelText('Phone')).toHaveValue('447700900123'));

    const last = screen.getByDisplayValue('Keeper');
    fireEvent.change(last, { target: { value: 'Keeper-Edited' } });
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/customers/cust-1', expect.anything()));
    const payload = mockApi.patch.mock.calls[0]![1] as { phone: string; phone_ext: string; phones: Array<{ phone: string }> };
    expect(payload.phone).toBe('447700900123');
    expect(payload.phone_ext).toBe('12');
    expect(payload.phones[0]!.phone).toBe('5125550147214');
  });

  it('a US number still opens masked and saves the same masked string as before', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/customers/cust-1') return Promise.resolve({ data: { customer: { ...CUSTOMER, phone: '5125550147', phones: [] } } });
      return Promise.resolve({ data: {} });
    });
    renderEditForm();
    await screen.findByTestId('customer-form');
    await waitFor(() => expect(screen.getByLabelText('Phone')).toHaveValue('(512) 555-0147'));
    fireEvent.click(screen.getByTestId('customer-form-submit'));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect((mockApi.patch.mock.calls[0]![1] as { phone: string }).phone).toBe('(512) 555-0147');
  });
});

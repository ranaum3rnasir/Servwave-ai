/**
 * Ran's acceptance run, scenario 3: J00307's customer was created without an email, then
 * edited a few minutes later to add one - and the board's drag-reschedule dialog kept saying
 * "No email address on file" because nothing told `['schedule-jobs']` (which embeds
 * `customer.email` for the notify composer, SRVW-243) that the customer it had already
 * cached had changed. Staging evidence: customer created 13:48:35.986, a single
 * `customer.updated` audit row at 13:51:15.741 whose metadata names `email` among the
 * changed fields, then the drag - reading the pre-13:51 snapshot, 5-minute staleTime,
 * refetchOnWindowFocus off.
 *
 * Same class as #1718 (a writer whose door touches data another query embeds, with no
 * invalidation), one entity over: a customer edit never invalidated the job/lead queries
 * that carry a copy of that customer's contact info.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import api from '@/lib/axios';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';

const createTestQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'cust-1',
  customer_number: 'd00512',
  first_name: 'RAN-Notify',
  last_name: 'Test',
  company_name: '',
  email: 'art.nakamura@example.com',
  phone: '5551234567',
  phone_ext: null,
  segment: null,
  extra_emails: [],
  phones: [],
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

function mockCustomerApi() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/customers/cust-1') return Promise.resolve({ data: { customer: CUSTOMER } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: {} });
  });
  mockApi.patch.mockResolvedValue({ data: { customer: CUSTOMER } });
}

function renderEditForm(queryClient: ReturnType<typeof createTestQueryClient>) {
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

describe('editing a customer invalidates every query that embeds a copy of their contact info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomerApi();
  });

  it('invalidates schedule-jobs, schedule-walkthroughs and the job/lead detail caches on save', async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderEditForm(queryClient);

    await screen.findByTestId('customer-form');
    fireEvent.click(await screen.findByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/customers/cust-1', expect.anything()));

    // The schedule board's job AND walkthrough queries both embed `customer.email`
    // (jobListSelect / leadListSelect, SRVW-243) - the exact cache the drag-reschedule
    // dialog reads to decide "Email X" vs "No email address on file".
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedule-jobs'] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedule-walkthroughs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedule-unscheduled-walkthroughs'] });
    // The job page (jobDetailSelect) and the lead page both render customer.email directly
    // too, and neither is keyed by customer id - invalidated by prefix, not by a job/lead id
    // this form has no way to know.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['job'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['lead'] });
  });
});

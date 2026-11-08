import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobFormPage from '@/pages/JobFormPage';
import { buildAbility } from '@/lib/ability';

// JobFormPage's create form composes the shared PickOrCreateCustomer control
// (Task 12): first/last/phone/email/company all share placeholder="Search...",
// in the same render order. (Also regression coverage for the older "Create
// Job does nothing" bug — an EXISTING customer's non-2-char-state stored
// location must not silently block submit.)

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// An existing customer whose imported service location is NOT schema-clean:
// full state name + short zip — the exact shape that broke submit.
const EXISTING = {
  id: 'c0000000-0000-0000-0000-0000000000aa',
  first_name: 'Imported',
  last_name: 'Customer',
  company_name: null,
  phone: '2015550100',
  email: null,
  ad_source: null,
  service_locations: [
    {
      id: 'l0000000-0000-0000-0000-0000000000bb',
      address_line1: '12 Elm St',
      address_line2: null,
      city: 'Ridgefield',
      state: 'New Jersey',
      zip: '076',
      is_primary: true,
    },
  ],
};

function mountWithPreselectedCustomer() {
  return renderWithProviders(<JobFormPage />, {
    ability: adminAbility,
    initialEntries: [`/jobs/new?customer_id=${EXISTING.id}`],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === `/api/customers/${EXISTING.id}`) {
      return Promise.resolve({ data: { customer: EXISTING } });
    }
    return Promise.resolve({ data: { customers: [] } });
  });
  mockApi.post.mockResolvedValue({ data: { job: { id: 'j0000000-0000-0000-0000-0000000000cc' } } });
});

describe('JobFormPage — Create Job with an existing customer', () => {
  it('fires POST /api/jobs with the picked service_location_id even when the stored location has a non-2-char state', async () => {
    mountWithPreselectedCustomer();

    // Wait for the existing customer to prefill the form.
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Describe the work needed...'), {
      target: { value: 'Replace the deadbolt' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/jobs',
      expect.objectContaining({
        customer_id: EXISTING.id,
        service_location_id: EXISTING.service_locations[0].id,
        scope_notes: 'Replace the deadbolt',
      }),
    );
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/jobs/j0000000-0000-0000-0000-0000000000cc'),
    );
  });

  it('still blocks submit and surfaces a visible error when a required VISIBLE field is empty', async () => {
    mountWithPreselectedCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    // Leave Service Request empty.
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    expect(await screen.findByText('Service request is required')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('JobFormPage — Workiz-style accretion on an existing customer (spec §3/§4/§5.3/§5.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({ data: { job_type_options: [], source_options: [] } });
      }
      if (url === `/api/customers/${EXISTING.id}`) {
        return Promise.resolve({ data: { customer: EXISTING } });
      }
      if (url === '/api/customers') {
        return Promise.resolve({ data: { customers: [] } });
      }
      return Promise.resolve({ data: {} });
    });
    mockApi.post.mockResolvedValue({ data: { job: { id: 'job-1', job_number: 'J00099' } } });
  });

  it('keeps the customer link when the phone is edited, and sends the typed phone for accretion', async () => {
    const { container } = mountWithPreselectedCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    const phoneInput = container.querySelector('#phone') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: '5559998888' } });

    // EXISTING has one service_location, so selectCustomer auto-picks it via the
    // Location dropdown — no free-text address fields to fill here.
    fireEvent.change(screen.getByPlaceholderText('Describe the work needed...'), {
      target: { value: 'New phone for this job' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.customer_id).toBe(EXISTING.id);
    expect(body.phone).toBe('(555) 999-8888');
    expect(body.new_customer).toBeUndefined();
  });

  it('drops the customer link (forks a new customer) when the first name is edited', async () => {
    mountWithPreselectedCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('Imported'), { target: { value: 'Bob' } });

    // The fork carries over the previously-selected location's address (see
    // JobFormPage's onFieldChange — only the customer link is dropped, not the
    // address fields), so the new_customer.location the payload builder sends
    // is already populated; no address re-entry needed here.
    fireEvent.change(screen.getByPlaceholderText('Describe the work needed...'), {
      target: { value: 'Different person now' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.customer_id).toBeUndefined();
    expect((body.new_customer as Record<string, unknown>).first_name).toBe('Bob');
  });
});

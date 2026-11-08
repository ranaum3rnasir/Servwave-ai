import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import LeadFormPage from '@/pages/LeadFormPage';
import { buildAbility } from '@/lib/ability';

// Regression for the "Create Lead does nothing" bug (sibling of the JobFormPage
// fix): selecting an EXISTING customer copies that customer's stored service
// location into hidden address fields. Imported Northwind Services data stores full
// state names ("New Jersey"), so the old schema — service_state: z.string().max(2)
// — failed validation on a hidden field, silently aborting form.handleSubmit and
// never firing the POST. See lead-form-schemas.ts.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: () => ({ data: [] }),
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
  return renderWithProviders(<LeadFormPage />, {
    ability: adminAbility,
    initialEntries: [`/leads/new?customer_id=${EXISTING.id}`],
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
  mockApi.post.mockResolvedValue({
    data: { lead: { id: 'e0000000-0000-0000-0000-0000000000cc', customer_id: EXISTING.id } },
  });
});

describe('LeadFormPage — Create Lead with an existing customer', () => {
  it('fires POST /api/leads with the picked service_location_id even when the stored location has a non-2-char state', async () => {
    mountWithPreselectedCustomer();

    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Describe the service needed...'), {
      target: { value: 'Front door will not lock' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(
      '/api/leads',
      expect.objectContaining({
        customer_id: EXISTING.id,
        service_location_id: EXISTING.service_locations[0].id,
        service_request: 'Front door will not lock',
      }),
    );
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/leads/e0000000-0000-0000-0000-0000000000cc'),
    );
  });

  it('still blocks submit and surfaces a visible error when a required VISIBLE field is empty', async () => {
    mountWithPreselectedCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    // Leave Service Request empty.
    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

    expect(await screen.findByText('Service request is required')).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('LeadFormPage — ?phone= create-prefill (dialer slice 2.2)', () => {
  it('seeds the phone field from /leads/new?phone=<e164>, country code stripped + masked', async () => {
    renderWithProviders(<LeadFormPage />, {
      ability: adminAbility,
      initialEntries: ['/leads/new?phone=%2B15555550199'],
    });

    await waitFor(() =>
      expect(screen.getByDisplayValue('(555) 555-0199')).toBeInTheDocument(),
    );
  });
});

describe('LeadFormPage — Workiz-style accretion on an existing customer (spec §3/§4/§5.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({ data: { job_type_options: [], source_options: [] } });
      }
      if (url === '/api/users') {
        return Promise.resolve({ data: { users: [] } });
      }
      if (url === `/api/customers/${EXISTING.id}`) {
        return Promise.resolve({ data: { customer: EXISTING } });
      }
      if (url === '/api/customers') {
        return Promise.resolve({ data: { customers: [] } });
      }
      return Promise.resolve({ data: {} });
    });
    mockApi.post.mockResolvedValue({ data: { lead: { id: 'lead-1', customer_id: EXISTING.id } } });
  });

  it('keeps the customer link when the phone is edited, and sends the typed phone for accretion', async () => {
    const { container } = mountWithPreselectedCustomer();
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    const phoneInput = container.querySelector('#phone') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: '5559998888' } });

    fireEvent.change(screen.getByPlaceholderText('Describe the service needed...'), {
      target: { value: 'New phone for this job' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

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
    fireEvent.change(screen.getByPlaceholderText('Describe the service needed...'), {
      target: { value: 'Different person now' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.customer_id).toBeUndefined();
    expect((body.new_customer as Record<string, unknown>).first_name).toBe('Bob');
  });
});

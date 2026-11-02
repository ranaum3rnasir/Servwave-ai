import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';

// Backdating a customer's "Customer Since" date follows the Change customer created date switch, not
// the admin role: whoever holds the switch sees the field and sends the date, and whoever does not
// has neither.

// The routed page (pages/v2/routes/customers.routes.tsx), not the legacy pages/CustomerFormPage.tsx
// that no route renders.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ id: 'c1' }) };
});

const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'c1',
  first_name: 'Robert',
  last_name: 'Lee',
  company_name: '',
  email: 'robert@example.com',
  phone: '5551234567',
  segment: 'RESIDENTIAL',
  parent_id: null,
  is_parent: false,
  billing_address_line1: '12 Main St',
  billing_city: 'Fort Lee',
  billing_state: 'NJ',
  billing_zip: '07024',
  service_locations: [
    { id: 'l1', is_primary: true, address_line1: '99 Other Ave', city: 'Fort Lee', state: 'NJ', zip: '07024' },
  ],
  extra_emails: [],
  phones: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

// Change customer created date needs Edit customers, which needs View customers.
const holder = buildAbility([
  { action: 'change_created_date', subject: 'Customer' },
  { action: 'update', subject: 'Customer' },
  { action: 'read', subject: 'Customer' },
]);
const nonHolder = buildAbility([{ action: 'update', subject: 'Customer' }, { action: 'read', subject: 'Customer' }]);

function signInAs(role: 'ADMIN' | 'SALES') {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'u1', email: 'u@test.com', first_name: 'Sam', last_name: 'User', role }, isAuthenticated: true })) as never);
}

describe('CustomerFormPage - Customer Since follows the Change customer created date switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') return Promise.resolve({ data: {} });
      if (url === '/api/customers/c1') return Promise.resolve({ data: { customer: CUSTOMER } });
      return Promise.resolve({ data: {} });
    });
    mockApi.patch.mockResolvedValue({ data: { customer: { id: 'c1' } } });
  });

  it('shows the field and sends the date to a holder of the switch, whatever their role', async () => {
    // A custom role on a SALES base: the base role is not ADMIN, the switch is on.
    signInAs('SALES');
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'], ability: holder });
    await screen.findByDisplayValue('Robert');

    expect(screen.getByText('Customer Since')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect((mockApi.patch.mock.calls[0][1] as Record<string, unknown>).created_at).toBe('2026-01-01');
  });

  it('hides the field and sends no date from a person without the switch, even on the ADMIN base role', async () => {
    signInAs('ADMIN');
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'], ability: nonHolder });
    await screen.findByDisplayValue('Robert');

    expect(screen.queryByText('Customer Since')).toBeNull();
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch.mock.calls[0][1]).not.toHaveProperty('created_at');
  });
});

/**
 * Text length limits (spec 2026-10-14): a note takes 20,000 characters. Past 90% of that a counter
 * appears, and past the limit the field says so before anything is sent, instead of a save that
 * silently does nothing or a generic "Failed to add note".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import { IconRail } from '@/components/crm/IconRail';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn(), useParams: () => ({ id: 'c1' }) };
});

const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'c1', first_name: 'Robert', last_name: 'Lee', company_name: '', email: 'robert@example.com', phone: '5551234567',
  segment: 'RESIDENTIAL', parent_id: null, is_parent: false,
  billing_address_line1: '12 Main St', billing_city: 'Fort Lee', billing_state: 'NJ', billing_zip: '07024',
  service_locations: [{ id: 'l1', is_primary: true, address_line1: '99 Other Ave', city: 'Fort Lee', state: 'NJ', zip: '07024' }],
  extra_emails: [], phones: [], created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe('record note composer (Activity panel)', () => {
  beforeEach(() => mockApi.get.mockResolvedValue({ data: { notes: [] } }));

  it('counts from 18,000 and will not send 20,001 characters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IconRail entityType="LEAD" entityId="lead-1"><div /></IconRail>);
    await user.click(screen.getByRole('button', { name: 'Activity' }));
    const textarea = await screen.findByPlaceholderText('Add a note...');

    fireEvent.change(textarea, { target: { value: 'x'.repeat(17_999) } });
    expect(screen.queryByText('17,999 / 20,000')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();

    fireEvent.change(textarea, { target: { value: 'x'.repeat(20_001) } });
    expect(screen.getByText('20,001 / 20,000')).toBeInTheDocument();
    expect(screen.getByText('Too long (maximum 20,000 characters)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });
});

describe('customer form notes', () => {
  it('shows why Save did nothing when the notes are over 20,000 characters', async () => {
    vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ user: { id: 'u1', email: 'u@test.com', first_name: 'Sam', last_name: 'User', role: 'ADMIN' }, isAuthenticated: true })) as never);
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/api/customers/c1' ? { customer: CUSTOMER } : {} }));
    renderWithProviders(<CustomerFormPage />, {
      initialEntries: ['/customers/c1/edit'],
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
    });
    await screen.findByDisplayValue('Robert');

    fireEvent.change(screen.getByPlaceholderText('Internal notes...'), { target: { value: 'x'.repeat(20_001) } });
    expect(screen.getByText('20,001 / 20,000')).toBeInTheDocument();
    fireEvent.submit(screen.getByPlaceholderText('Internal notes...').closest('form')!);

    expect(await screen.findByText('Too long (maximum 20,000 characters)')).toBeInTheDocument();
    await waitFor(() => expect(mockApi.patch).not.toHaveBeenCalled());
  });
});

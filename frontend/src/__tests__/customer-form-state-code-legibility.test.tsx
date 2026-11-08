import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

// The State inputs are one narrow grid column, sized for "NJ". Imported rows hold a full
// state name, and once focus lands in the field only its tail is visible ("sey"), which
// reads as garbage. The message has to name the value it found, and focusing the field
// has to select it so a single keystroke replaces the whole thing.

let mockParams: Record<string, string> = { id: 'c1' };
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => mockParams };
});

const mockApi = vi.mocked(api);

const IMPORTED = {
  id: 'c1',
  first_name: 'Robert',
  last_name: '',
  company_name: 'Loumidis Foods',
  email: 'robert@example.com',
  phone: '5551234567',
  segment: 'RESIDENTIAL',
  parent_id: null,
  is_parent: false,
  billing_address_line1: '12 Main St',
  billing_city: 'Fort Lee',
  billing_state: 'New Jersey',
  billing_zip: '07024',
  service_locations: [
    { id: 'l1', is_primary: true, address_line1: '99 Other Ave', city: 'Fort Lee', state: 'NJ', zip: '07024' },
  ],
  extra_emails: [],
  phones: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

function mockCustomer(overrides: Record<string, unknown> = {}) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/customers/c1')
      return Promise.resolve({ data: { customer: { ...IMPORTED, ...overrides } } });
    return Promise.resolve({ data: {} });
  });
}

describe('CustomerFormPage - the state-code error names the value it found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams = { id: 'c1' };
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    mockCustomer();
    mockApi.patch.mockResolvedValue({ data: { customer: { id: 'c1' } } });
  });

  it('quotes the billing state it found, since the field is too narrow to show it', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    expect(summary).toHaveTextContent(/Use the 2-letter state code \(found "New Jersey"\)/i);
  });

  it('selects the offending value so one keystroke replaces it', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));
    await screen.findByTestId('customer-form-blocked');

    const field = screen.getByDisplayValue('New Jersey') as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
      expect(field.selectionStart).toBe(0);
      expect(field.selectionEnd).toBe('New Jersey'.length);
    });
  });

  it('applies the same treatment to the service address state', async () => {
    mockCustomer({
      billing_state: 'NJ',
      service_locations: [
        { id: 'l1', is_primary: true, address_line1: '99 Other Ave', city: 'Fort Lee', state: 'New York', zip: '10001' },
      ],
    });
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    expect(summary).toHaveTextContent(/State/i);
    expect(summary).toHaveTextContent(/Use the 2-letter state code \(found "New York"\)/i);
    // Never zod's default, which is what this field showed before.
    expect(screen.queryByText(/at most 2 character/i)).toBeNull();
  });

  it('keeps the plain message when the value is simply missing', async () => {
    mockCustomer({
      billing_state: 'NJ',
      service_locations: [
        { id: 'l1', is_primary: true, address_line1: '99 Other Ave', city: 'Fort Lee', state: '', zip: '10001' },
      ],
    });
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    expect(summary).toHaveTextContent(/Use the 2-letter state code/i);
    expect(summary).not.toHaveTextContent(/found ""/i);
  });

  it('still saves cleanly once both state codes are valid', async () => {
    mockCustomer({ billing_state: 'NJ' });
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByRole('button', { name: /more details/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect((mockApi.patch.mock.calls[0][1] as Record<string, unknown>).is_parent).toBe(true);
    expect(screen.queryByTestId('customer-form-blocked')).toBeNull();
  });
});

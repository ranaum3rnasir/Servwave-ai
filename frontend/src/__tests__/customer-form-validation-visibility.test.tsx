import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

// A blocked submit must always say so. The billing_* rules used to have no error
// surface at all, so a customer whose imported billing_state was a full state name
// ("New Jersey") could never be saved from this form: handleSubmit refused, no
// request went out, and nothing on the page explained why. Two guarantees here -
// the billing fields render their own errors, and a form-level summary catches
// ANY blocked submit so no future field can fail silently either.

let mockParams: Record<string, string> = {};
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => mockParams };
});

const mockApi = vi.mocked(api);

// Shaped after real imported rows: billing_state holds the full state name, and the
// billing address differs from the service location (so the form loads it verbatim).
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

describe('CustomerFormPage - a blocked submit is always visible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams = { id: 'c1' };
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    mockCustomer();
    mockApi.patch.mockResolvedValue({ data: { customer: { id: 'c1' } } });
  });

  it('shows the billing state error inline when an imported full state name blocks the save', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');
    expect(screen.getByDisplayValue('New Jersey')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await screen.findByTestId('customer-form-blocked');
    const summary = screen.getByTestId('customer-form-blocked');
    // The message is reported inside the billing panel itself, not only in the summary.
    const inline = screen
      .getAllByText(/2-letter state code/i)
      .filter((el) => !summary.contains(el));
    expect(inline).toHaveLength(1);
    // ...and the offending input is flagged.
    expect(screen.getByDisplayValue('New Jersey').className).toContain('border-danger');
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('names the blocking field in a form-level summary', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    expect(summary).toHaveTextContent(/before saving/i);
    expect(summary).toHaveTextContent(/billing state/i);
  });

  it('clears the summary once the offending field is fixed and the save goes through', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    fireEvent.click(screen.getByTestId('customer-form-submit'));
    await screen.findByTestId('customer-form-blocked');

    fireEvent.change(screen.getByDisplayValue('New Jersey'), { target: { value: 'NJ' } });
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(screen.queryByTestId('customer-form-blocked')).toBeNull();
  });

  it('still blocks and reports a non-billing field the same way', async () => {
    mockCustomer({ billing_state: 'NJ' });
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    // Wipe both contact methods - SERV10X-35 requires one of them.
    fireEvent.change(screen.getByPlaceholderText('(555) 123-4567'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('jane@example.com'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    expect(summary).toHaveTextContent(/phone/i);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('scrolls the summary into view when the blocking field has no rendered input', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/c1/edit'] });
    await screen.findByDisplayValue('Robert');

    // Collapsing the billing panel keeps the bad value but removes its input, so there
    // is nothing to focus and the summary is the only thing left to show the user.
    fireEvent.click(screen.getByRole('button', { name: /same as service address/i }));
    await waitFor(() => expect(screen.queryByDisplayValue('New Jersey')).toBeNull());

    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    fireEvent.click(screen.getByTestId('customer-form-submit'));

    const summary = await screen.findByTestId('customer-form-blocked');
    await waitFor(() => {
      expect(scrollSpy.mock.instances).toContain(summary);
    });
    scrollSpy.mockRestore();
  });

  it('does not block a clean customer - the franchise toggle still saves', async () => {
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

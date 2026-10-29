// Per-address opt-in for automated customer mail (customer_emails.receives_emails).
//
// The API recreates extra_emails on every write and reads a MISSING flag as false, so
// the form has to send the value explicitly on every save. The load path matters just
// as much: addresses that predate the column come back false and must render off.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({}) };
});

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: { id: 'new-id' } });
});

describe('CustomerFormPage — additional-email automated-mail opt-in', () => {
  it('adds a new address opted IN, and posts the flag explicitly', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/new'] });

    await user.click(await screen.findByRole('button', { name: /add email/i }));

    const toggle = await screen.findByRole('switch', { name: /receives automated emails/i });
    expect(toggle).toBeChecked();

    await user.type(screen.getByPlaceholderText('Additional email'), 'ops@acme.com');
    await user.type(screen.getByPlaceholderText('Jane'), 'Jane');
    await user.type(screen.getByPlaceholderText('(555) 123-4567'), '5551234567');
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as { extra_emails: unknown[] };
    expect(body.extra_emails).toEqual([
      expect.objectContaining({ email: 'ops@acme.com', receives_emails: true }),
    ]);
  });

  it('turning the toggle off posts receives_emails:false rather than omitting it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/new'] });

    await user.click(await screen.findByRole('button', { name: /add email/i }));
    await user.type(screen.getByPlaceholderText('Additional email'), 'ops@acme.com');
    await user.click(await screen.findByRole('switch', { name: /receives automated emails/i }));

    await user.type(screen.getByPlaceholderText('Jane'), 'Jane');
    await user.type(screen.getByPlaceholderText('(555) 123-4567'), '5551234567');
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as { extra_emails: { receives_emails?: boolean }[] };
    expect(body.extra_emails[0].receives_emails).toBe(false);
  });

  it('disables the toggle until the row has an address', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/new'] });

    await user.click(await screen.findByRole('button', { name: /add email/i }));

    expect(await screen.findByRole('switch', { name: /receives automated emails/i })).toBeDisabled();
  });
});

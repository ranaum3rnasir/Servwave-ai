import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import V2LoginPage from '@/pages/v2/auth-public/LoginPage';
import V2AcceptInvitePage from '@/pages/v2/auth-public/AcceptInvitePage';
import V2NotAuthorizedPage from '@/pages/v2/auth-public/NotAuthorizedPage';
import V2PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import V2PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';

const login = vi.fn();
const verifyMfa = vi.fn();
const loginWithGoogle = vi.fn();

// The store is mocked globally in the vitest setup; this file only decides what
// the selector sees. Cast because the real hook is an overloaded zustand store
// and the stub only has to satisfy the selectors these pages actually call.
const SIGNED_OUT = {
  login,
  verifyMfa,
  loginWithGoogle,
  user: null,
  isAuthenticated: false,
  isLoading: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
});

describe('v2 auth-public smoke', () => {
  it('login keeps #email / #password / Sign In heading + exact button', () => {
    renderWithProviders(<V2LoginPage />, { initialEntries: ['/login'] });
    expect(document.querySelector('#email')).toBeTruthy();
    expect(document.querySelector('#password')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('login seeds the error banner from ?error=', () => {
    renderWithProviders(<V2LoginPage />, { initialEntries: ['/login?error=nope'] });
    expect(screen.getByRole('alert')).toHaveTextContent('nope');
  });

  it('accept-invite with no token renders the invalid phase', async () => {
    renderWithProviders(<V2AcceptInvitePage />, { initialEntries: ['/accept-invite'] });
    expect(
      await screen.findByText('This invitation link is invalid or has expired.'),
    ).toBeInTheDocument();
  });

  it('not-authorized renders', () => {
    renderWithProviders(<V2NotAuthorizedPage />);
    expect(screen.getByRole('heading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
  });

  it('public estimate with no token renders the fatal card and fetches nothing', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    renderWithProviders(<V2PublicEstimatePage />, { initialEntries: ['/p/estimates/x'] });
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Invalid link - token missing')).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('public invoice renders the document, totals and payment options', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          invoice: {
            id: 'i1', invoice_number: 'I00001', status: 'SENT', kind: 'INVOICE',
            subtotal: 100, discount_amount: 0, tax_amount: 0, deposit_credit: 0,
            total_amount: 100, amount_due: 100, due_date: null, sent_at: null,
            paid_at: null, created_at: '2026-01-01', customer: null,
            line_items: [{ id: 'l1', sequence: 1, description: 'Work', quantity: 1, unit_price: 100, is_taxable: false, line_total: 100 }],
            job: null, payments: [],
          },
          organization: { name: 'Acme' },
          available_payment_methods: ['CHECK'],
          payment_instructions: { check: 'Mail it' },
          service_fee_preview: 0,
        }),
      }),
    );
    renderWithProviders(<V2PublicInvoicePage />, { initialEntries: ['/p/invoices/i1?token=t'] });
    await waitFor(() => expect(screen.getByText('I00001')).toBeInTheDocument());
    expect(screen.getByText('INVOICE')).toBeInTheDocument();
    expect(screen.getByText('Amount Due')).toBeInTheDocument();
    expect(screen.getByText('Payment Options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay by Check/i })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

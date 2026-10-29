/**
 * Task 2.6 - §6.5/§6.8: when an org is paused/restricted between send and view, the
 * deposit-checkout POST to /approve can fail with the raw backend string ("Card payment
 * is not available"). Before the fix this rendered verbatim in the estimate page's error
 * banner; the homeowner-facing copy must replace it with friendly wording (org name
 * present), matching the same treatment applied to PublicInvoicePage.
 *
 * Targets `pages/v2/auth-public/PublicEstimatePage`, which is what
 * `/p/estimates/:id` actually mounts. It previously imported the unrouted
 * `pages/PublicEstimatePage`, so the "raw backend string must never reach the
 * homeowner" guarantee was being proved against a page no homeowner could load.
 * The v2 page maps the same error with the same regex, so the assertions carry
 * over unchanged.
 *
 * Isolated in its own spec (rather than extending public-estimate-deposit.test.tsx)
 * because it needs the signature canvas to report "drawn" so the deposit+CARD payment
 * step renders - a mock behavior the existing file's tests don't need.
 */

import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-card-gate-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-card-gate'), vi.fn()],
  };
});

// Reports "signature drawn" on mount (fires the real onEnd prop) so the deposit+CARD
// payment step renders immediately, mirroring a homeowner who has already signed.
vi.mock('react-signature-canvas', () => ({
  default: (props: { onEnd?: () => void }) => {
    useEffect(() => {
      props.onEnd?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  },
}));

const CARD_DEPOSIT_ESTIMATE_RESPONSE = {
  estimate: {
    id: 'est-card-gate-1',
    estimate_number: 'E00777',
    status: 'SENT',
    tax_rate: 0,
    subtotal: 500,
    tax_amount: 0,
    total_amount: 500,
    scope_notes: '',
    line_items: [],
    send_config: {
      deposit_required: true,
      deposit_percentage: 100,
      deposit_amount: 500,
      payment_methods: ['CARD'],
      message_body: null,
    },
    invoices: [
      { id: 'dep-inv-card-gate', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
    ],
    lead: { customer: { first_name: 'Homer', last_name: 'Owner', company_name: null } },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: { name: 'ServWave HVAC', estimate_terms: null },
  payment_instructions: {},
  expired: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PublicEstimatePage — CARD-unavailable deposit-checkout copy (Task 2.6)', () => {
  it('shows friendly homeowner copy instead of the raw backend error when CARD is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ error: 'Card payment is not available' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => CARD_DEPOSIT_ESTIMATE_RESPONSE });
      }),
    );

    renderWithProviders(<PublicEstimatePage />);

    const payButton = await screen.findByRole('button', { name: /pay with credit\/debit card/i });
    await userEvent.click(payButton);

    // Friendly §6.8 copy renders, with the org name interpolated in.
    await waitFor(() => {
      expect(screen.getByText(/ServWave HVAC isn't accepting card payments right now/i)).toBeInTheDocument();
    });

    // The raw backend string must never reach the homeowner.
    expect(screen.queryByText('Card payment is not available')).not.toBeInTheDocument();
  });
});

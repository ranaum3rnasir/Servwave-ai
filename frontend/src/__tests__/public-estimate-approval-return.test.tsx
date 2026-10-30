/**
 * Payments go-live slice 27 (conductor ruling 2) - the return from the sign-then-pay checkout.
 *
 * The approval route's checkout returns with `payment=success&method=...`. A bank debit has only
 * started when the customer lands back here, so the banner must say so, never "Payment received!".
 * Card keeps its existing wording.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';

let query = 'token=tok-pub&payment=success&method=bank';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-dep-1' }),
    useSearchParams: () => [new URLSearchParams(query), vi.fn()],
  };
});
vi.mock('react-signature-canvas', () => ({ default: vi.fn().mockImplementation(() => null) }));

const DEPOSIT_ESTIMATE_RESPONSE = {
  estimate: {
    id: 'est-dep-1',
    estimate_number: 'E00099',
    status: 'SENT',
    tax_rate: 6.25,
    subtotal: 10000,
    tax_amount: 625,
    total_amount: 10625,
    scope_notes: 'HVAC replacement',
    line_items: [],
    // The redesign shape: send_config + invoices[] — NO legacy `deposit` key
    send_config: {
      deposit_required: true,
      deposit_percentage: 30,
      deposit_amount: 3187.5,
      payment_methods: ['CARD', 'CHECK'],
      message_body: null,
    },
    invoices: [
      {
        id: 'inv-dep-1',
        status: 'SENT',
        total_amount: 3187.5,
        amount_due: 3187.5,
        public_token: 'dep-tok',
      },
    ],
    lead: {
      customer: { first_name: 'Alice', last_name: 'Smith', company_name: null },
    },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: { name: 'ServWave HVAC', estimate_terms: null },
  payment_instructions: {},
  expired: false,
};


function load(q: string) {
  query = q;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => DEPOSIT_ESTIMATE_RESPONSE }));
  renderWithProviders(<PublicEstimatePage />);
}

afterEach(() => vi.unstubAllGlobals());

describe('PublicEstimatePage - return from the approval checkout', () => {
  it('a bank return says the payment has started, never "Payment received!"', async () => {
    load('token=tok-pub&payment=success&method=bank');
    await waitFor(() => expect(screen.getByText(/your bank payment has started/i)).toBeInTheDocument());
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
  });

  it('a card return keeps the existing wording', async () => {
    load('token=tok-pub&payment=success&method=card');
    await waitFor(() => expect(screen.getByText(/payment received! your estimate has been approved/i)).toBeInTheDocument());
  });
});

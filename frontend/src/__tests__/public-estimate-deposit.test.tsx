/**
 * Unit test for #169 - the routed public estimate page's deposit-required path.
 *
 * The page was reading the legacy `estimate.deposit` scalar which the entity-model
 * redesign removed.  The fix reads `estimate.invoices[0]` (kind=DEPOSIT) and
 * `send_config.deposit_amount` / `send_config.deposit_percentage` instead.
 *
 * Targets `pages/v2/auth-public/PublicEstimatePage`, which is what
 * `/p/estimates/:id` actually mounts. It previously imported the unrouted
 * `pages/PublicEstimatePage`, so it asserted this contract against a page no
 * customer could load. The v2 page derives the deposit identically
 * (depositInvoice = invoices[0]; depositAmount from send_config.deposit_amount),
 * so the assertions carry over unchanged.
 *
 * Mock shape mirrors estimatePublicSelect (estimate.controller.ts:150-209):
 *   - send_config.deposit_required: true
 *   - send_config.deposit_amount: 3187.5
 *   - invoices: [{ status:'SENT', total_amount:3187.5, ... }]
 *   - NO `deposit` key (the legacy field)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-dep-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-pub'), vi.fn()],
  };
});

vi.mock('react-signature-canvas', () => ({
  default: vi.fn().mockImplementation(() => null),
}));

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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => DEPOSIT_ESTIMATE_RESPONSE,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PublicEstimatePage — deposit-required estimate (issue #169)', () => {
  it('shows the deposit info card with the correct amount derived from invoices[0] (not legacy estimate.deposit)', async () => {
    renderWithProviders(<PublicEstimatePage />);

    // The estimate loads and renders the document header
    await waitFor(() => {
      expect(screen.getByText('E00099', { exact: false })).toBeInTheDocument();
    });

    // AC1: "Deposit required:" card must render with the correct amount
    // Before fix: depositRequired = !!(send_config.deposit_required && estimate.deposit)
    //             estimate.deposit is undefined → depositRequired is always false → card hidden
    // After fix:  depositRequired = !!(send_config.deposit_required && depositInvoice)
    //             depositInvoice = invoices[0] → card renders
    await waitFor(() => {
      expect(screen.getByText(/deposit required/i)).toBeInTheDocument();
    });

    // The amount must be derived from send_config.deposit_amount (= $3,187.50)
    expect(screen.getByText(/\$3,187\.50/)).toBeInTheDocument();
  });

  it('shows the percentage suffix from send_config.deposit_percentage', async () => {
    renderWithProviders(<PublicEstimatePage />);

    await waitFor(() => {
      expect(screen.getByText('E00099', { exact: false })).toBeInTheDocument();
    });

    // AC5: send_config.deposit_percentage (30) must appear, not estimate.deposit.deposit_percentage
    await waitFor(() => {
      expect(screen.getByText(/30% of total/i)).toBeInTheDocument();
    });
  });
});

/**
 * Payments go-live slice 02 (D9) - card payments carry no service fee. The ROUTED public estimate
 * page must say nothing about one, even if a payload (an older backend, a cached response) still
 * carries `service_fee_preview`: neither on the card button in the deposit method picker nor in
 * the "Approved - Deposit Pending" notice.
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicEstimatePage from '../PublicEstimatePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-no-fee' }),
    useSearchParams: () => [new URLSearchParams('token=tok-no-fee'), vi.fn()],
  };
});

// Reports "signature drawn" on mount so the deposit method picker renders at once, as for a
// homeowner who has already signed.
function SignatureCanvasStub(props: { onEnd?: () => void }) {
  useEffect(() => {
    props.onEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

vi.mock('react-signature-canvas', () => ({
  default: SignatureCanvasStub,
}));

function buildResponse(status: 'SENT' | 'PENDING') {
  return {
    estimate: {
      id: 'est-no-fee',
      estimate_number: 'E00777',
      status,
      tax_rate: 0,
      subtotal: 1000,
      tax_amount: 0,
      total_amount: 1000,
      scope_notes: '',
      line_items: [],
      send_config: {
        deposit_required: true,
        deposit_percentage: 50,
        deposit_amount: 500,
        payment_methods: ['CARD', 'CHECK'],
        message_body: null,
      },
      invoices: [
        { id: 'dep-inv-no-fee', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
      ],
      lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
      customer: null,
      signature_data: status === 'PENDING' ? 'data:image/png;base64,abc' : null,
      signature_at: status === 'PENDING' ? '2026-10-01T12:00:00.000Z' : null,
    },
    organization: { name: 'Org', estimate_terms: null, phone: null },
    payment_instructions: {},
    expired: false,
    // A stale quote of the retired 3.5% fee on the $500.00 deposit.
    service_fee_preview: 17.5,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public estimate page - no card service fee (payments go-live D9)', () => {
  it('shows no fee on the card button of the deposit method picker, even when the payload quotes one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => buildResponse('SENT') }));

    const { container } = renderWithProviders(<PublicEstimatePage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pay with credit\/debit card/i })).toBeInTheDocument();
    });

    expect(container.textContent).not.toMatch(/service fee/i);
    expect(container.textContent).not.toContain('$17.50');
  });

  it('shows no card fee in the deposit-pending notice, even when the payload quotes one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => buildResponse('PENDING') }));

    const { container } = renderWithProviders(<PublicEstimatePage />);

    await waitFor(() => {
      expect(screen.getByText(/Approved - Deposit Pending/)).toBeInTheDocument();
    });

    expect(container.textContent).not.toMatch(/service fee/i);
    expect(container.textContent).not.toContain('$17.50');
  });
});

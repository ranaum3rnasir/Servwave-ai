/**
 * #2044 — the ROUTED public estimate page (`pages/v2/auth-public/PublicEstimatePage.tsx`;
 * `pages/v2/routes/auth-public.routes.tsx` maps `/p/estimates/:id` here). The v1
 * `pages/PublicEstimatePage.tsx` this note used to contrast against has been deleted,
 * and every `public-estimate-*.test.tsx` file now targets this same routed page.
 *
 * With `send_config.deposit_required: true` and `payment_methods: []`, once the customer signs,
 * the page must render the "Online payment is not available..." fallback line instead of an
 * empty "Select Payment Method" card, must not offer any "Pay by/with" button, and must still
 * offer Decline.
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-2044-no-methods' }),
    useSearchParams: () => [new URLSearchParams('token=tok-2044'), vi.fn()],
  };
});

// Reports "signature drawn" on mount (fires the real onEnd prop) so the deposit payment step
// renders immediately, mirroring a homeowner who has already signed - same pattern as
// public-estimate-card-unavailable-copy.test.tsx.
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

function buildResponse(orgPhone: string | null) {
  return {
    estimate: {
      id: 'est-2044-no-methods',
      estimate_number: 'E00888',
      status: 'SENT',
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
        payment_methods: [],
        message_body: null,
      },
      invoices: [
        { id: 'dep-inv-2044', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' },
      ],
      lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } },
      customer: null,
      signature_data: null,
      signature_at: null,
    },
    organization: { name: 'Org', estimate_terms: null, phone: orgPhone },
    payment_instructions: {},
    expired: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#2044 — public estimate page, zero configured payment methods', () => {
  it('renders the fallback line (with phone) instead of an empty method list, and keeps Decline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildResponse('5555550123') }),
    );

    renderWithProviders(<PublicEstimatePage />);

    await waitFor(() => {
      expect(screen.getByText(/Select Payment Method/i)).toBeInTheDocument();
    });

    // The fallback line renders, with the phone inserted after "contact us" (not at the end).
    const fallback = await screen.findByText(
      /Online payment is not available for this estimate\. Please contact us at \(555\) 555-0123 to arrange your deposit and complete your approval\./,
    );
    expect(fallback).toBeInTheDocument();

    // No dead method buttons.
    expect(screen.queryByRole('button', { name: /pay (with|by)/i })).not.toBeInTheDocument();

    // Decline still works.
    expect(screen.getByRole('button', { name: /decline estimate/i })).toBeInTheDocument();
  });

  it('omits the phone clause when the org has none set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => buildResponse(null) }),
    );

    renderWithProviders(<PublicEstimatePage />);

    const fallback = await screen.findByText(
      /Online payment is not available for this estimate\. Please contact us to arrange your deposit and complete your approval\./,
    );
    expect(fallback).toBeInTheDocument();
  });
});

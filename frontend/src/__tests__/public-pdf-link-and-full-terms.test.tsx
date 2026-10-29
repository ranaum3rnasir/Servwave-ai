/**
 * Mobile slice 04 (PRD module 10, stories 111 + 112, rubric PUB-02).
 *
 *  1. TERMS. The public estimate page used to show a 200-character excerpt of the organization's
 *     terms followed by "See attached PDF for full terms" - so a customer on a phone (or inside a
 *     messaging app's built-in browser, where the PDF may not open at all) agreed to text they
 *     could not read. The full text is now on the page and the agree box sits AFTER it.
 *
 *  2. PDF LINK. Both public pages linked the PDF with a RELATIVE `/api/...` href and
 *     `target="_blank"`. On the deployed frontend a relative `/api/*` path never reaches the API:
 *     the static host's catch-all rewrite answers it with the app shell's index.html (status 200),
 *     so the customer got a blank app instead of a document (vault: Learnings/
 *     Vercel-SPA-Fallback-Masks-API-Misroutes.md - same trap the authed preview hit). The link
 *     now points at the API host (`VITE_API_URL`) and opens in the same tab - in-app browsers
 *     routinely swallow new windows. The backend half (inline disposition) is pinned in
 *     backend/src/__tests__/estimate-pdf.test.ts and invoice-pdf.test.ts.
 *
 * Both pages imported here are the ROUTED ones (`pages/v2/routes/auth-public.routes.tsx`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';
import { CAPTURED, PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING } from '@/__tests__/fixtures/public-estimate-payload';

const routeParams = vi.hoisted(() => ({ id: '' }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: routeParams.id }),
    useSearchParams: () => [new URLSearchParams('token=tok-1'), vi.fn()],
  };
});

vi.mock('react-signature-canvas', () => ({
  default: vi.fn().mockImplementation(() => null),
}));

const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };
const API_HOST = 'https://api.host.test';

/** Long terms: well past the old 200-character cut, with a distinctive last clause. */
const TERMS_HEAD = 'All work is warranted for one year from the completion date. ';
const TERMS_TAIL = 'Cancellations within 48 hours of the visit forfeit the deposit in full.';
const LONG_TERMS = `${TERMS_HEAD}${'Payment is due on completion unless agreed otherwise in writing. '.repeat(12)}${TERMS_TAIL}`;

function estimatePayload(terms: string) {
  const base = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
  const estimate = base.estimate as Record<string, unknown>;
  estimate.invoices = [];
  estimate.send_config = null;
  estimate.status = 'SENT';
  const org = base.organization as Record<string, unknown>;
  return { ...base, organization: { ...org, estimate_terms: terms } };
}

const INVOICE_ID = 'inv-pdf-link-1';
const INVOICE_PAYLOAD = {
  invoice: {
    id: INVOICE_ID,
    invoice_number: 'I00042',
    status: 'SENT',
    kind: 'STANDARD',
    subtotal: 500,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 500,
    amount_due: 500,
    due_date: null,
    sent_at: '2026-03-01T00:00:00.000Z',
    paid_at: null,
    created_at: '2026-03-01T00:00:00.000Z',
    job: null,
    customer: { first_name: 'Pat', last_name: 'Payer' },
    line_items: [
      { id: 'li-1', sequence: 1, description: 'Door service', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 },
    ],
    payments: [],
  },
  organization: { name: 'Test Services Co' },
  available_payment_methods: [],
  payment_instructions: {},
};

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_API_URL', API_HOST);
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderEstimate(terms: string) {
  routeParams.id = CAPTURED.estimateId;
  stubFetch(estimatePayload(terms));
  renderWithProviders(<PublicEstimatePage />, {
    initialEntries: [`/p/estimates/${CAPTURED.estimateId}?token=tok-1`],
  });
  await screen.findByText('Door install');
}

describe('public estimate - the full terms are on the page (story 111)', () => {
  it('renders the whole terms text, not a 200-character excerpt', async () => {
    await renderEstimate(LONG_TERMS);
    const block = screen.getByTestId('public-terms-text');
    expect(block.textContent).toBe(LONG_TERMS);
  });

  it('no longer sends the customer to the PDF for the full terms', async () => {
    await renderEstimate(LONG_TERMS);
    expect(screen.queryByText(/see attached pdf/i)).not.toBeInTheDocument();
  });

  it('the agree checkbox sits after the full text', async () => {
    await renderEstimate(LONG_TERMS);
    const block = screen.getByTestId('public-terms-text');
    const box = screen.getByRole('checkbox', { name: /i agree to the terms/i });
    // DOCUMENT_POSITION_FOLLOWING: the checkbox comes after the terms block in reading order.
    expect(block.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('long terms start collapsed behind a disclosure that expands to the full height', async () => {
    await renderEstimate(LONG_TERMS);
    const toggle = screen.getByRole('button', { name: /show full terms/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const block = screen.getByTestId('public-terms-text');
    expect(toggle).toHaveAttribute('aria-controls', block.id);
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: /hide full terms/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('short terms need no disclosure', async () => {
    await renderEstimate('Net 30.');
    expect(screen.getByTestId('public-terms-text').textContent).toBe('Net 30.');
    expect(screen.queryByRole('button', { name: /full terms/i })).not.toBeInTheDocument();
  });
});

describe('public PDF links point at the API host and open in the same tab (story 112)', () => {
  it('estimate: absolute API-host href, no new-window target', async () => {
    await renderEstimate('Net 30.');
    const link = screen.getByRole('link', { name: /pdf/i });
    expect(link).toHaveAttribute(
      'href',
      `${API_HOST}/api/estimates/${CAPTURED.estimateId}/public/pdf?token=tok-1`,
    );
    expect(link).not.toHaveAttribute('target');
  });

  it('invoice: absolute API-host href, no new-window target', async () => {
    routeParams.id = INVOICE_ID;
    stubFetch(INVOICE_PAYLOAD);
    renderWithProviders(<PublicInvoicePage />, {
      initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`],
    });
    const link = await screen.findByRole('link', { name: /pdf/i });
    expect(link).toHaveAttribute('href', `${API_HOST}/api/invoices/${INVOICE_ID}/public/pdf?token=tok-1`);
    expect(link).not.toHaveAttribute('target');
  });
});

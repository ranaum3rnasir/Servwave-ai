/**
 * #2028 slice 1 — the public estimate page is the third document surface.
 *
 * The page rendered line items and a Sub total, but never the priced scope-of-work blocks that
 * calculateTotals folds into that Sub total. On Ran's reported estimate that meant a single $200
 * line item printed under a $2,200 total, with the missing $2,000 nowhere on the page.
 *
 * `/p/estimates/:id` routes to the v2 page (pages/v2/routes/auth-public.routes.tsx) — the v1
 * pages/PublicEstimatePage.tsx is dead code behind it, so this exercises the v2 one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'est-1' }),
    useSearchParams: () => [new URLSearchParams('token=tok-1'), vi.fn()],
  };
});

vi.mock('react-signature-canvas', () => ({
  default: vi.fn().mockImplementation(() => null),
}));

const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };

/** Ran's reported document: $200 of line items, a $2,000 priced scope, a $2,200 Sub total. */
const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
};

const PAYLOAD = {
  estimate: {
    id: 'est-1',
    estimate_number: 'E00042',
    status: 'SENT',
    scope_notes: null,
    scopes: [PRICED_SCOPE],
    tax_rate: 0,
    subtotal: 2200,
    tax_amount: 0,
    total_amount: 2200,
    discount_amount: 0,
    line_items: [
      {
        id: 'li-1',
        description: 'Keypad',
        item_type: 'MATERIAL',
        quantity: 1,
        unit_price: 200,
        is_taxable: true,
        line_total: 200,
        discount_amount: 0,
      },
    ],
    lead: null,
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null },
    invoices: [],
    send_config: null,
  },
  organization: { name: 'Northwind Services', brand_color: '#E11D2E' },
  terms: null,
  payment_instructions: {},
  expired: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the public estimate page', () => {
  it('prints the priced scope block that its Sub total already contains', async () => {
    renderWithProviders(<PublicEstimatePage />, {
      initialEntries: ['/p/estimates/est-1?token=tok-1'],
    });

    expect(
      await screen.findByText('Install 3 commercial storefront doors'),
    ).toBeInTheDocument();
    expect(screen.getByText('$2,000.00')).toBeInTheDocument();
  });

  // #2028 slice 4 — an unpriced block describes work the salesperson wrote down. It used to be
  // filtered off the page entirely.
  it('prints an unpriced scope block with a blank amount rather than a zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...PAYLOAD,
          estimate: {
            ...PAYLOAD.estimate,
            scopes: [
              PRICED_SCOPE,
              {
                id: 'scope-2',
                title: 'Site survey and measurements',
                body: 'Included at no separate charge.',
                flat_price: null,
                is_taxable: false,
              },
            ],
          },
        }),
      }),
    );

    renderWithProviders(<PublicEstimatePage />, {
      initialEntries: ['/p/estimates/est-1?token=tok-1'],
    });

    const unpriced = (await screen.findByText('Site survey and measurements')).closest('div.flex.items-start')!;
    expect(unpriced).toHaveTextContent('Included at no separate charge.');
    // Scoped to the row: a $0.00 HERE would tell the customer the work is free. (The totals block
    // legitimately shows $0.00 for tax on this fixture, so a page-wide assertion would be wrong.)
    expect(unpriced.textContent).not.toMatch(/\$/);
    // …and the priced block still shows its amount.
    expect(screen.getByText('$2,000.00')).toBeInTheDocument();
  });
});

/**
 * #2029 slice 3 — the photos a salesperson attaches to a scope of work appear beneath that scope
 * block. These are the ONLY uploaded images on the document. Ran, directly: the attachments of a
 * lead/job should not come as part of the estimate.
 */
describe('scope photos on the public page', () => {
  const PHOTOS = [
    { id: 'sp-1', scope_id: 'scope-1', url: 'https://signed.test/door-1.jpg', caption: 'Existing frame', mime_type: 'image/jpeg', uploaded_at: '2026-09-01T00:00:00Z', uploaded_by: 'Rep' },
    { id: 'sp-2', scope_id: 'scope-1', url: 'https://signed.test/door-2.jpg', caption: null, mime_type: 'image/jpeg', uploaded_at: '2026-09-01T00:00:00Z', uploaded_by: 'Rep' },
  ];

  function withPhotos(extra: Record<string, unknown> = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...PAYLOAD,
          estimate: { ...PAYLOAD.estimate, scope_photos: PHOTOS, ...extra },
        }),
      }),
    );
    renderWithProviders(<PublicEstimatePage />, {
      initialEntries: ['/p/estimates/est-1?token=tok-1'],
    });
  }

  it("renders a scope's photos beneath its block", async () => {
    withPhotos();

    const scope = (await screen.findByText('Install 3 commercial storefront doors')).closest('div.flex.items-start')!;
    const images = within(scope as HTMLElement).getAllByRole('img');
    expect(images.map((i) => i.getAttribute('src'))).toEqual([
      'https://signed.test/door-1.jpg',
      'https://signed.test/door-2.jpg',
    ]);
  });

  it('renders no strip at all for a scope with no photos', async () => {
    withPhotos({ scope_photos: [] });

    const scope = (await screen.findByText('Install 3 commercial storefront doors')).closest('div.flex.items-start')!;
    expect(within(scope as HTMLElement).queryAllByRole('img')).toHaveLength(0);
  });

  it('hangs a photo only under ITS scope, never a sibling', async () => {
    withPhotos({
      scopes: [
        PRICED_SCOPE,
        { id: 'scope-9', title: 'Rekey the back door', body: '', flat_price: 150, is_taxable: true },
      ],
    });

    const sibling = (await screen.findByText('Rekey the back door')).closest('div.flex.items-start')!;
    expect(within(sibling as HTMLElement).queryAllByRole('img')).toHaveLength(0);
  });

  // A customer-facing privacy expectation, not a layout preference — which is why it gets its own
  // test rather than being left implied by "we didn't build it".
  it('never shows the lead\'s attachments, the job\'s attachments, or the estimate\'s own file panel', async () => {
    withPhotos();
    await screen.findByText('Install 3 commercial storefront doors');

    const html = document.body.innerHTML;
    expect(html).not.toMatch(/lead[-_ ]?attachment/i);
    expect(html).not.toMatch(/job[-_ ]?attachment/i);
    expect(screen.queryByText(/^Attachments$/i)).not.toBeInTheDocument();
  });
});

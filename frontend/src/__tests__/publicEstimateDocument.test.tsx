import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { renderPublicEstimate, servePublicEstimate, setPublicRoute } from '@/__tests__/harness/publicEstimatePage';
import { useAuthStore } from '@/stores/auth.store';
import userEvent from '@testing-library/user-event';
import { OPTIONAL_DECLINED_MARKER, OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER } from '@/lib/estimate-document-view';
import { sectionRowLists } from '@/__tests__/estimate-document-dom';
import { CAPTURED, PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING, PUBLIC_PAYLOAD_DEPOSIT_PAID } from '@/__tests__/fixtures/public-estimate-payload';
import { renderWithProviders } from '@/__tests__/helpers';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());
vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).blankPad());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
});

describe('public-estimate-scopes', () => {
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
    organization: { name: 'Example Doors', brand_color: '#E11D2E' },
    terms: null,
    payment_instructions: {},
    expired: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
      selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
    servePublicEstimate({ page: PAYLOAD });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the public estimate page', () => {
    it('prints the priced scope block that its Sub total already contains', async () => {
      renderPublicEstimate({ id: 'est-1', entry: '/p/estimates/est-1?token=tok-1' });

      expect(
        await screen.findByText('Install 3 commercial storefront doors'),
      ).toBeInTheDocument();
      expect(screen.getByText('$2,000.00')).toBeInTheDocument();
    });

    // #2028 slice 4 — an unpriced block describes work the salesperson wrote down. It used to be
    // filtered off the page entirely.
    it('prints an unpriced scope block with a blank amount rather than a zero', async () => {
      servePublicEstimate({
        page: {
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
        },
      });

      renderPublicEstimate({ id: 'est-1', entry: '/p/estimates/est-1?token=tok-1' });

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
      servePublicEstimate({ page: { ...PAYLOAD, estimate: { ...PAYLOAD.estimate, scope_photos: PHOTOS, ...extra } } });
      renderPublicEstimate({ id: 'est-1', entry: '/p/estimates/est-1?token=tok-1' });
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
});

describe('public-estimate-optional-addons', () => {
  /**
   * The customer's own choice, on the public estimate page - 2026-09-18 revision.
   *
   * Ran reversed the shape this page shipped with: "Just one estimate with checkboxes for optional
   * items, so they can tick and untick. That's it." The separate "Optional add-ons" card below the
   * document is gone. Every add-on now sits in the one priced list the customer was already reading,
   * with its own tick box at the leading edge of its own row.
   *
   * TICKING MUST NOT MOVE A ROW. That is the thing a customer notices and the thing this file
   * guards hardest: an implementation that sorted the taken add-ons up into the priced rows and left
   * the rest at the bottom would satisfy every other assertion here and still make the document
   * jump under the reader's finger.
   *
   * Signing is the only thing that locks the choice.
   *
   * `/p/estimates/:id` routes to the v2 page; the v1 one is dead code behind it.
   */

  const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };

  const { estimateId, requiredLineId, declinedLineId, preselectedLineId, optionalScopeId } = CAPTURED;

  /**
   * The document this file works over is the CAPTURED one, not an invention:
   *  - "Door install" 1000, required
   *  - "Smart keypad" 300, optional, NOT taken
   *  - "Extended warranty" 200, optional, taken by the rep
   *  - "Permit filing" 150, an optional SCOPE block, not taken
   * Subtotal 1200, no tax, total 1200.
   *
   * `payload()` clones the capture and applies overrides, so a test that wants a different state
   * changes a value on the real shape rather than rebuilding it. A deep clone per call, because the
   * page mutates nothing but the tests hand these objects to React state.
   */
  function payload(over: Record<string, unknown> = {}, estimateOver: Record<string, unknown> = {}) {
    const base = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
    const estimate = base.estimate as Record<string, unknown>;
    // The default fixture is the selections-OPEN one, so the deposit invoice is dropped unless a
    // test asks for it; an outstanding deposit would otherwise pull the payment UI into every test.
    estimate.invoices = [];
    estimate.send_config = null;
    return { ...base, estimate: { ...estimate, ...estimateOver }, ...over };
  }

  /** The deposit invoice exactly as the API serialises it, PAID. Never hand-written. */
  const PAID_DEPOSIT_INVOICES = structuredClone(
    PUBLIC_PAYLOAD_DEPOSIT_PAID.estimate.invoices,
  ) as unknown as Record<string, unknown>[];

  /** The same row while the deposit is still outstanding. */
  const OUTSTANDING_DEPOSIT_INVOICES = structuredClone(
    PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING.estimate.invoices,
  ) as unknown as Record<string, unknown>[];

  /** One captured line item, with a field changed. Keeps the capture's own encodings. */
  function lineWith(id: string, patch: Record<string, unknown>) {
    const lines = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING.estimate.line_items) as unknown as Record<string, unknown>[];
    return lines.map((l) => (l.id === id ? { ...l, ...patch } : l));
  }

  function stubFetch(...responses: { ok: boolean; body: unknown }[]) {
    return servePublicEstimate({ first: responses, page: () => payload() });
  }

  /** Every row card the document drew, across every section, in the order it drew them. */
  function rowCards(): Element[] {
    return sectionRowLists(document.body).flatMap((list) => Array.from(list.children));
  }

  /** The title of every row card, in document order - what a customer reads top to bottom. */
  function rowTitles(): string[] {
    return rowCards().map((card) => card.querySelector('p')?.textContent ?? '');
  }

  /** The one row card that lists this title. */
  function rowCardFor(title: string): HTMLElement {
    const hit = rowCards().find((card) => card.querySelector('p')?.textContent === title);
    if (!hit) throw new Error(`no row card titled ${title}`);
    return hit as HTMLElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
      selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('one priced list, with the add-ons inline', () => {
    it('offers no second card - every add-on is a row of the document itself', async () => {
      stubFetch({ ok: true, body: payload() });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(screen.queryByText('Optional add-ons')).not.toBeInTheDocument();

      // Every box the page draws sits inside a row card of the priced list, not beside it.
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes).toHaveLength(3);
      for (const box of boxes) {
        expect(rowCards().some((card) => card.contains(box))).toBe(true);
      }
    });

    it('puts the box on the optional rows only, and names each one', async () => {
      stubFetch({ ok: true, body: payload() });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(within(rowCardFor('Smart keypad')).getByRole('checkbox', { name: 'Include Smart keypad' })).toHaveAttribute('data-state', 'unchecked');
      expect(within(rowCardFor('Extended warranty')).getByRole('checkbox', { name: 'Include Extended warranty' })).toHaveAttribute('data-state', 'checked');
      expect(within(rowCardFor('Permit filing')).getByRole('checkbox', { name: 'Include Permit filing' })).toHaveAttribute('data-state', 'unchecked');
      // A row the customer has no choice about carries no control at all.
      expect(within(rowCardFor('Door install')).queryByRole('checkbox')).toBeNull();
    });

    it('draws no boxes at all on an estimate that offers nothing optional', async () => {
      stubFetch({ ok: true, body: payload({}, { line_items: lineWith(requiredLineId, {}).filter((l) => l.id === requiredLineId), scopes: [] }) });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });
  });

  describe('ticking a box', () => {
    it('moves the row and the one total, and moves NOTHING else on the page', async () => {
      stubFetch(
        { ok: true, body: payload() },
        { ok: true, body: { estimate: payload({}, { subtotal: '1500', total_amount: '1500', line_items: lineWith(declinedLineId, { is_selected: true }) }).estimate } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      const before = rowTitles();
      expect(before).toContain('Smart keypad');
      expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0);

      await userEvent.click(screen.getByRole('checkbox', { name: 'Include Smart keypad' }));

      // 1200 + 300 - computed on the page the instant the box moved, then confirmed by the server.
      await waitFor(() => expect(screen.getAllByText('$1,500.00').length).toBeGreaterThan(0));
      expect(screen.queryByText('$1,200.00')).not.toBeInTheDocument();
      expect(screen.queryByText(/total with options/i)).not.toBeInTheDocument();

      // The row is ticked, its tag now reads Included, and the list is in the SAME order.
      expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).toHaveAttribute('data-state', 'checked');
      expect(within(rowCardFor('Smart keypad')).getByText(OPTIONAL_INCLUDED_MARKER)).toBeInTheDocument();
      expect(rowTitles()).toEqual(before);
    });

    it('PATCHes the selection door with that one row, and nothing about is_optional', async () => {
      const fetchMock = stubFetch(
        { ok: true, body: payload() },
        { ok: true, body: { estimate: payload({}, { subtotal: '1500', total_amount: '1500', line_items: lineWith(declinedLineId, { is_selected: true }) }).estimate } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      await userEvent.click(screen.getByRole('checkbox', { name: 'Include Smart keypad' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toContain(`/api/estimates/${estimateId}/public/selections?token=tok-1`);
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({
        selections: [{ kind: 'line', id: declinedLineId, is_selected: true }],
      });
      expect(init.body).not.toContain('is_optional');
    });

    it('lets the customer untick an option the rep pre-selected', async () => {
      const fetchMock = stubFetch(
        { ok: true, body: payload() },
        { ok: true, body: { estimate: payload({}, { subtotal: '1000', total_amount: '1000', line_items: lineWith(preselectedLineId, { is_selected: false }) }).estimate } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      const warranty = screen.getByRole('checkbox', { name: 'Include Extended warranty' });
      expect(warranty).not.toBeDisabled();

      await userEvent.click(warranty);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        selections: [{ kind: 'line', id: preselectedLineId, is_selected: false }],
      });
    });

    it('addresses a scope block by its uuid, never by an index', async () => {
      const fetchMock = stubFetch(
        { ok: true, body: payload() },
        { ok: true, body: { estimate: payload().estimate } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      await userEvent.click(screen.getByRole('checkbox', { name: 'Include Permit filing' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        selections: [{ kind: 'scope', id: optionalScopeId, is_selected: true }],
      });
    });

    it('puts the document back and says why when the server refuses', async () => {
      stubFetch(
        { ok: true, body: payload() },
        { ok: false, body: { error: 'OPTIONS_LOCKED', message: 'Selections are locked because this estimate has been accepted.' } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      await userEvent.click(screen.getByRole('checkbox', { name: 'Include Smart keypad' }));

      expect(await screen.findByText('Selections are locked because this estimate has been accepted.')).toBeInTheDocument();
      // Reverted: the box is back where it was and the total never moved.
      await waitFor(() =>
        expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).toHaveAttribute('data-state', 'unchecked'),
      );
      expect(screen.getAllByText('$1,200.00').length).toBeGreaterThan(0);
    });
  });

  describe('the tick box is big enough to hit on a phone', () => {
    /**
     * WCAG 2.5.8 wants at least 24x24 CSS px. The Radix box is the shared 16px primitive and must
     * stay 16px visually, so - exactly as `LineItemRow.tsx` already does for the same control - the
     * hit area is a 44px label square pulled back by matching negative margins, leaving the MARGIN
     * box (what the row's flex actually reserves, and what the empty rows' spacer matches) at 16px.
     *
     * The deleted "Optional add-ons" card made the whole title block clickable through a
     * `<label htmlFor>`. Losing that and leaving a bare 16x16 button would be a regression on a page
     * whose reader is a homeowner on a phone.
     */
    it('wraps the box in a 44px label that is still only 16px of layout', async () => {
      stubFetch({ ok: true, body: payload() });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      const box = screen.getByRole('checkbox', { name: 'Include Smart keypad' });
      const label = box.closest('label');
      if (!label) throw new Error('the tick box has no label wrapper, so its hit area is 16x16');

      expect(label.className).toMatch(/\bh-11\b/);
      expect(label.className).toMatch(/\bw-11\b/);
      // Pulled back by 14px a side: 44 - 14 - 14 = the 16px the empty rows reserve.
      expect(label.className).toMatch(/-m-\[14px\]/);
      expect(label).toHaveAttribute('for', box.getAttribute('id'));
    });

    it('toggles when the customer hits the label rather than the 16px box itself', async () => {
      const fetchMock = stubFetch(
        { ok: true, body: payload() },
        { ok: true, body: { estimate: payload({}, { subtotal: '1500', total_amount: '1500', line_items: lineWith(declinedLineId, { is_selected: true }) }).estimate } },
      );
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      const label = screen.getByRole('checkbox', { name: 'Include Smart keypad' }).closest('label')!;

      await userEvent.click(label);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        selections: [{ kind: 'line', id: declinedLineId, is_selected: true }],
      });
    });
  });

  describe('what each add-on says it is', () => {
    it('reads Included once taken and Optional (not included) while it is not', async () => {
      stubFetch({ ok: true, body: payload() });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(within(rowCardFor('Extended warranty')).getByText('Included')).toBeInTheDocument();
      expect(within(rowCardFor('Smart keypad')).getByText('Optional (not included)')).toBeInTheDocument();
      expect(within(rowCardFor('Permit filing')).getByText(OPTIONAL_ROW_MARKER)).toBeInTheDocument();
      // A row the customer was never offered a choice about says nothing at all.
      expect(within(rowCardFor('Door install')).queryByText(/optional|included/i)).toBeNull();
    });
  });

  describe('once the estimate is signed', () => {
    /**
     * The fixture is signed WITH AN OUTSTANDING deposit, and the "outstanding" half is the whole
     * point: signature is the only thing that locks, so a state that would have read as open under
     * a deposit-based predicate is the one case that can tell the two apart.
     */
    it('disables every box without pretending it is still interactive (signed, deposit outstanding)', async () => {
      stubFetch({
        ok: true,
        // The deposit row is the CAPTURED one, exactly as the server serialises it.
        body: payload({}, { status: 'WON', invoices: OUTSTANDING_DEPOSIT_INVOICES }),
      });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes).toHaveLength(3);
      for (const box of boxes) {
        expect(box).toBeDisabled();
        // Still named, so a screen reader reads WHICH add-on it is reporting the state of.
        expect(box).toHaveAccessibleName(/^Include /);
      }
      // The document still says which were taken and which were not, in the shared vocabulary. A
      // row the customer never took now reads "Declined" (#2089's public-page half), not the
      // still-open "Optional (not included)" - the estimate is signed, so the answer is final.
      expect(within(rowCardFor('Extended warranty')).getByText(OPTIONAL_INCLUDED_MARKER)).toBeInTheDocument();
      expect(within(rowCardFor('Smart keypad')).getByText(OPTIONAL_DECLINED_MARKER)).toBeInTheDocument();
    });

    it('locks a signed estimate that never required a deposit', async () => {
      stubFetch({ ok: true, body: payload({}, { status: 'WON', invoices: [] }) });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).toBeDisabled();
    });

    it('does NOT lock an unsigned estimate while a deposit is still outstanding', async () => {
      stubFetch({
        ok: true,
        body: payload({}, { status: 'PENDING', invoices: OUTSTANDING_DEPOSIT_INVOICES }),
      });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).not.toBeDisabled();
    });

    /**
     * A deposit that has been PAID used to lock the page on its own; an unsigned estimate is now
     * open whatever the deposit says, because the customer has not yet committed to anything.
     */
    it('does NOT lock an unsigned estimate whose deposit has already been paid', async () => {
      stubFetch({
        ok: true,
        body: payload({}, { status: 'PENDING', invoices: PAID_DEPOSIT_INVOICES }),
      });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).not.toBeDisabled();
    });
  });
});

describe('public-estimate-document-locked', () => {
  /**
   * #2089 (public-page follow-up) - the customer-facing document must say "Declined" on an untaken
   * optional row once the estimate is WON, exactly like its PDF twin already does
   * (`backend/src/lib/pdf/__tests__/optional-declined-row.test.ts`). `EstimateDocumentView` has
   * carried the `locked` prop since #2234, but `PublicEstimatePage` never passed it - the page
   * already computes `selectionsLocked` (`areSelectionsLocked(estimate)`, THE lock predicate, see
   * `@/lib/estimates/selectionLock`) for the tick-box controls and simply never threaded it into the
   * document below them, so the page kept printing "Optional (not included)" on a signed estimate.
   *
   * Fixture style follows `public-estimate-optional-addons.test.tsx`: the same captured payload, the
   * same `payload()`/`lineWith()` helpers, the same row-card DOM readers.
   */

  const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };

  const { estimateId, declinedLineId } = CAPTURED;

  /** Same clone-and-override helper as the sibling file: the default fixture is selections-OPEN. */
  function payload(over: Record<string, unknown> = {}, estimateOver: Record<string, unknown> = {}) {
    const base = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
    const estimate = base.estimate as Record<string, unknown>;
    estimate.invoices = [];
    estimate.send_config = null;
    return { ...base, estimate: { ...estimate, ...estimateOver }, ...over };
  }

  /** One captured line item, with a field changed. Keeps the capture's own encodings. */
  function lineWith(id: string, patch: Record<string, unknown>) {
    const lines = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING.estimate.line_items) as unknown as Record<string, unknown>[];
    return lines.map((l) => (l.id === id ? { ...l, ...patch } : l));
  }

  function stubFetch(...responses: { ok: boolean; body: unknown }[]) {
    return servePublicEstimate({ first: responses, page: () => payload() });
  }

  function rowCards(): Element[] {
    return sectionRowLists(document.body).flatMap((list) => Array.from(list.children));
  }

  function rowCardFor(title: string): HTMLElement {
    const hit = rowCards().find((card) => card.querySelector('p')?.textContent === title);
    if (!hit) throw new Error(`no row card titled ${title}`);
    return hit as HTMLElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
      selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the public document reads "Declined" once the estimate is WON', () => {
    it('an untaken optional row reads "Declined", not "Optional (not included)"', async () => {
      stubFetch({ ok: true, body: payload({}, { status: 'WON', invoices: [] }) });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(within(rowCardFor('Smart keypad')).getByText(OPTIONAL_DECLINED_MARKER)).toBeInTheDocument();
      expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_ROW_MARKER)).not.toBeInTheDocument();
    });

    it('the same untaken optional row reads "Optional (not included)" while the estimate is only SENT', async () => {
      stubFetch({ ok: true, body: payload({}, { status: 'SENT' }) });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(within(rowCardFor('Smart keypad')).getByText(OPTIONAL_ROW_MARKER)).toBeInTheDocument();
      expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_DECLINED_MARKER)).not.toBeInTheDocument();
    });

    it('a TAKEN optional row on a WON estimate reads neither "Declined" nor "Optional (not included)"', async () => {
      stubFetch({
        ok: true,
        body: payload({}, {
          status: 'WON',
          invoices: [],
          line_items: lineWith(declinedLineId, { is_selected: true }),
        }),
      });
      renderPublicEstimate({ id: estimateId, entry: `/p/estimates/${estimateId}?token=tok-1` });

      await screen.findByText('Door install');
      expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_DECLINED_MARKER)).not.toBeInTheDocument();
      expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_ROW_MARKER)).not.toBeInTheDocument();
    });
  });
});

describe('public-pdf-link-and-full-terms', () => {
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
    servePublicEstimate({ page: body });
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
    stubFetch(estimatePayload(terms));
    renderPublicEstimate({ id: CAPTURED.estimateId, entry: `/p/estimates/${CAPTURED.estimateId}?token=tok-1` });
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
      setPublicRoute({ id: INVOICE_ID });
      stubFetch(INVOICE_PAYLOAD);
      renderWithProviders(<PublicInvoicePage />, {
        initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`],
      });
      const link = await screen.findByRole('link', { name: /pdf/i });
      expect(link).toHaveAttribute('href', `${API_HOST}/api/invoices/${INVOICE_ID}/public/pdf?token=tok-1`);
      expect(link).not.toHaveAttribute('target');
    });
  });
});

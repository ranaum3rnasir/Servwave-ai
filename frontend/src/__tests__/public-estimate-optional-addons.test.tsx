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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import { OPTIONAL_DECLINED_MARKER, OPTIONAL_INCLUDED_MARKER, OPTIONAL_ROW_MARKER } from '@/lib/estimate-document-view';
import { sectionRowLists } from '@/__tests__/estimate-document-dom';
import {
  CAPTURED,
  PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING,
  PUBLIC_PAYLOAD_DEPOSIT_PAID,
} from '@/__tests__/fixtures/public-estimate-payload';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: CAPTURED.estimateId }),
    useSearchParams: () => [new URLSearchParams('token=tok-1'), vi.fn()],
  };
});

vi.mock('react-signature-canvas', () => ({
  default: vi.fn().mockImplementation(() => null),
}));

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
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({ ok: r.ok, json: async () => r.body });
  }
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

    await screen.findByText('Door install');
    expect(within(rowCardFor('Smart keypad')).getByRole('checkbox', { name: 'Include Smart keypad' })).toHaveAttribute('data-state', 'unchecked');
    expect(within(rowCardFor('Extended warranty')).getByRole('checkbox', { name: 'Include Extended warranty' })).toHaveAttribute('data-state', 'checked');
    expect(within(rowCardFor('Permit filing')).getByRole('checkbox', { name: 'Include Permit filing' })).toHaveAttribute('data-state', 'unchecked');
    // A row the customer has no choice about carries no control at all.
    expect(within(rowCardFor('Door install')).queryByRole('checkbox')).toBeNull();
  });

  it('draws no boxes at all on an estimate that offers nothing optional', async () => {
    stubFetch({ ok: true, body: payload({}, { line_items: lineWith(requiredLineId, {}).filter((l) => l.id === requiredLineId), scopes: [] }) });
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

    await screen.findByText('Door install');
    expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).toBeDisabled();
  });

  it('does NOT lock an unsigned estimate while a deposit is still outstanding', async () => {
    stubFetch({
      ok: true,
      body: payload({}, { status: 'PENDING', invoices: OUTSTANDING_DEPOSIT_INVOICES }),
    });
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

    await screen.findByText('Door install');
    expect(screen.getByRole('checkbox', { name: 'Include Smart keypad' })).not.toBeDisabled();
  });
});

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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import { OPTIONAL_DECLINED_MARKER, OPTIONAL_ROW_MARKER } from '@/lib/estimate-document-view';
import { sectionRowLists } from '@/__tests__/estimate-document-dom';
import { CAPTURED, PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING } from '@/__tests__/fixtures/public-estimate-payload';

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
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({ ok: r.ok, json: async () => r.body });
  }
  fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

    await screen.findByText('Door install');
    expect(within(rowCardFor('Smart keypad')).getByText(OPTIONAL_DECLINED_MARKER)).toBeInTheDocument();
    expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_ROW_MARKER)).not.toBeInTheDocument();
  });

  it('the same untaken optional row reads "Optional (not included)" while the estimate is only SENT', async () => {
    stubFetch({ ok: true, body: payload({}, { status: 'SENT' }) });
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

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
    renderWithProviders(<PublicEstimatePage />, { initialEntries: [`/p/estimates/${estimateId}?token=tok-1`] });

    await screen.findByText('Door install');
    expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_DECLINED_MARKER)).not.toBeInTheDocument();
    expect(within(rowCardFor('Smart keypad')).queryByText(OPTIONAL_ROW_MARKER)).not.toBeInTheDocument();
  });
});

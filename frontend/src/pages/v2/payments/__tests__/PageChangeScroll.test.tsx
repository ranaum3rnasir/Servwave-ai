/**
 * V7-06a: a page change in a table brings the top of that table into view, and nothing else on this page scrolls
 * anything: tabs, chips, search and filters leave the position where it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { useShellScroll } from '@/hooks/useShellScroll';

import PaymentsPage from '../PaymentsPage';
import { attentionCalls, makeItem, serveAttention } from './attentionFixtures';
import { TabHarness, listCalls, mockApi, serve } from './paymentsFixtures';
import { PayoutsHarness, servePayouts } from './payoutsFixtures';

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectDocuments: () => <div data-testid="embedded-documents" />,
}));

const user = () => userEvent.setup();
const OWNER = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }, { action: 'view_payments', subject: 'Organization' }]);
let scrolled: Array<Element>;

beforeEach(() => {
  mockApi.get.mockReset();
  scrolled = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this); });
});
afterEach(() => vi.restoreAllMocks());

describe('a page change scrolls the top of its table into view', () => {
  it('on the Payments table, but not on first render and not when a chip resets to page 1', async () => {
    const u = user();
    serve();
    renderWithProviders(<TabHarness />, { initialEntries: ['/payments'], ability: OWNER });
    await screen.findAllByText('Customer 1');
    expect(scrolled).toHaveLength(0);
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await screen.findByText('Customer 26');
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]!.contains(screen.getAllByRole('table')[0]!)).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Succeeded' }));
    await screen.findAllByText('Customer 1');
    expect(scrolled).toHaveLength(1);
  });

  it('on the Payouts table', async () => {
    const u = user();
    servePayouts();
    renderWithProviders(<PayoutsHarness />, { initialEntries: ['/payments?tab=payouts'], ability: OWNER });
    await screen.findByText('PO-000001');
    expect(scrolled).toHaveLength(0);
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await screen.findByText('PO-000026');
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]!.contains(screen.getAllByRole('table')[0]!)).toBe(true);
  });

  it('on the Needs attention table', async () => {
    const u = user();
    serveAttention({ open: Array.from({ length: 60 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })) });
    renderWithProviders(<TabHarness />, { initialEntries: ['/payments?chip=attention'], ability: OWNER });
    await waitFor(() => expect(within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')).toHaveLength(25));
    expect(scrolled).toHaveLength(0);
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    await waitFor(() => expect(attentionCalls().filter((c) => c.limit === 25).at(-1)).toMatchObject({ page: 2 }));
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]!.contains(screen.getAllByRole('table')[0]!)).toBe(true);
  });
});

/** The shell's page scroller around the whole page, as the app has it. */
function Shell() {
  const ref = useRef<HTMLElement>(null);
  useShellScroll(ref);
  return <main ref={ref} data-testid="canvas"><PaymentsPage /></main>;
}

describe('nothing on the page moves the page', () => {
  it('keeps the scroll position across tabs, chips, search and the drawer, and never asks for a scroll', async () => {
    const u = user();
    serveAttention({ open: [makeItem(1, 'failed_payment', { actions: [] })] });
    serveWholePage();
    renderWithProviders(<Shell />, { initialEntries: ['/payments'], ability: OWNER });
    const canvas = await screen.findByTestId('canvas');
    const state = { top: 0 };
    Object.defineProperty(canvas, 'scrollTop', { get: () => state.top, set: (v: number) => { state.top = v; }, configurable: true });
    await screen.findAllByText('Customer 1');
    act(() => { state.top = 400; canvas.dispatchEvent(new Event('scroll')); });

    await u.click(screen.getByRole('tab', { name: 'Payouts' }));
    await u.click(await screen.findByRole('tab', { name: 'Documents' }));
    await u.click(screen.getByRole('tab', { name: 'Payments' }));
    await screen.findAllByText('Customer 1');
    await u.click(screen.getByRole('button', { name: 'Succeeded' }));
    await u.type(screen.getByRole('searchbox', { name: /Search/ }), 'ann');
    // The search is debounced: wait until the list has been asked for it (that is the page's whole
    // reaction), and judge the scroll position after that.
    await waitFor(() => expect(listCalls().some((c) => c.q === 'ann')).toBe(true));
    expect(state.top).toBe(400);
    expect(scrolled).toHaveLength(0);
  });
});

/** Whatever the test already serves, plus a payout account that is set up, so the whole page (not one tab) renders. */
function serveWholePage() {
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === '/api/organization/stripe/status') {
      return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null, collected_awaiting_payout: 0 } });
    }
    if (url === '/api/payments-page/payouts') return Promise.resolve({ data: { payouts: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } } });
    return (base as (u: string, c?: unknown) => unknown)(url, config);
  }) as never);
}

describe('the panels', () => {
  it('keep at least the visible height of the page canvas, so a short panel does not shrink the page', async () => {
    serve();
    serveWholePage();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'MAIN' ? 720 : 0;
    });
    renderWithProviders(<main><PaymentsPage /></main>, { initialEntries: ['/payments'], ability: OWNER });
    const panel = await screen.findByRole('tabpanel');
    await waitFor(() => expect(panel.parentElement!.style.minHeight).toBe('720px'));
  });

  it('do not replay the entrance glide on every tab change', async () => {
    serve();
    serveWholePage();
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    const panel = await screen.findByRole('tabpanel');
    expect(panel.classList.contains('motion-safe:animate-tab-panel-in')).toBe(false);
  });
});

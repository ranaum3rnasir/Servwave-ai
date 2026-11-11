import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import type { PaymentsSummary } from '@/lib/api/paymentsPage';
import type { StripeStatus } from '@/lib/api/shared/organization';

import PaymentsPage from '../PaymentsPage';

const mockApi = vi.mocked(api);

// The Documents tab hosts the processor's embedded component, which does not render in jsdom (and would fetch a script).
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectDocuments: () => <div data-testid="embedded-documents" />,
}));

// 2026-10-13 03:30 UTC is still Oct 12 in Los Angeles; the browser (test) zone is not the org's.
const NOW = new Date('2026-10-13T03:30:00Z');

const SUMMARY: PaymentsSummary = {
  collected: 12480,
  fees: 374.4,
  net: 12105.6,
  refunds: 250,
  count: 18,
  fees_pending: 0,
  next_payout: { amount: 3210.5, in_transit: 1800, date: '2026-10-15', schedule_text: 'Weekly on Mondays', bank_label: 'Chase ending 4242' },
};
const EMPTY: PaymentsSummary = {
  collected: 0, fees: 0, net: 0, refunds: 0, count: 0, fees_pending: 0,
  next_payout: { amount: 0, in_transit: 0, date: null, schedule_text: null, bank_label: null },
};
const READY: StripeStatus = {
  connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
  stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null, collected_awaiting_payout: 0,
  first_payout: { state: 'arrived', arrival_date: '2026-10-09' },
};

interface Serve {
  summary?: (params: { from: string; to: string }) => Promise<{ data: unknown }> | { data: unknown };
  status?: StripeStatus;
}

function serve({ summary = () => ({ data: SUMMARY }), status = READY }: Serve = {}) {
  mockApi.get.mockImplementation(((url: string, config?: { params?: { from: string; to: string } }) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === '/api/organization/stripe/status') return Promise.resolve({ data: status });
    if (url === '/api/payments-page/summary') return Promise.resolve(summary(config!.params!));
    return Promise.resolve({ data: {} });
  }) as never);
}

const summaryCalls = () =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/summary').map(([, config]) => (config as { params: { from: string; to: string } }).params);
const lastRange = () => summaryCalls().at(-1);

function Where() {
  const { search } = useLocation();
  return <div data-testid="search">{search}</div>;
}

// The Payments page draws its totals and amounts for a person who sees prices (P11).
const OWNER = buildAbility([...catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never), { action: 'read', subject: 'Prices' } as never]);

function open(entry = '/payments', ability = OWNER) {
  return renderWithProviders(<><PaymentsPage /><Where /></>, { initialEntries: [entry], ability });
}

const search = () => screen.getByTestId('search').textContent;
const expectSearch = (expected: string) => waitFor(() => expect(search()).toBe(expected));
const user = () => userEvent.setup();

async function pickPeriod(u: ReturnType<typeof userEvent.setup>, label: string) {
  await u.click(await screen.findByRole('combobox', { name: 'Period' }));
  await u.click(await screen.findByRole('option', { name: label }));
}

/** Pick "Custom range" and wait until the select has fully closed, so a later click is not swallowed by its layer. */
async function openCustomRange(u: ReturnType<typeof userEvent.setup>) {
  await pickPeriod(u, 'Custom range');
  const dialog = await screen.findByRole('dialog', { name: 'Custom range' });
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  return dialog;
}

async function typeDate(u: ReturnType<typeof userEvent.setup>, name: string, text: string) {
  const field = screen.getByLabelText(name);
  await u.clear(field);
  if (text) await u.type(field, text);
  await u.tab();
}

beforeEach(() => {
  // performance.now is faked too: the period picker judges its hand-over window by it, so a test steps the clock instead of sleeping.
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(NOW);
  mockApi.get.mockReset();
  serve();
});
afterEach(() => vi.useRealTimers());

describe('KPI tiles', () => {
  it('shows the four figures and their notes from the summary', async () => {
    open();
    expect(await screen.findByText('$12,480.00')).toBeInTheDocument();
    expect(screen.getByText('18 payments')).toBeInTheDocument();
    expect(screen.getByText('$374.40')).toBeInTheDocument();
    expect(screen.getByText('3.0% of collected')).toBeInTheDocument();
    expect(screen.getByText('$12,105.60')).toBeInTheDocument();
    expect(screen.getByText('Refunds $250.00')).toBeInTheDocument();
    expect(screen.getByText('$3,210.50')).toBeInTheDocument();
    expect(screen.getByText('Oct 15, Thursday')).toBeInTheDocument();
    expect(screen.getByText('In transit $1,800.00')).toBeInTheDocument();
    // The first payout reached the bank: the page confirms payouts instead of explaining the wait.
    expect(screen.getByTestId('first-payout-notice')).toHaveTextContent('Payouts are arriving regularly');
  });

  it('says "1 payment" for one', async () => {
    serve({ summary: () => ({ data: { ...SUMMARY, count: 1 } }) });
    open();
    expect(await screen.findByText('1 payment')).toBeInTheDocument();
  });

  it('opens the Next payout note on click, not on hover', async () => {
    const u = user();
    open();
    const help = await screen.findByRole('button', { name: 'More about Next payout' });
    await u.hover(help);
    expect(screen.queryByText(/Estimated\. This is money/)).not.toBeInTheDocument();
    await u.click(help);
    expect(await screen.findByText(/^Estimated\. This is money you collected online that is not in a payout yet/)).toBeInTheDocument();
  });

  it('marks the tile Estimated, and names no bank in the note', async () => {
    const u = user();
    open();
    expect(await screen.findByText('Estimated')).toBeInTheDocument();
    await u.click(await screen.findByRole('button', { name: 'More about Next payout' }));
    expect(await screen.findByText(/^Estimated\. This is money/)).not.toHaveTextContent(/Chase|4242/);
  });

  it('puts the "?" on Next payout only', async () => {
    open();
    await screen.findByText('$12,480.00');
    expect(screen.getAllByRole('button', { name: /^More about/ })).toHaveLength(1);
  });

  it('adds the fees footnote only while some fees are unconfirmed', async () => {
    const { unmount } = open();
    await screen.findByText('$374.40');
    expect(screen.queryByText('Some fees are still being confirmed.')).not.toBeInTheDocument();
    unmount();

    serve({ summary: () => ({ data: { ...SUMMARY, fees_pending: 2 } }) });
    open();
    expect(await screen.findByText('Some fees are still being confirmed.')).toBeInTheDocument();
    // The tile detail is nowrap by default; this note must wrap or it is cut off at 390 px.
    expect(screen.getByText('Some fees are still being confirmed.')).toHaveClass('whitespace-normal');
  });

  it('says on the Net tile why it is lower than Collected - Fees - Refunds while fees are pending', async () => {
    serve({ summary: () => ({ data: { ...SUMMARY, fees_pending: 2 } }) });
    open();
    expect(await screen.findByText('2 payments not counted until fees are confirmed')).toBeInTheDocument();
  });

  it('has no such note when every fee is confirmed', async () => {
    open();
    await screen.findByText('Refunds $250.00');
    expect(screen.queryByText(/not counted until fees are confirmed/)).not.toBeInTheDocument();
  });

  it('shows zeros, and the empty state, for a period with no payments', async () => {
    serve({ summary: () => ({ data: EMPTY }) });
    open();
    expect(await screen.findByText('0 payments')).toBeInTheDocument();
    expect(screen.getByText('0.0% of collected')).toBeInTheDocument();
    expect(screen.getByText('Refunds $0.00')).toBeInTheDocument();
    expect(screen.getByText('In transit $0.00')).toBeInTheDocument();
    expect(await screen.findByText('No payments match')).toBeInTheDocument();
    expect(screen.queryByText('No payments in this period')).not.toBeInTheDocument();
  });

  it('shows skeletons while loading', async () => {
    serve({ summary: () => new Promise(() => {}) });
    open();
    await screen.findByRole('tablist');
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('$12,480.00')).not.toBeInTheDocument();
  });

  it('shows one failure with Retry in place of the tiles, and the tabs still work', async () => {
    const u = user();
    let fail = true;
    serve({ summary: () => { if (fail) throw new Error('boom'); return { data: SUMMARY }; } });
    open();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load these totals.')).toBeInTheDocument();

    await u.click(screen.getByRole('tab', { name: 'Payouts' }));
    await expectSearch('?tab=payouts');

    fail = false;
    await u.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$12,480.00')).toBeInTheDocument();
  });

  it('keeps the old figures on screen while a new period loads', async () => {
    const u = user();
    let release: (v: { data: unknown }) => void = () => {};
    serve({
      summary: ({ from }) =>
        from === '2026-09-13' ? { data: SUMMARY } : new Promise((resolve) => { release = resolve; }),
    });
    open();
    await screen.findByText('$12,480.00');

    await pickPeriod(u, 'Last 7 days');
    await waitFor(() => expect(lastRange()).toEqual({ from: '2026-10-06', to: '2026-10-12' }));
    expect(screen.getByText('$12,480.00')).toBeInTheDocument();
    // The Needs-attention card has its own frame (and skeleton rows while it loads); the tiles must show none.
    expect(document.querySelectorAll('[data-slot="skeleton"]:not([role=region] *)')).toHaveLength(0);

    await act(async () => release({ data: { ...SUMMARY, collected: 99 } }));
    expect(await screen.findByText('$99.00')).toBeInTheDocument();
  });
});

describe('period', () => {
  it('starts on Last 30 days in the org timezone', async () => {
    open();
    await waitFor(() => expect(lastRange()).toEqual({ from: '2026-09-13', to: '2026-10-12' }));
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Last 30 days');
  });

  it.each([
    ['Last 7 days', '7', { from: '2026-10-06', to: '2026-10-12' }],
    ['Last 90 days', '90', { from: '2026-07-15', to: '2026-10-12' }],
    ['This month', 'month', { from: '2026-10-01', to: '2026-10-12' }],
  ])('%s asks for %j and is kept in the URL', async (label, key, range) => {
    const u = user();
    open();
    await screen.findByText('$12,480.00');
    await pickPeriod(u, label);
    await waitFor(() => expect(lastRange()).toEqual(range));
    await expectSearch(`?period=${key}`);
  });

  it('restores the period from the URL on reload', async () => {
    open('/payments?period=90&tab=payouts');
    await waitFor(() => expect(lastRange()).toEqual({ from: '2026-07-15', to: '2026-10-12' }));
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Last 90 days');
    expect(await screen.findByRole('tab', { name: 'Payouts' })).toHaveAttribute('aria-selected', 'true');
  });

  describe('Custom range', () => {
    async function openCustom(u: ReturnType<typeof userEvent.setup>) {
      await screen.findByText('$12,480.00');
      return openCustomRange(u);
    }
    const apply = (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: 'Apply' }));

    it('rejects an end before the start: focus lands on the end field with the message beside it', async () => {
      const u = user();
      open();
      await openCustom(u);
      await typeDate(u, 'Start date', '10/05/2026');
      await typeDate(u, 'End date', '10/01/2026');
      await apply(u);

      const end = screen.getByLabelText('End date');
      await waitFor(() => expect(end).toHaveFocus());
      expect(end).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Start date')).not.toHaveAttribute('aria-invalid');
      expect(screen.getByRole('alert')).toHaveTextContent('End date can’t be before the start date');
      await expectSearch('');
    });

    it('rejects a missing start date and focuses it', async () => {
      const u = user();
      open();
      await openCustom(u);
      await typeDate(u, 'Start date', '');
      await typeDate(u, 'End date', '');
      await apply(u);
      await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveFocus());
      expect(screen.getByRole('alert')).toHaveTextContent('Choose a start date');
    });

    it('accepts a one-day range and keeps it in the URL', async () => {
      const u = user();
      open();
      await openCustom(u);
      await typeDate(u, 'Start date', '10/05/2026');
      await typeDate(u, 'End date', '10/05/2026');
      await apply(u);

      await waitFor(() => expect(lastRange()).toEqual({ from: '2026-10-05', to: '2026-10-05' }));
      await expectSearch('?period=custom&from=2026-10-05&to=2026-10-05');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).not.toBeInTheDocument());
      expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Oct 5 - Oct 5');
    });

    it('rejects 367 days and accepts 366', async () => {
      const u = user();
      open();
      await openCustom(u);
      await typeDate(u, 'Start date', '10/12/2025');
      await typeDate(u, 'End date', '10/13/2026');
      await apply(u);
      expect(await screen.findByRole('alert')).toHaveTextContent('Choose a range of 366 days or less');
      await waitFor(() => expect(screen.getByLabelText('End date')).toHaveFocus());

      await typeDate(u, 'Start date', '10/13/2025');
      await apply(u);
      await waitFor(() => expect(lastRange()).toEqual({ from: '2025-10-13', to: '2026-10-13' }));
    });

    it('restores the previous period on Escape', async () => {
      const u = user();
      open('/payments?period=7');
      await waitFor(() => expect(lastRange()).toEqual({ from: '2026-10-06', to: '2026-10-12' }));
      await screen.findByText('$12,480.00');
      await openCustomRange(u);
      await u.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).not.toBeInTheDocument());
      expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Last 7 days');
      await expectSearch('?period=7');
      expect(lastRange()).toEqual({ from: '2026-10-06', to: '2026-10-12' });
    });

    it('stays open when focus or the pointer lands elsewhere just as the select hands over', async () => {
      const u = user();
      open();
      await screen.findByText('$12,480.00');
      await pickPeriod(u, 'Custom range');
      const heading = screen.getByRole('heading', { name: 'Payments' });
      // What a real browser does while the select closes: focus drops onto the page, a pointer event follows.
      act(() => {
        fireEvent.focusIn(heading);
        fireEvent.pointerDown(heading);
        fireEvent.focusIn(document.body);
      });
      expect(screen.getByRole('dialog', { name: 'Custom range' })).toBeInTheDocument();
      expect(document.getElementById('payments-period-from')).toBeInTheDocument();
    });

    it('restores the previous period on Cancel and on a click outside', async () => {
      const u = user();
      open();
      await openCustom(u);
      await u.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).not.toBeInTheDocument());
      expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Last 30 days');

      await openCustomRange(u);
      vi.advanceTimersByTime(400); // past the moment the select is still handing over
      await u.click(screen.getByRole('heading', { name: 'Payments' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).not.toBeInTheDocument());
      expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Last 30 days');
      await expectSearch('');
    });
  });
});

describe('tabs', () => {
  it('has Payments, Payouts and Documents, and keeps the tab in the URL', async () => {
    const u = user();
    open();
    expect(await screen.findAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true');
    await u.click(screen.getByRole('tab', { name: 'Documents' }));
    await expectSearch('?tab=documents');
    expect(await screen.findByTestId('embedded-documents')).toBeInTheDocument();
  });

  it('keeps the period when the tab changes', async () => {
    const u = user();
    open('/payments?period=7');
    await u.click(await screen.findByRole('tab', { name: 'Payouts' }));
    expect(new URLSearchParams(search()!).get('period')).toBe('7');
    expect(new URLSearchParams(search()!).get('tab')).toBe('payouts');
  });

  it('falls back to Payments for an unknown tab', async () => {
    open('/payments?tab=nonsense');
    expect(await screen.findByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true');
  });

  it('has the title "Payments" and no subtitle', async () => {
    open();
    const heading = await screen.findByRole('heading', { name: 'Payments' });
    expect(heading.nextElementSibling).toBeNull();
  });
});

describe('an org that is not set up', () => {
  const NOT_SET_UP = { ...READY, connected: false };

  it('shows the owner a button to the payout account page', async () => {
    serve({ status: NOT_SET_UP });
    open();
    expect(await screen.findByText('Payments are not set up yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up your payout account' })).toHaveAttribute('href', '/settings/servwave-payments#payout-account');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(summaryCalls()).toHaveLength(0);
  });

  it('shows anyone without Manage payout account only the sentence', async () => {
    serve({ status: NOT_SET_UP });
    open('/payments', buildAbility([]));
    expect(await screen.findByText('Payments are not set up yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up your payout account' })).not.toBeInTheDocument();
  });

  it('treats an account whose terms are not accepted the same way', async () => {
    serve({ status: { ...READY, terms_accepted: false } });
    open();
    expect(await screen.findByText('Payments are not set up yet')).toBeInTheDocument();
  });
});

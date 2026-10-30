import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { toast } from '@/ui-kit/components/ui/sonner';
import { PAYMENTS_CHANNEL, postAttached } from '@/lib/paymentsChannel';
import type { PaymentsSummary } from '@/lib/api/paymentsPage';
import type { StripeStatus } from '@/lib/api/organization';

import PaymentsPage from '../PaymentsPage';

// The invoice tab tells this page the payment is booked; the page refetches by itself and says so (V7-09, spec 7.17).

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectDocuments: () => <div data-testid="embedded-documents" />,
}));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

const SUMMARY: PaymentsSummary = {
  collected: 12480, fees: 374.4, net: 12105.6, refunds: 250, count: 18, fees_pending: 0,
  next_payout: { amount: 3210.5, in_transit: 1800, date: '2026-10-15', schedule_text: 'Weekly on Mondays', bank_label: 'Chase ending 4242' },
};
const READY: StripeStatus = {
  connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
  stripe_details_submitted: true, stripe_requirements_due: [], stripe_disabled_reason: null, collected_awaiting_payout: 0,
};
const OWNER = buildAbility([...catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never), { action: 'read', subject: 'Prices' } as never]);

class FakeChannel {
  static all: FakeChannel[] = [];
  closed = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) { FakeChannel.all.push(this); }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && !c.closed && c.name === this.name) c.onmessage?.({ data });
  }
  close() { this.closed = true; }
}

const summaryCalls = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/payments-page/summary').length;

function open() {
  return renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
}

beforeEach(() => {
  FakeChannel.all = [];
  mockToast.success.mockClear();
  mockApi.get.mockReset();
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === '/api/organization/stripe/status') return Promise.resolve({ data: READY });
    if (url === '/api/payments-page/summary') return Promise.resolve({ data: SUMMARY });
    return Promise.resolve({ data: {} });
  }) as never);
});
afterEach(() => vi.unstubAllGlobals());

describe('Payments page: the new-invoice tab reports back', () => {
  it('refetches the page and toasts the payment when another tab records it on a new invoice', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    open();
    await screen.findByText('$12,480.00');
    const before = summaryCalls();

    act(() => postAttached({ invoice_number: 'INV-1042', amount: 150 }));

    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
    expect(mockToast.success).toHaveBeenCalledWith('Payment of $150.00 recorded on the new invoice INV-1042');
  });

  it('stops listening, and closes its channel, when the page goes away', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { unmount } = open();
    await screen.findByText('$12,480.00');
    const listener = FakeChannel.all.find((c) => c.name === PAYMENTS_CHANNEL)!;
    expect(listener.closed).toBe(false);
    unmount();
    expect(listener.closed).toBe(true);
  });

  it('with no BroadcastChannel, refetches when the window regains focus', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    open();
    await screen.findByText('$12,480.00');
    const before = summaryCalls();

    act(() => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not also refetch on focus when the channel is working', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    open();
    await screen.findByText('$12,480.00');
    const before = summaryCalls();
    act(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise((r) => setTimeout(r, 50));
    expect(summaryCalls()).toBe(before);
  });

  it('takes the focus listener off the window when the page goes away', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { unmount } = open();
    await screen.findByText('$12,480.00');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(1));
    unmount();
    const before = summaryCalls();
    fireEvent(window, new Event('focus'));
    expect(summaryCalls()).toBe(before);
  });
});

/**
 * Spider (#2619) - Seam E: the popup cards and the red frame, with the API faked at axios.
 *
 * They render only from the server's unread-alerts list, survive a remount with nothing in the
 * browser, mark read through the existing notification endpoint, poll on the bell's cadence and
 * stop while the tab is hidden - and a company without Spider mounts nothing and asks for nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { LazySpiderAlerts } from '../LazySpiderAlerts';
import SpiderAlertsHost from '../SpiderAlertsHost';
import { RETIRED_SPIDER_STORAGE_KEYS } from '@/lib/spider/gate';

const mockApi = vi.mocked(api);
const UNREAD = '/api/ai-farm/spider/alerts/unread';

const ALERT = {
  id: 'nr-1',
  created_at: '2026-10-01T12:00:00.000Z',
  lead_id: 'lead-1',
  lead_number: 'L00042',
  customer_name: 'Pat Payer',
  status: 'CONTACTED',
  status_label: 'Contacted',
  address: '1 Test Way, Testville, MA 02108',
  owner_name: 'Rita Rep',
  entered_status_at: '2026-10-01T09:00:00.000Z',
  counted_from: '2026-10-01T09:00:00.000Z',
  time_in_status: '3 hours',
};

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}
const SPIDER_USER = { id: 'u1', role: 'SALES', organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };

let unread: { alerts: unknown[]; red_frame: boolean };

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}|${JSON.stringify(loc.state)}`}</div>;
}

function mount(ui: React.ReactElement, client?: QueryClient) {
  const qc = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<>{ui}<LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

const unreadCalls = () => mockApi.get.mock.calls.filter(([url]) => url === UNREAD).length;
const spiderCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).includes('spider')).length;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  unread = { alerts: [ALERT], red_frame: true };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === UNREAD) return { data: unread };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: { ok: true } });
  signIn(SPIDER_USER);
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('the gate', () => {
  it.each([
    ['without the spider feature', { ...SPIDER_USER, org_features: ['leads'] }],
    ['that is not a demo company', { ...SPIDER_USER, org_is_demo: false }],
    ['with no feature list at all (a stale session)', { id: 'u1', role: 'ADMIN', org_is_demo: true }],
  ])('a company %s mounts no popup or frame and makes no Spider request', async (_label, user) => {
    signIn(user);
    mount(<LazySpiderAlerts />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
    expect(screen.queryByRole('button', { name: /unread Spider alert/ })).toBeNull();
    expect(spiderCalls()).toBe(0);
  });

  it('a company with Spider loads the alerts and shows them', async () => {
    mount(<LazySpiderAlerts />);
    expect(await screen.findByRole('button', { name: '1 unread Spider alert' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
  });

  it('clears the browser keys an earlier Spider left behind, for every company', async () => {
    for (const key of RETIRED_SPIDER_STORAGE_KEYS) window.localStorage.setItem(key, '{"isActive":true}');
    signIn({ ...SPIDER_USER, org_is_demo: false });
    mount(<LazySpiderAlerts />);
    await waitFor(() => {
      for (const key of RETIRED_SPIDER_STORAGE_KEYS) expect(window.localStorage.getItem(key)).toBeNull();
    });
  });
});

describe('popup cards and the red frame', () => {
  it('render only from the server alerts, and the same after a remount, with nothing in the browser', async () => {
    const first = mount(<SpiderAlertsHost />);
    fireEvent.click(await screen.findByRole('button', { name: '1 unread Spider alert' }));
    const card = screen.getByRole('button', { name: /Open lead L00042 for Pat Payer/ });
    expect(card).toHaveTextContent('L00042');
    expect(card).toHaveTextContent('Contacted');
    expect(card).toHaveTextContent('Pat Payer');
    expect(card).toHaveTextContent('1 Test Way, Testville, MA 02108');
    expect(card).toHaveTextContent('Owner: Rita Rep');
    expect(card).toHaveTextContent(/In Contacted for \d+ (minute|hour|day)s?/);
    first.unmount();

    // A reload: a fresh cache and a fresh mount. The cards come back from the server alone.
    mount(<SpiderAlertsHost />);
    expect(await screen.findByRole('button', { name: '1 unread Spider alert' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i));
    expect(keys.filter((k) => /spider/i.test(String(k)))).toEqual([]);
  });

  it('show nothing when the server has no unread alert', async () => {
    unread = { alerts: [], red_frame: true };
    mount(<SpiderAlertsHost />);
    await waitFor(() => expect(unreadCalls()).toBe(1));
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
    expect(screen.queryByRole('button', { name: /unread Spider alert/ })).toBeNull();
  });

  it('show no red frame when the company has the red frame switched off', async () => {
    unread = { alerts: [ALERT], red_frame: false };
    mount(<SpiderAlertsHost />);
    expect(await screen.findByRole('button', { name: '1 unread Spider alert' })).toBeInTheDocument();
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
  });

  it('the frame goes away on its own once the list is empty', async () => {
    const { qc } = mount(<SpiderAlertsHost />);
    expect(await screen.findByTestId('spider-red-frame')).toBeInTheDocument();
    unread = { alerts: [], red_frame: true };
    await act(async () => {
      await qc.refetchQueries();
    });
    await waitFor(() => expect(screen.queryByTestId('spider-red-frame')).toBeNull());
  });

  it('clicking a card marks it read through the existing endpoint and opens the lead', async () => {
    mount(<SpiderAlertsHost />);
    fireEvent.click(await screen.findByRole('button', { name: '1 unread Spider alert' }));
    unread = { alerts: [], red_frame: true };
    fireEvent.click(screen.getByRole('button', { name: /Open lead L00042/ }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/notifications/nr-1/read'));
    expect(screen.getByTestId('location')).toHaveTextContent('/leads/lead-1|{"spiderFollowUp":true}');
    await waitFor(() => expect(screen.queryByTestId('spider-red-frame')).toBeNull());
  });

  it('has no "Enable notifications" button', async () => {
    mount(<SpiderAlertsHost />);
    fireEvent.click(await screen.findByRole('button', { name: '1 unread Spider alert' }));
    expect(screen.queryByRole('button', { name: /enable notifications/i })).toBeNull();
  });
});

describe('polling', () => {
  it('asks the server every 30 seconds, and not while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    focusManager.setFocused(true);
    mount(<SpiderAlertsHost />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(unreadCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(unreadCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(unreadCalls()).toBe(2);

    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(unreadCalls()).toBe(2);
  });
});

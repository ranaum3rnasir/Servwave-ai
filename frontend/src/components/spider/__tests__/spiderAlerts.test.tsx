/**
 * Spider (#2619) - the contractor's popup and red frame (Ran, 15 Oct), with the API faked at axios.
 *
 * They render only from the server's unread-alerts list, survive a remount with nothing in the
 * browser, poll on the bell's cadence and stop while the tab is hidden - and a company without
 * Spider mounts nothing and asks for nothing. His click (D4): the card opens the tab for the lead's
 * stage and leaves the alert unread, at every stage, Estimate included (SPEC-6, Ran's decision 11.2).
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { LazySpiderAlerts } from '../LazySpiderAlerts';
import SpiderAlertsHost from '../SpiderAlertsHost';
import { RETIRED_SPIDER_STORAGE_KEYS } from '@/lib/spider/gate';
import { PANEL_EXIT_MS } from '../SpiderNotificationPopup';
import { closeLiveLine, liveBackoffMs } from '@/lib/live/liveLine';
import { resetAccountScopedStores } from '@/lib/storeReset';
import { SPIDER_UNREAD_KEY } from '@/lib/api/shared/queryKeys';
import { fakeLiveLine } from '@/__tests__/harness/fakeLiveLine';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastSpy }), toast: toastSpy }));

const mockApi = vi.mocked(api);
const UNREAD = '/api/ai-farm/spider/alerts/unread';
const SETTINGS = '/api/ai-farm/spider/settings';

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const card = (over: Record<string, unknown> = {}) => ({
  id: 'nr-1',
  created_at: ago(2 * HOUR + 15 * 60_000),
  lead_id: 'lead-1',
  lead_number: 'L00042',
  customer_name: 'Pat Payer',
  company_name: 'Payer Homes',
  status: 'NEW',
  stage_name: 'New',
  current_stage: 'New',
  service_location: '12 Elm Street, Testville, MA, 02108',
  service_request: 'Door repair',
  assigned_to: 'Rita Rep',
  stage_entered_at: ago(3 * DAY + 5 * HOUR),
  message: 'This lead was created 3 days ago and has not yet been contacted.',
  ...over,
});
const NEW_CARD = card();
const CONTACTED_CARD = card({
  id: 'nr-2', lead_id: 'lead-2', lead_number: 'L00043', status: 'CONTACTED', stage_name: 'Contacted', current_stage: 'Contacted',
  stage_entered_at: ago(5 * HOUR + 25 * 60_000),
});
const WALKTHROUGH_CARD = card({
  id: 'nr-3', lead_id: 'lead-3', lead_number: 'L00044', status: 'WALKTHROUGH_COMPLETED', stage_name: 'Walkthrough Completed',
  current_stage: 'Walkthrough Completed', customer_name: 'Sam Shore', company_name: null, assigned_to: 'Unassigned',
  stage_entered_at: ago(2 * DAY),
});

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}
const SPIDER_USER = { id: 'u1', role: 'SALES', organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };

let unread: { alerts: unknown[]; in_app?: boolean; red_frame: boolean; frame?: boolean; frame_ids?: string[] };
/** The live line's server end (#3472). Down by default, so every test that is not about it sees the 30-second checks. */
let live: ReturnType<typeof fakeLiveLine>;

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}|${JSON.stringify(loc.state)}`}</div>;
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
const button = () => screen.findByRole('button', { name: /unread Spider notification/ });

async function openPanel() {
  fireEvent.click(await button());
  return screen.getByRole('dialog', { name: 'Spider Lead Watcher Notifications' });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  unread = { alerts: [NEW_CARD], in_app: true, red_frame: true };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === UNREAD) return { data: unread };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: { ok: true } });
  signIn(SPIDER_USER);
  live = fakeLiveLine();
  live.answerWith('fail');
});

afterEach(() => {
  // The host is still mounted here: its line closing re-renders it.
  act(() => closeLiveLine());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('the gate', () => {
  it.each([
    ['without the spider feature', { ...SPIDER_USER, org_features: ['leads'] }],
    ['that is not a demo company', { ...SPIDER_USER, org_is_demo: false }],
    ['that is neither a demo company nor on the pilot list', { ...SPIDER_USER, org_is_demo: false, org_is_spider_pilot: false }],
    ['on the pilot list but without the spider feature', { ...SPIDER_USER, org_is_demo: false, org_is_spider_pilot: true, org_features: ['leads'] }],
    ['with no feature list at all (a stale session)', { id: 'u1', role: 'ADMIN', is_admin: true, org_is_demo: true }],
  ])('a company %s mounts no popup or frame and makes no Spider request', async (_label, user) => {
    signIn(user);
    mount(<LazySpiderAlerts />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
    expect(spiderCalls()).toBe(0);
    // Nor a live line (#3472).
    expect(live.fetchMock).not.toHaveBeenCalled();
  });

  it('a company with Spider loads the alerts and shows them', async () => {
    mount(<LazySpiderAlerts />);
    expect(await screen.findByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    expect(live.fetchMock.mock.calls[0]?.[0]).toBe('/api/live');
  });

  // SPEC-5: a real (non-demo) company on the server's Spider pilot list.
  it('a pilot company loads the alerts and shows the button and the red frame', async () => {
    signIn({ ...SPIDER_USER, org_is_demo: false, org_is_spider_pilot: true });
    mount(<LazySpiderAlerts />);
    expect(await screen.findByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    expect(unreadCalls()).toBeGreaterThanOrEqual(1);
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

describe('his floating button', () => {
  it('shows the unread count, bounces while closed, and stops when the panel opens', async () => {
    unread = { alerts: [NEW_CARD, CONTACTED_CARD], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    const fab = await screen.findByRole('button', { name: '2 unread Spider notifications — click to view' });
    expect(fab).toHaveTextContent('2');
    expect(fab.className).toContain('animate-bounce');
    fireEvent.click(fab);
    expect(fab.className).not.toContain('animate-bounce');
    expect(fab).toHaveAttribute('aria-expanded', 'true');
  });

  it('reads "99+" above 99', async () => {
    unread = { alerts: Array.from({ length: 100 }, (_, i) => card({ id: `nr-${i}` })), in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    expect(await button()).toHaveTextContent('99+');
  });

  it('is not there when the server has no unread alert, and neither is the frame', async () => {
    unread = { alerts: [], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await waitFor(() => expect(unreadCalls()).toBe(1));
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
  });
});

describe('his panel and cards', () => {
  it('has his header: "Spider Notifications" and a red "{n} Awaiting"', async () => {
    unread = { alerts: [NEW_CARD, CONTACTED_CARD, WALKTHROUGH_CARD], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'Spider Notifications' })).toBeInTheDocument();
    expect(within(panel).getByText('3 Awaiting')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows each card as he did: lead #, stage, time ago, customer • company, address, sentence, action, assigned', async () => {
    unread = { alerts: [NEW_CARD, CONTACTED_CARD, WALKTHROUGH_CARD], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await openPanel();

    const first = screen.getByRole('button', { name: 'Open notification for lead L00042' });
    expect(first).toHaveTextContent('L00042');
    expect(first).toHaveTextContent('New');
    expect(first).toHaveTextContent('2 hours 15 minutes ago');
    expect(first).toHaveTextContent('Customer:Pat Payer• Payer Homes');
    expect(first).toHaveTextContent('12 Elm Street, Testville, MA, 02108');
    expect(first).toHaveTextContent('This lead was created 3 days 5 hours ago and has not yet been contacted.');
    expect(first).toHaveTextContent('Need to contact');
    expect(first).toHaveTextContent('Assigned: Rita Rep');

    const second = screen.getByRole('button', { name: 'Open notification for lead L00043' });
    expect(second).toHaveTextContent('Contacted');
    expect(second).toHaveTextContent('This lead was contacted 5 hours 25 min ago, but a walkthrough has not yet been scheduled.');
    expect(second).toHaveTextContent('Schedule walkthrough');

    const third = screen.getByRole('button', { name: 'Open notification for lead L00044' });
    expect(third).toHaveTextContent('Walkthrough Completed');
    expect(third).toHaveTextContent('The walkthrough was completed 2 days ago, but an estimate has not yet been sent.');
    expect(third).toHaveTextContent('Send estimate');
    // No company: his "• company" is left out (it would repeat the customer's name).
    expect(third).toHaveTextContent('Customer:Sam Shore');
    expect(third).not.toHaveTextContent('•');
    expect(third).toHaveTextContent('Assigned: Unassigned');
  });

  it('a lead moved back to New: the sentence counts from when the lead was created, not from the new stay (D7)', async () => {
    unread = {
      alerts: [card({
        stage_entered_at: ago(DAY), lead_created_at: ago(3 * DAY),
        message: 'This lead was created 3 days ago and has not yet been contacted.',
      })],
      in_app: true,
      red_frame: true,
    };
    mount(<SpiderAlertsHost />);
    await openPanel();
    const c = screen.getByRole('button', { name: 'Open notification for lead L00042' });
    expect(c).toHaveTextContent('This lead was created 3 days ago and has not yet been contacted.');
    expect(c).not.toHaveTextContent('created 1 day ago');
  });

  it('cuts a sentence longer than 100 characters, with "See more" / "See less", without opening the lead', async () => {
    const long = `${'Spider '.repeat(20)}end.`;
    unread = { alerts: [card({ stage_entered_at: null, message: long })], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await openPanel();
    expect(screen.getByText(`${long.slice(0, 100)}...`, { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See more' }));
    expect(screen.getByText(long, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See less' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/\|/);
  });

  it('render the same after a remount, with nothing in the browser', async () => {
    const first = mount(<SpiderAlertsHost />);
    await openPanel();
    first.unmount();
    mount(<SpiderAlertsHost />);
    expect(await button()).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i));
    expect(keys.filter((k) => /spider/i.test(String(k)))).toEqual([]);
  });

  it("fills his card from an older server's alert (the frontend can deploy first)", async () => {
    unread = {
      alerts: [{
        id: 'nr-9', created_at: ago(HOUR), lead_id: 'lead-9', lead_number: 'L00049', customer_name: 'Old Shape',
        status: 'CONTACTED', status_label: 'Contacted', address: '1 Old Road', owner_name: 'Rita Rep',
        entered_status_at: ago(3 * HOUR), counted_from: ago(3 * HOUR), time_in_status: '3 hours',
      }],
      red_frame: true,
    };
    mount(<SpiderAlertsHost />);
    await openPanel();
    const c = screen.getByRole('button', { name: 'Open notification for lead L00049' });
    expect(c).toHaveTextContent('Contacted');
    expect(c).toHaveTextContent('1 Old Road');
    expect(c).toHaveTextContent('Assigned: Rita Rep');
    expect(c).toHaveTextContent('This lead was contacted 3 hours ago, but a walkthrough has not yet been scheduled.');
    expect(c).toHaveTextContent('Schedule walkthrough');
  });

  it('closes on Escape', async () => {
    mount(<SpiderAlertsHost />);
    await openPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows each customer's initials, not only the first letter", async () => {
    unread = { alerts: [card({ customer_name: 'Kim Placeholder' })], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await openPanel();
    const c = screen.getByRole('button', { name: 'Open notification for lead L00042' });
    expect(within(c).getByText('KP')).toBeInTheDocument();
  });

  it('shows "C" for an alert with no customer name, matching the "Customer" it shows', async () => {
    unread = { alerts: [card({ customer_name: null, company_name: null })], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await openPanel();
    const c = screen.getByRole('button', { name: 'Open notification for lead L00042' });
    expect(c).toHaveTextContent('Customer:Customer');
    expect(within(c).getByText('C')).toBeInTheDocument();
  });

  it('with reduced motion, closes at once with no closing phase', async () => {
    const plain = vi.mocked(window.matchMedia).getMockImplementation()!;
    onTestFinished(() => void vi.mocked(window.matchMedia).mockImplementation(plain));
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(panel).not.toBeInTheDocument();
  });

  it("waits exactly the motion token's length before removing a closing panel", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../design-system/tokens-v2.css'), 'utf8');
    const token = /--motion-duration-fast:\s*(\d+)ms/.exec(css)?.[1];
    expect(Number(token)).toBe(PANEL_EXIT_MS);
  });

  it('opens with an animation, and on close leaves at once for assistive tech but plays out before it goes', async () => {
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    expect(panel).toHaveAttribute('data-state', 'open');

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const closing = screen.getByRole('dialog', { hidden: true });
    expect(closing).toHaveAttribute('data-state', 'closed');
    expect(closing).toHaveAttribute('inert');

    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull());
  });

  it('reopens cleanly when the button is tapped again while the panel is closing', async () => {
    // Fake clock (real time still flows): the closing animation's timer is stepped over, not slept through.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    fireEvent.click(await button());
    const again = screen.getByRole('dialog', { name: 'Spider Lead Watcher Notifications' });
    expect(again).toHaveAttribute('data-state', 'open');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByRole('dialog', { name: 'Spider Lead Watcher Notifications' })).toBeInTheDocument();
  });
});

describe('his click (D4)', () => {
  async function clickCard(c: Record<string, unknown>) {
    unread = { alerts: [c], in_app: true, red_frame: true };
    mount(<SpiderAlertsHost />);
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: `Open notification for lead ${c.lead_number}` }));
    return screen.getByTestId('location').textContent ?? '';
  }

  it('New: opens Communication with his pre-filled draft, and leaves the alert unread', async () => {
    const at = await clickCard(NEW_CARD);
    expect(at).toBe(
      '/leads/lead-1?tab=communication|'
        + JSON.stringify({ spiderAlertId: 'nr-1', spiderDraft: 'Hello Pat Payer, following up regarding your Door repair (Stage: New).' }),
    );
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('New with no service request: his "service request" stands in', async () => {
    const at = await clickCard(card({ service_request: null }));
    expect(at).toContain('Hello Pat Payer, following up regarding your service request (Stage: New).');
  });

  it('Contacted: opens the Walkthrough tab, and leaves the alert unread', async () => {
    expect(await clickCard(CONTACTED_CARD)).toBe('/leads/lead-2?tab=walkthrough|{"spiderAlertId":"nr-2"}');
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('Walkthrough Completed: opens Overview, and leaves the alert unread', async () => {
    expect(await clickCard(WALKTHROUGH_CARD)).toBe('/leads/lead-3?tab=overview|{"spiderAlertId":"nr-3"}');
    expect(mockApi.patch).not.toHaveBeenCalled();
    // Still unread: the frame stays.
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
  });

  it("Estimate (the lead's status is Estimate Sent): opens Overview, and leaves the alert unread", async () => {
    const at = await clickCard(card({ ...WALKTHROUGH_CARD, current_stage: 'Estimate' }));
    expect(at).toBe('/leads/lead-3?tab=overview|{"spiderAlertId":"nr-3"}');
    // Still unread: no mark-read is sent, and the frame stays until an estimate is really sent.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
  });
});

describe('his states', () => {
  it('in-app switched off: his sentence, and [Enable Notifications] only for an Admin, which turns it on through the settings save', async () => {
    unread = { alerts: [NEW_CARD], in_app: false, red_frame: true };
    signIn({ ...SPIDER_USER, role: 'ADMIN', is_admin: true });
    const settings = {
      settings: {
        is_active: true, activated_at: ago(DAY),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: { enabled: false, value: 1, unit: 'MINUTE' }, WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'MINUTE' } },
        channels: { in_app: false, red_frame: true, email: true, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true },
        updated_at: ago(DAY),
      },
      options: { statuses: [], units: [], roles: [] },
    };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === UNREAD) return { data: unread };
      if (url === SETTINGS) return { data: settings };
      return { data: {} };
    });
    mockApi.put.mockResolvedValue({ data: { ...settings, settings: { ...settings.settings, channels: { ...settings.settings.channels, in_app: true } } } });
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    expect(within(panel).getByText('In-App Spider notifications are currently disabled.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Open notification/ })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Enable Notifications' }));
    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(
        SETTINGS,
        {
          status_limits: settings.settings.status_limits,
          channels: { in_app: true, red_frame: true, email: true, text: false },
          recipients: settings.settings.recipients,
        },
        { silentErrors: true },
      ),
    );
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: 'Enabled Spider In-App Notifications', duration: 2000 }));
  });

  it('in-app switched off, not an Admin: his sentence alone', async () => {
    unread = { alerts: [NEW_CARD], in_app: false, red_frame: true };
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    expect(within(panel).getByText('In-App Spider notifications are currently disabled.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Enable Notifications' })).toBeNull();
  });
});

describe('his red frame', () => {
  it('is labelled for screen readers and never blocks a click', async () => {
    mount(<SpiderAlertsHost />);
    const frame = await screen.findByTestId('spider-red-frame');
    expect(frame).toHaveAttribute('role', 'status');
    expect(frame).toHaveAttribute('aria-label', 'Spider has an unread alert for you');
    expect(frame.className).toContain('pointer-events-none');
    expect(frame.innerHTML).toContain('spiderMaroonPulse');
  });

  it('is not shown when the company has the red frame switched off', async () => {
    unread = { alerts: [NEW_CARD], in_app: true, red_frame: false };
    mount(<SpiderAlertsHost />);
    expect(await button()).toBeInTheDocument();
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
  });

  it('Red Frame on its own (in-app off): shows from the server\'s frame flag with no button, as his did', async () => {
    unread = { alerts: [], in_app: false, red_frame: true, frame: true } as typeof unread;
    mount(<SpiderAlertsHost />);
    expect(await screen.findByTestId('spider-red-frame')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
  });

  it('follows the server\'s frame flag over the alert list when it is given', async () => {
    unread = { alerts: [NEW_CARD], in_app: true, red_frame: true, frame: false } as typeof unread;
    mount(<SpiderAlertsHost />);
    expect(await button()).toBeInTheDocument();
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
  });

  it('goes away on its own once the server stops listing the alert (the lead left the stage)', async () => {
    const { qc } = mount(<SpiderAlertsHost />);
    expect(await screen.findByTestId('spider-red-frame')).toBeInTheDocument();
    unread = { alerts: [], in_app: true, red_frame: true };
    await act(async () => {
      await qc.refetchQueries();
    });
    await waitFor(() => expect(screen.queryByTestId('spider-red-frame')).toBeNull());
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
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

describe('the live line (#3472)', () => {
  const tick = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  const fetches = () => live.fetchMock.mock.calls.length;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    focusManager.setFocused(true);
    // Every random wait at its middle: a reconnect 6.5 s after a drop, then 15 s, 30 s, 45 s; a re-read after 1.5 s.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    live.answerWith('open');
  });

  it("opens one line with the sign-in token in a header, never in the URL; while it is open and the server says Spider's check runs (#3469), nothing is asked for 4 minutes, then the 5-minute safety check", async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(unreadCalls()).toBe(1);
    expect(fetches()).toBe(1);
    const [url, init] = live.fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/live');
    expect(String(url)).not.toContain('test-access-token');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');

    await tick(4 * 60_000);
    expect(unreadCalls()).toBe(1);
    // A window focus asks nothing while the line is open either.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await tick(10);
    expect(unreadCalls()).toBe(1);
    await tick(61_000);
    expect(unreadCalls()).toBe(2);
    expect(fetches()).toBe(1);
  });

  it("with the line open but Spider's check not running on the server (#3469), it keeps asking every 30 s, and a window focus still asks", async () => {
    unread = { alerts: [NEW_CARD], in_app: true, red_frame: true, frame: true, frame_ids: [] };
    live.helloWith({ spider_tick: false });
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(unreadCalls()).toBe(1);
    expect(fetches()).toBe(1);
    expect(live.last.aborted()).toBe(false);
    await tick(29_000);
    expect(unreadCalls()).toBe(1);
    await tick(1_500);
    expect(unreadCalls()).toBe(2);
    await tick(30_000);
    expect(unreadCalls()).toBe(3);
    // The line still carries its messages: a new alert shows at once, with no read.
    live.send('spider.alert.added', { alerts: [CONTACTED_CARD], frame_ids: [] });
    await tick(10);
    expect(screen.getByRole('button', { name: '2 unread Spider notifications — click to view' })).toBeInTheDocument();
    expect(unreadCalls()).toBe(3);
    // And a window focus still asks (staleTime is 15 s).
    await tick(16_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await tick(10);
    expect(unreadCalls()).toBe(4);
    expect(fetches()).toBe(1);
  });

  it('a server that sends no hello (older than #3469) keeps the 30-second check too', async () => {
    live.helloWith(null);
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(unreadCalls()).toBe(1);
    await tick(30_500);
    expect(unreadCalls()).toBe(2);
    expect(fetches()).toBe(1);
    expect(live.last.aborted()).toBe(false);
  });

  it("the check's hello holds for one line only: a line that reopens on a server without the check is back to 30 s", async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    await tick(60_000);
    expect(unreadCalls()).toBe(1);
    live.helloWith({ spider_tick: false });
    live.last.end();
    // Reconnects after 6.5 s, re-reads once after 1.5 s, then every 30 s.
    await tick(8_100);
    expect(fetches()).toBe(2);
    const before = unreadCalls();
    await tick(30_500);
    expect(unreadCalls()).toBeGreaterThan(before);
  });

  it('a new alert shows its card and the frame at once, and its end takes them away, with no read; a red-frame-only record the same', async () => {
    unread = { alerts: [], in_app: true, red_frame: true, frame: false, frame_ids: [] };
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(unreadCalls()).toBe(1);
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();

    live.send('spider.alert.added', { alerts: [NEW_CARD], frame_ids: [] });
    await tick(10);
    expect(screen.getByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    live.send('spider.alert.added', { alerts: [CONTACTED_CARD], frame_ids: [] });
    await tick(10);
    expect(screen.getByRole('button', { name: '2 unread Spider notifications — click to view' })).toBeInTheDocument();

    live.send('spider.alert.ended', { ids: [NEW_CARD.id, CONTACTED_CARD.id] });
    await tick(10);
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();

    // In-app alerts off: a red-frame-only record shows the frame with no button, and goes with its end.
    live.send('spider.alert.added', { alerts: [], frame_ids: ['nr-frame'] });
    await tick(10);
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
    live.send('spider.alert.ended', { ids: ['nr-frame'] });
    await tick(10);
    expect(screen.queryByTestId('spider-red-frame')).toBeNull();
    expect(unreadCalls()).toBe(1);
  });

  it('a settings change re-reads once, after a random wait of at most 3 s, however many arrive together', async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    live.send('spider.settings.changed', {});
    live.send('spider.settings.changed', {});
    await tick(1_400);
    expect(unreadCalls()).toBe(1);
    await tick(200);
    expect(unreadCalls()).toBe(2);
    await tick(5_000);
    expect(unreadCalls()).toBe(2);
  });

  it('reconnects first after a random 1-12 s (so a deploy\'s returns spread over at least 10 s), then waits up to twice as long each time, never past 60 s', () => {
    expect(liveBackoffMs(1, () => 0)).toBe(1_000);
    expect(liveBackoffMs(1, () => 0.5)).toBe(6_500);
    expect(liveBackoffMs(1, () => 1)).toBe(12_000);
    expect([liveBackoffMs(2, () => 0), liveBackoffMs(2, () => 1)]).toEqual([10_000, 20_000]);
    expect([liveBackoffMs(3, () => 0), liveBackoffMs(3, () => 1)]).toEqual([20_000, 40_000]);
    expect([liveBackoffMs(4, () => 0), liveBackoffMs(4, () => 1)]).toEqual([30_000, 60_000]);
    expect(liveBackoffMs(12, () => 1)).toBe(60_000);
  });

  it('when the line drops: 30-second checks at once, a reconnect after 1-12 s, and one re-read once it is back', async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(unreadCalls()).toBe(1);
    live.last.end();
    await tick(6_400);
    expect(fetches()).toBe(1);
    await tick(200);
    expect(fetches()).toBe(2);
    // Back: one re-read after its random wait, then the 5-minute safety check again.
    await tick(1_300);
    expect(unreadCalls()).toBe(1);
    await tick(200);
    expect(unreadCalls()).toBe(2);
    await tick(4 * 60_000);
    expect(unreadCalls()).toBe(2);
  });

  it('a network cut: the 30-second checks carry on, and it keeps trying with growing random waits (up to 60 s) until it is back', async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    live.answerWith('fail');
    live.last.drop();
    await tick(10);
    // The checks carry on every 30 s from the drop.
    await tick(30_500);
    expect(unreadCalls()).toBe(2);
    // Tries at 6.5 s, then 15 s, 30 s and 45 s after each failure (the middle of 1-12 s, 10-20 s, 20-40 s, 30-60 s).
    expect(fetches()).toBe(3);
    await tick(21_500);
    expect(fetches()).toBe(4);
    await tick(45_000);
    expect(fetches()).toBe(5);
    await tick(45_000);
    expect(fetches()).toBe(6);
    expect(unreadCalls()).toBe(5);

    live.answerWith('open');
    await tick(45_000);
    expect(fetches()).toBe(7);
    // Open again: one re-read, then nothing more for minutes.
    const before = unreadCalls();
    await tick(2_000);
    expect(unreadCalls()).toBe(before + 1);
    await tick(4 * 60_000);
    expect(unreadCalls()).toBe(before + 1);
  });

  it('refused by a full server: keeps the 30-second checks and waits as long as it is told before trying again', async () => {
    live.answerWith({ status: 503, retryAfter: '60' });
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(fetches()).toBe(1);
    await tick(30_000);
    expect(unreadCalls()).toBe(2);
    await tick(29_000);
    expect(fetches()).toBe(1);
    await tick(1_100);
    expect(fetches()).toBe(2);
  });

  it('a hidden tab keeps its line for 30 minutes, then closes it; shown again, it reopens and re-reads', async () => {
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const setVisibility = (next: DocumentVisibilityState) => {
      state = next;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    mount(<SpiderAlertsHost />);
    await tick(10);
    act(() => setVisibility('hidden'));
    await tick(29 * 60_000);
    expect(live.last.aborted()).toBe(false);
    await tick(61_000);
    expect(live.last.aborted()).toBe(true);
    expect(fetches()).toBe(1);
    const before = unreadCalls();

    act(() => setVisibility('visible'));
    await tick(10);
    expect(fetches()).toBe(2);
    await tick(2_000);
    expect(unreadCalls()).toBeGreaterThan(before);
  });

  it('a line that goes silent is taken to have dropped: the server\'s 25-second keep-alive holds it, 60 s of nothing does not (30-second checks at once, then a reconnect)', async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    // Keep-alives every 25 s (the fake server sends them): five minutes pass, the line stays, the checks stay at 5 minutes.
    await tick(5 * 60_000 - 10);
    expect(fetches()).toBe(1);
    expect(live.last.aborted()).toBe(false);
    expect(unreadCalls()).toBe(2);

    // The connection dies without a word (a laptop that slept): nothing arrives for 60 s.
    live.keepAlives(false);
    live.answerWith('fail');
    await tick(59_000);
    expect(live.lines[0]!.aborted()).toBe(false);
    const before = unreadCalls();
    await tick(2_000);
    expect(live.lines[0]!.aborted(), 'the idle watchdog dropped it').toBe(true);
    // Dropped: back to the 30-second checks at once, and it tries to come back after its random wait.
    await tick(30_500);
    expect(unreadCalls()).toBeGreaterThan(before);
    expect(fetches()).toBeGreaterThanOrEqual(2);

    // It comes back: open again, one re-read, safety check again.
    live.answerWith('open');
    live.keepAlives(true);
    await tick(60_000);
    const opened = fetches();
    const reads = unreadCalls();
    await tick(4 * 60_000);
    expect(fetches()).toBe(opened);
    expect(unreadCalls()).toBe(reads);
  });

  describe("applying a message when the copy on screen cannot be patched safely (it reads again instead)", () => {
    it('an older server\'s copy (no frame ids) is read again, not patched', async () => {
      unread = { alerts: [NEW_CARD], in_app: true, red_frame: true };
      mount(<SpiderAlertsHost />);
      await tick(10);
      expect(unreadCalls()).toBe(1);
      unread = { alerts: [NEW_CARD, CONTACTED_CARD], in_app: true, red_frame: true, frame: true, frame_ids: [] };
      live.send('spider.alert.added', { alerts: [CONTACTED_CARD], frame_ids: [] });
      await tick(10);
      expect(unreadCalls()).toBe(2);
      live.send('spider.alert.ended', { ids: [NEW_CARD.id] });
      await tick(10);
      // Now the copy has frame ids (the second read brought them): an end is patched in with no read.
      expect(unreadCalls()).toBe(2);
      expect(screen.getByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
      live.send('spider.alert.ended', { ids: [CONTACTED_CARD.id] });
      await tick(10);
      expect(unreadCalls()).toBe(2);
      expect(screen.queryByRole('button', { name: /unread Spider notification/ })).toBeNull();
    });

    it('while a read is already on its way a message is not patched in (the read may have started before it and would replace it): the screen shows what the read brings', async () => {
      unread = { alerts: [NEW_CARD], in_app: true, red_frame: true, frame: true, frame_ids: [] };
      const { qc } = mount(<SpiderAlertsHost />);
      await tick(10);
      expect(unreadCalls()).toBe(1);

      // The next read is held, as a slow server would.
      const release: Array<() => void> = [];
      mockApi.get.mockImplementation((url: string) =>
        url === UNREAD ? new Promise((r) => release.push(() => r({ data: unread }))) : Promise.resolve({ data: {} }),
      );
      act(() => {
        void qc.refetchQueries({ queryKey: SPIDER_UNREAD_KEY });
      });
      await tick(10);
      expect(release).toHaveLength(1);

      // A card arrives meanwhile: patching it in would be wiped by the held read. It asks again instead.
      live.send('spider.alert.added', { alerts: [CONTACTED_CARD], frame_ids: [] });
      await tick(10);
      expect(screen.getByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
      expect(release.length).toBeGreaterThanOrEqual(1);
      // The server's answer (which includes the card) is what ends up on screen, after every held read is let go.
      unread = { alerts: [NEW_CARD, CONTACTED_CARD], in_app: true, red_frame: true, frame: true, frame_ids: [] };
      for (let i = 0; i < 4; i++) {
        release.splice(0).forEach((r) => r());
        await tick(10);
      }
      expect(screen.getByRole('button', { name: '2 unread Spider notifications — click to view' })).toBeInTheDocument();
    });

    it('a list at its limit of 100 reads again when one ends (an alert past the limit may now belong in it)', async () => {
      const hundred = Array.from({ length: 100 }, (_, i) => card({ id: `nr-${i}`, lead_id: `lead-${i}`, lead_number: `L${i}`, created_at: ago(i * 60_000) }));
      unread = { alerts: hundred, in_app: true, red_frame: true, frame: true, frame_ids: [] };
      mount(<SpiderAlertsHost />);
      await tick(10);
      expect(unreadCalls()).toBe(1);
      live.send('spider.alert.ended', { ids: ['nr-0'] });
      await tick(10);
      expect(unreadCalls(), 'one read for the alert that may have come into the list').toBe(2);

      // Below the limit an end is applied with no read.
      unread = { alerts: hundred.slice(1, 10), in_app: true, red_frame: true, frame: true, frame_ids: [] };
      live.send('spider.settings.changed', {});
      await tick(3_100);
      expect(unreadCalls()).toBe(3);
      live.send('spider.alert.ended', { ids: ['nr-1'] });
      await tick(10);
      expect(unreadCalls()).toBe(3);
    });
  });

  it('sign-out closes the line, and it does not come back', async () => {
    mount(<SpiderAlertsHost />);
    await tick(10);
    expect(live.last.aborted()).toBe(false);
    act(() => resetAccountScopedStores());
    expect(live.last.aborted()).toBe(true);
    await tick(120_000);
    expect(fetches()).toBe(1);
  });
});

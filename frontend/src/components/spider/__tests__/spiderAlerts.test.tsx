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

let unread: { alerts: unknown[]; in_app?: boolean; red_frame: boolean };

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
});

afterEach(() => {
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
  });

  it('a company with Spider loads the alerts and shows them', async () => {
    mount(<LazySpiderAlerts />);
    expect(await screen.findByRole('button', { name: '1 unread Spider notification — click to view' })).toBeInTheDocument();
    expect(screen.getByTestId('spider-red-frame')).toBeInTheDocument();
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
    mount(<SpiderAlertsHost />);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    fireEvent.click(await button());
    const again = screen.getByRole('dialog', { name: 'Spider Lead Watcher Notifications' });
    expect(again).toHaveAttribute('data-state', 'open');
    await new Promise((r) => setTimeout(r, 400));
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
        watch_all_leads: true, selected_lead_ids: [], updated_at: ago(DAY),
      },
      selected_leads: [], options: { statuses: [], units: [], roles: [] },
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
          watch_all_leads: true,
          selected_lead_ids: [],
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

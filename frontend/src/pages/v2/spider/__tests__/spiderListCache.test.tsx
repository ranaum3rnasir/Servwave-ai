/**
 * #2988 - the Spider page stops reloading its lead and customer lists every time it opens.
 *
 * Runs with the APP's cache rules (the shared queryClient's defaults, retry rule included), not the
 * test harness's: the freshness window is READ from that client.
 *
 * ONE table covers every way in. Each row: a first visit (leads 1-3: Pat has L00001 and L00002, Kim
 * has L00003) -> leave -> the server's lead list changes (by default it gains L00004 for a new
 * customer, Ned) -> come back inside the window -> act -> save. The page now draws the lists from its
 * cache, so the person does not see the change; the saved body must still be what TODAY's code
 * (which re-read both lists on every open, so the person saw the change) writes for the same clicks
 * on the server's CURRENT list. Those expected bodies were taken from today's code (the verifier's
 * r2 probe at build/spider-efficiency, plus this table run there; see reports/2988-builder-r3.md).
 * The request-count rows hold the ticket's criteria: a visit inside the window reads no list, one
 * after it reads each once, a save re-reads both, the switch and the in-app enable read none.
 */
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import api from '@/lib/axios';
import { queryClient as appQueryClient } from '@/lib/queryClient';
import { useEnableSpiderInApp } from '@/lib/api/spider';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth.store';
import SpiderPage from '../SpiderPage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  };
});

const mockApi = vi.mocked(api);
const SETTINGS = '/api/ai-farm/spider/settings';
const STATUS = '/api/ai-farm/spider/status';
const LEADS = '/api/leads';
const CUSTOMERS = '/api/customers';
const T0 = Date.parse('2026-11-03T15:00:00.000Z');
const MIN = 60_000;

/** The app's freshness rule, read from the one shared client. */
const APP_DEFAULTS = appQueryClient.getDefaultOptions();
const FRESH_MS = Number(APP_DEFAULTS.queries?.staleTime);

const ADMIN = { id: 'u1', role: 'ADMIN', is_admin: true, organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };
const OFF = { enabled: false, value: 1, unit: 'MINUTE' };
const settingsBody = (watchAll: boolean, ids: string[]) => ({
  settings: {
    is_active: true,
    activated_at: null,
    status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: OFF, WALKTHROUGH_COMPLETED: OFF },
    channels: { in_app: false, red_frame: true, email: false, text: false },
    recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true },
    watch_all_leads: watchAll,
    selected_lead_ids: ids,
    updated_at: null,
  },
  selected_leads: [],
  options: {
    statuses: [{ value: 'NEW', label: 'New' }],
    units: [{ value: 'HOUR', label: 'Hours' }],
    roles: [{ value: 'ADMIN', label: 'Admin' }],
  },
});
const cust = (id: string, first: string, last: string) => ({ id, first_name: first, last_name: last, company_name: null, email: `${id}@example.test` });
const PAT = cust('cust-pat', 'Pat', 'Payer');
const KIM = cust('cust-kim', 'Kim', 'Keeper');
const NED = cust('cust-ned', 'Ned', 'Newcomer');
const lead = (n: number, c: ReturnType<typeof cust>, status: string, ageMin: number) => ({
  id: `lead-${n}`, lead_number: `L0000${n}`, status, created_at: new Date(T0 - ageMin * MIN).toISOString(), customer_id: c.id, customer: c,
  service_request: `Request ${n}`, contacted_at: null, walkthrough_first_booked_at: null, last_visit_completed_at: null,
  first_estimate_sent_at: null, won_at: null as string | null, lost_at: null, cancelled_at: null, commission_owner: null, service_location: null,
});
const L1 = lead(1, PAT, 'NEW', 30);
const L2 = lead(2, PAT, 'CONTACTED', 300);
const L3 = lead(3, KIM, 'NEW', 90);
const L4 = lead(4, NED, 'NEW', 1);
const L5 = lead(5, PAT, 'NEW', 1);
const OWNER: Record<number, string> = { 1: 'Pat Payer', 2: 'Pat Payer', 3: 'Kim Keeper', 4: 'Ned Newcomer', 5: 'Pat Payer' };
const asCustomer = (c: ReturnType<typeof cust>) => ({ ...c, service_locations: [] });

/** What the server's lists become while the person is away. */
const CHANGES = {
  /** A new lead, L00004, for a new customer, Ned. */
  ned: { leads: [L1, L2, L3, L4], customers: [PAT, KIM, NED].map(asCustomer) },
  /** A new lead, L00005, for a customer already listed, Pat. */
  pat5: { leads: [L1, L2, L3, L5], customers: [PAT, KIM].map(asCustomer) },
  /** L00002 is won (it leaves Spider's list) and Ned's L00004 arrives. */
  won2: { leads: [L1, { ...L2, status: 'WON', won_at: new Date(T0).toISOString() }, L3, L4], customers: [PAT, KIM, NED].map(asCustomer) },
};

let leadRows: unknown[];
let customerRows: unknown[];
let leadsFail: number | null;
let leadsDelay: number;
let settings = settingsBody(true, []);
let spiderSwitch = { isActive: true, isSetUp: true };

const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data: {} } });
const reads = (url: string) => mockApi.get.mock.calls.filter(([u]) => u === url).length;
const settingsPuts = () => mockApi.put.mock.calls.filter(([u]) => u === SETTINGS);
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The in-app enable from the alerts pop-up (it is not on the page), mounted beside the page. */
function EnableInApp() {
  const enable = useEnableSpiderInApp();
  return (
    <Button type="button" onClick={() => enable.mutate()}>
      test: enable in-app
    </Button>
  );
}

let client: QueryClient;
function mount() {
  const tree = (): ReactElement => (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={320}>
        <MemoryRouter>
          <SpiderPage />
          <EnableInApp />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return render(tree());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  leadRows = [L1, L2, L3];
  customerRows = [PAT, KIM].map(asCustomer);
  leadsFail = null;
  leadsDelay = 0;
  settings = settingsBody(true, []);
  spiderSwitch = { isActive: true, isSetUp: true };
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: ADMIN, isAuthenticated: true })) as never);
  client = new QueryClient({ defaultOptions: APP_DEFAULTS });
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === SETTINGS) return { data: settings };
    if (url === STATUS) return { data: spiderSwitch };
    if (url === LEADS) {
      const fail = leadsFail;
      const rows = leadRows;
      if (leadsDelay) await new Promise((r) => setTimeout(r, leadsDelay));
      if (fail) throw httpError(fail);
      return { data: { leads: rows } };
    }
    if (url === CUSTOMERS) return { data: { customers: customerRows } };
    if (url === '/api/users') return { data: { users: [] } };
    if (String(url).includes('/spider/history')) return { data: { total: 0, new_since: 0, items: [], recipients: [], customers: [] } };
    return { data: {} };
  });
  mockApi.post.mockImplementation(async () => ({ data: { items: [], total: 0, page: 1, page_size: 25, total_pages: 1 } }));
  mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
    if (url === STATUS) {
      spiderSwitch = { ...spiderSwitch, isActive: (body as { isActive: boolean }).isActive };
      return { data: spiderSwitch };
    }
    const b = body as { watch_all_leads: boolean; selected_lead_ids: string[] };
    settings = settingsBody(b.watch_all_leads, b.selected_lead_ids);
    return { data: settings };
  });
});

afterEach(() => {
  vi.useRealTimers();
  client.clear();
});

const settled = () => screen.findByText('Stage Thresholds', {}, { timeout: 4000 });

// ─── What a row's person does ───────────────────────────────────────────────

/** A lead's box, opening its customer first when the list shows another customer's leads. */
const leadBox = (n: number): HTMLElement => {
  const name = `Select lead L0000${n} for notifications`;
  const found = screen.queryByRole('checkbox', { name });
  if (found) return found;
  fireEvent.click(screen.getByRole('button', { name: `Toggle leads for ${OWNER[n]}` }));
  return screen.getByRole('checkbox', { name });
};
const custBox = (name: string) => screen.getByRole('checkbox', { name: `Select customer ${name} for watcher` });
const autoBox = () => screen.getByRole('checkbox', { name: 'Auto-select new leads created during active Spider session' });
const allLink = () => screen.getByText(/^(Select all|Deselect all)$/);
const click = async (el: Element) => {
  fireEvent.click(el);
  await pause(30);
};
const lead_ = (n: number) => () => click(leadBox(n));
const customer_ = (name: string) => () => click(custBox(name));
const autoBox_ = () => click(autoBox());
const allLink_ = () => click(allLink());

/** Save + confirm. `refused`: no save reaches the server and the existing failure toast shows. */
async function saveNow(refused = false) {
  const before = settingsPuts().length;
  fireEvent.click(screen.getByRole('button', { name: /^(Save|Saved)$/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Active' }));
  if (refused) {
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to Save Settings', expect.anything()), { timeout: 4000 });
    await pause(100);
    expect(settingsPuts().length).toBe(before);
    expect(toast).not.toHaveBeenCalledWith('Spider Agent Settings Saved', expect.anything());
    return;
  }
  await waitFor(() => expect(settingsPuts().length).toBe(before + 1), { timeout: 5000 });
  await pause(300);
}

/** Each lead's tick ('absent' when the list does not show it) and the Auto-select box. */
function ticks(...ns: number[]) {
  const out: Record<string, string> = {};
  for (const n of ns) {
    out[`L${n}`] = screen.queryByRole('button', { name: `Toggle leads for ${OWNER[n]}` })
      ? (leadBox(n).getAttribute('data-state') ?? 'none')
      : 'absent';
  }
  out.auto = autoBox().getAttribute('data-state') ?? 'none';
  return out;
}

// ─── The table ──────────────────────────────────────────────────────────────

type Body = { watch_all: boolean; ids: string[] };
const f = (...ns: number[]): Body => ({ watch_all: false, ids: ns.map((n) => `lead-${n}`) });
const t = (...ns: number[]): Body => ({ watch_all: true, ids: ns.map((n) => `lead-${n}`) });

interface Row {
  id: string;
  /** The saved settings at the first visit (default: Auto-select new leads on). */
  start?: { watchAll: boolean; ids: string[] };
  /** How the server's lists change while away (default `ned`; null: they do not). */
  change?: keyof typeof CHANGES | null;
  /** When the person comes back (default 2 minutes later, inside the window). */
  backAfter?: number;
  /** What the person does; saves are part of it. */
  act: () => Promise<unknown>;
  /** Every settings save the server received, in order (ids compared as sets). */
  saves: Body[];
  /** The exact list reads at the end, first visit included. */
  reads?: { leads: number; customers: number };
}

/** A plain visit: the person only looks. */
const stay = () => pause(100);
const LIST13 = { watchAll: false, ids: ['lead-1', 'lead-3'] };
let ticksSeen: Record<string, Record<string, string>> = {};

const ROWS: Row[] = [
  // Visits, and what does or does not read the lists (criteria 1 and 2).
  { id: 'V1 a plain visit inside the window', act: stay, saves: [], reads: { leads: 1, customers: 1 } },
  { id: 'V2 a visit after the window', backAfter: FRESH_MS + 1000, act: stay, saves: [], reads: { leads: 2, customers: 2 } },
  { id: 'V3 a settings save with no tick change re-reads both lists', act: () => saveNow(), saves: [t()], reads: { leads: 2, customers: 2 } },
  {
    id: 'V4 switching Spider off and on reads no list',
    act: async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Switch Spider on or off' }));
      fireEvent.click(await within(await screen.findByRole('alertdialog', { name: 'Turn off Spider?' })).findByRole('button', { name: 'Turn off' }));
      await screen.findByText('Turn it on to change its settings or see its history.');
      fireEvent.click(screen.getByRole('switch', { name: 'Switch Spider on or off' }));
      await settled();
      await pause(100);
    },
    saves: [],
    reads: { leads: 1, customers: 1 },
  },
  {
    id: 'V5 enabling in-app alerts reads no list',
    act: async () => {
      await click(screen.getByRole('button', { name: 'test: enable in-app' }));
      await waitFor(() => expect(settingsPuts().length).toBe(1));
      await pause(200);
    },
    saves: [t()],
    reads: { leads: 1, customers: 1 },
  },
  // Every way from "Auto-select new leads" into a list (the verifier's W rows).
  {
    id: 'W1 untick a lead',
    act: async () => {
      await lead_(1)();
      ticksSeen.before = ticks(1, 2, 3, 4);
      await saveNow();
      ticksSeen.after = ticks(1, 2, 3, 4);
      // Nothing is left unsaved: turning Spider off does not warn about lost changes.
      fireEvent.click(screen.getByRole('switch', { name: 'Switch Spider on or off' }));
      const off = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
      ticksSeen.after.unsavedWarning = String(/not saved will be lost/.test(off.textContent ?? ''));
    },
    saves: [f(2, 3, 4)],
    // the return reads nothing; the save reads the leads fresh once, then re-reads both lists
    reads: { leads: 3, customers: 2 },
  },
  { id: 'W2 untick a customer', act: async () => { await customer_('Kim Keeper')(); await saveNow(); }, saves: [f(1, 2, 4)] },
  { id: 'W3 untick the Auto-select box (F1)', act: async () => { await autoBox_(); await saveNow(); }, saves: [f(1, 2, 3, 4)] },
  { id: 'W4 Deselect all', act: async () => { await allLink_(); await saveNow(); }, saves: [f()] },
  { id: 'W5 Deselect all, then Select all', act: async () => { await allLink_(); await allLink_(); await saveNow(); }, saves: [f(1, 2, 3, 4)] },
  { id: 'W6 untick a lead, tick it again', act: async () => { await lead_(1)(); await lead_(1)(); await saveNow(); }, saves: [f(1, 2, 3, 4)] },
  { id: 'W7 untick a lead, then Auto-select on again', act: async () => { await lead_(1)(); await autoBox_(); await saveNow(); }, saves: [t(2, 3, 4)] },
  { id: 'W8 untick a lead, then Select all', act: async () => { await lead_(1)(); await allLink_(); await saveNow(); }, saves: [f(1, 2, 3, 4)] },
  { id: 'W9 untick every listed lead one by one (F3)', act: async () => { await lead_(1)(); await lead_(2)(); await lead_(3)(); await saveNow(); }, saves: [f(4)] },
  {
    id: 'W10 untick a lead and save, then untick another and save',
    act: async () => { await lead_(1)(); await saveNow(); await lead_(3)(); await saveNow(); },
    saves: [f(2, 3, 4), f(2, 4)],
  },
  { id: 'W11 untick the Auto-select box, then a lead (F1)', act: async () => { await autoBox_(); await lead_(1)(); await saveNow(); }, saves: [f(2, 3, 4)] },
  // From a saved list of leads (E rows).
  { id: 'E1 list: untick a lead', start: LIST13, act: async () => { await lead_(1)(); await saveNow(); }, saves: [f(3)], reads: { leads: 2, customers: 2 } },
  { id: 'E2 list: Select all', start: LIST13, act: async () => { await allLink_(); await saveNow(); }, saves: [f(1, 2, 3, 4)] },
  { id: 'E3 list: tick a lead', start: LIST13, act: async () => { await lead_(2)(); await saveNow(); }, saves: [f(1, 2, 3)] },
  { id: 'E4 list: Select all, then untick a lead', start: LIST13, act: async () => { await allLink_(); await lead_(2)(); await saveNow(); }, saves: [f(1, 3, 4)] },
  {
    id: 'R1 list: Select all, untick a lead, History and back, save',
    start: LIST13,
    act: async () => {
      await allLink_();
      await lead_(2)();
      fireEvent.click(screen.getByRole('tab', { name: 'History Tab' }));
      await pause(200);
      fireEvent.click(screen.getByRole('tab', { name: 'Configuration Tab' }));
      await settled();
      await pause(200);
      await saveNow();
    },
    saves: [f(1, 3, 4)],
  },
  // F2: the fresh read fails at save time -> the save is refused through the existing failure toast;
  // the draft stays, and the next save (the read works again) writes today's result.
  {
    id: 'F2 the lead list cannot be read at save time',
    act: async () => {
      await lead_(1)();
      leadsFail = 429;
      await saveNow(true);
      leadsFail = null;
      await saveNow();
    },
    saves: [f(2, 3, 4)],
  },
  // F4 (the verifier's I1a/I1b): an edit made while the save reads the list.
  {
    id: 'I1 an edit while the save reads the list, then a second save (F4)',
    act: async () => {
      await lead_(1)();
      leadsDelay = 400;
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Active' }));
      await pause(50);
      await lead_(2)();
      await waitFor(() => expect(settingsPuts().length).toBe(1), { timeout: 5000 });
      await pause(1000);
      leadsDelay = 0;
      await saveNow();
    },
    saves: [f(2, 3, 4), f(3, 4)],
  },
  {
    // After the first save the server holds a list, so a lead that arrives before the second save
    // is not added by the edit kept from during the first one (today: the kept edit is that list).
    id: 'I2 as I1, and Pat gains a lead before the second save (F4)',
    act: async () => {
      await lead_(1)();
      leadsDelay = 400;
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Active' }));
      await pause(50);
      await lead_(2)();
      await waitFor(() => expect(settingsPuts().length).toBe(1), { timeout: 5000 });
      await pause(1000);
      leadsDelay = 0;
      leadRows = [L1, L2, L3, L4, L5];
      await saveNow();
    },
    saves: [f(2, 3, 4), f(3, 4)],
  },
  // Further ways in: a new lead for a customer already listed, a lead that leaves the list, the box
  // off and on again.
  { id: 'X1 Pat gains a lead: untick customer Pat', change: 'pat5', act: async () => { await customer_('Pat Payer')(); await saveNow(); }, saves: [f(3)] },
  { id: 'X2 Pat gains a lead: list, tick customer Pat', change: 'pat5', start: LIST13, act: async () => { await customer_('Pat Payer')(); await saveNow(); }, saves: [f(1, 2, 3, 5)] },
  { id: 'X3 L00002 is won meanwhile: untick a lead', change: 'won2', act: async () => { await lead_(1)(); await saveNow(); }, saves: [f(3, 4)] },
  { id: 'X4 untick the Auto-select box, tick it again', act: async () => { await autoBox_(); await autoBox_(); await saveNow(); }, saves: [t(1, 2, 3, 4)] },
  { id: 'X5 nothing changed on the server: untick a lead', change: null, act: async () => { await lead_(1)(); await saveNow(); }, saves: [f(2, 3)] },
];

const sortedBodies = () =>
  settingsPuts().map(([, body]) => {
    const b = body as { watch_all_leads: boolean; selected_lead_ids: string[] };
    return { watch_all: b.watch_all_leads, ids: [...b.selected_lead_ids].sort() };
  });

describe("Spider's lists use the app's freshness rule, and every save writes what the server's current list gives", () => {
  it('has a freshness window to test against', () => {
    expect(FRESH_MS).toBeGreaterThan(1000);
  });

  it.each(ROWS)('$id', async (row) => {
    ticksSeen = {};
    const start = row.start ?? { watchAll: true, ids: [] };
    settings = settingsBody(start.watchAll, start.ids);
    // First visit: one request per list.
    const first = mount();
    await settled();
    await screen.findByRole('button', { name: 'Toggle leads for Pat Payer' });
    await pause(100);
    expect({ leads: reads(LEADS), customers: reads(CUSTOMERS) }).toEqual({ leads: 1, customers: 1 });
    first.unmount();

    const change = row.change === undefined ? 'ned' : row.change;
    if (change) {
      leadRows = CHANGES[change].leads;
      customerRows = CHANGES[change].customers;
    }
    vi.setSystemTime(T0 + (row.backAfter ?? 2 * MIN));
    mount();
    await settled();
    await screen.findByRole('button', { name: 'Toggle leads for Pat Payer' });
    await pause(100);

    await row.act();

    expect(sortedBodies()).toEqual(row.saves.map((b) => ({ ...b, ids: [...b.ids].sort() })));
    if (row.reads) expect({ leads: reads(LEADS), customers: reads(CUSTOMERS) }).toEqual(row.reads);
    if (row.id.startsWith('W1 ')) {
      // On screen: the cached list (no L00004) with L00001 unticked; after the save, today's screen.
      expect(ticksSeen.before).toEqual({ L1: 'unchecked', L2: 'checked', L3: 'checked', L4: 'absent', auto: 'unchecked' });
      expect(ticksSeen.after).toEqual({ L1: 'unchecked', L2: 'checked', L3: 'checked', L4: 'checked', auto: 'unchecked', unsavedWarning: 'false' });
    }
  });
});

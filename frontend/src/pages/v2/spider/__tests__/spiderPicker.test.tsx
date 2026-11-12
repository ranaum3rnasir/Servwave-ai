/**
 * #3436 - "Select Contacts for Alert" as mockup M2 draws it: a picker the server searches and pages, with Exclude and
 * Include again, whose ticks wait for the page's one Save (Ran, 10 Nov: Q4 A, Q5 A, the words Exclude / Excluded /
 * Include again). The page never downloads the whole lead or customer list: opening it makes the same six requests at
 * any company size (three of them the picker's), opening a customer one. The API is faked at axios. The tests about
 * size give the company 120 customers with open leads; the rest give it 5, so each test stays quick.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/ui-kit/components/ui/sonner';
import SpiderPage from '../SpiderPage';
import { SPIDER_WATCHING_HELP } from '../SpiderLeadPicker';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) };
});

const mockApi = vi.mocked(api);
const BASE = '/api/ai-farm/spider';
const SETTINGS = `${BASE}/settings`;
const STATUS = `${BASE}/status`;
const OVERVIEW = `${BASE}/overview`;
const CUSTOMERS = `${BASE}/customers`;
const EXCLUDED = `${BASE}/excluded`;
const EXCLUSIONS = `${BASE}/exclusions`;
const PREVIEW = `${BASE}/activation-preview`;
const leadsOf = (customerId: string) => `${CUSTOMERS}/${customerId}/leads`;

const ADMIN = { id: 'u1', role: 'ADMIN', is_admin: true, organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };
function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const LIMIT_OFF = { enabled: false, value: 1, unit: 'MINUTE' };
const settingsBody = (isActive: boolean) => ({
  settings: {
    is_active: isActive,
    activated_at: null,
    status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: LIMIT_OFF, WALKTHROUGH_COMPLETED: LIMIT_OFF },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true },
    updated_at: null,
  },
  options: { statuses: [], units: [], roles: [] },
});

/** Customers with open leads, newest first, as the server pages them (50 a page). The first is mockup M2's. */
const TOTAL_CUSTOMERS = 120;
let customerCount = 5;
const customerRow = (i: number) =>
  i === 0
    ? { id: 'c-0', name: 'Brookline Plumbing', company_name: null, email: 'office@brooklineplumbing.example', open_leads: 3, excluded_leads: 1 }
    : { id: `c-${i}`, name: `Customer ${String(i).padStart(3, '0')}`, company_name: null, email: `c${i}@example.test`, open_leads: 1, excluded_leads: 0 };

const BROOKLINE_LEADS = [
  { id: 'l-24113', lead_number: 'L24113', status: 'NEW', stage: 'NEW', stage_entered_at: ago(2 * HOUR + 60_000), owner_name: 'Dana Cole', address: '48 Elm Street, Springfield', excluded: false },
  { id: 'l-24090', lead_number: 'L24090', status: 'CONTACTED', stage: 'CONTACTED', stage_entered_at: ago(3 * DAY + 60_000), owner_name: 'Dana Cole', address: null, excluded: true },
  { id: 'l-23977', lead_number: 'L23977', status: 'WALKTHROUGH_SCHEDULED', stage: null, stage_entered_at: null, owner_name: 'Sam Rivera', address: null, excluded: false },
];
const leadsFor = (customerId: string) =>
  customerId === 'c-0'
    ? BROOKLINE_LEADS
    : [{ id: `l-${customerId}`, lead_number: `L9${customerId.slice(2).padStart(4, '0')}`, status: 'NEW', stage: 'NEW', stage_entered_at: ago(HOUR), owner_name: null, address: null, excluded: false }];

let spiderSwitch = { isActive: false, isSetUp: true };
let overviewBody = { watched: 2287, excluded: 13 };
let patchFails = false;
/** Every request, in order, as "METHOD url[?query]". */
let calls: string[] = [];

const query = (config?: { params?: Record<string, string> }) => {
  const p = new URLSearchParams(config?.params ?? {}).toString();
  return p ? `?${p}` : '';
};

/** The end-of-list watchers the page made, so a test can scroll a list to its end. */
let watchers: Array<{ cb: IntersectionObserverCallback; targets: Element[]; live: boolean }> = [];
class FakeIntersectionObserver {
  private w: (typeof watchers)[number];
  constructor(cb: IntersectionObserverCallback) {
    this.w = { cb, targets: [], live: true };
    watchers.push(this.w);
  }
  observe(el: Element) {
    this.w.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.w.live = false;
  }
  takeRecords() {
    return [];
  }
}
/** Brings the customers list's end into view. */
function scrollToEnd() {
  act(() => {
    for (const w of watchers.filter((x) => x.live)) {
      w.cb(w.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver);
    }
  });
}

beforeEach(() => {
  spiderSwitch = { isActive: false, isSetUp: true };
  overviewBody = { watched: 2287, excluded: 13 };
  patchFails = false;
  customerCount = 5;
  calls = [];
  watchers = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  localStorage.clear();
  vi.clearAllMocks();
  signIn(ADMIN);
  mockApi.get.mockImplementation((async (url: string, config?: { params?: Record<string, string> }) => {
    calls.push(`GET ${url}${query(config)}`);
    if (url === SETTINGS) return { data: settingsBody(spiderSwitch.isActive) };
    if (url === STATUS) return { data: spiderSwitch };
    if (url === OVERVIEW) return { data: overviewBody };
    if (url === PREVIEW) return { data: { watchedLeads: overviewBody.watched, excludedLeads: overviewBody.excluded, pastLimitLeads: 0, summaryRecipients: 1 } };
    if (url === CUSTOMERS) {
      const q = (config?.params?.q ?? '').toLowerCase();
      const matching = Array.from({ length: customerCount }, (_, i) => customerRow(i)).filter((c) => c.name.toLowerCase().includes(q));
      const start = config?.params?.cursor ? Number(config.params.cursor) : 0;
      const page = matching.slice(start, start + 50);
      return {
        data: { customers: page, next_cursor: start + 50 < matching.length ? String(start + 50) : null, ...(q ? { total: matching.length } : {}) },
      };
    }
    const own = url.match(/\/customers\/([^/]+)\/leads$/);
    if (own) return { data: { leads: leadsFor(own[1]!), next_cursor: null } };
    if (url === EXCLUDED) {
      return {
        data: {
          leads: [{ id: 'l-24090', lead_number: 'L24090', status: 'CONTACTED', stage: 'CONTACTED', stage_entered_at: ago(3 * DAY + 60_000), customer_id: 'c-0', customer_name: 'Brookline Plumbing', customer_company_name: null }],
          next_cursor: null,
        },
      };
    }
    if (url === '/api/users') return { data: { users: [] } };
    return { data: {} };
  }) as never);
  mockApi.post.mockImplementation(async (url: string) => {
    calls.push(`POST ${url}`);
    return { data: {} };
  });
  mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
    calls.push(`PUT ${url}`);
    if (url === STATUS) {
      spiderSwitch = { ...spiderSwitch, isActive: (body as { isActive: boolean }).isActive };
      return { data: spiderSwitch };
    }
    return { data: settingsBody(spiderSwitch.isActive) };
  });
  mockApi.patch.mockImplementation(async (url: string, body?: unknown) => {
    calls.push(`PATCH ${url}`);
    if (patchFails) throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: 'Could not save the excluded leads' } } });
    const b = body as { exclude: string[]; include: string[] };
    overviewBody = { watched: overviewBody.watched - b.exclude.length + b.include.length, excluded: overviewBody.excluded + b.exclude.length - b.include.length };
    return { data: overviewBody };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const picker = () => document.querySelector<HTMLElement>('[data-spider-picker]')!;
const customer = (id: string) => document.querySelector<HTMLElement>(`[data-spider-customer="${id}"]`)!;

async function openPage() {
  renderWithProviders(<SpiderPage />);
  await screen.findByText('Brookline Plumbing');
  await within(picker()).findByText('2,287');
}

async function openBrookline() {
  fireEvent.click(within(customer('c-0')).getByRole('button', { name: 'Toggle leads for Brookline Plumbing' }));
  await within(customer('c-0')).findByText('L24113');
}

const leadBox = (n: string) => within(picker()).getByRole('checkbox', { name: `Lead ${n}` });
const unsavedLine = () => document.querySelector('[data-spider-unsaved-ticks]');
const patches = () => mockApi.patch.mock.calls.filter(([u]) => u === EXCLUSIONS).map(([, b]) => b);

describe('opening the page reads a page, never the whole list', () => {
  it('makes the same six requests at any company size, and nothing else: the picker reads the settings, the header numbers and the first 50 customers', async () => {
    customerCount = TOTAL_CUSTOMERS;
    await openPage();
    // Let anything the page would still ask for go out before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Every GET the page makes on open, picker or not, so a new request on page open fails here. Three are the picker's
    // (settings, overview, customers); the status, the History badge and the people list are the page's own.
    const PAGE_OPEN_GETS = [`GET ${STATUS}`, `GET ${BASE}/history/summary`, 'GET /api/users', `GET ${OVERVIEW}`, `GET ${SETTINGS}`, `GET ${CUSTOMERS}`];
    expect(calls.filter((c) => c.startsWith('GET ')).sort()).toEqual([...PAGE_OPEN_GETS].sort());
    // The whole-list downloads are gone: no /api/leads and no /api/customers, at any size.
    expect(calls.filter((c) => /GET \/api\/(leads|customers)/.test(c))).toEqual([]);
    expect(document.querySelectorAll('[data-spider-customer]')).toHaveLength(50);
  });

  it('opening a customer makes one request, and shows its leads as the mockup draws them', async () => {
    await openPage();
    const before = calls.length;
    await openBrookline();
    expect(calls.slice(before)).toEqual([`GET ${leadsOf('c-0')}`]);
    const row = (n: string) => within(customer('c-0')).getByText(n).closest<HTMLElement>('[data-spider-lead]')!;
    expect(within(row('L24113')).getByText('New')).toBeInTheDocument();
    expect(within(row('L24113')).getByText('2 Hours in stage')).toBeInTheDocument();
    expect(within(row('L24113')).getByText('48 Elm Street, Springfield')).toBeInTheDocument();
    expect(within(row('L24113')).getByText('Dana Cole')).toBeInTheDocument();
    expect(within(row('L24090')).getByText('Contacted')).toBeInTheDocument();
    expect(within(row('L24090')).getByText('3 Days in stage')).toBeInTheDocument();
    expect(within(row('L24090')).getByText('Excluded')).toBeInTheDocument();
    expect(within(row('L23977')).getByText('Walkthrough Scheduled')).toBeInTheDocument();
    expect(within(row('L24113')).queryByText('Excluded')).toBeNull();
    expect(leadBox('L24113')).toBeChecked();
    expect(leadBox('L24090')).not.toBeChecked();
    // The client-side overdue chips are gone: nothing is counted in the browser.
    expect(within(picker()).queryByText(/\d+ alerts?$|Alert: Overdue/)).toBeNull();
  });
});

describe('the picker as mockup M2 draws it', () => {
  it('header line with its ? hover, the Customers and Excluded tabs, and a customer row with its email, chips and dash', async () => {
    await openPage();
    const count = document.querySelector<HTMLElement>('[data-spider-picker-count]')!;
    expect(count).toHaveTextContent('Watching 2,287 open leads · 13 excluded');
    fireEvent.click(within(count).getByRole('button', { name: 'How watching works' }));
    expect(await screen.findByText(SPIDER_WATCHING_HELP)).toBeInTheDocument();
    expect(SPIDER_WATCHING_HELP).toBe('Every open lead is watched, new ones included. Exclude a lead or a whole customer to leave it out.');
    // "Auto-select new leads" and "Select all / Deselect all" are gone.
    for (const gone of [/Auto-select/i, /Select all/, /Deselect all/]) expect(within(picker()).queryByText(gone)).toBeNull();

    expect(within(picker()).getByRole('tab', { name: 'Customers' })).toHaveAttribute('aria-selected', 'true');
    expect(within(picker()).getByRole('tab', { name: /^Excluded\s*13$/ })).toBeInTheDocument();
    expect(within(picker()).getByText('Name, company, lead # or phone')).toBeInTheDocument();

    const row = customer('c-0');
    expect(within(row).getByText('office@brooklineplumbing.example')).toBeInTheDocument();
    expect(within(row).getByText('3 leads')).toBeInTheDocument();
    expect(within(row).getByText('1 excluded')).toBeInTheDocument();
    // Some of its leads are excluded: the box shows a dash.
    expect(within(row).getByRole('checkbox', { name: 'Customer Brookline Plumbing' })).toHaveAttribute('aria-checked', 'mixed');
    expect(within(customer('c-1')).getByText('1 lead')).toBeInTheDocument();
    expect(within(customer('c-1')).getByRole('checkbox', { name: 'Customer Customer 001' })).toBeChecked();

    // "13 excluded" opens the Excluded tab.
    fireEvent.click(within(count).getByRole('button', { name: '13 excluded' }));
    expect(await within(picker()).findByText('Contacted · 3 Days in stage')).toBeInTheDocument();
    expect(within(picker()).getByRole('tab', { name: /^Excluded\s*13$/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(picker()).getByRole('button', { name: 'Include again' })).toBeInTheDocument();
    expect(within(picker()).getByPlaceholderText('Search excluded leads')).toBeInTheDocument();
  });

  it('never says "unticked", and names no vendor', async () => {
    await openPage();
    await openBrookline();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/untick/i);
    expect(text).not.toMatch(/CallTrackingMetrics|\bCTM\b|Supabase|Render\b/);
  });
});

describe('the list scales: its own scroll, 50 at a time, search on the server once typing pauses', () => {
  it('scrolls on its own and loads the next 50 as the end comes into view, past 100 customers', async () => {
    customerCount = TOTAL_CUSTOMERS;
    await openPage();
    const list = document.querySelector<HTMLElement>('[data-spider-picker-list]')!;
    expect(list.className).toMatch(/overflow-y-auto/);
    expect(list.className).toMatch(/max-h-/);
    expect(within(list).getByText('Loading more customers')).toBeInTheDocument();
    scrollToEnd();
    await waitFor(() => expect(document.querySelectorAll('[data-spider-customer]')).toHaveLength(100));
    scrollToEnd();
    await waitFor(() => expect(document.querySelectorAll('[data-spider-customer]')).toHaveLength(TOTAL_CUSTOMERS));
    expect(calls.filter((c) => c.startsWith(`GET ${CUSTOMERS}`) && !c.includes('/leads'))).toEqual([
      `GET ${CUSTOMERS}`,
      `GET ${CUSTOMERS}?cursor=50`,
      `GET ${CUSTOMERS}?cursor=100`,
    ]);
    // The last page is in: no more loading line.
    expect(within(list).queryByText('Loading more customers')).toBeNull();
  });

  it('sends the search to the server once, after typing pauses', async () => {
    await openPage();
    const box = within(picker()).getByPlaceholderText('Search customers');
    for (const v of ['b', 'br', 'bro']) fireEvent.change(box, { target: { value: v } });
    await waitFor(() => expect(calls).toContain(`GET ${CUSTOMERS}?q=bro`));
    expect(calls.filter((c) => c.startsWith(`GET ${CUSTOMERS}?q=`))).toEqual([`GET ${CUSTOMERS}?q=bro`]);
    await waitFor(() => expect(document.querySelectorAll('[data-spider-customer]')).toHaveLength(1));
    // Mockup M2's count of every match, for the search the server answered (one is singular).
    expect(document.querySelector('[data-spider-search-total]')).toHaveTextContent('1 customer with open leads matches "bro"');
    fireEvent.change(box, { target: { value: 'customer' } });
    await waitFor(() =>
      expect(document.querySelector('[data-spider-search-total]')).toHaveTextContent('4 customers with open leads match "customer"'),
    );
    // No search, no count.
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(document.querySelectorAll('[data-spider-customer]')).toHaveLength(5));
    expect(document.querySelector('[data-spider-search-total]')).toBeEmptyDOMElement();
  });
});

describe('ticks wait for Save, and the one Save sends them (Q4 A)', () => {
  it('excluding a lead shows "Excluded" and "1 change not saved.", and Save sends the settings, then one PATCH; while Not active nothing starts', async () => {
    await openPage();
    await openBrookline();
    fireEvent.click(leadBox('L24113'));
    const row = within(customer('c-0')).getByText('L24113').closest<HTMLElement>('[data-spider-lead]')!;
    expect(within(row).getByText('Excluded')).toBeInTheDocument();
    expect(unsavedLine()).toHaveTextContent('1 change not saved. Ticks count when you press Save.');
    expect(within(customer('c-0')).getByText('2 excluded')).toBeInTheDocument();
    // Nothing is sent until Save.
    expect(mockApi.patch).not.toHaveBeenCalled();
    // Ticking it back is no change.
    fireEvent.click(leadBox('L24113'));
    expect(unsavedLine()).toBeNull();
    fireEvent.click(leadBox('L24113'));
    fireEvent.click(leadBox('L24090'));
    expect(unsavedLine()).toHaveTextContent('2 changes not saved. Ticks count when you press Save.');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ exclude: ['l-24113'], include: ['l-24090'] });
    // The settings first, then the ticks; no review and no activation while Not active.
    expect(calls.filter((c) => c.startsWith('PUT') || c.startsWith('PATCH'))).toEqual([`PUT ${SETTINGS}`, `PATCH ${EXCLUSIONS}`]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(unsavedLine()).toBeNull());
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });

  it('a Save with no ticks changed sends no PATCH', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toContain(`PUT ${SETTINGS}`));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('ticking a customer with a dash ticks all its leads; unticking a customer whose leads are not open reads them once and excludes them all', async () => {
    await openPage();
    await openBrookline();
    fireEvent.click(within(customer('c-0')).getByRole('checkbox', { name: 'Customer Brookline Plumbing' }));
    expect(leadBox('L24090')).toBeChecked();
    expect(within(customer('c-0')).queryByText(/excluded/)).toBeNull();
    expect(within(customer('c-0')).getByRole('checkbox', { name: 'Customer Brookline Plumbing' })).toBeChecked();

    const before = calls.length;
    fireEvent.click(within(customer('c-1')).getByRole('checkbox', { name: 'Customer Customer 001' }));
    await waitFor(() => expect(within(customer('c-1')).getByText('1 excluded')).toBeInTheDocument());
    expect(calls.slice(before)).toEqual([`GET ${leadsOf('c-1')}`]);
    expect(within(customer('c-1')).getByRole('checkbox', { name: 'Customer Customer 001' })).not.toBeChecked();
    expect(unsavedLine()).toHaveTextContent('2 changes not saved.');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toEqual([{ exclude: ['l-c-1'], include: ['l-24090'] }]));
  });

  it('Include again puts an excluded lead back on Save', async () => {
    await openPage();
    fireEvent.click(within(picker()).getByRole('tab', { name: /^Excluded\s*13$/ }));
    fireEvent.click(await within(picker()).findByRole('button', { name: 'Include again' }));
    expect(unsavedLine()).toHaveTextContent('1 change not saved.');
    // Its customer's row follows at once, though the customer was never opened: no "1 excluded", box ticked.
    fireEvent.click(within(picker()).getByRole('tab', { name: 'Customers' }));
    await waitFor(() => expect(within(customer('c-0')).getByRole('checkbox', { name: 'Customer Brookline Plumbing' })).toHaveAttribute('aria-checked', 'true'));
    expect(within(customer('c-0')).queryByText(/excluded/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toEqual([{ exclude: [], include: ['l-24090'] }]));
    // The header shows what the server now holds.
    await waitFor(() => expect(document.querySelector('[data-spider-picker-count]')).toHaveTextContent('Watching 2,288 open leads · 12 excluded'));
  });

  it('a failed PATCH says so and keeps the ticks as changes not saved', async () => {
    patchFails = true;
    await openPage();
    await openBrookline();
    fireEvent.click(leadBox('L24113'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(unsavedLine()).toHaveTextContent('1 change not saved.');
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
    // The settings were saved (final review L2): never "Failed to Save Settings", the server's sentence as the reason.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Settings saved, but the lead changes did not save. Try again.',
        expect.objectContaining({ description: 'Could not save the excluded leads' }),
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith('Failed to Save Settings', expect.anything());
  });

  it('while Active, Save opens the review counting the leads watched after the ticks, and confirming sends the settings then the ticks', async () => {
    spiderSwitch = { isActive: true, isSetUp: true };
    await openPage();
    await openBrookline();
    fireEvent.click(leadBox('L24113'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    expect(within(dialog).getByText('2,286 leads')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toEqual([{ exclude: ['l-24113'], include: [] }]));
    expect(calls.filter((c) => c.startsWith('PUT') || c.startsWith('PATCH'))).toEqual([`PUT ${SETTINGS}`, `PATCH ${EXCLUSIONS}`]);
  });

  it('Activate with ticks not saved saves them first, so the review counts what was saved', async () => {
    await openPage();
    await openBrookline();
    fireEvent.click(leadBox('L24113'));
    const header = document.querySelector<HTMLElement>('[data-spider-status-actions]')!;
    fireEvent.click(await within(header).findByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    await within(dialog).findByText(/Spider watches/);
    const order = calls.filter((c) => c === `PUT ${SETTINGS}` || c === `PATCH ${EXCLUSIONS}` || c === `GET ${PREVIEW}`);
    expect(order).toEqual([`PUT ${SETTINGS}`, `PATCH ${EXCLUSIONS}`, `GET ${PREVIEW}`]);
    expect(within(dialog).getByText('2,286 open leads')).toBeInTheDocument();
    expect(calls).not.toContain(`PUT ${STATUS}`);
  });
});

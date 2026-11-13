/**
 * Spider's starting summary (#2794) on screen, as Ran approved it in the demo (starting-summary-demo-v3,
 * 17 Oct): the "Starting summary" card on the Spider page (placement A), the summary page every role
 * may open, its status filter, "Moved on", Download CSV, the bell entry that opens it, and History's
 * "In starting summary" tag. The API is faked at axios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { Outlet, Route, Routes, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { exportCsvFile } from '@/lib/csv';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import type { NotificationView } from '@/lib/api/notifications';
import { spiderV2Routes } from '../../routes/spider.routes';
import SpiderPage from '../SpiderPage';
import SpiderSummaryPage from '../SpiderSummaryPage';
import { SpiderHistory } from '../SpiderHistory';
import { useSpiderLiveUpdates } from '@/lib/api/spider';
import { closeLiveLine } from '@/lib/live/liveLine';
import { fakeLiveLine } from '@/__tests__/harness/fakeLiveLine';

vi.mock('@/lib/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csv')>();
  return { ...actual, exportCsvFile: vi.fn() };
});
// The app's layout is not what these tests are about: the route tree renders straight into the page.
vi.mock('../../V2AppLayout', () => ({ default: () => <Outlet /> }));

const mockApi = vi.mocked(api);
const STATUS = '/api/ai-farm/spider/status';
const SETTINGS = '/api/ai-farm/spider/settings';
const MINE = '/api/ai-farm/spider/summary';
const COMPANY = '/api/ai-farm/spider/summary/company';

const ADMIN = { id: 'u1', role: 'ADMIN', is_admin: true, organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };
const SALES = { ...ADMIN, id: 'u2', role: 'SALES', is_admin: false };

function signIn(user: Record<string, unknown>) {
  const state = { user, isAuthenticated: true, isLoading: false };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(state) : state) as never);
}

const MADE = '2026-10-14T18:12:00.000Z';
const LEADS = [
  {
    lead_id: 'lead-1', lead_number: 'L-1031', customer_name: 'Hannah Brooks', address: '418 Elm St', stage: 'NEW', stage_name: 'New',
    entered_stage_at: '2026-09-25T18:12:00.000Z', in_stage: '19 days', limit: '5 days', over_by: '14 days', owner_name: 'Maya Ortiz',
    moved_on: false, moved_to: null,
  },
  {
    lead_id: 'lead-2', lead_number: 'L-1037', customer_name: 'Westfield Dental Group', address: '90 Market Ave', stage: 'CONTACTED',
    stage_name: 'Contacted', entered_stage_at: '2026-10-03T18:12:00.000Z', in_stage: '11 days', limit: '3 days', over_by: '8 days',
    owner_name: null, moved_on: true, moved_to: 'Walkthrough Scheduled',
  },
  {
    lead_id: 'lead-3', lead_number: 'L-1063', customer_name: 'Daniel Reyes', address: '9 Ridge Rd', stage: 'NEW', stage_name: 'New',
    entered_stage_at: '2026-10-14T12:12:00.000Z', in_stage: '6 hours', limit: '1 hour', over_by: '5 hours', owner_name: 'Maya Ortiz',
    moved_on: true, moved_to: 'Contacted',
  },
];
const SUMMARY = {
  id: 's1', created_at: MADE, triggered_at: '2026-10-14T18:10:00.000Z', trigger_kind: 'SWITCHED_ON', scope: 'company',
  show_owner: true, total: 3, still_waiting: 1, moved_on: 2, leads: LEADS,
};
const MY_SUMMARY = { ...SUMMARY, scope: 'mine', show_owner: false, total: 2, still_waiting: 1, moved_on: 1, leads: [LEADS[0], LEADS[2]] };

let companyAnswer: () => Promise<unknown>;
let mineAnswer: () => Promise<unknown>;
let spiderOn = true;
const notFound = () => Promise.reject(Object.assign(new Error('Not found'), { response: { status: 404 } }));
const callsTo = (url: string) => mockApi.get.mock.calls.filter(([u]) => u === url).length;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn(ADMIN);
  spiderOn = true;
  companyAnswer = async () => ({ data: { summary: SUMMARY } });
  mineAnswer = async () => ({ data: { summary: MY_SUMMARY } });
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === STATUS) return { data: { isActive: spiderOn, isSetUp: true } };
    if (url === COMPANY) return companyAnswer();
    if (url === MINE) return mineAnswer();
    if (url === SETTINGS) {
      return {
        data: {
          settings: {
            is_active: true, activated_at: null,
            status_limits: { NEW: { enabled: true, value: 1, unit: 'HOUR' }, CONTACTED: { enabled: false, value: 1, unit: 'MINUTE' }, WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'MINUTE' } },
            channels: { in_app: true, red_frame: true, email: true, text: true },
            recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: true },
            updated_at: null,
          },
          options: { statuses: [], units: [], roles: [] },
        },
      };
    }
    if (url === '/api/ai-farm/spider/overview') return { data: { watched: 0, excluded: 0 } };
    if (url === '/api/ai-farm/spider/customers') return { data: { customers: [], next_cursor: null } };
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } });
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

// ─── The Spider page's card (placement A) ────────────────────────────────────

describe('the Starting summary card on the Spider page', () => {
  it('sits directly under the header card with the status, above Configuration | History, with its date, sentence and two actions', async () => {
    renderWithProviders(<SpiderPage />);
    const card = (await screen.findByText('Starting summary')).closest('[data-spider-starting-summary]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('3 leads were already past their limit when Spider started watching. 1 is still waiting.')).toBeInTheDocument();
    expect(within(card).getByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 1[45] Oct, \d{1,2}:12 (AM|PM)$/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();

    const theStatus = screen.getByText('Active', { selector: '[data-agent-chip]' });
    const tabs = screen.getAllByRole('tablist')[0]!;
    expect(theStatus.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(callsTo(COMPANY)).toBe(1);
  });

  it('is not there with no summary, nor against a server from before the summary', async () => {
    companyAnswer = async () => ({ data: { summary: null } });
    const { unmount } = renderWithProviders(<SpiderPage />);
    await screen.findAllByRole('tablist');
    await waitFor(() => expect(callsTo(COMPANY)).toBe(1));
    expect(screen.queryByText('Starting summary')).toBeNull();
    unmount();

    companyAnswer = notFound;
    renderWithProviders(<SpiderPage />);
    await screen.findAllByRole('tablist');
    await waitFor(() => expect(callsTo(COMPANY)).toBe(2));
    expect(screen.queryByText('Starting summary')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is not there while Spider is Not active: the summary is not even asked for', async () => {
    spiderOn = false;
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByText('Not active', { selector: '[data-agent-chip]' })).toBeInTheDocument();
    await screen.findAllByRole('tablist');
    expect(screen.queryByText('Starting summary')).toBeNull();
    expect(callsTo(COMPANY)).toBe(0);
  });

  // #3472: the card follows a summary made while the page is open, without the page being reloaded.
  it('reads the summary again when the window comes back into focus', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Starting summary');
    expect(callsTo(COMPANY)).toBe(1);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(callsTo(COMPANY)).toBe(2));
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it('reads the summary again when the live line says one is ready', async () => {
    const live = fakeLiveLine();
    function LiveLine() {
      useSpiderLiveUpdates();
      return null;
    }
    try {
      renderWithProviders(
        <>
          <SpiderPage />
          <LiveLine />
        </>,
      );
      await screen.findByText('Starting summary');
      await waitFor(() => expect(live.fetchMock).toHaveBeenCalledTimes(1));
      expect(callsTo(COMPANY)).toBe(1);
      // The re-read waits a random 0-3 s; at its shortest here.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      live.send('spider.summary.ready', {});
      await waitFor(() => expect(callsTo(COMPANY)).toBe(2));
      random.mockRestore();
    } finally {
      closeLiveLine();
      vi.unstubAllGlobals();
    }
  });

  it('View opens the company-wide summary', async () => {
    renderWithProviders(
      <>
        <SpiderPage />
        <Where />
      </>,
      { initialEntries: ['/spider'] },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/spider/summary?scope=company');
  });

  it("Download CSV saves the whole company's list, read again so \"Now\" is as of the download", async () => {
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(exportCsvFile).toHaveBeenCalledTimes(1));
    expect(callsTo(COMPANY)).toBe(2);
    const [name, header, rows] = vi.mocked(exportCsvFile).mock.calls[0]!;
    expect(name).toMatch(/^spider-starting-summary-2026-10-1[45]\.csv$/);
    expect(header).toEqual([
      'Lead', 'Customer', 'Address', 'Status then', 'Entered that status', 'Time in status', 'Limit', 'Over the limit by', 'Owner', 'Now', 'Link',
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([
      'L-1031', 'Hannah Brooks', '418 Elm St', 'New', expect.stringMatching(/^Sep 2[45], \d{1,2}:12 (AM|PM)$/), '19 days', '5 days', '14 days',
      'Maya Ortiz', 'Still waiting', `${window.location.origin}/leads/lead-1`,
    ]);
    expect(rows[1]![8]).toBe('');
    expect(rows[1]![9]).toBe('Moved on to Walkthrough Scheduled');
  });
});

// ─── The summary page ────────────────────────────────────────────────────────

describe('the starting summary page', () => {
  it("shows a salesperson their own leads: made when, the counts, each lead's status then, how far over, and Now", async () => {
    signIn(SALES);
    renderWithProviders(<SpiderSummaryPage />, { initialEntries: ['/spider/summary'] });
    expect(await screen.findByRole('heading', { level: 1, name: "Spider's starting summary" })).toBeInTheDocument();
    expect(await screen.findByText(/^Your leads · made (Mon|Tue|Wed|Thu|Fri|Sat|Sun) 1[45] Oct, \d{1,2}:12 (AM|PM), when Spider was turned on$/)).toBeInTheDocument();
    expect(callsTo(MINE)).toBe(1);
    expect(callsTo(COMPANY)).toBe(0);

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Lead', 'Customer', 'Status then', 'Over the limit by', 'Now',
    ]);
    const first = within(table).getByRole('link', { name: 'Open lead L-1031' }).closest('tr') as HTMLElement;
    expect(first).toHaveTextContent('Hannah Brooks');
    expect(first).toHaveTextContent('418 Elm St');
    expect(first).toHaveTextContent('14 days over');
    expect(first).toHaveTextContent('In status 19 days · limit 5 days');
    expect(within(first).getByText('Still waiting')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Open lead L-1031' })).toHaveAttribute('href', '/leads/lead-1');
    const moved = within(table).getByRole('link', { name: 'Open lead L-1063' }).closest('tr') as HTMLElement;
    expect(within(moved).getByText('Moved on to Contacted')).toBeInTheDocument();
    expect(moved).toHaveAttribute('data-moved-on', 'true');

    const meta = screen.getByText('past their limit').parentElement as HTMLElement;
    expect(meta).toHaveTextContent('2 past their limit');
    expect(meta).toHaveTextContent('1 still waiting');
    expect(meta).toHaveTextContent('1 moved on since');
  });

  it('filters by status with chips for the stages in it, with their counts', async () => {
    renderWithProviders(<SpiderSummaryPage />, { initialEntries: ['/spider/summary?scope=company'] });
    const chips = within(await screen.findByRole('group', { name: 'Filter by status' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['All3', 'New2', 'Contacted1']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(chips[2]!);
    expect(chips[2]).toHaveAttribute('aria-pressed', 'true');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('link').map((l) => l.textContent)).toEqual(['L-1037']);
    fireEvent.click(chips[0]!);
    expect(within(table).getAllByRole('link')).toHaveLength(3);
  });

  it('gives an Admin from the card the whole company, with the Owner column; anyone else reads their own', async () => {
    const { unmount } = renderWithProviders(<SpiderSummaryPage />, { initialEntries: ['/spider/summary?scope=company'] });
    expect(await screen.findByText(/^Whole company · made /)).toBeInTheDocument();
    expect(callsTo(COMPANY)).toBe(1);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Owner' })).toBeInTheDocument();
    expect(within(table).getByText('No owner')).toBeInTheDocument();
    unmount();

    signIn(SALES);
    renderWithProviders(<SpiderSummaryPage />, { initialEntries: ['/spider/summary?scope=company'] });
    expect(await screen.findByText(/^Your leads · made /)).toBeInTheDocument();
    expect(callsTo(COMPANY)).toBe(1);
    expect(callsTo(MINE)).toBe(1);
  });

  it('says there is no starting summary when there is none, and quietly against a server from before it', async () => {
    mineAnswer = async () => ({ data: { summary: null } });
    const { unmount } = renderWithProviders(<SpiderSummaryPage />);
    expect(await screen.findByText("There's no starting summary")).toBeInTheDocument();
    expect(screen.getByText('Nothing was past its limit when Spider was turned on.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
    unmount();

    mineAnswer = notFound;
    renderWithProviders(<SpiderSummaryPage />);
    expect(await screen.findByText("There's no starting summary")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so, with Try again, when the summary cannot be read', async () => {
    mineAnswer = () => Promise.reject(Object.assign(new Error('boom'), { response: { status: 500 } }));
    renderWithProviders(<SpiderSummaryPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the starting summary.');
    mineAnswer = async () => ({ data: { summary: MY_SUMMARY } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it("Download CSV saves this person's own leads, as of now", async () => {
    signIn(SALES);
    renderWithProviders(<SpiderSummaryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(exportCsvFile).toHaveBeenCalledTimes(1));
    expect(callsTo(MINE)).toBe(2);
    const rows = vi.mocked(exportCsvFile).mock.calls[0]![2];
    expect(rows.map((r) => r[0])).toEqual(['L-1031', 'L-1063']);
    expect(rows[1]![9]).toBe('Moved on to Contacted');
  });

  it('on a phone, each lead is a block with the same fields (the table is for wider screens)', async () => {
    renderWithProviders(<SpiderSummaryPage />, { initialEntries: ['/spider/summary?scope=company'] });
    const list = await screen.findByRole('list', { name: 'Leads in the starting summary' });
    expect(list.className).toContain('md:hidden');
    expect(screen.getByRole('table').className).toContain('hidden md:table');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent('Westfield Dental Group');
    expect(items[1]).toHaveTextContent('Status then: Contacted');
    expect(items[1]).toHaveTextContent('8 days over');
    expect(items[1]).toHaveTextContent('Owner: No owner');
    expect(items[1]).toHaveTextContent('Moved on to Walkthrough Scheduled');
  });
});

// ─── Who can open it ─────────────────────────────────────────────────────────

describe('the starting summary route', () => {
  function routed(path: string) {
    return renderWithProviders(
      <Routes>
        {spiderV2Routes()}
        <Route path="/" element={<div>Dashboard</div>} />
      </Routes>,
      { initialEntries: [path] },
    );
  }

  it('opens for a non-Admin in a Spider company, whose Spider page is still Admin-only', async () => {
    signIn(SALES);
    const { unmount } = routed('/spider/summary');
    expect(await screen.findByRole('heading', { level: 1, name: "Spider's starting summary" })).toBeInTheDocument();
    unmount();
    routed('/spider');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('sends a company without Spider to the dashboard and asks nothing', async () => {
    signIn({ ...SALES, org_is_demo: false });
    routed('/spider/summary');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(callsTo(MINE)).toBe(0);
  });
});

// ─── The bell ────────────────────────────────────────────────────────────────

describe('the bell entry', () => {
  const ITEM: NotificationView = {
    id: 'nr-1',
    verb: 'spider.starting_summary',
    category: 'LEAD',
    priority: 'FEED',
    needs_action: false,
    title: 'Spider is on. 12 of your leads were already past their limit.',
    body: 'Your starting summary',
    object_type: 'SPIDER_SUMMARY',
    object_id: 's1',
    object_label: 'Starting summary',
    action_type: null,
    data: { link_path: '/spider/summary', lead_count: 12 },
    created_at: new Date().toISOString(),
    seen_at: null,
    read_at: null,
    acted_at: null,
  };

  it("reads as the demo's, with Spider's portrait and View summary, and opens the summary", async () => {
    renderWithProviders(
      <>
        <NotificationItem item={ITEM} />
        <Where />
      </>,
    );
    expect(screen.getByText('Spider is on. 12 of your leads were already past their limit.')).toBeInTheDocument();
    expect(screen.getByText('Your starting summary')).toBeInTheDocument();
    expect(screen.getByText('View summary')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ITEM.title }));
    expect(screen.getByTestId('where')).toHaveTextContent('/spider/summary');
  });
});

// ─── History ─────────────────────────────────────────────────────────────────

describe('History', () => {
  const ROW = {
    id: 'a1', lead_id: 'lead-1', lead_number: 'L-1031', customer_id: null, customer_name: 'Hannah Brooks', company_name: null,
    service_request: null, service_location: '418 Elm St', status: 'NEW', stage_name: 'New', elapsed: { value: 19, unit: 'DAY' },
    alerted_at: MADE, outcome: 'SENT',
    outcomes: {
      email: { enabled: true, status: 'SENT', sent: 1, skipped: 0, failed: 0, error: null, skip_reason: null },
      sms: { enabled: false, status: 'SKIPPED', sent: 0, skipped: 0, failed: 0, error: null, skip_reason: null },
      in_app: { enabled: true, status: 'SENT' },
    },
    recipients: [{ id: 'u1', name: 'Dana Cole', email: null, role: 'ADMIN', type: 'admin' }],
    email_subject: null, email_body: null, sms_message: null, in_app_message: null,
  };

  it('tags a lead reported in the starting summary "In starting summary", and no other', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        items: [
          { ...ROW, in_starting_summary: true },
          { ...ROW, id: 'a2', lead_id: 'lead-9', lead_number: 'L-1071', in_starting_summary: false },
        ],
        page: 1, page_size: 25, total: 2, total_pages: 1,
      },
    });
    renderWithProviders(<SpiderHistory isSpiderActive watchedLeads={2} />);
    const tagged = (await screen.findByText('L-1031')).closest('tr') as HTMLElement;
    expect(within(tagged).getByText('In starting summary')).toBeInTheDocument();
    const plain = screen.getByText('L-1071').closest('tr') as HTMLElement;
    expect(within(plain).queryByText('In starting summary')).toBeNull();
  });
});

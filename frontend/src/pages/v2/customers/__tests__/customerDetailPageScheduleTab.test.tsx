import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Slice 10 — the combined Schedule tab on the v2 customer detail page.
 *
 * `frontend/src/pages/v2/customers/CustomerDetailPage.tsx` is the LIVE page: it is the component
 * `pages/v2/routes/customers.routes.tsx` mounts at `/customers/:id` (verified by reading that
 * route file - `customers.routes.tsx` imports `../customers/CustomerDetailPage`, which resolves
 * to this file, not `src/pages/CustomerDetailPage.tsx`). Editing the wrong copy is slice 01's
 * documented trap (a change that lands in a dead v1 fork nothing routes to).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

const mockApi = vi.mocked(api);

const CUSTOMER_DETAIL_FIXTURE = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
    phone_ext: null,
    secondary_phone: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [],
    custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    is_active: true,
    tags: [],
    service_locations: [],
    _count: { leads: 1, jobs: 1 },
    activity_notes: [],
    orphan_invoices: [],
    invoices: [],
  },
  summary: {
    financials: {
      lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0,
      paid_invoice_count: 0, unpaid_invoice_count: 0,
    },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 1, active: 0 },
    tasks: { open: 0 },
  },
};

/**
 * GET /api/customers/:id/schedule (slice 04): every visit of every job and lead. J00041 holds three
 * visits with a different crew on each (the demo org's J00044 shape); its first is done, so its
 * NEXT visit is the second. The lead holds one walkthrough. Far-future dates keep "next" stable
 * whatever day the suite runs.
 */
const crewMember = (id: string, first_name: string, last_name: string) => ({ id, first_name, last_name });
const scheduleVisit = (id: string, visit_seq: number, status: string, scheduled_at: string, crew: ReturnType<typeof crewMember>[]) => ({
  id, visit_seq, status, scheduled_at, scheduled_end: null, is_all_day: false, created_at: '2026-01-01T00:00:00.000Z', crew,
});
const SCHEDULE_FIXTURE = {
  jobs: [
    {
      id: 'job-1',
      job_number: 'J00041',
      status: 'SCHEDULED',
      scope_notes: 'Replace condenser',
      visits: [
        scheduleVisit('v1', 1, 'COMPLETED', '2026-01-05T15:00:00.000Z', [crewMember('u1', 'Ana', 'Lee')]),
        scheduleVisit('v2', 2, 'SCHEDULED', '2099-03-14T15:00:00.000Z', [crewMember('u2', 'Ben', 'Ortiz')]),
        scheduleVisit('v3', 3, 'SCHEDULED', '2099-03-20T15:00:00.000Z', [crewMember('u3', 'Cy', 'Park')]),
      ],
    },
  ],
  leads: [
    {
      id: 'lead-1',
      lead_number: 'L00012',
      status: 'NEW',
      service_request: 'AC not cooling',
      visits: [scheduleVisit('w1', 1, 'SCHEDULED', '2099-03-01T14:00:00.000Z', [crewMember('u2', 'Ben', 'Ortiz')])],
    },
  ],
};

/** GET /api/customers/:id/jobs (slice 06): the Jobs tab's one page. */
const JOBS_PAGE_FIXTURE = {
  jobs: [
    {
      id: 'job-1',
      job_number: 'J00041',
      status: 'SCHEDULED',
      scope_notes: 'Replace condenser',
      completed_at: null,
      created_at: '2026-09-01T00:00:00.000Z',
      // The job-window rule's pick, served by the endpoint: visit 2, the next one (visit 1 is done).
      scheduled_start: '2099-03-14T15:00:00.000Z',
      scheduled_end: null,
      is_all_day: false,
      assignees: [],
      service_location: null,
      invoices: [],
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};
const NO_LEADS = { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };

const CALENDAR_ENTRIES_FIXTURE = {
  calendar_entries: [
    {
      id: 'entry-1',
      title: "Dave's follow-up call",
      description: '',
      start: '2099-03-12T16:00:00.000Z',
      end: '2099-03-12T16:30:00.000Z',
      is_all_day: false,
      participants: [],
    },
  ],
};

function mockGetFor({ withCalendarEntries }: { withCalendarEntries: boolean }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return { data: SCHEDULE_FIXTURE };
    if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: JOBS_PAGE_FIXTURE };
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
    if (url === '/api/leads') return { data: NO_LEADS };
    if (url === '/api/calendar-entries') {
      if (!withCalendarEntries) throw new Error('should never be requested without the grant');
      return { data: CALENDAR_ENTRIES_FIXTURE };
    }
    // Every other GET this heavy page fires on mount (tags, estimates, ...) - one
    // generic empty shape is enough, the same reasoning jobsV2Smoke.test.tsx documents.
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomerDetailPage — Schedule tab (slice 10; per visit since visits slice 04)', () => {
  it('places Schedule right after Jobs in the tab strip', async () => {
    mockGetFor({ withCalendarEntries: true });
    const ability = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

    renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    const jobsIdx = tabs.indexOf('Jobs');
    const scheduleIdx = tabs.indexOf('Schedule');
    expect(jobsIdx).toBeGreaterThanOrEqual(0);
    expect(scheduleIdx).toBe(jobsIdx + 1);
    // Comms still renders last (unchanged by this slice).
    expect(tabs[tabs.length - 1]).not.toBe('Schedule');
  });

  it('with `read CalendarEntry`: every job visit, the walkthrough and the Event, in one chronological list', async () => {
    mockGetFor({ withCalendarEntries: true });
    const ability = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

    renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));

    // The schedule and calendar-entries queries resolve on their own schedules - wait for both.
    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument(); // walkthrough row
      expect(screen.getByText('Visit 3 of 3')).toBeInTheDocument(); // last job visit row
      expect(screen.getByText("Dave's follow-up call")).toBeInTheDocument(); // Event row
    });

    // Chronological: v1 (Jan 5 2026) -> walkthrough (Mar 1) -> Event (Mar 12) -> v2 (Mar 14) -> v3 (Mar 20).
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Visit 1 of 3');
    expect(rows[0]).toHaveTextContent('Ana Lee');
    expect(rows[1]).toHaveTextContent('AC not cooling');
    expect(rows[2]).toHaveTextContent("Dave's follow-up call");
    expect(rows[3]).toHaveTextContent('Visit 2 of 3');
    expect(rows[3]).toHaveTextContent('Ben Ortiz');
    expect(rows[4]).toHaveTextContent('Visit 3 of 3');
    expect(rows[4]).toHaveTextContent('Cy Park');

    const calledUrls = mockApi.get.mock.calls.map((c) => c[0]);
    const entriesCall = mockApi.get.mock.calls.find((c) => c[0] === '/api/calendar-entries');
    expect(entriesCall?.[1]).toMatchObject({ params: { customer_id: CUSTOMER_ID } });
    // Walkthrough rows come off the schedule feed (the leads mock above returns no leads at all).
    expect(calledUrls).toContain(`/api/customers/${CUSTOMER_ID}/schedule`);
  });

  it("the Jobs tab's Scheduled column shows the same next date as the Schedule tab", async () => {
    mockGetFor({ withCalendarEntries: false });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    // Visit 2 is J00041's next visit (visit 1 is done) - not the job's first visit.
    const jobRow = (await screen.findByText('J00041')).closest('tr')!;
    await waitFor(() => expect(jobRow).toHaveTextContent('Mar 14, 2099'));
    expect(jobRow).not.toHaveTextContent('Jan 5, 2026');

    fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    const nextRow = (await screen.findByText('Visit 2 of 3')).closest('tr')!;
    expect(nextRow).toHaveTextContent('Mar 14, 2099');
  });

  it('the Jobs tab reads its dates off its own page: the per-visit feed is requested only once the Schedule tab opens', async () => {
    mockGetFor({ withCalendarEntries: false });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }));
    const jobRow = (await screen.findByText('J00041')).closest('tr')!;
    await waitFor(() => expect(jobRow).toHaveTextContent('Mar 14, 2099'));
    const scheduleUrl = `/api/customers/${CUSTOMER_ID}/schedule`;
    expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain(scheduleUrl);

    fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    await waitFor(() => expect(mockApi.get.mock.calls.map((c) => c[0])).toContain(scheduleUrl));
  });

  it('a lead marked lost: its cancelled walkthrough is marked Cancelled, even though the leads list still carries a walkthrough date', async () => {
    // Marking a lead lost cancels its walkthrough visit, but `GET /api/leads` still derives the
    // flat walkthrough_scheduled_at from that cancelled visit. The Schedule tab must read the
    // visit's own status off the schedule feed, not that flat date.
    const lostSchedule = {
      jobs: [],
      leads: [{
        ...SCHEDULE_FIXTURE.leads[0],
        status: 'LOST',
        visits: [scheduleVisit('w1', 1, 'CANCELLED', '2099-03-01T14:00:00.000Z', [crewMember('u2', 'Ben', 'Ortiz')])],
      }],
    };
    const staleLeads = {
      leads: [{
        id: 'lead-1', lead_number: 'L00012', status: 'LOST', service_request: 'AC not cooling',
        created_at: '2026-09-01T00:00:00.000Z', walkthrough_scheduled_at: '2099-03-01T14:00:00.000Z', estimates: [],
      }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return { data: lostSchedule };
      if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: JOBS_PAGE_FIXTURE };
      if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
      if (url === '/api/leads') return { data: staleLeads };
      return { data: {} };
    });

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });
    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));

    const row = (await screen.findByText('AC not cooling')).closest('tr')!;
    await waitFor(() => expect(row).toHaveTextContent('Cancelled'));
  });

  it('while the schedule feed is loading: the Schedule tab shows a skeleton, not "Nothing scheduled yet."', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return new Promise(() => {}); // never settles
      if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: JOBS_PAGE_FIXTURE };
      if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
      return { data: {} };
    });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByTestId('schedule-loading')).toBeInTheDocument();
    expect(screen.queryByText('Nothing scheduled yet.')).toBeNull();
  });

  it('when the schedule feed fails: the Schedule tab says so with a working Retry, and the Jobs tab keeps its own dates', async () => {
    let scheduleCalls = 0;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/customers/${CUSTOMER_ID}/schedule`) {
        scheduleCalls += 1;
        throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
      }
      if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: JOBS_PAGE_FIXTURE };
      if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
      return { data: {} };
    });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));
    expect(await screen.findByText("Couldn't load this customer's schedule.")).toBeInTheDocument();
    expect(screen.queryByText('Nothing scheduled yet.')).toBeNull();
    const before = scheduleCalls;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(scheduleCalls).toBeGreaterThan(before));

    // The Jobs tab's date rides on its own page (visits fix pass), so the feed failing costs it
    // nothing: the date shows, and there is no feed error to report there.
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }));
    const jobRow = (await screen.findByText('J00041')).closest('tr')!;
    expect(jobRow).toHaveTextContent('Mar 14, 2099');
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('without `read CalendarEntry`: jobs and walkthroughs still render, no Events row, and /api/calendar-entries is never requested', async () => {
    mockGetFor({ withCalendarEntries: false });
    // No ability at all -> emptyAbility -> can('read','CalendarEntry') is false.

    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    fireEvent.click(await screen.findByRole('tab', { name: 'Schedule' }));

    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument();
      expect(screen.getByText('Visit 1 of 3')).toBeInTheDocument();
    });
    expect(screen.queryByText("Dave's follow-up call")).toBeNull();

    const calledUrls = mockApi.get.mock.calls.map((c) => c[0]);
    expect(calledUrls).not.toContain('/api/calendar-entries');
  });

  describe('an org without the `leads` entitlement', () => {
    // useFeature('leads') reads org_features off the auth store; the globally-mocked default
    // user carries no org_features key, which useFeature treats as "unknown" and fails OPEN
    // (true). An org_features array that omits 'leads' is what actually turns it off.
    let restore: (() => void) | null = null;
    beforeEach(async () => {
      const { useAuthStore } = await import('@/stores/auth.store');
      const original = vi.mocked(useAuthStore).getMockImplementation();
      restore = () => { if (original) vi.mocked(useAuthStore).mockImplementation(original); };
      // Matches the store's own permissive selector signature, as job-plan-gating.test.tsx does.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
        selector({
          user: {
            id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com',
            first_name: 'Test', last_name: 'Admin', role: 'ADMIN',
            org_features: ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling'],
          },
          isAuthenticated: true, isLoading: false, error: null,
        }),
      );
    });
    afterEach(() => { restore?.(); });

    it('still gets the Schedule tab, listing every job visit (and no walkthrough rows); the Leads tab stays hidden', async () => {
      // The server leaves lead visits out for an org without the entitlement.
      const jobsOnly = { jobs: SCHEDULE_FIXTURE.jobs, leads: [] };
      mockApi.get.mockImplementation(async (url: string) => {
        if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return { data: jobsOnly };
        if (url === `/api/customers/${CUSTOMER_ID}/jobs`) return { data: JOBS_PAGE_FIXTURE };
        if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL_FIXTURE };
        if (url === '/api/leads') throw new Error('the leads API is plan-gated; never requested without the entitlement');
        return { data: {} };
      });

      renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

      await screen.findByRole('tab', { name: 'Jobs' });
      expect(screen.queryByRole('tab', { name: 'Leads' })).toBeNull();
      const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
      expect(tabs.indexOf('Schedule')).toBe(tabs.indexOf('Jobs') + 1);

      fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
      await waitFor(() => expect(screen.getByText('Visit 3 of 3')).toBeInTheDocument());
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.textContent)).toEqual([
        expect.stringContaining('Visit 1 of 3'),
        expect.stringContaining('Visit 2 of 3'),
        expect.stringContaining('Visit 3 of 3'),
      ]);
      expect(screen.queryByText('AC not cooling')).toBeNull();
      expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain('/api/leads');
    });

    it('lands on Estimates, not on the hidden Leads tab, and fetches no schedule feed until Schedule opens', async () => {
      mockGetFor({ withCalendarEntries: false });
      renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

      expect(await screen.findByRole('tab', { name: 'Estimates' })).toHaveAttribute('aria-selected', 'true');
      expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain(`/api/customers/${CUSTOMER_ID}/schedule`);
    });
  });
});

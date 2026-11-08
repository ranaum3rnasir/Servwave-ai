import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomerDetailPage from '../CustomerDetailPage';

/**
 * Visits slice 05 - the customer page's Leads tab (the landing tab) shows each lead's walkthrough
 * date: the next upcoming non-cancelled trip, else the latest past one. The server resolves that
 * trip (`next_walkthrough` on each lead of `GET /api/leads`, one backend rule), so the tab renders
 * it straight off its own page of leads - never off the leads list's flat `walkthrough_scheduled_at`,
 * and without downloading the customer's whole per-visit schedule feed, which the page requests
 * only when the Schedule tab is open.
 *
 * `pages/v2/customers/CustomerDetailPage.tsx` is the routed page (`customers.routes.tsx`).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000005';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

const mockApi = vi.mocked(api);

/** The org clock. Deliberately NOT the default zone, so a browser- or default-zone render fails. */
const ORG_TIMEZONE = 'America/Los_Angeles';

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C00005',
    first_name: 'Rita',
    last_name: 'Vance',
    company_name: null,
    email: 'rita@example.test',
    phone: '5551230000',
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
    _count: { leads: 4, jobs: 0 },
    jobs: [],
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
    leads: { open: 4, active: 0 },
    tasks: { open: 0 },
  },
};

const visit = (id: string, visit_seq: number, status: string, scheduled_at: string) => ({
  id, visit_seq, status, scheduled_at, scheduled_end: null, is_all_day: false,
  created_at: '2026-01-01T00:00:00.000Z', crew: [],
});

/**
 * Four leads, one per rule. Past dates sit in 2020 and upcoming ones in 2099, so "next" does not
 * depend on the day the suite runs. 2099-03-01T18:30Z is 10:30 AM in Los Angeles.
 */
const SCHEDULE = {
  jobs: [],
  leads: [
    {
      // A done first trip and a booked second one: the second is next.
      id: 'lead-upcoming', lead_number: 'L00075', status: 'CONTACTED', service_request: 'Front door rekey',
      visits: [
        visit('w1', 1, 'COMPLETED', '2020-02-10T15:00:00.000Z'),
        visit('w2', 2, 'SCHEDULED', '2099-03-01T18:30:00.000Z'),
      ],
    },
    {
      // Every trip is past: the latest one shows.
      id: 'lead-past', lead_number: 'L00076', status: 'CONTACTED', service_request: 'Garage door survey',
      visits: [
        visit('w3', 1, 'COMPLETED', '2020-04-02T16:00:00.000Z'),
        visit('w4', 2, 'COMPLETED', '2020-05-06T17:00:00.000Z'),
      ],
    },
    {
      // Marked lost: its only walkthrough was cancelled.
      id: 'lead-lost', lead_number: 'L00077', status: 'LOST', service_request: 'Safe install quote',
      visits: [visit('w5', 1, 'CANCELLED', '2099-06-01T16:00:00.000Z')],
    },
    {
      // Never booked.
      id: 'lead-none', lead_number: 'L00078', status: 'NEW', service_request: 'Intercom estimate',
      visits: [],
    },
  ],
};

/** The trip the server picked for the Leads tab, as `next_walkthrough` carries it. */
const trip = (visit_id: string, scheduled_at: string, is_all_day = false) => ({ visit_id, scheduled_at, scheduled_end: null, is_all_day });

/**
 * The leads list as `GET /api/leads` serves it. Every flat `walkthrough_scheduled_at` is WRONG on
 * purpose - the lost lead's is its cancelled trip, the way the list used to derive it - so a tab
 * that read that field would render a date these assertions reject. `next_walkthrough` agrees with
 * SCHEDULE above: it is the server's pick among those same visits.
 */
const leadRow = (
  id: string, lead_number: string, status: string, service_request: string, flat: string | null,
  next: ReturnType<typeof trip> | null,
) => ({
  id, lead_number, status, service_request, created_at: '2026-09-01T00:00:00.000Z',
  walkthrough_scheduled_at: flat, next_walkthrough: next, lead_assignees: [], estimates: [],
});
const LEADS = {
  leads: [
    leadRow('lead-upcoming', 'L00075', 'CONTACTED', 'Front door rekey', '2020-02-10T15:00:00.000Z', trip('w2', '2099-03-01T18:30:00.000Z')),
    leadRow('lead-past', 'L00076', 'CONTACTED', 'Garage door survey', '2020-04-02T16:00:00.000Z', trip('w4', '2020-05-06T17:00:00.000Z')),
    leadRow('lead-lost', 'L00077', 'LOST', 'Safe install quote', '2099-06-01T16:00:00.000Z', null),
    leadRow('lead-none', 'L00078', 'NEW', 'Intercom estimate', '2098-01-01T16:00:00.000Z', null),
    // An all-day booking reads as a day; an evening trip keeps the ORG's date (06:30Z is 10:30 PM
    // the evening before in Los Angeles).
    leadRow('lead-allday', 'L00079', 'CONTACTED', 'Lock survey', null, trip('w6', '2099-04-10T07:00:00.000Z', true)),
    leadRow('lead-evening', 'L00080', 'CONTACTED', 'Evening walkthrough', null, trip('w7', '2099-05-02T05:30:00.000Z')),
  ],
  pagination: { page: 1, limit: 20, total: 6, totalPages: 1 },
};

type ScheduleResponder = () => Promise<{ data: unknown }>;

function mockGets(schedule: ScheduleResponder = async () => ({ data: SCHEDULE })) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: ORG_TIMEZONE } };
    if (url === `/api/customers/${CUSTOMER_ID}/schedule`) return schedule();
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: LEADS };
    return { data: {} };
  });
}

/** The Leads tab row of one lead - the tab is the landing tab, so no click is needed. */
async function leadRowFor(serviceRequest: string): Promise<HTMLElement> {
  return (await screen.findByText(serviceRequest)).closest('tr')!;
}

function walkthroughCell(row: HTMLElement): HTMLElement {
  return within(row).getByTestId('lead-walkthrough');
}

beforeEach(() => {
  vi.clearAllMocks();
});

const NEVER = () => new Promise<{ data: unknown }>(() => {});

describe('CustomerDetailPage - Leads tab walkthrough date (visits slice 05)', () => {
  // The schedule feed never answers in these cases: the Leads tab must not need it.
  it('shows each lead\'s next upcoming walkthrough date and time, on the org clock', async () => {
    mockGets(NEVER);
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    expect(await screen.findByRole('columnheader', { name: 'Walkthrough' })).toBeInTheDocument();
    const row = await leadRowFor('Front door rekey');
    await waitFor(() => expect(walkthroughCell(row)).toHaveTextContent('Mar 1, 2099, 10:30 AM'));
    expect(row).not.toHaveTextContent('2020');
  });

  it('a lead whose walkthroughs are all past shows the latest one', async () => {
    mockGets(NEVER);
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const row = await leadRowFor('Garage door survey');
    await waitFor(() => expect(walkthroughCell(row)).toHaveTextContent('May 6, 2020'));
    expect(walkthroughCell(row)).not.toHaveTextContent('Apr 2, 2020');
  });

  it('a lead with no walkthrough, and a lost lead whose only walkthrough was cancelled, show an empty value - not the list\'s flat date', async () => {
    mockGets(NEVER);
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const dated = await leadRowFor('Front door rekey');
    await waitFor(() => expect(walkthroughCell(dated)).toHaveTextContent('2099'));

    const lost = await leadRowFor('Safe install quote');
    expect(walkthroughCell(lost)).toHaveTextContent(/^-$/);
    expect(lost).not.toHaveTextContent('2099');

    const none = await leadRowFor('Intercom estimate');
    expect(walkthroughCell(none)).toHaveTextContent(/^-$/);
    expect(none).not.toHaveTextContent('2098');
  });

  it('an all-day walkthrough reads as a day, and an evening one keeps the org\'s date across the UTC midnight', async () => {
    mockGets(NEVER);
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const allDay = await leadRowFor('Lock survey');
    await waitFor(() => expect(walkthroughCell(allDay)).toHaveTextContent('Apr 10, 2099 · All day'));
    const evening = await leadRowFor('Evening walkthrough');
    expect(walkthroughCell(evening)).toHaveTextContent('May 1, 2099, 10:30 PM');
  });

  it('the date is the same text the Schedule tab shows for that visit', async () => {
    mockGets();
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const row = await leadRowFor('Front door rekey');
    await waitFor(() => expect(walkthroughCell(row)).toHaveTextContent('2099'));
    const leadsTabText = walkthroughCell(row).textContent;

    fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    // L00075's second walkthrough - the visit the Leads tab picked.
    await screen.findAllByText('Visit 2 of 2');
    const scheduleRow = screen.getAllByText('Front door rekey')
      .map((el) => el.closest('tr')!)
      .find((tr) => tr.textContent?.includes('Visit 2 of 2'));
    expect(scheduleRow).toBeDefined();
    expect(scheduleRow).toHaveTextContent(leadsTabText!);
  });

  it('opening the page on the Leads tab never requests the per-visit schedule feed; opening the Schedule tab does', async () => {
    mockGets();
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    const row = await leadRowFor('Front door rekey');
    await waitFor(() => expect(walkthroughCell(row)).toHaveTextContent('2099'));
    const scheduleUrl = `/api/customers/${CUSTOMER_ID}/schedule`;
    expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain(scheduleUrl);

    fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
    await waitFor(() => expect(mockApi.get.mock.calls.map((c) => c[0])).toContain(scheduleUrl));
  });

  it('while the leads page loads, the tab shows it is loading - never a "-" walkthrough', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/organization') return { data: { id: 'org-1', timezone: ORG_TIMEZONE } };
      if (url === '/api/leads') return new Promise(() => {});
      if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
      return { data: {} };
    });
    renderWithProviders(<CustomerDetailPage />, { initialEntries: [`/customers/${CUSTOMER_ID}`] });

    expect(await screen.findByTestId('list-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('lead-walkthrough')).toBeNull();
  });
});

/**
 * Multi-visit spec slice S2, the job-page half.
 *
 * A job can now hold several visits. The ROUTED page (pages/v2/jobs) has to list them, add one
 * and reschedule one - driven through the rendered page, what a user can read and click, so it
 * survives any reshuffle of how the list is derived internally.
 *
 * The org zone here is Asia/Manila deliberately: it differs from every plausible runner zone, so
 * these assertions fail on browser-local behaviour rather than passing by coincidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobDetailPage from '../JobDetailPage';

const ORG_TZ = 'Asia/Manila'; // UTC+8, no DST.
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

// The assignable roster the crew picker fetches. Fixed here so the picker can be driven for real
// rather than stubbed away - the point of these cases is that the DIALOG carries a working picker.
vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>();
  return {
    ...actual,
    useAssignableUsers: () => ({
      data: [
        { id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz', role: 'TECHNICIAN', department: null },
        { id: 'u-sam', first_name: 'Sam', last_name: 'Okafor', role: 'TECHNICIAN', department: null },
      ],
      isLoading: false,
    }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

// useScheduleTimezone reads org.timezone through this module.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false }),
  };
});

// The app mounts both toasters at the root; renderWithProviders does not, so the toast call is
// the seam a test can see. Same shape the backend suite uses for dispatchAutomationEvent.
vi.mock('@/components/ui/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/use-toast')>()),
  toast: vi.fn(),
}));

const mockToast = vi.mocked(toast);
const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const BASE_JOB = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'SCHEDULED',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  // 2026-09-05T01:00:00Z is 9:00 AM Sep 5 in Manila.
  scheduled_start: '2026-09-05T01:00:00.000Z',
  scheduled_end: '2026-09-05T03:30:00.000Z',
  is_all_day: false,
  started_at: null,
  on_site_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  signature_at: null,
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
};

const VISIT_1 = {
  id: 'v-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-09-05T01:00:00.000Z',
  scheduled_end: '2026-09-05T03:30:00.000Z',
  is_all_day: false,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-20T10:00:00.000Z',
};

const VISIT_2 = {
  ...VISIT_1,
  id: 'v-2',
  visit_seq: 2,
  scheduled_at: '2026-09-09T01:00:00.000Z',
  scheduled_end: '2026-09-09T03:30:00.000Z',
  created_at: '2026-08-20T11:00:00.000Z',
};

const VISIT_3_CANCELLED = {
  ...VISIT_1,
  id: 'v-3',
  visit_seq: 3,
  status: 'CANCELLED',
  scheduled_at: '2026-09-12T01:00:00.000Z',
  scheduled_end: '2026-09-12T03:30:00.000Z',
  cancelled_at: '2026-08-25T10:00:00.000Z',
  cancelled_reason: 'Customer away',
  created_at: '2026-08-20T12:00:00.000Z',
};

function mockJobWithVisits(visits: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/visits')) return { data: { visits } };
    if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
    return { data: {} };
  });
}

/**
 * The VISITS CARD's row for a trip.
 *
 * Scoped rather than a bare findByText because from S5 the lifecycle rail carries the same
 * "Visit N" label (D11 gives every trip its own node), so the text alone is ambiguous. The card's
 * row is the one inside an <li>; the rail's node is not.
 */
function visitRowSync(seq: number): HTMLElement {
  const row = screen.getAllByText(`Visit ${seq}`)
    .map((el) => el.closest('li'))
    .find((li): li is HTMLLIElement => li !== null);
  if (!row) throw new Error(`No Visits-card row for Visit ${seq}`);
  return row;
}

async function visitRow(seq: number): Promise<HTMLElement> {
  await screen.findAllByText(`Visit ${seq}`);
  return visitRowSync(seq);
}

async function openVisitsTab() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Visits' }));
}

describe('v2 job page - the visits list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists every visit with its number and its org-zone time', async () => {
    mockJobWithVisits([VISIT_1, VISIT_2]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    expect(await visitRow(1)).toBeInTheDocument();
    expect(visitRowSync(2)).toBeInTheDocument();
    // 01:00Z is 9:00 AM in Manila - a browser-local render would read 9:00 AM only in UTC+8.
    expect(screen.getByText(/Sep 5, 2026, 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText(/Sep 9, 2026, 9:00 AM/)).toBeInTheDocument();
  });

  it('keeps a cancelled visit on the list, marked as cancelled', async () => {
    // D19: rows are never deleted. The customer holds an email referencing "Visit 3", and hiding
    // the row would make the first-time-fix / callback data unrecoverable.
    mockJobWithVisits([VISIT_1, VISIT_2, VISIT_3_CANCELLED]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(3);
    expect(within(row).getByText(/Cancelled/)).toBeInTheDocument();
    expect(within(row).getByText('Customer away')).toBeInTheDocument();
  });
});

describe('v2 job page - the hero reads Next Visit (D14a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels the hero tile Next Visit and renders it on the org clock', async () => {
    mockJobWithVisits([VISIT_1, VISIT_2]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });

    // D14a: the tile describes the NEXT upcoming visit, which by D14 is exactly what the mirrored
    // Job.scheduled_start holds - which is why the hero needs no new payload.
    expect(await screen.findByText('Next Visit')).toBeInTheDocument();
    // 2026-09-05T01:00:00Z is 9:00 AM in Manila. A viewer in any other zone must read the same
    // string the visit list below shows.
    expect(screen.getAllByText(/Sep 5, 9:00 AM/).length).toBeGreaterThan(0);
  });
});

describe('v2 job page - Add visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('books a second visit through the four-field module, converting at the org seam', async () => {
    // The list the server holds. The POST appends to it, so the refetch after the mutation shows
    // what a real user would see.
    const serverVisits: Array<Record<string, unknown>> = [VISIT_1];
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: serverVisits } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    mockApi.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/visits')) {
        serverVisits.push(VISIT_2);
        return { data: { visit: VISIT_2 } };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add visit/i }));

    const startDate = await screen.findByLabelText('Start date');
    await userEvent.clear(startDate);
    await userEvent.type(startDate, '09/20/2026');
    await userEvent.tab();

    const startTime = screen.getByLabelText('Start time');
    await userEvent.clear(startTime);
    await userEvent.type(startTime, '9:00 AM');
    await userEvent.tab();

    const endDate = screen.getByLabelText('End date');
    await userEvent.clear(endDate);
    await userEvent.type(endDate, '09/20/2026');
    await userEvent.tab();

    const endTime = screen.getByLabelText('End time');
    await userEvent.clear(endTime);
    await userEvent.type(endTime, '11:30 AM');
    await userEvent.tab();

    await userEvent.click(screen.getByRole('button', { name: /book visit/i }));

    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/visits'));
    if (!call) throw new Error('no POST to the visits collection');
    expect(call[0]).toBe(`/api/jobs/${JOB_ID}/visits`);
    // 9:00 AM Manila is 01:00Z; 11:30 AM Manila is 03:30Z. A browser-zone conversion would send a
    // different instant and the visit would land at the wrong time of day for the crew.
    expect(call[1]).toMatchObject({
      scheduled_start: '2026-09-20T01:00:00.000Z',
      scheduled_end: '2026-09-20T03:30:00.000Z',
    });

    expect(await visitRow(2)).toBeInTheDocument();
  });
});

describe('v2 job page - Reschedule a visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens pre-seeded with that visit\'s slot and PATCHes the same row', async () => {
    mockJobWithVisits([VISIT_1, VISIT_2]);
    mockApi.patch.mockResolvedValue({ data: { visit: VISIT_2 } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));

    // Seeded WHOLE from the row's own instants, before the user types anything. The live
    // #1535/#1551 defect on this page is the opposite: AssignJobDialog is mounted without its
    // default props, so Reschedule opens with four empty pickers and the slot has to be retyped.
    expect(await screen.findByLabelText('Start date')).toHaveValue('09/09/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    expect(screen.getByLabelText('End date')).toHaveValue('09/09/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:30 AM');

    const startTime = screen.getByLabelText('Start time');
    await userEvent.clear(startTime);
    await userEvent.type(startTime, '10:00 AM');
    await userEvent.tab();

    await userEvent.click(screen.getByRole('button', { name: /save visit/i }));

    const call = mockApi.patch.mock.calls[0];
    if (!call) throw new Error('no PATCH to the visit');
    // D19: the SAME row, addressed by its id - never a second visit.
    expect(call[0]).toBe(`/api/jobs/${JOB_ID}/visits/${VISIT_2.id}`);
    // 10:00 AM Manila is 02:00Z. The end follows the start keeping the 2h30 span, which is the
    // shared four-field module's own rule (withStartTime) rather than anything this dialog decides.
    expect(call[1]).toMatchObject({
      scheduled_start: '2026-09-09T02:00:00.000Z',
      scheduled_end: '2026-09-09T04:30:00.000Z',
    });
  });
});

/**
 * The founder-reported gap this dialog was missing: AssignJobDialog had All Day, this one
 * didn't, so a multi-day install visit was unsayable from the job's own Visits card. Both
 * date fields read INCLUSIVE - "Sep 20 to Sep 22" runs through the end of the 22nd - and the
 * exclusive end instant the API stores is derived at the seam, the same rule AssignJobDialog's
 * own all-day describe block asserts.
 */
describe('v2 job page - booking an all-day visit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts is_all_day and the inclusive span as an exclusive-midnight window', async () => {
    const serverVisits: Array<Record<string, unknown>> = [VISIT_1];
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: serverVisits } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    mockApi.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/visits')) {
        const created = { ...VISIT_2, is_all_day: true };
        serverVisits.push(created);
        return { data: { visit: created } };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add visit/i }));

    await userEvent.click(screen.getByLabelText('All Day'));

    // The times are what All Day removes; the span is not.
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();

    const startDate = screen.getByLabelText('Start date');
    await userEvent.clear(startDate);
    await userEvent.type(startDate, '09/20/2026');
    await userEvent.tab();

    // Cleared first: picking the start already mirrored a one-day span into this field, so
    // typing alone would append to '09/20/2026'.
    const endDate = screen.getByLabelText('End date');
    await userEvent.clear(endDate);
    await userEvent.type(endDate, '09/22/2026');
    await userEvent.tab();

    await userEvent.click(screen.getByRole('button', { name: /book visit/i }));

    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/visits'));
    if (!call) throw new Error('no POST to the visits collection');
    // Midnight Manila is 16:00Z the day before. Sep 22 is the last day INCLUDED, so the stored
    // end is midnight the 23rd - a browser-zone conversion would send a different instant.
    expect(call[1]).toMatchObject({
      is_all_day: true,
      scheduled_start: '2026-09-19T16:00:00.000Z',
      scheduled_end: '2026-09-22T16:00:00.000Z',
    });
  });
});

describe('v2 job page - Reschedule an all-day visit', () => {
  const VISIT_ALLDAY = {
    id: 'v-allday',
    visit_seq: 4,
    status: 'SCHEDULED',
    // Aug 17, 00:00 Manila.
    scheduled_at: '2026-08-16T16:00:00.000Z',
    // Aug 20, 00:00 Manila - the exclusive end of an inclusive Aug 17-19 span.
    scheduled_end: '2026-08-19T16:00:00.000Z',
    is_all_day: true,
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_at: '2026-08-01T09:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens with All Day ticked and the inclusive dates the row actually spans', async () => {
    mockJobWithVisits([VISIT_ALLDAY]);
    mockApi.patch.mockResolvedValue({ data: { visit: VISIT_ALLDAY } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(4);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));

    expect(await screen.findByLabelText('All Day')).toBeChecked();
    // INCLUSIVE round-trip: the row's own exclusive end (Aug 20 midnight) reads back as Aug 19,
    // the last day the visit actually occupies - never the exclusive boundary itself.
    expect(screen.getByLabelText('Start date')).toHaveValue('08/17/2026');
    expect(screen.getByLabelText('End date')).toHaveValue('08/19/2026');
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save visit/i }));

    const call = mockApi.patch.mock.calls[0];
    if (!call) throw new Error('no PATCH to the visit');
    // Saved without editing anything: the round trip must reproduce the SAME window, not a
    // day-shifted one from a lossy inclusive/exclusive conversion.
    expect(call[1]).toMatchObject({
      is_all_day: true,
      scheduled_start: '2026-08-16T16:00:00.000Z',
      scheduled_end: '2026-08-19T16:00:00.000Z',
    });
  });
});

describe('v2 job page - an inverted window cannot be saved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Save disabled while the end is not after the start', async () => {
    // Every other consumer of these four fields blocks on isInvertedRange (AssignJobDialog, the
    // lead page, the walkthrough tab). Without it the dialog sends a zero-length or negative
    // window, the backend mirrors it onto the job, and detectCrewConflicts' overlap test can no
    // longer match the job at all - double-booking checks silently pass.
    mockJobWithVisits([VISIT_1, VISIT_2]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));

    const save = await screen.findByRole('button', { name: /save visit/i });
    expect(save).toBeEnabled();

    // Drag the END date back before the start - the one way to build an inverted range through
    // these fields, since an earlier end TIME rolls the end date forward instead.
    const endDate = screen.getByLabelText('End date');
    await userEvent.clear(endDate);
    await userEvent.type(endDate, '09/08/2026');
    await userEvent.tab();

    expect(save).toBeDisabled();

    await userEvent.click(save);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

describe('v2 job page - the Visits controls follow the ROW, not the subject', () => {
  // The mocked auth-store user.
  const TECH_ID = '00000000-0000-0000-0000-000000000001';
  const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };
  const CREATED_BY_ME_COND = { created_by_id: TECH_ID };

  // The shape the server ships for a technician granted the per-user "Reschedule own jobs"
  // capability: read covers assigned-OR-created, reschedule covers ASSIGNED only.
  const technicianAbility = buildAbility([
    { action: 'read', subject: 'Job', conditions: { OR: [OWN_JOB_COND, CREATED_BY_ME_COND] } },
    { action: 'reschedule', subject: 'Job', conditions: OWN_JOB_COND },
  ] as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers no scheduling control on a job the technician created but is no longer crewed on', async () => {
    // `ability.can('reschedule','Job')` answers "could you ever", and is true for this principal
    // on EVERY job in the org. The API asks the row: canActOnRow intersects the read scope with
    // reschedule's OWN_JOB, this job fails the assignment half, and the POST 403s. A rendered
    // button here is the "button the API refuses" both pages' own comments exist to prevent.
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return { data: { job: { ...BASE_JOB, created_by_id: TECH_ID, assignees: [] } } };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: technicianAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    // The list is still READABLE - `read Job` covers a job they created.
    expect(await visitRow(1)).toBeInTheDocument();
    // Absent, not disabled - house convention.
    expect(screen.queryByRole('button', { name: /add visit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reschedule/i })).toBeNull();
  });

  it('offers them on a job the same technician IS crewed on', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return {
          data: {
            job: {
              ...BASE_JOB,
              created_by_id: TECH_ID,
              assignees: [{ user: { id: TECH_ID, first_name: 'Test', last_name: 'Tech' } }],
            },
          },
        };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: technicianAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    expect(await screen.findByRole('button', { name: /add visit/i })).toBeInTheDocument();
  });
});

/**
 * Multi-visit S3 (D6): crew lives on the visit, so the Visits card has to say who is on each trip.
 * Asserted through the rendered row - what a dispatcher can read - not through the props the card
 * was handed.
 */
describe('v2 job page - the Visits card names each visit\'s crew', () => {
  const DANA = { user_id: 'u-dana', user: { id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz' } };
  const SAM = { user_id: 'u-sam', user: { id: 'u-sam', first_name: 'Sam', last_name: 'Okafor' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows visit 1 its own crew and visit 2 a different one', async () => {
    mockJobWithVisits([
      { ...VISIT_1, assignees: [DANA] },
      { ...VISIT_2, assignees: [SAM] },
    ]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row1 = await visitRow(1);
    expect(within(row1).getByText(/Dana Ruiz/)).toBeInTheDocument();
    // Scoped to the ROW: the union on the job carries both people, so a card that rendered the
    // job-level crew on every visit would pass a bare screen.getByText and prove nothing.
    expect(within(row1).queryByText(/Sam Okafor/)).toBeNull();

    const row2 = await visitRow(2);
    expect(within(row2).getByText(/Sam Okafor/)).toBeInTheDocument();
    expect(within(row2).queryByText(/Dana Ruiz/)).toBeNull();
  });
});

/**
 * S3: the Visits dialog is where a per-visit crew is actually SET. Both modes go through one
 * component, so the picker arrives for both - what differs, and is proved separately below, is
 * that Reschedule opens holding the row's existing crew.
 */
describe('v2 job page - naming the crew on a visit', () => {
  const DANA = { user_id: 'u-dana', user: { id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function pickCrew(name: RegExp) {
    await userEvent.click(await screen.findByLabelText('Crew'));
    await userEvent.click(await screen.findByRole('option', { name }));
  }

  // 120s, not 30s. Sixteen userEvent gestures across four date/time fields
  // and a crew picker already put this case within a few seconds of the
  // default cap; it goes over intermittently now that `SelectField`'s §4.2
  // branch puts `components/ui/combobox` in the import graph of every page
  // that renders a dropdown, with machine contention making up the rest of
  // the margin.
  //
  // NOTHING here changed behaviour: the crew picker is MultiAssigneeSelect,
  // which composes Radix Select directly and never reaches the rule.
  it('sends the picked crew alongside the org-zone instants when booking', async () => {
    mockJobWithVisits([VISIT_1]);
    mockApi.post.mockResolvedValue({ data: { visit: VISIT_2 } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();
    await userEvent.click(await screen.findByRole('button', { name: /add visit/i }));

    const startDate = await screen.findByLabelText('Start date');
    await userEvent.clear(startDate);
    await userEvent.type(startDate, '09/20/2026');
    await userEvent.tab();
    const startTime = screen.getByLabelText('Start time');
    await userEvent.clear(startTime);
    await userEvent.type(startTime, '9:00 AM');
    await userEvent.tab();
    const endDate = screen.getByLabelText('End date');
    await userEvent.clear(endDate);
    await userEvent.type(endDate, '09/20/2026');
    await userEvent.tab();
    const endTime = screen.getByLabelText('End time');
    await userEvent.clear(endTime);
    await userEvent.type(endTime, '11:30 AM');
    await userEvent.tab();

    await pickCrew(/Dana Ruiz/);
    await userEvent.click(screen.getByRole('button', { name: /book visit/i }));

    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/visits'));
    if (!call) throw new Error('no POST to the visits collection');
    expect(call[0]).toBe(`/api/jobs/${JOB_ID}/visits`);
    expect(call[1]).toMatchObject({
      scheduled_start: '2026-09-20T01:00:00.000Z',
      scheduled_end: '2026-09-20T03:30:00.000Z',
      assignee_ids: ['u-dana'],
    });
  }, 120000);

  it('opens Reschedule holding that visit\'s crew, and PATCHes the replacement', async () => {
    mockJobWithVisits([VISIT_1, { ...VISIT_2, assignees: [DANA] }]);
    mockApi.patch.mockResolvedValue({ data: { visit: VISIT_2 } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));

    // Seeded from the ROW, not empty: the dialog opens showing who is already going, so a
    // dispatcher moving a trip does not have to re-pick the crew they never changed.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /remove dana ruiz/i })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /remove dana ruiz/i }));
    await pickCrew(/Sam Okafor/);
    await userEvent.click(screen.getByRole('button', { name: /save visit/i }));

    const call = mockApi.patch.mock.calls[0];
    if (!call) throw new Error('no PATCH to the visit');
    expect(call[0]).toBe(`/api/jobs/${JOB_ID}/visits/${VISIT_2.id}`);
    expect(call[1]).toMatchObject({ assignee_ids: ['u-sam'] });
  });
});

/**
 * S3 put a per-instance `assign Job` check behind BOTH visit routes, on top of the subject-level
 * `reschedule Job` route gate. Without matching that in the UI the experience is: the dialog
 * opens, the picker renders, crew is chosen, Save returns a bare 403 with no explanation.
 */
describe('v2 job page - a reschedule-only principal gets the visit dialog without a crew picker', () => {
  const TECH_ID = '00000000-0000-0000-0000-000000000001';
  const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };

  // Holds `reschedule Job` on their own jobs and NOT `assign Job` at all.
  const rescheduleOnly = buildAbility([
    { action: 'read', subject: 'Job', conditions: OWN_JOB_COND },
    { action: 'reschedule', subject: 'Job', conditions: OWN_JOB_COND },
  ] as never);

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return {
          data: {
            job: {
              ...BASE_JOB,
              assignees: [{ user: { id: TECH_ID, first_name: 'Test', last_name: 'Tech' } }],
            },
          },
        };
      }
      return { data: {} };
    });
  });

  it('keeps the four time fields and drops the crew picker on Add visit', async () => {
    renderWithProviders(<JobDetailPage />, { ability: rescheduleOnly, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Visits' }));
    await userEvent.click(await screen.findByRole('button', { name: /add visit/i }));

    // The dialog and its window fields are still there - hiding those would break plain
    // drag-to-reschedule for exactly the people the route gate keeps working.
    expect(await screen.findByLabelText('Start date')).toBeInTheDocument();
    expect(screen.queryByLabelText('Crew')).toBeNull();
  });

  it('keeps them and drops the crew picker on Reschedule too', async () => {
    renderWithProviders(<JobDetailPage />, { ability: rescheduleOnly, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Visits' }));

    const row = await visitRow(1);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));

    expect(await screen.findByLabelText('Start date')).toBeInTheDocument();
    expect(screen.queryByLabelText('Crew')).toBeNull();
  });
});

// ─── Multi-visit S4: the visit's real status, and its lifecycle actions ───────

const VISIT_1_ON_SITE = {
  ...VISIT_1,
  status: 'ON_SITE',
  on_site_at: '2026-09-05T01:12:00.000Z',
};

describe('v2 job page - a visit shows its real status (S4 B15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads On site for a visit whose crew has arrived, not Scheduled', async () => {
    mockJobWithVisits([VISIT_1_ON_SITE, VISIT_2]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const onSiteRow = await visitRow(1);
    const scheduledRow = await visitRow(2);
    // Both rows read "Scheduled" before S4: the card collapsed every live status to that one
    // word, so a crew standing in the customer's driveway looked like a booking nobody had left
    // for yet.
    // Case-sensitive: the registry's status word is "On Site"; the stamps line below it (slice
    // 09) names the milestone "On site", and this case is about the STATUS.
    expect(within(onSiteRow).getByText(/^On Site /)).toBeInTheDocument();
    expect(within(scheduledRow).getByText(/Scheduled/)).toBeInTheDocument();
  });

  it('renders the arrival stamp on the ORG clock', async () => {
    mockJobWithVisits([VISIT_1_ON_SITE]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    // 01:12Z is 9:12 AM in Manila. A viewer's-zone render would read 9:12 only from UTC+8.
    expect(await screen.findByText(/9:12 AM/)).toBeInTheDocument();
  });

  it('starts the visit the button belongs to', async () => {
    // Visit 2 is on site, so "Start work" is its PRIMARY step (slice 09); on a merely scheduled
    // trip it sits behind Skip to, which the slice 09 block below drives.
    mockJobWithVisits([VISIT_1, { ...VISIT_2, status: 'ON_SITE', on_site_at: '2026-09-09T01:02:00.000Z' }]);
    mockApi.post.mockResolvedValue({ data: { visit: { ...VISIT_2, status: 'IN_PROGRESS' } } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: 'Start work' }));

    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/visits/v-2/start`);
  });

  it('offers a crewed technician Mark on site, then Start work, but NOT Mark on the way, which they cannot do', async () => {
    // DEFAULT_GRANTS gives TECHNICIAN `start Job` and `arrive Job` on their own jobs and
    // deliberately NOT `en_route Job` - the file's own comment calls en_route an opt-in per-user
    // toggle, and permissions-parity pins it to ADMIN/DISPATCHER. Each route gates on ITS OWN
    // verb (job.routes.ts: start -> start, arrive -> arrive, en-route -> en_route, complete ->
    // start), so a card that renders all four buttons off the `start` ability offers this
    // technician a button whose POST is guaranteed to 403 - and useVisitLifecycle has no onError,
    // so it appears to do nothing at all.
    const TECH_ID = '00000000-0000-0000-0000-000000000001';
    const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };
    const crewAbility = buildAbility([
      { action: 'read', subject: 'Job', conditions: OWN_JOB_COND },
      { action: 'start', subject: 'Job', conditions: OWN_JOB_COND },
      { action: 'arrive', subject: 'Job', conditions: OWN_JOB_COND },
    ] as never);
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return {
          data: {
            job: {
              ...BASE_JOB,
              assignees: [{ user: { id: TECH_ID, first_name: 'Test', last_name: 'Tech' } }],
            },
          },
        };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: crewAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    // Slice 09: the first PERMITTED verb is the primary - not an empty slot where the absent
    // "Mark on the way" would have been - and the later permitted one sits behind Skip to.
    expect(within(row).getByRole('button', { name: 'Mark on site' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Mark on the way' })).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: 'Skip to' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Start work']);
  });

  it('tells the user when a lifecycle click is refused, instead of appearing to do nothing', async () => {
    // The gate above cannot cover every refusal: D7a scopes each visit to ITS OWN crew, while the
    // ability the card reads answers off job.assignees - the S3 union across every visit - so a
    // technician crewed on visit 3 is still offered visit 1's buttons and the API 403s them.
    // With no onError on the mutation and no 403 branch in the axios interceptor, that click
    // invalidates nothing, says nothing and looks like a dead button.
    mockJobWithVisits([VISIT_1]);
    mockApi.post.mockRejectedValue({ response: { status: 403, data: { error: 'Insufficient permissions' } } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    await userEvent.click(within(row).getByRole('button', { name: 'Mark on the way' }));

    await vi.waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(JSON.stringify(mockToast.mock.calls[0]![0])).toContain('Insufficient permissions');
  });

  it('offers no lifecycle actions to a principal without the gate', async () => {
    mockJobWithVisits([VISIT_1]);
    const readOnly = buildAbility([{ action: 'read', subject: 'Job' }]);

    renderWithProviders(<JobDetailPage />, { ability: readOnly, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    await visitRow(1);
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });
});

describe('v2 job page - acting on a visit refreshes the card (S4 B16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the new status without a manual remount', async () => {
    let visits: Array<Record<string, unknown>> = [VISIT_1, VISIT_2];
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    mockApi.post.mockImplementation(async () => {
      // What the refetch will now see.
      visits = [VISIT_1, { ...VISIT_2, status: 'IN_PROGRESS', started_at: '2026-09-09T01:05:00.000Z' }];
      return { data: { visit: {} } };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: 'Skip to' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Start work' }));

    // invalidateJob never invalidated the visits query, so the card kept rendering the pre-click
    // status until something else forced a refetch. Scoped to the CARD's row: from S5 the
    // lifecycle rail renders the same status word for the same trip.
    await vi.waitFor(() => {
      expect(within(visitRowSync(2)).getByText(/In Progress/i)).toBeInTheDocument();
    });
  });
});

// ─── Multi-visit S4 (D19): calling ONE trip off ──────────────────────────────

const VISIT_4_COMPLETED = {
  ...VISIT_1,
  id: 'v-4',
  visit_seq: 4,
  status: 'COMPLETED',
  scheduled_at: '2026-09-02T01:00:00.000Z',
  scheduled_end: '2026-09-02T03:30:00.000Z',
  completed_at: '2026-09-02T03:00:00.000Z',
  created_at: '2026-08-20T09:00:00.000Z',
};

describe('v2 job page - cancelling one visit (S4 D19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers Cancel on a still-coming trip and on neither a finished nor an already-cancelled one', async () => {
    // D19: a completed or cancelled row is history - kept and readable, never driven anywhere.
    // The route itself has no such guard to lean on, so the card is where "history is not
    // actionable" has to hold.
    mockJobWithVisits([VISIT_1, VISIT_4_COMPLETED, VISIT_3_CANCELLED]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const live = await visitRow(1);
    expect(within(live).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    const completed = await visitRow(4);
    expect(within(completed).queryByRole('button', { name: 'Cancel' })).toBeNull();

    const cancelled = await visitRow(3);
    expect(within(cancelled).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('posts the typed reason to THAT visit, and the row then reads Cancelled with it', async () => {
    let visits: Array<Record<string, unknown>> = [VISIT_1, VISIT_2];
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    mockApi.post.mockImplementation(async () => {
      // What the refetch after the mutation will see.
      visits = [
        VISIT_1,
        {
          ...VISIT_2,
          status: 'CANCELLED',
          cancelled_at: '2026-08-26T02:00:00.000Z',
          cancelled_reason: 'Customer postponed the second trip',
        },
      ];
      return { data: { visit: {} } };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    await userEvent.type(await screen.findByLabelText('Reason'), 'Customer postponed the second trip');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel visit' }));

    // The visit the button belongs to, addressed by ITS id - and the body the route's schema
    // requires, without which validate() 400s before the handler ever runs.
    expect(mockApi.post).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/visits/${VISIT_2.id}/cancel`,
      { cancelled_reason: 'Customer postponed the second trip' },
    );

    // D19: the row survives as history, carrying the reason the office typed.
    await vi.waitFor(() => {
      const after = visitRowSync(2);
      expect(within(after).getByText(/Cancelled/)).toBeInTheDocument();
      expect(within(after).getByText('Customer postponed the second trip')).toBeInTheDocument();
    });
  });

  it('hides Cancel from a crewed technician who may drive the trip but may not reschedule', async () => {
    // The cancel route rides `reschedule Job` (job.routes.ts), NOT the crew verbs its three
    // sibling lifecycle routes use. Gating the button on `start` instead would hand every
    // technician a Cancel whose POST can only ever 403 - the exact defect VISIT_ACTIONS' own
    // comment exists to prevent, one row over.
    const TECH_ID = '00000000-0000-0000-0000-000000000001';
    const OWN_JOB_COND = { assignees: { some: { user_id: TECH_ID } } };
    const crewAbility = buildAbility([
      { action: 'read', subject: 'Job', conditions: OWN_JOB_COND },
      { action: 'start', subject: 'Job', conditions: OWN_JOB_COND },
      { action: 'arrive', subject: 'Job', conditions: OWN_JOB_COND },
    ] as never);
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return {
          data: {
            job: { ...BASE_JOB, assignees: [{ user: { id: TECH_ID, first_name: 'Test', last_name: 'Tech' } }] },
          },
        };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: crewAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    // They can still drive the trip they are crewed on...
    expect(within(row).getByRole('button', { name: 'Mark on site' })).toBeInTheDocument();
    // ...but calling it off is dispatch work. Absent, not disabled - house convention.
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('will not call a trip off with an empty reason', async () => {
    // cancelVisitSchema requires 1-5000 characters, so a blank confirm is a guaranteed 400 that
    // says nothing on screen. Whitespace counts as blank here, matching the schema's own
    // .min(1) once the server trims nothing for us.
    mockJobWithVisits([VISIT_1]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    const confirm = await screen.findByRole('button', { name: 'Cancel visit' });
    await userEvent.click(confirm);
    expect(mockApi.post).not.toHaveBeenCalled();

    // Spaces are not a reason either.
    await userEvent.type(await screen.findByLabelText('Reason'), '   ');
    await userEvent.click(confirm);
    expect(mockApi.post).not.toHaveBeenCalled();

    // And the dialog is still open, waiting - not silently dismissed.
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
  });
});

/**
 * S5 B3 (D11): the rail's per-visit control must post to the PER-VISIT route carrying that row's
 * id. The job-level verbs (POST /api/jobs/:id/{arrive,en-route,start}) take no visit id - the
 * server resolves one - so a node left wired to them returns 200, invalidates the right queries,
 * and stamps the wrong trip. #1550's class, and the reason this asserts the URL and not the
 * response.
 */
describe('v2 job page - the lifecycle rail acts per visit (S5 B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts a rail control to the route for THAT visit', async () => {
    mockJobWithVisits([VISIT_1, VISIT_2]);
    mockApi.post.mockResolvedValue({ data: { visit: {} } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });

    const node = within(await screen.findByRole('group', { name: 'Visit 2' }));
    await userEvent.click(node.getByRole('button', { name: 'Mark on the way' }));

    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/visits/v-2/en-route`);
  });
});

/**
 * S5 B8: the ROUTED page passed no `tz` to the rail, so every node dated on
 * DEFAULT_SCHEDULE_TIMEZONE ('America/New_York') while the hero two lines above rendered the same
 * job on the org zone - two contradictory dates on one screen. The v1 page passed it correctly,
 * so the guard that existed ran only against the page nobody can reach: #1551's drift, inverted.
 */
describe('v2 job page - the lifecycle rail dates on the ORG clock (S5 B8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dates Job Created on the org calendar day, not New York', async () => {
    // 17:00Z on Aug 1 is Aug 2 in Manila and Aug 1 in both UTC and New York.
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) {
        return { data: { job: { ...BASE_JOB, created_at: '2026-08-01T17:00:00.000Z' } } };
      }
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });

    const node = within(await screen.findByRole('group', { name: 'Job Created' }));
    expect(node.getByText('Aug 2')).toBeInTheDocument();
    expect(node.queryByText('Aug 1')).not.toBeInTheDocument();
  });
});

/**
 * S5: the rail must not GUESS while the visit list is unknown.
 *
 * The job payload and GET /api/jobs/:id/visits are two parallel queries and nothing gates the
 * render on the second, so an in-flight - or, permanently, a failed - visits fetch reaches the bar
 * as an empty array. The bar cannot tell that from "this job has no trips", so it drew the
 * visit-less shape over a job that actually holds visits: a Scheduled node marked unreached
 * (asserting nobody ever booked it) plus the JOB-level Start, whose POST /api/jobs/:id/start lets
 * the SERVER pick which trip to stamp - the exact hazard B2/B3 exist to prevent.
 */
describe('v2 job page - the rail waits for the visit list (S5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draws neither the Scheduled placeholder nor the job-level Start while the visits are still loading', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return new Promise(() => {});
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });

    // The rail itself IS on screen - this is not an assertion about an unrendered page.
    expect(await screen.findByRole('group', { name: 'Job Created' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Scheduled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
  });
});

// ─── Customer notifications come only from automations (scheduling-notifications 01) ────────
// The visit dialog used to host the hand-composed "Notify the customer" composer (default on),
// so a save through it either sent a one-off email beside the org's automation or, unticked,
// suppressed the automation for that occurrence. Two senders for one message. Now the dialog
// books the trip and says nothing about email: no fields, and a save body with NO notify key,
// which the visit routes read as "let the automation handle it".
describe('v2 job page - the visit dialog offers no notify fields and sends no notify keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockServer() {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) return { data: { visits: [VISIT_1, VISIT_2] } };
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    mockApi.post.mockResolvedValue({ data: { visit: VISIT_2 } });
    mockApi.patch.mockResolvedValue({ data: { visit: VISIT_2 } });
  }

  async function openJob() {
    mockServer();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();
  }

  async function fillWindow() {
    const startDate = await screen.findByLabelText('Start date');
    await userEvent.clear(startDate);
    await userEvent.type(startDate, '09/20/2026');
    await userEvent.tab();
    const startTime = screen.getByLabelText('Start time');
    await userEvent.clear(startTime);
    await userEvent.type(startTime, '9:00 AM');
    await userEvent.tab();
    const endDate = screen.getByLabelText('End date');
    await userEvent.clear(endDate);
    await userEvent.type(endDate, '09/20/2026');
    await userEvent.tab();
    const endTime = screen.getByLabelText('End time');
    await userEvent.clear(endTime);
    await userEvent.type(endTime, '11:30 AM');
    await userEvent.tab();
  }

  function expectNoNotifyFields() {
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  }

  it('Add Visit shows no notify fields, and the booking POST carries no notify key', async () => {
    await openJob();
    await userEvent.click(await screen.findByRole('button', { name: /add visit/i }));
    await screen.findByLabelText('Start date');

    expectNoNotifyFields();

    await fillWindow();
    await userEvent.click(screen.getByRole('button', { name: /book visit/i }));

    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/visits'));
    if (!call) throw new Error('no POST to the visits collection');
    const body = call[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('notify');
    expect(body).not.toHaveProperty('notify_customer');
  });

  it('Reschedule shows no notify fields, and the visit PATCH carries no notify key', async () => {
    await openJob();
    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: /reschedule/i }));
    await screen.findByLabelText('Start date');

    expectNoNotifyFields();

    await userEvent.click(screen.getByRole('button', { name: /save visit/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const call = mockApi.patch.mock.calls.find(([url]) => String(url).includes('/visits/v-2'));
    if (!call) throw new Error('no PATCH for visit 2');
    const body = call[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('notify');
    expect(body).not.toHaveProperty('notify_customer');
  });
});

// ─── Scheduling-notifications PRD: the stamp is a dispatch guard, not a receipt ──────────────
// The visit's `customer_email_sent_at` (and the job's scheduled-announcement stamp) record that
// an announcement occurrence HAPPENED, never that the customer received anything: in production
// 168 jobs were stamped as told in a month in which zero customer emails went out. "Was this
// customer told" is the automation ledger's question, so the visits card must not answer it off
// the stamp. This flips S7 / B10's receipt line.
describe('v2 job page - the visits card never reads the announcement stamp as a receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints no "customer notified" line for a stamped trip, and none for an unstamped one', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) {
        return {
          data: {
            visits: [
              // 2026-09-01T02:00:00Z is 10:00 AM Sep 1 in Manila.
              { ...VISIT_1, customer_email_sent_at: '2026-09-01T02:00:00.000Z' },
              { ...VISIT_2, customer_email_sent_at: null },
            ],
          },
        };
      }
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const stamped = await visitRow(1);
    expect(within(stamped).queryByText(/customer notified/i)).not.toBeInTheDocument();
    expect(within(stamped).queryByText(/Sep 1, 2026, 10:00 AM/)).not.toBeInTheDocument();

    const unstamped = visitRowSync(2);
    expect(within(unstamped).queryByText(/customer notified/i)).not.toBeInTheDocument();
  });
});

/**
 * Ran's acceptance run (2026-08-24): a failed visits fetch rendered as the definitive
 * "No visits booked yet." - the exact conflation useJobVisits's own S5 comment warns
 * against. The query lives at page level, so no tab switch ever remounts it, and with
 * refetchOnWindowFocus off the only recovery was a full reload. The card now says the
 * list is UNKNOWN and offers the retry the page otherwise cannot reach.
 */
describe('v2 job page - a visits fetch that failed is not an empty list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says the list could not load - and Retry recovers it without a reload', async () => {
    let failuresLeft = 1;
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/visits')) {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('network down');
        }
        return { data: { visits: [VISIT_1] } };
      }
      if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
      if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job: BASE_JOB } };
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });

    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    // The honest answer, not the confident lie.
    expect(await screen.findByText(/Couldn't load this job's visits/)).toBeInTheDocument();
    expect(screen.queryByText('No visits booked yet.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await visitRow(1)).toBeInTheDocument();
  });
});

/**
 * Scheduling-notifications slice 09: ONE next step per live row, not five equal ghost buttons.
 *
 * The primary button is the next milestone in lifecycle order that THIS viewer may perform; the
 * later permitted milestones sit behind a "Skip to" menu; Reschedule and Cancel live in a
 * separate, right-aligned office group. Each control keeps riding its own route's permission, so
 * a verb the role lacks is absent rather than present and failing (PRD stories 18, 19, 20, 21,
 * 27).
 */
describe('v2 job page - the visit row offers one next step and a Skip to menu (slice 09)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Mark on the way as the primary step and the later milestones under Skip to', async () => {
    mockJobWithVisits([VISIT_1]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    expect(within(row).getByRole('button', { name: 'Mark on the way' })).toBeInTheDocument();
    // The later milestones are NOT laid out as equal buttons beside it.
    expect(within(row).queryByRole('button', { name: 'Mark on site' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Start work' })).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: 'Skip to' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Mark on site', 'Start work']);
  });

  it('offers an on-site trip Start work as the primary step and Complete under Skip to', async () => {
    mockJobWithVisits([VISIT_1_ON_SITE]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    expect(within(row).getByRole('button', { name: 'Start work' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Complete' })).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: 'Skip to' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Complete']);
  });

  it('posts a Skip to pick to the route of THAT visit', async () => {
    mockJobWithVisits([VISIT_1, VISIT_2]);
    mockApi.post.mockResolvedValue({ data: { visit: { ...VISIT_2, status: 'IN_PROGRESS' } } });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(2);
    await userEvent.click(within(row).getByRole('button', { name: 'Skip to' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Start work' }));

    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/visits/v-2/start`);
  });

  it('offers a trip with one permitted step left no Skip to menu at all', async () => {
    mockJobWithVisits([{ ...VISIT_1, status: 'IN_PROGRESS', started_at: '2026-09-05T01:30:00.000Z' }]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    // Complete is still the ONE primary step, in the step group...
    const step = within(row).getByRole('group', { name: 'Next step' });
    expect(within(step).getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    // ...with nothing left to skip to, so no menu is offered rather than an empty one.
    expect(within(row).queryByRole('button', { name: 'Skip to' })).toBeNull();
  });

  it('keeps Reschedule and Cancel in an office group apart from the milestone step (story 21)', async () => {
    mockJobWithVisits([VISIT_1]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    const office = within(row).getByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
    expect(within(office).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The crew's step is NOT in that group.
    expect(within(office).queryByRole('button', { name: 'Mark on the way' })).toBeNull();
    expect(within(office).queryByRole('button', { name: 'Skip to' })).toBeNull();
  });

  it('labels a skipped stamp as skipped in the stamps line, and a tapped one not (story 23)', async () => {
    // Slice 08's shape for "Mark on site" tapped on a merely scheduled trip: the on-the-way stamp
    // carries the SAME instant and the skipped marker. Without the marker rendered, the row reads
    // as if the crew left and arrived in the same second.
    mockJobWithVisits([{
      ...VISIT_1,
      status: 'ON_SITE',
      en_route_at: '2026-09-05T01:12:00.000Z',
      en_route_skipped: true,
      on_site_at: '2026-09-05T01:12:00.000Z',
    }]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    expect(within(row).getByText(/^On the way \(skipped\)/)).toBeInTheDocument();
    // The stamp label is lower-case "On site"; the status word above it is the registry's "On Site".
    expect(within(row).getByText(/^On site /)).not.toHaveTextContent(/skipped/);
  });
});

describe('v2 job page - the visit row stays intact on a narrow viewport (slice 09 follow-up f1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets the actions wrap under the visit text as a full-width row, milestone step left and office group right, instead of clipping past the card edge', async () => {
    // At 375px the milestone group plus the office group run to about 370px. A container that
    // may never shrink and a row that may never break its line leave only one outcome: the visit
    // text is squeezed to a character per line and Reschedule / Cancel are clipped past the card.
    // jsdom lays nothing out, so the assertion is on the rules that make the wrap possible - the
    // same rules the lead walkthrough tab's live row already uses.
    mockJobWithVisits([VISIT_1]);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });
    await openVisitsTab();

    const row = await visitRow(1);
    const step = within(row).getByRole('group', { name: 'Next step' });
    const office = within(row).getByRole('group', { name: 'Office actions' });
    const actions = office.parentElement!;
    // Both groups share ONE actions container, so they wrap together under the text.
    expect(step.parentElement).toBe(actions);
    // The row may break its line...
    expect(row).toHaveClass('flex-wrap');
    // ...the actions container takes the whole line when it does, spreading its two groups...
    expect(actions).toHaveClass('basis-full');
    expect(actions).toHaveClass('justify-between');
    // ...and the office group hugs the end of that line even when no milestone step precedes it.
    expect(office).toHaveClass('ms-auto');
  });
});

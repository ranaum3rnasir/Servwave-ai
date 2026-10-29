/**
 * The ROUTED job page must open its schedule dialog on the slot the job already has.
 *
 * #1535 fixed exactly this - and fixed it in `pages/JobDetailPage`, which App.tsx no longer
 * mounts: the route table is built entirely by `v2Routes()`, so the v1 page is dead code and
 * the fork users actually reach kept mounting AssignJobDialog with no `defaultStart` /
 * `defaultEnd` / `defaultIsAllDay` / `mode`. Reschedule therefore opened four empty pickers
 * and silently discarded the existing slot unless the user retyped all of it.
 *
 * Reported against prod job 698776 (Alpha Doors), whose row was correct the whole time.
 *
 * The org zone is Asia/Manila deliberately: it differs from every plausible runner zone, so
 * these assertions fail on browser-local behaviour rather than passing by coincidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobDetailPage from '../JobDetailPage';

const ORG_TZ = 'Asia/Manila'; // UTC+8, no DST.
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>();
  return {
    ...actual,
    useAssignableUsers: () => ({
      data: [{ id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz', role: 'TECHNICIAN', department: null }],
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

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false }),
  };
});

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
  // The reported shape: a multi-day window. 2026-09-05T01:00:00Z is 9:00 AM Sep 5 in Manila,
  // and it runs to 9:00 AM Sep 8 - four calendar days, like prod job 698776.
  scheduled_start: '2026-09-05T01:00:00.000Z',
  scheduled_end: '2026-09-08T01:00:00.000Z',
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

function mockJob(job: Record<string, unknown> = BASE_JOB) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/visits')) return { data: { visits: [] } };
    if (url.includes('/financials')) return { data: { final_invoice: null, invoices: [], payments: [] } };
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } };
    return { data: {} };
  });
}

async function openScheduleTile() {
  renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
  await screen.findByRole('heading', { name: /J00001/ });
  await userEvent.click(screen.getByRole('button', { name: /reschedule job/i }));
}

describe('v2 job page - the schedule dialog opens on the slot the job already has', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds all four pickers from the job, in the ORG zone', async () => {
    mockJob();
    await openScheduleTile();

    // 01:00Z is 9:00 AM in Manila. A browser-local render reads 9:00 AM only in UTC+8.
    expect(await screen.findByLabelText('Start date')).toHaveValue('09/05/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // The END date is the point: a same-day assumption would print 09/05 here and quietly
    // shorten a four-day job to a few hours the moment anything else was edited.
    expect(screen.getByLabelText('End date')).toHaveValue('09/08/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('9:00 AM');
  });

  it('says Reschedule, not Assign, when reached from the schedule tile', async () => {
    mockJob();
    await openScheduleTile();

    // `mode` travels with the defaults; dropping one dropped the other, so the crew-focused
    // copy was all a user ever saw from a date/time-focused trigger.
    expect(await screen.findByRole('heading', { name: 'Reschedule Job' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
  });

  it('offers Schedule Job for a job with no slot yet, with the pickers empty', async () => {
    mockJob({ ...BASE_JOB, status: 'UNSCHEDULED', scheduled_start: null, scheduled_end: null });
    await openScheduleTile();

    expect(await screen.findByRole('heading', { name: 'Schedule Job' })).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).toHaveValue('');
  });

  it('carries the all-day flag through, so the dialog opens on the date fields', async () => {
    // Midnight Sep 5 through midnight Sep 8 in Manila - an all-day job spanning three days.
    mockJob({
      ...BASE_JOB,
      is_all_day: true,
      scheduled_start: '2026-09-04T16:00:00.000Z',
      scheduled_end: '2026-09-07T16:00:00.000Z',
    });
    await openScheduleTile();

    expect(await screen.findByLabelText('Start date')).toHaveValue('09/05/2026');
    // Displayed INCLUSIVE: the stored end is exclusive midnight on the 8th, and the last day
    // the job actually occupies is the 7th.
    expect(screen.getByLabelText('End date')).toHaveValue('09/07/2026');
    // All-day means no time fields at all.
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
  });
});

/**
 * The other half of seeding the pickers: what the page must NOT then say.
 *
 * Both crew-focused triggers mount the same dialog with the same seeded window, so once the
 * window is shown it is one submit away from being restated. assign() treats any
 * scheduled_start as a booking - status to SCHEDULED, then milestoneClears('scheduled') nulls
 * en_route_at / on_site_at / started_at / completed_at / cancelled_at - so adding a
 * technician to a COMPLETED job silently un-completed it, and the dashboard lost it.
 */
describe('v2 job page - adding crew is not a reschedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('posts crew alone when the window was only displayed, on a COMPLETED job', async () => {
    // Crew already on the job: the submit is disabled while the crew picker is empty, and a
    // user who opens Assign on a finished job is looking at a crew that exists.
    mockJob({
      ...BASE_JOB,
      status: 'COMPLETED',
      completed_at: '2026-09-08T02:00:00.000Z',
      assignees: [{ user: { id: 'u-dana', first_name: 'Dana', last_name: 'Ruiz', role: 'TECHNICIAN' } }],
    });
    renderWithProviders(<JobDetailPage />, { ability: adminAbility, initialEntries: [`/jobs/${JOB_ID}`] });
    await screen.findByRole('heading', { name: /J00001/ });

    await userEvent.click(screen.getByRole('button', { name: /^Actions$/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Assign$/ }));

    // The dialog still SHOWS the job's window - that is what makes the omission meaningful
    // rather than an accident of an empty form.
    expect(await screen.findByLabelText('Start date')).toHaveValue('09/05/2026');

    // Crew is already on the job, so both the dialog and its submit read "Reassign".
    await userEvent.click(screen.getByRole('button', { name: /^Reassign$/ }));

    const assignCall = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/assign'));
    expect(assignCall).toBeDefined();
    const payload = assignCall![1] as Record<string, unknown>;
    expect(payload.scheduled_start).toBeUndefined();
    expect(payload.scheduled_end).toBeUndefined();
  });
});

/**
 * The board's reschedule confirm sends NO customer notification of its own.
 *
 * Customer notifications come only from automations (scheduling-notifications slice 01). Until
 * this slice the confirm dialog carried a hand-composed "Notify the customer" composer, defaulted
 * on, and every drag-and-confirm reached the wire with an explicit notify object: ticked, a
 * one-off email beside the org's "Job is rescheduled" automation; unticked, an explicit decline
 * that suppressed the automation for that occurrence. Now the confirm shows no notify fields and
 * the request carries no notify key at all, which every reschedule route reads as "let the
 * automation handle it". The routes still accept the keys for other clients.
 *
 * The UNSCHEDULE confirm followed (follow-up f3): it offered the same composer over the per-visit
 * cancel and /unassign doors, the one hand-composed customer send left on the board. It now shows
 * no notify fields and both doors carry no notify key, so nothing on the board emails a customer
 * outside the org's automations.
 *
 * These drive the ROUTED board through the same drag-and-confirm gesture boardReadsVisits uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14, minute = 0): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0)).toISOString();
}

const CREW = [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];

const TWO_VISIT_JOB = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: CREW,
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
  ],
};

/** One trip only - the commonest shape on the board, and the one /unassign owns. */
const SINGLE_VISIT_JOB = {
  ...TWO_VISIT_JOB,
  id: 'job-2',
  job_number: 'J00042',
  visits: [
    { id: 'v9', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }] },
  ],
};

/** A job the board can still draw with no visit row at all - the /assign fallback. */
const NO_VISIT_JOB = { ...TWO_VISIT_JOB, id: 'job-3', job_number: 'J00043', visits: [] };

/** A lead whose walkthrough sits in Alice's lane, so it can be dragged like any other card. */
const WALKTHROUGH_LEAD = {
  id: 'lead-1',
  lead_number: 'L00007',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  walkthrough_scheduled_at: dayAt(1, 10),
  walkthrough_duration_minutes: 60,
  walkthrough_performers: [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }],
  tags: [],
};

function mockBoard(jobs: Array<Record<string, unknown>>, leads: Array<Record<string, unknown>> = []) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') {
      const params = (config?.params ?? {}) as { walkthrough_after?: string };
      return Promise.resolve({ data: { leads: params.walkthrough_after ? leads : [] } });
    }
    // The board's roster moved to the scoped endpoint; serve it the same fixture.
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({
        data: { users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] },
      });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

/** Mount the member board over a given set of rows and wait for a card to be on it. */
async function mountBoard(
  jobs: Array<Record<string, unknown>>,
  leads: Array<Record<string, unknown>> = [],
  waitFor: RegExp = /J00041/,
) {
  mockBoard(jobs, leads);
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(waitFor);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
}

/** Drag one card that is already on the board onto another day in the same lane. */
async function dropOnDay(boardId: string, toOffset: number, type: 'job' | 'walkthrough' = 'job') {
  const cell = await screen.findByTestId(cellFor(toOffset));
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? type : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

/** The original two-visit gesture: mount, then drag visit 2 to another day. */
async function dragCard(boardId: string, toOffset: number) {
  await mountBoard([TWO_VISIT_JOB]);
  await dropOnDay(boardId, toOffset);
}

describe('the board confirm sends no notify keys on the job doors (scheduling-notifications 01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows no notify fields in the confirm, and the visit PATCH carries no notify key', async () => {
    await dragCard('jv-v2', 5);

    const confirm = await screen.findByRole('button', { name: /Confirm reschedule/i });
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule & send/i })).not.toBeInTheDocument();

    fireEvent.click(confirm);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const body = mockApi.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    // Absent, not an explicit decline: `notify_customer: false` would suppress the automation
    // for this occurrence, and the automation is now the only thing that tells the customer.
    expect(body).not.toHaveProperty('notify');
    expect(body).not.toHaveProperty('notify_customer');
    expect(body).toMatchObject({ scheduled_start: expect.any(String), scheduled_end: expect.any(String) });
  });

  it('a job with NO visit row confirms through /assign with no notify keys', async () => {
    await mountBoard([NO_VISIT_JOB], [], /J00043/);
    await dropOnDay('job-3', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/assign'));
    if (!call) throw new Error('no /assign POST');
    const body = call[1] as Record<string, unknown>;
    // FLAT keys on this door, so the flat name is the one that must be absent.
    expect(body).not.toHaveProperty('notify_customer');
    expect(body).not.toHaveProperty('notify_recipient_email');
    expect(body).not.toHaveProperty('notify_message');
    expect(body).not.toHaveProperty('notify');
  });

  it('the 409 "Schedule Anyway" retry carries force and still no notify keys', async () => {
    mockApi.patch.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [] } },
    });
    await dragCard('jv-v2', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Schedule Anyway/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(2));
    const retry = mockApi.patch.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(retry.force).toBe(true);
    expect(retry).not.toHaveProperty('notify');
    expect(retry).not.toHaveProperty('notify_customer');
  });
});

describe('the board confirm sends no notify keys on the lead door (scheduling-notifications 01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('a WALKTHROUGH shows no notify fields and confirms through /walkthrough/schedule with no notify keys', async () => {
    await mountBoard([], [WALKTHROUGH_LEAD], /L00007/);
    await dropOnDay('wt-lead-1', 5, 'walkthrough');

    const confirm = await screen.findByRole('button', { name: /Confirm reschedule/i });
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule & send/i })).not.toBeInTheDocument();

    fireEvent.click(confirm);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/walkthrough/schedule'));
    if (!call) throw new Error('no walkthrough schedule POST');
    const body = call[1] as Record<string, unknown>;
    // FLAT keys on this door, so the flat name is the one that must be absent.
    expect(body).not.toHaveProperty('notify_customer');
    expect(body).not.toHaveProperty('notify_recipient_email');
    expect(body).not.toHaveProperty('notify_message');
    expect(body).not.toHaveProperty('notify');
    expect(body).toMatchObject({ walkthrough_scheduled_at: expect.any(String), performer_ids: ['m-alice'] });
  });
});

describe('the unschedule confirm sends no notify keys on the job doors (scheduling-notifications f3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  /** Open a card's editor, then take its "Move to Unscheduled" action - the page owns the
   *  confirm and the write, exactly as it does for the drag-to-sidebar gesture. */
  async function unscheduleFrom(number: RegExp, cardText: RegExp, jobs: Array<Record<string, unknown>>) {
    await mountBoard(jobs, [], number);
    const [card] = await screen.findAllByText(cardText);
    if (!card) throw new Error('no card to unschedule');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));
  }

  it('shows no notify fields, and the per-visit cancel carries only its reason', async () => {
    await unscheduleFrom(/J00041/, /Visit 2 of 2/, [TWO_VISIT_JOB]);

    const confirm = await screen.findByRole('button', { name: /^Unschedule$/i });
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();

    fireEvent.click(confirm);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/cancel'));
    if (!call) throw new Error('no per-visit cancel POST');
    expect(call[0]).toBe('/api/jobs/job-1/visits/v2/cancel');
    // Absent, not an explicit decline: the nested object is what this route reads as a
    // dispatcher's decision, and the web app no longer makes one here.
    expect(call[1]).toEqual({ cancelled_reason: 'Removed from schedule' });
  });

  it('unscheduling a SINGLE-visit job posts /unassign with an empty body', async () => {
    await unscheduleFrom(/J00042/, /J00042/, [SINGLE_VISIT_JOB]);

    await screen.findByText(/Move to Unscheduled\?/);
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/unassign'));
    if (!call) throw new Error('no /unassign POST');
    expect(call[0]).toBe('/api/jobs/job-2/unassign');
    expect(call[1]).toEqual({});
  });
});

describe('a gesture that cannot send does not offer to (S7, B9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('removing a WALKTHROUGH from the board shows no composer, because that route sends nothing', async () => {
    await mountBoard([], [WALKTHROUGH_LEAD], /L00007/);
    const [card] = await screen.findAllByText(/L00007/);
    if (!card) throw new Error('no walkthrough card');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));

    // The confirm is up...
    expect(await screen.findByText(/Move to Unscheduled\?/)).toBeInTheDocument();
    // ...and offers no tick, because POST /leads/:id/walkthrough/unschedule takes no notify and
    // no cancelled-walkthrough template exists. An offer here would be discarded in silence.
    expect(screen.queryByRole('checkbox', { name: /notify the customer/i })).not.toBeInTheDocument();
  });
});

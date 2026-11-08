// A job with no schedule yet must be schedulable from the job page's own dialog, not only
// by dragging its card onto the board. The dialog used to keep the schedule as two combined
// 'YYYY-MM-DDTHH:mm' strings while the shared fields edit four independent ones, so every
// partial edit (a date before its time) collapsed to '' and the state never accumulated -
// Schedule then posted crew with no times and closed, looking like nothing happened.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';

// The real picker fetches the assignable roster; this test is about the time fields.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['tech-1'])}>
      crew:{value.join(',') || 'none'}
    </button>
  ),
}));

const post = api.post as ReturnType<typeof vi.fn>;

const renderDialog = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssignJobDialog open onOpenChange={() => {}} jobId="job-1" mode="schedule" />
    </QueryClientProvider>,
  );
};

/** [start date, start time, end date, end time] - the four fields, in render order. */
const timeFields = () => screen.getAllByRole('textbox') as HTMLInputElement[];

describe('AssignJobDialog - scheduling a job that has no schedule yet', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('keeps the start date after picking it, before any time is set', async () => {
    const user = userEvent.setup();
    renderDialog();

    const [startDate] = timeFields();
    await user.type(startDate!, '09/01/2026');
    await user.tab();

    // Asserted on the END date, not the start: the field the user typed into holds its own
    // display text either way, so only a field nobody touched proves the DIALOG kept the
    // date. `withStartDate` mirrors the start day into an unset end day.
    expect(timeFields()[2]!.value).toBe('09/01/2026');
  });

  it('posts the schedule that was entered field by field', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByText(/^crew:/));

    const [startDate, startTime, endDate, endTime] = timeFields();
    await user.type(startDate!, '09/01/2026');
    await user.tab();
    await user.type(startTime!, '9:00 AM');
    await user.tab();
    await user.type(endDate!, '09/01/2026');
    await user.tab();
    await user.type(endTime!, '11:00 AM');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.assignee_ids).toEqual(['tech-1']);
    // Org zone defaults to America/New_York; 9:00 AM EDT on 2026-09-01 is 13:00Z.
    expect(payload.scheduled_start).toBe('2026-09-01T13:00:00.000Z');
    expect(payload.scheduled_end).toBe('2026-09-01T15:00:00.000Z');
  });

  // Ran's acceptance run, scenario 4 (2026-08-24): the dialog required a crew pick before
  // Schedule would even enable, "which is a violation of the decision that visits can be
  // scheduled without a crew." assignJobSchema's assignee_ids is REPLACE semantics and
  // explicitly accepts [] server-side; the board's reschedule confirm already renders
  // "Crew (unchanged): No crew" and the notify email falls back to "Our team" for exactly
  // this state. Only 'assign' mode (below) still gates on a pick.
  it('schedules a job with no crew selected, posting an empty crew', async () => {
    const user = userEvent.setup();
    renderDialog();

    const [startDate, startTime, endDate, endTime] = timeFields();
    await user.type(startDate!, '09/01/2026');
    await user.tab();
    await user.type(startTime!, '9:00 AM');
    await user.tab();
    await user.type(endDate!, '09/01/2026');
    await user.tab();
    await user.type(endTime!, '11:00 AM');
    await user.tab();

    const submit = screen.getByRole('button', { name: /^Schedule$/ });
    expect(submit).not.toBeDisabled();
    await user.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.assignee_ids).toEqual([]);
    expect(payload.scheduled_start).toBe('2026-09-01T13:00:00.000Z');
    expect(payload.scheduled_end).toBe('2026-09-01T15:00:00.000Z');
  });

  it('still posts the seeded schedule unchanged when rescheduling', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AssignJobDialog
          open
          onOpenChange={() => {}}
          jobId="job-2"
          mode="schedule"
          defaultStart="2026-09-01T13:00:00.000Z"
          defaultEnd="2026-09-01T15:00:00.000Z"
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.scheduled_start).toBe('2026-09-01T13:00:00.000Z');
    expect(payload.scheduled_end).toBe('2026-09-01T15:00:00.000Z');
  });
});

/**
 * All Day used to offer ONE date and hardcode the end to the next morning, so a multi-day
 * all-day job (a two-week install) was unsayable: whatever span the user meant, the dialog
 * posted a single day. Both date fields read INCLUSIVE - "Aug 17 to Aug 19" runs through the
 * end of the 19th - and the exclusive end instant the API stores is derived at the seam.
 */
describe('AssignJobDialog - an all-day job that spans several days', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  const checkAllDay = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByLabelText('All Day'));
  };

  it('offers a start AND an end date, not a single date', async () => {
    const user = userEvent.setup();
    renderDialog();
    await checkAllDay(user);

    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();
    // The times are what All Day removes; the span is not.
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
  });

  it('posts midnight-to-midnight across the whole inclusive range', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText(/^crew:/));
    await checkAllDay(user);

    await user.type(screen.getByLabelText('Start date'), '09/01/2026');
    await user.tab();
    // Cleared first: picking the start already mirrored a one-day span into this field,
    // so typing alone would append to '09/01/2026'.
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '09/03/2026');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.is_all_day).toBe(true);
    // Midnight EDT is 04:00Z. The end is the 4th, not the 3rd: the 3rd is included, so the
    // job runs until the instant the 4th begins.
    expect(payload.scheduled_start).toBe('2026-09-01T04:00:00.000Z');
    expect(payload.scheduled_end).toBe('2026-09-04T04:00:00.000Z');
  });

  it('still posts one whole day when both dates are the same', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText(/^crew:/));
    await checkAllDay(user);

    await user.type(screen.getByLabelText('Start date'), '09/01/2026');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    // Picking only a start must not post a zero-length range - it is one full day.
    expect(payload.scheduled_start).toBe('2026-09-01T04:00:00.000Z');
    expect(payload.scheduled_end).toBe('2026-09-02T04:00:00.000Z');
  });

  it('keeps the span when All Day is ticked on a timed multi-day job', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AssignJobDialog
          open
          onOpenChange={() => {}}
          jobId="job-3"
          mode="schedule"
          // Sep 1 9:00 AM through Sep 4 9:00 AM EDT - the reported four-day shape.
          defaultStart="2026-09-01T13:00:00.000Z"
          defaultEnd="2026-09-04T13:00:00.000Z"
        />
      </QueryClientProvider>,
    );

    await checkAllDay(user);

    // Ticking All Day must not collapse a four-day job to one - the last day it occupies
    // is the 4th, and that is what the inclusive End date shows.
    expect(screen.getByLabelText('Start date')).toHaveValue('09/01/2026');
    expect(screen.getByLabelText('End date')).toHaveValue('09/04/2026');
  });
});

// Seeding the pickers from the job (so Reschedule opens on the current slot) turned the
// crew-focused triggers into schedule writes: Actions > Assign and the Team card post the
// same body, so a window that was only ever DISPLAYED came back as a restatement. The
// backend reads any scheduled_start as "this job is being (re)booked" - job.controller.ts
// forces status to SCHEDULED and runs milestoneClears('scheduled'), nulling en_route_at,
// on_site_at, started_at, completed_at, cancelled_at. Adding a technician to a COMPLETED
// job therefore silently un-completed it. The API contract is what makes the fix simple:
// omitting both instants means "leave the schedule alone", so an untouched window is not
// sent at all.
describe('AssignJobDialog - a window that was only displayed is not a reschedule', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  const renderSeeded = (extra: Record<string, unknown> = {}) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AssignJobDialog
          open
          onOpenChange={() => {}}
          jobId="job-1"
          mode="assign"
          isScheduled
          defaultsAreCurrentSchedule
          currentAssigneeIds={['tech-0']}
          defaultStart="2026-09-01T13:00:00.000Z"
          defaultEnd="2026-09-04T21:00:00.000Z"
          {...extra}
        />
      </QueryClientProvider>,
    );
  };

  it('omits both instants when only the crew changed', async () => {
    const user = userEvent.setup();
    renderSeeded();

    // The pickers still SHOW the job's window - that is the whole point of seeding them.
    expect(timeFields()[0]!.value).toBe('09/01/2026');
    expect(timeFields()[2]!.value).toBe('09/04/2026');

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.assignee_ids).toEqual(['tech-1']);
    // Not merely equal to the old value - ABSENT. Sending it back unchanged still reads as
    // a booking to assign(), which is what nulls the milestones.
    expect(payload.scheduled_start).toBeUndefined();
    expect(payload.scheduled_end).toBeUndefined();
  });

  it('still posts the schedule once a field is actually edited', async () => {
    const user = userEvent.setup();
    renderSeeded();

    const startTime = timeFields()[1]!;
    await user.clear(startTime);
    await user.type(startTime, '10:00 AM');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.scheduled_start).toBe('2026-09-01T14:00:00.000Z');
    // The shared fields preserve duration when the start time moves, so the end follows it.
    expect(payload.scheduled_end).toBe('2026-09-04T22:00:00.000Z');
  });

  // The withhold is VALUE-based, not touch-based, and this is what proves the difference: a
  // field edited and put back holds exactly what it was seeded with, so nothing was changed and
  // nothing may be posted. A "the user focused this field" flag would fail here, and would fail
  // in the direction that un-completes a job.
  it('omits the instants when a field is edited and then restored', async () => {
    const user = userEvent.setup();
    renderSeeded();

    const startTime = timeFields()[1]!;
    await user.clear(startTime);
    await user.type(startTime, '10:00 AM');
    await user.tab();
    await user.clear(startTime);
    await user.type(startTime, '9:00 AM');
    await user.tab();

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.scheduled_start).toBeUndefined();
    expect(payload.scheduled_end).toBeUndefined();
  });

  // The all-day branch renders a DIFFERENT pair of controls (two DatePickers, no times) and
  // `allDayRange` rewrites the whole value object whenever either is touched. The snapshot has to
  // survive that shape, or adding a technician to an all-day job re-books it.
  it('omits both instants on an ALL-DAY job whose dates were only displayed', async () => {
    const user = userEvent.setup();
    renderSeeded({
      defaultIsAllDay: true,
      defaultStart: '2026-09-01T04:00:00.000Z',
      defaultEnd: '2026-09-05T04:00:00.000Z',
    });

    expect(screen.getByLabelText('Start date')).toHaveValue('09/01/2026');

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.scheduled_start).toBeUndefined();
    expect(payload.scheduled_end).toBeUndefined();
    // is_all_day rides along either way: assign() resolves an omitted flag against the job's
    // current window, and the dialog sending it keeps the two halves saying the same thing.
    expect(payload.is_all_day).toBe(true);
  });

  // The other direction, so the withhold cannot be read as "this dialog never posts a schedule
  // from a crew trigger": ticking All Day IS an edit of the window and must go out.
  it('posts the window when All Day is toggled, because that IS a change', async () => {
    const user = userEvent.setup();
    renderSeeded();

    await user.click(screen.getByLabelText('All Day'));
    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.is_all_day).toBe(true);
    expect(payload.scheduled_start).toBeDefined();
    expect(payload.scheduled_end).toBeDefined();
  });

  it('reassigns a job that holds a start and no end', async () => {
    const user = userEvent.setup();
    // updateJobSchema has no start/end pairing refine, so a PATCH can leave a job in this
    // state. assignJobSchema DOES refine, so posting the lone seeded start would 400.
    renderSeeded({ defaultEnd: undefined });

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Reassign$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.scheduled_start).toBeUndefined();
    expect(payload.scheduled_end).toBeUndefined();
  });
});

/**
 * Ran's acceptance run, scenario 1 (2026-08-24): schedule a job from the job page's own
 * dialog and the Visits tab kept "No visits booked yet." until a full reload. /assign has
 * created Visit 1 through the door since multi-visit S2, but this dialog's success path
 * never invalidated the visits query, and with a 5-minute staleTime and window-focus
 * refetch off, nothing else ever refetched it. The job payload WAS invalidated, so the
 * hero tile showed the new window beside a visit list that denied the trip existed.
 */
describe('AssignJobDialog - the visit list a successful schedule leaves behind', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('invalidates the job-visits query on success', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <AssignJobDialog
          open
          onOpenChange={() => {}}
          jobId="job-3"
          mode="schedule"
          defaultStart="2026-09-01T13:00:00.000Z"
          defaultEnd="2026-09-01T15:00:00.000Z"
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByText(/^crew:/));
    await user.click(screen.getByRole('button', { name: /^Schedule$/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['job-visits', 'job-3'] }),
    );
  });
});

// The crew-optional fix above is 'schedule' mode only. 'assign' mode is the one this
// dialog exists to gate: assign()'s assignee_ids is REPLACE semantics, so an empty submit
// there would silently CLEAR a crew that was already on the job, not merely leave it
// unset. That asymmetry is why the submit gate still tests mode !== 'schedule'.
describe('AssignJobDialog - assign mode still requires a crew pick', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('disables Assign until a crew member is picked, then submits it', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AssignJobDialog open onOpenChange={() => {}} jobId="job-4" mode="assign" />
      </QueryClientProvider>,
    );

    const submit = screen.getByRole('button', { name: /^Assign$/ });
    expect(submit).toBeDisabled();

    await user.click(screen.getByText(/^crew:/));
    expect(submit).not.toBeDisabled();

    await user.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.assignee_ids).toEqual(['tech-1']);
  });
});

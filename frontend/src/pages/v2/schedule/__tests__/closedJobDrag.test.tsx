import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { buildAbility } from '@/lib/ability';
import { renderSchedule, serveSchedule } from '@/__tests__/harness/schedulePage';
import { addDays, format, startOfWeek } from 'date-fns';
import api from '@/lib/axios';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import { useAuthStore } from '@/stores/auth.store';

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

/**
 * Roles & Permissions, PRD 6, S06.17 - a drag the server refuses because the job is Done or Cancelled.
 *
 * A Done or Cancelled job leaves only through Reopen, so the server answers a drag of its card with 409 "Reopen this job
 * first" (code JOB_CLOSE_OUT_REFUSED). That 409 lists no conflicts: it is a refusal, not a double-booking. The board shows
 * the server's words as its error toast, offers no "Schedule Anyway", and the card snaps back to where it was. A 409 that
 * does list conflicts keeps its "Schedule Anyway" (rescheduleNotify.test.tsx).
 *
 * A board that already knows the job is Done or Cancelled never lets the card move (closedJobCard.test.tsx). What is left
 * for the server's refusal is a board that has not yet heard the job closed (another tab, another person), so these jobs
 * still read as open when the board draws them.
 *
 * These drive the ROUTED board through the same drag-and-confirm gesture rescheduleNotify uses.
 */

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

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' };
const REOPEN_FIRST = 'Reopen this job first';
const REFUSAL = { response: { status: 409, data: { error: REOPEN_FIRST, code: 'JOB_CLOSE_OUT_REFUSED' } } };

/** A job the server has closed since the board last loaded: the board still draws it as open. */
const closedMeanwhile = (over: Record<string, unknown>) => ({
  id: 'job-1',
  job_number: 'J00051',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: [{ user: ALICE }],
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  ...over,
});

/** A trip-less job the board still draws, moved through /assign. */
const NO_VISIT_JOB = closedMeanwhile({ id: 'job-3', job_number: 'J00053', visits: [] });
/** A job with a trip, moved through the per-visit PATCH. */
const ONE_VISIT_JOB = closedMeanwhile({
  visits: [{ id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: [{ user_id: ALICE.id, user: ALICE }] }],
});

function mockBoard(jobs: Array<Record<string, unknown>>) {
  serveSchedule({ jobs: jobs, bucketJobs: [], users: [{ ...ALICE, is_active: true, role: 'TECHNICIAN' }] });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

async function dragCard(job: Record<string, unknown>, boardId: string, toOffset: number) {
  mockBoard([job]);
  renderSchedule({ ability: ADMIN });
  await screen.findAllByText(new RegExp(String(job.job_number)));
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
  const cell = await screen.findByTestId(cellFor(toOffset));
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'job' : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

describe('a drag the server refuses with "Reopen this job first"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows the server\'s words for a trip-less job moved through /assign, and offers no way to schedule anyway', async () => {
    mockApi.post.mockRejectedValueOnce(REFUSAL);
    await dragCard(NO_VISIT_JOB, 'job-3', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    expect(await screen.findByText(REOPEN_FIRST)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Schedule Anyway/i })).not.toBeInTheDocument();
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
  });

  it('shows the server\'s words for a trip moved through the per-visit PATCH, and offers no way to schedule anyway', async () => {
    mockApi.patch.mockRejectedValueOnce(REFUSAL);
    await dragCard(ONE_VISIT_JOB, 'jv-v1', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    expect(await screen.findByText(REOPEN_FIRST)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Schedule Anyway/i })).not.toBeInTheDocument();
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
  });
});

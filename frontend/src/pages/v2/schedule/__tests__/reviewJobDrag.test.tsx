/**
 * Roles & Permissions, PRD 6, S06.18 - a drag the server refuses because the job is in Office review or Ready to close.
 *
 * A calendar drag of a job in review is a backward move: it needs Complete jobs as well as Assign people to jobs. Without it the
 * server answers 409 "Only someone who can complete jobs can move this job out of office review." (code
 * JOB_CLOSE_OUT_REFUSED). That 409 lists no conflicts: it is a refusal, not a double-booking. The board shows the server's
 * words as its error toast, offers no "Schedule Anyway", and the card snaps back to where it was (S06.17 made the board
 * read a 409 as a conflict only when it lists them).
 *
 * These drive the ROUTED board through the same drag-and-confirm gesture closedJobDrag uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' };
const NEEDS_COMPLETE = 'Only someone who can complete jobs can move this job out of office review.';
const REFUSAL = { response: { status: 409, data: { error: NEEDS_COMPLETE, code: 'JOB_CLOSE_OUT_REFUSED' } } };

const inReview = (over: Record<string, unknown>) => ({
  id: 'job-1',
  job_number: 'J00051',
  status: 'OFFICE_REVIEW',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: [{ user: ALICE }],
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  ...over,
});

/** A trip-less job the board still draws, moved through /assign. */
const NO_VISIT_JOB = inReview({ id: 'job-3', job_number: 'J00053', visits: [] });
function mockBoard(jobs: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : jobs } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: [{ ...ALICE, is_active: true, role: 'TECHNICIAN' }] } });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

async function dragCard(job: Record<string, unknown>, boardId: string, toOffset: number) {
  mockBoard([job]);
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
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

describe('a drag the server refuses with the move-back sentence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows the server\'s words for a trip-less job moved through /assign, offers no way to schedule anyway, and puts the card back', async () => {
    mockApi.post.mockRejectedValueOnce(REFUSAL);
    await dragCard(NO_VISIT_JOB, 'job-3', 5);

    fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));

    expect(await screen.findByText(NEEDS_COMPLETE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Schedule Anyway/i })).not.toBeInTheDocument();
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    // The card is back where it was: in its first day's cell, not in the one it was dropped on.
    await waitFor(() => {
      expect(within(screen.getByTestId(cellFor(1))).queryByText(/J00053/)).toBeInTheDocument();
      expect(within(screen.getByTestId(cellFor(5))).queryByText(/J00053/)).not.toBeInTheDocument();
    });
  });
});

/**
 * A Plan Mode draft of a VISIT card moves exactly that visit, and changes nobody's crew
 * (visits-and-task-categories slice 02, verifier defect D1).
 *
 * Since slice 02 a job's board cards are its trips, each carrying ONLY that trip's crew. A draft
 * made from one used to carry that crew and no visit id, and "Confirm" sent it through the
 * job-level `/assign` - which moves the job's NEXT upcoming visit and applies the crew as a delta
 * against the whole job. Drafting visit 2 therefore moved visit 1 and stripped visit 1's crew.
 *
 * Ruling: a draft made from a visit card carries its visit id and confirms through the per-visit
 * reschedule request (PATCH /visits/:visitId, time only, no crew); a draft made from an
 * unscheduled bare-job card keeps the `/assign` first-booking path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// usePlanMode reads its storage key off a per-tab id at MODULE LOAD, so it has to exist before
// SchedulePage (and through it the hook) is imported.
vi.hoisted(() => sessionStorage.setItem('plan-mode-tab-id', 'vtc-s02-plan-test'));

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { asWallClock } from '@/lib/schedule-tz';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { jobToBucketEvent, jobToEvents } from '@/components/schedule/eventAdapters';
import type { GhostEvent } from '@/hooks/usePlanMode';
import SchedulePage, { boardCardDraft } from '@/pages/v2/schedule/SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const TZ = 'America/New_York';
const STORAGE_KEY = 'plan-mode-vtc-s02-plan-test';

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}

const T1 = { id: 'm-t1', first_name: 'Toni', last_name: 'One', phone: null };
const T2 = { id: 'm-t2', first_name: 'Tess', last_name: 'Two', phone: null };
const T3 = { id: 'm-t3', first_name: 'Theo', last_name: 'Three', phone: null };
const onVisit = (...people: (typeof T1)[]) => people.map((u) => ({ user_id: u.id, user: u }));
const CUSTOMER = { first_name: 'Pat', last_name: 'Sample', company_name: 'Sample Co' };

/** The verifier's shape: V1 {t1, t3}, V2 {t2}, V3 {t1}. */
const THREE_TRIPS = {
  id: 'job-1',
  job_number: 'J00177',
  status: 'SCHEDULED',
  scope_notes: 'Gate operator swap',
  customer: CUSTOMER,
  assignees: [T1, T2, T3].map((user) => ({ user })),
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: onVisit(T1, T3) },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: onVisit(T2) },
    { id: 'v3', visit_seq: 3, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: onVisit(T1) },
  ],
};
/** Unscheduled: no visit row, so there is no trip to move - `/assign` books its first one. */
const BUCKET_JOB = {
  id: 'job-9',
  job_number: 'J00099',
  status: 'UNSCHEDULED',
  scope_notes: 'Annual service',
  customer: CUSTOMER,
  assignees: [],
  tags: [],
  scheduled_start: null,
  scheduled_end: null,
  visits: [],
};

const visit2Card = () => jobToEvents(THREE_TRIPS, TZ).find((e) => e.boardId === 'jv-v2')!;
const FRIDAY = asWallClock(new Date(addDays(WEEK_START, 5).setHours(9, 0, 0, 0)));
const FRIDAY_END = asWallClock(new Date(addDays(WEEK_START, 5).setHours(11, 0, 0, 0)));

describe('boardCardDraft - what a Plan Mode draft of a board card remembers', () => {
  it('a draft of a visit card names that visit', () => {
    const draft = boardCardDraft(visit2Card(), FRIDAY, FRIDAY_END, TZ);

    expect(draft).toMatchObject({ sourceType: 'job', sourceId: 'job-1', visitId: 'v2' });
  });

  it('a draft of an unscheduled bare-job card names no visit, so it still first-books through /assign', () => {
    const draft = boardCardDraft(jobToBucketEvent(BUCKET_JOB, TZ), FRIDAY, FRIDAY_END, TZ);

    expect(draft.sourceId).toBe('job-9');
    expect(draft.visitId).toBeUndefined();
  });
});

function seedDrafts(ghosts: GhostEvent[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ isActive: true, ghosts, updatedAt: Date.now() }));
}

function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [BUCKET_JOB] : [THREE_TRIPS] } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: [T1, T2, T3].map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) } });
    }
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

async function confirmAll(count: number) {
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
  await screen.findAllByText(/J00177/);
  fireEvent.click(await screen.findByRole('button', { name: /^Confirm All$/ }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: `Confirm ${count} Change${count === 1 ? '' : 's'}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockBoard();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('confirming a Plan Mode draft (D1)', () => {
  it('a visit-card draft moves exactly that visit, by time only, and never touches crew', async () => {
    const draft = boardCardDraft(visit2Card(), FRIDAY, FRIDAY_END, TZ);
    seedDrafts([{ ...draft, id: 'g-v2' }]);

    await confirmAll(1);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2', {
        scheduled_start: draft.start,
        scheduled_end: draft.end,
      }),
    );
    // No crew statement anywhere: the job-level door is what moved visit 1 and emptied its crew.
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/jobs/job-1/assign', expect.anything());
    const crewWrites = [...mockApi.post.mock.calls, ...mockApi.patch.mock.calls].filter(
      ([, body]) => body && typeof body === 'object' && 'assignee_ids' in (body as object),
    );
    expect(crewWrites).toEqual([]);
  });

  it('a bare-job draft from the unscheduled bucket still first-books through /assign with its crew', async () => {
    const draft = boardCardDraft(jobToBucketEvent(BUCKET_JOB, TZ), FRIDAY, FRIDAY_END, TZ);
    seedDrafts([{ ...draft, crew: [T2.id], id: 'g-bucket' }]);

    await confirmAll(1);

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-9/assign', {
        assignee_ids: [T2.id],
        scheduled_start: draft.start,
        scheduled_end: draft.end,
      }),
    );
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

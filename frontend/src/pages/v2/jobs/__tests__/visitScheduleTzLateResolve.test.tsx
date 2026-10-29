/**
 * Defect C - the org timezone resolving AFTER a schedule form mounts must not shift the visit.
 *
 * `useScheduleTimezone()` answers `America/New_York` while `GET /api/organization` is still in
 * flight, because `org?.timezone || DEFAULT` cannot tell "not loaded yet" from "loaded with no
 * zone configured". For a READER that is cosmetic and self-corrects on the next paint. For a
 * WRITER it is not: `visitScheduleDialog` seeds its four picker fields ONCE at mount, so a visit
 * stored at 18:00Z seeds as 14:00 (Eastern) - and then saves that wall clock back through the
 * RESOLVED zone, writing 20:00Z for a Denver org on a save that never touched the schedule.
 * Silent, persisted, two hours out.
 *
 * The org zone here is America/Denver deliberately, and nothing else will do. Under an EASTERN
 * org the fallback value EQUALS the correct value, so every assertion below passes identically
 * against the broken code and proves nothing. Denver (MDT, UTC-6 in June) diverges from the
 * Eastern fallback (EDT, UTC-4) by exactly two hours, which only the fix resolves.
 *
 * The reference implementation for the fix is `pages/v2/leads/components/walkthroughTab.tsx`,
 * which already carries this guard and names this exact cause in its comment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import api from '@/lib/axios';
import type { JobVisitRow } from '@/lib/visits';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const ORG_TZ = 'America/Denver'; // MDT (UTC-6) in June. NOT Eastern - see the header.

interface OrgQueryState {
  data: { id: string; timezone: string | null } | undefined;
  isLoading: boolean;
  isError: boolean;
}

// `vi.hoisted` because the mock factory is hoisted above every other statement in this file;
// a plain `let` would still be in its temporal dead zone when the factory is registered.
const orgMock = vi.hoisted(() => ({
  state: { data: undefined, isLoading: true, isError: false } as OrgQueryState,
}));

// useScheduleTimezone reads org.timezone through this module, so this is the seam that can
// simulate the query landing after the dialog has already mounted and seeded itself.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => orgMock.state };
});

/** The org query lands. Flip, then re-render, to reproduce the real ordering. */
function resolveOrg() {
  orgMock.state = {
    data: { id: 'org-1', timezone: ORG_TZ },
    isLoading: false,
    isError: false,
  };
}

const patch = api.patch as ReturnType<typeof vi.fn>;

// June, so no DST boundary is in play at either end. 18:00Z reads 12:00 in Denver and 14:00 in
// New York - the whole defect, in one row.
const VISIT = {
  id: 'v-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-06-15T18:00:00.000Z',
  scheduled_end: '2026-06-15T20:00:00.000Z',
  is_all_day: false,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  assignees: [],
} as unknown as JobVisitRow;

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // A FRESH element every time, deliberately. Handing `rerender` the identical element object
  // lets React bail out of the subtree entirely, so the flipped org state is never read and the
  // test passes against the broken code - the exact false green this file is written to avoid.
  const ui = () => (
    <QueryClientProvider client={qc}>
      <VisitScheduleDialog
        open
        onOpenChange={() => {}}
        jobId="job-1"
        visit={VISIT}
        canAssignCrew={false}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, replay: () => view.rerender(ui()) };
}

describe('VisitScheduleDialog - the org timezone can land after the dialog has seeded', () => {
  beforeEach(() => {
    orgMock.state = { data: undefined, isLoading: true, isError: false };
    patch.mockReset();
    patch.mockResolvedValue({ data: {} });
  });

  it('does not shift a visit when the org timezone resolves after the dialog mounts', async () => {
    const user = userEvent.setup();
    const { replay } = renderDialog();

    // Precondition: seeded on the Eastern fallback, because the org has not answered yet.
    expect(screen.getByLabelText('Start time')).toHaveValue('2:00 PM');

    resolveOrg();
    replay();

    await user.click(screen.getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [url, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/jobs/job-1/visits/v-1');
    // Untouched schedule fields must round-trip to the instants the row already held. Without
    // the re-seed the 14:00 Eastern seed is written back through Denver as 20:00Z - two hours
    // later than the visit the dispatcher never edited.
    expect(body.scheduled_start).toBe('2026-06-15T18:00:00.000Z');
    expect(body.scheduled_end).toBe('2026-06-15T20:00:00.000Z');
  });

  it('re-seeds the visible start time when the org timezone resolves after mount', async () => {
    const { replay } = renderDialog();

    expect(screen.getByLabelText('Start time')).toHaveValue('2:00 PM');

    resolveOrg();
    replay();

    // The hour on screen is the office's hour. Left unfixed it reads 2:00 PM for the life of
    // the dialog - wrong, and with nothing to tell the dispatcher it is wrong.
    await waitFor(() => expect(screen.getByLabelText('Start time')).toHaveValue('12:00 PM'));
    expect(screen.getByLabelText('End time')).toHaveValue('2:00 PM');
    expect(screen.getByLabelText('Start date')).toHaveValue('06/15/2026');
  });

  // A REGRESSION GUARD, not a red test: it passes before the fix too, because the unfixed code
  // has no re-seed to clobber anything with. It exists because the fix itself could introduce
  // this bug - see the dirty check in visitScheduleDialog, and the note in the plan.
  //
  // The decision it pins: a wall clock the dispatcher TYPED is their intent on the company
  // clock, whatever the app briefly believed that clock to be, so it survives the resolve and
  // is saved as-typed in the real zone. Only fields still holding the seed are re-derived.
  it('keeps a user-edited time when the org timezone resolves after mount', async () => {
    const user = userEvent.setup();
    const { replay } = renderDialog();

    const startTime = screen.getByLabelText('Start time');
    await user.clear(startTime);
    await user.type(startTime, '9:30 AM');
    await user.tab();

    resolveOrg();
    replay();

    expect(screen.getByLabelText('Start time')).toHaveValue('9:30 AM');

    await user.click(screen.getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [, body] = patch.mock.calls[0] as [string, Record<string, unknown>];
    // 09:30 in Denver, not 09:30 re-read through Eastern (which would be 07:30 there).
    expect(body.scheduled_start).toBe('2026-06-15T15:30:00.000Z');
  });
});

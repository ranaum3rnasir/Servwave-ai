import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { buildAbility } from '@/lib/ability';
import { renderSchedule, serveSchedule } from '@/__tests__/harness/schedulePage';
import { addDays, startOfWeek } from 'date-fns';
import api from '@/lib/axios';
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
 * Roles & Permissions, PRD 4, slice S04.10 - a "To be scheduled" walkthrough on the routed Schedule page.
 *
 * A walkthrough whose performers were picked without a time has people on it and no time. It has no slot
 * on the board, and it shows in the unscheduled walkthroughs bucket with its crew. The page is the routed
 * one (`pages/v2/schedule/SchedulePage`); the two lead requests are told apart by their params, the way
 * the server tells the board's window from the bucket's feed, and each is answered with the lead rows the
 * server serves for it.
 */

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// A time inside the week the board opens on, so the fixture cannot rot out of the default window.
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
const inWeek = (offset: number, hour: number) => {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
};

const ALICE = { user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', phone: null } };
const CUSTOMER = { first_name: 'Ada', last_name: 'Byron', company_name: null };

/** A lead with one timed walkthrough on the board this week. */
const TIMED_LEAD = {
  id: 'lead-timed', lead_number: 'L00501', status: 'WALKTHROUGH_SCHEDULED', customer: CUSTOMER, tags: [],
  walkthrough_scheduled_at: inWeek(2, 14), walkthrough_duration_minutes: 60, walkthrough_to_be_scheduled: false,
  walkthrough_performers: [ALICE],
  walkthrough_visits: [
    { id: 'wt-v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: inWeek(2, 14), scheduled_end: inWeek(2, 15), is_all_day: false, assignees: [ALICE] },
  ],
};

/** A lead whose walkthrough has Alice on it and no time: the bucket's feed serves it, the board's window never does. */
const TO_BE_SCHEDULED_LEAD = {
  id: 'lead-tbs', lead_number: 'L00502', status: 'WALKTHROUGH_SCHEDULED', customer: CUSTOMER, tags: [],
  walkthrough_scheduled_at: null, walkthrough_duration_minutes: null, walkthrough_to_be_scheduled: true,
  walkthrough_performers: [ALICE],
  walkthrough_visits: [
    { id: 'wt-v2', visit_seq: 1, status: 'SCHEDULED', scheduled_at: null, scheduled_end: null, is_all_day: false, assignees: [ALICE] },
  ],
};

function mockBoard(windowLeads: Array<Record<string, unknown>>, bucketLeads: Array<Record<string, unknown>>) {
  serveSchedule({ jobs: [], bucketJobs: [], leads: (p) => (p.walkthrough_status === 'needs_scheduling' ? bucketLeads : windowLeads), users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] });
}

const boardIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-board-id]')).map((el) => el.getAttribute('data-board-id'));

describe('a "To be scheduled" walkthrough on the routed Schedule page (S04.10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has no slot on the board and is in the unscheduled walkthroughs bucket with its crew', async () => {
    // Even when the board's own window feed carries the untimed trip beside a timed one, it gets no card.
    const withUntimedBeside = {
      ...TIMED_LEAD,
      walkthrough_visits: [...TIMED_LEAD.walkthrough_visits, ...TO_BE_SCHEDULED_LEAD.walkthrough_visits],
    };
    mockBoard([withUntimedBeside], [TO_BE_SCHEDULED_LEAD]);

    const { container } = renderSchedule({ ability: ADMIN });

    // The bucket card: its lead number, the crew kept on it (Alice, by name) and nowhere else.
    const bucketNumber = await screen.findByText('L00502');
    const card = bucketNumber.closest('[draggable]') as HTMLElement;
    expect(card).toHaveTextContent('crew kept');
    expect(card.querySelector('[title="Alice Ng"]')).not.toBeNull();

    // The board: the timed trip has its card, and the untimed one has none.
    const ids = boardIds(container);
    expect(ids).toContain('wv-wt-v1');
    expect(ids).not.toContain('wv-wt-v2');
    expect(ids).not.toContain('wt-lead-tbs');
    expect(screen.getAllByText('L00502')).toHaveLength(1);
  });
});

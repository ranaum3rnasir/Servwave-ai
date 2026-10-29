/**
 * PRD story 9 (visits-and-task-categories): "I want to drag, SEARCH and open each walkthrough visit
 * card on its own". A board search result names a parent - a job or a lead - and the one trip it
 * found (its `date`). Since cards became one per visit (`jv-<visitId>`, `wv-<visitId>`), the search
 * set a bare job id that no card carries, so a job search lit nothing, and a lead search lit every
 * one of the lead's trips. It now lights the card of the trip the result names - including a card
 * painted double-booked, which used to return before the highlight was applied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => sessionStorage.setItem('plan-mode-tab-id', 'vtc-fe-search-test'));

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { addDays, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';

import SchedulePage from '../SchedulePage';
import { highlightedBoardIds, searchHighlightTarget } from '../searchHighlight';
import { asWallClock } from '@/lib/schedule-tz';
import type { BoardEvent } from '@/components/schedule/scheduleModel';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', phone: null };
const BEN = { id: 'm-ben', first_name: 'Ben', last_name: 'Ortiz', phone: null };
const on = (u: typeof ALICE) => [{ user_id: u.id, user: u }];

const JOB = {
  id: 'job-1', job_number: 'J00041', status: 'SCHEDULED', scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme' },
  assignees: [{ user: ALICE }], tags: [],
  scheduled_start: dayAt(1), scheduled_end: dayAt(1, 16),
  visits: [
    { id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1), scheduled_end: dayAt(1, 16), is_all_day: false, assignees: on(ALICE) },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 16), is_all_day: false, assignees: on(ALICE) },
    { id: 'v3', visit_seq: 3, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: on(ALICE) },
  ],
};

/** Alice again, overlapping trip 1: that card paints double-booked. */
const CLASHING_JOB = {
  id: 'job-2', job_number: 'J00042', status: 'SCHEDULED', scope_notes: 'Gate check',
  customer: { first_name: 'Bo', last_name: 'Sample', company_name: null },
  assignees: [{ user: ALICE }], tags: [],
  scheduled_start: dayAt(1, 15), scheduled_end: dayAt(1, 17),
  visits: [
    { id: 'c1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1, 15), scheduled_end: dayAt(1, 17), is_all_day: false, assignees: on(ALICE) },
  ],
};

const WT_1 = { id: 'wa', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(4), scheduled_end: dayAt(4, 15), is_all_day: false, assignees: on(BEN) };
const WT_2 = { id: 'wb', visit_seq: 2, status: 'SCHEDULED', scheduled_at: dayAt(5), scheduled_end: dayAt(5, 15), is_all_day: false, assignees: on(BEN) };
const LEAD = {
  id: 'lead-75', lead_number: 'L00075', status: 'CONTACTED',
  customer: { first_name: 'Elena', last_name: 'Sample', company_name: null, email: 'elena@example.test' },
  commission_owner: null, tags: [],
  walkthrough_scheduled_at: WT_2.scheduled_at, walkthrough_duration_minutes: 60, walkthrough_completed_at: null,
  walkthrough_performers: WT_2.assignees,
  walkthrough_visits: [WT_1, WT_2],
};

const EMPTY_RESULTS = { jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as { status?: unknown; walkthrough_status?: string; q?: string };
    if (url === '/api/jobs') {
      const wantsBucket = params.status === 'UNSCHEDULED'
        || (Array.isArray(params.status) && params.status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [] : [JOB, CLASHING_JOB] } });
    }
    if (url === '/api/leads') return Promise.resolve({ data: { leads: params.walkthrough_status ? [] : [LEAD] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: [ALICE, BEN].map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) } });
    }
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/search') {
      const results = params.q?.startsWith('L')
        ? { ...EMPTY_RESULTS, leads: [{ id: LEAD.id, entity_type: 'lead', title: 'L00075', subtitle: 'Elena Sample', date: WT_2.scheduled_at, status: 'CONTACTED' }] }
        : { ...EMPTY_RESULTS, jobs: [{ id: JOB.id, entity_type: 'job', title: 'J00041', subtitle: 'Acme', date: JOB.visits[0]!.scheduled_at, status: 'SCHEDULED' }] };
      return Promise.resolve({ data: { results } });
    }
    return Promise.resolve({ data: {} });
  });
});

/** Whether the board card for `boardId` carries the search highlight. */
function isLit(boardId: string): boolean {
  const card = document.querySelector(`[data-board-id="${boardId}"]`)?.closest('.rbc-event') as HTMLElement | null;
  if (!card) throw new Error(`no card ${boardId}`);
  return card.style.animation.includes('search-highlight');
}

async function searchAndPick(query: string, title: string) {
  renderWithProviders(<TooltipProvider><SchedulePage /></TooltipProvider>, { ability: ADMIN });
  await screen.findAllByText(/J00041/);
  fireEvent.change(screen.getByPlaceholderText('Search schedule...'), { target: { value: query } });
  const option = await screen.findByRole('option', { name: new RegExp(title) }, { timeout: 3000 });
  fireEvent.click(option);
}

describe('a scheduler search lights the card of the trip it found (story 9)', () => {
  it('a job result lights that job\'s trip - the one on the result\'s date - and not its other trips', async () => {
    await searchAndPick('J00041', 'J00041');
    await waitFor(() => expect(isLit('jv-v1')).toBe(true));
    expect(isLit('jv-v2')).toBe(false);
    expect(isLit('jv-v3')).toBe(false);
    expect(isLit('jv-c1')).toBe(false);
  });

  it('a lead result lights the walkthrough trip it found, not every trip of the lead', async () => {
    await searchAndPick('L00075', 'L00075');
    await waitFor(() => expect(isLit('wv-wb')).toBe(true));
    expect(isLit('wv-wa')).toBe(false);
  });

  it('a double-booked card lights too', async () => {
    await searchAndPick('J00041', 'J00041');
    // Trip 1 shares Alice with J00042's overlapping trip, so it is painted double-booked.
    const card = document.querySelector('[data-board-id="jv-v1"]')?.closest('.rbc-event') as HTMLElement;
    await waitFor(() => expect(isLit('jv-v1')).toBe(true));
    expect(card.className).toContain('!outline-warning');
    // And it is still a JOB card under the amber frame: the type's derived surface and left bar,
    // not the plain white card double-booked used to become (owner: "unreadable").
    expect(card.className).toContain('!bg-ev-job-surface');
    expect(card.className).toContain('!border-l-ev-job-border');
    expect(card.className).not.toContain('!bg-surface-light');
  });
});

describe('highlightedBoardIds (the rule the board applies)', () => {
  const at = (h: number) => asWallClock(new Date(2026, 9, 5, h, 0, 0));
  const card = (boardId: string, o: Partial<BoardEvent>): BoardEvent => ({
    boardId, parentId: 'job-1', type: 'job', number: 'J00041', title: '', customer: '', crew: [], ownerId: null,
    start: at(9), end: at(10), raw: {}, ...o,
  } as BoardEvent);
  const EVENTS = [
    card('jv-1', { start: at(9) }),
    card('jv-2', { start: at(13) }),
    card('jv-x', { parentId: 'job-9', start: at(9) }),
    card('ghost-1', { start: at(9), isGhost: true }),
    card('ce-7', { type: 'calendar-entry', parentId: '7' }),
  ];

  it('lights the parent\'s card at the found time, and no other parent\'s card at that time', () => {
    expect(highlightedBoardIds(EVENTS, { kind: 'trip', type: 'job', parentId: 'job-1', at: at(13).getTime() }))
      .toEqual(new Set(['jv-2']));
  });

  it('falls back to every card of the parent when none starts at the found time (never to none)', () => {
    expect(highlightedBoardIds(EVENTS, { kind: 'trip', type: 'job', parentId: 'job-1', at: at(11).getTime() }))
      .toEqual(new Set(['jv-1', 'jv-2']));
  });

  it('never lights a plan-mode ghost', () => {
    expect(highlightedBoardIds(EVENTS, { kind: 'trip', type: 'job', parentId: 'job-1', at: at(9).getTime() }))
      .toEqual(new Set(['jv-1']));
  });

  it('an Event result names its own card', () => {
    const target = searchHighlightTarget({ id: '7', entity_type: 'calendar-entry', title: 'Stand-up' }, 'America/New_York');
    expect(highlightedBoardIds(EVENTS, target)).toEqual(new Set(['ce-7']));
  });

  it('nothing is lit without a search', () => {
    expect(highlightedBoardIds(EVENTS, null).size).toBe(0);
  });
});

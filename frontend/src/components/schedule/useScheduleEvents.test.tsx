import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScheduleEvents } from './useScheduleEvents';
import { isCompletedEvent, isOnBoardFor, visitLabel } from './scheduleModel';
import { eventCrewPeople } from './eventPeople';

const scheduledJob = {
  id: 'job-1',
  job_number: 'J00001',
  scope_notes: 'Fix unit',
  customer: { first_name: 'Ada', last_name: 'Lovelace', company_name: null },
  scheduled_start: '2026-06-02T15:00:00.000Z',
  scheduled_end: '2026-06-02T17:00:00.000Z',
  status: 'SCHEDULED',
  assignees: [{ user: { id: 'u-1', first_name: 'Tech', last_name: 'One' } }],
};
const unassignedJob = {
  id: 'job-2',
  job_number: 'J00002',
  scope_notes: '',
  customer: { first_name: 'Grace', last_name: 'Hopper', company_name: null },
  scheduled_start: null,
  scheduled_end: null,
  status: 'UNSCHEDULED',
  assignees: [],
};

describe('useScheduleEvents', () => {
  it('builds scheduledEvents from jobs+walkthroughs and narrows to placed events only', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['job-1']);
    expect(result.current.bucketEvents.map((e) => e.boardId)).toEqual(['job-2']);
    expect(result.current.visibleBucketEvents.map((e) => e.boardId)).toEqual(['job-2']);
    expect(result.current.conflictIds.size).toBe(0);
  });

  it('hides a bucket job whose id is in hiddenSidebarIds', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(['job-2']),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.visibleBucketEvents).toHaveLength(0);
  });
});

// ─── Slice 03 — calendar entries merge into scheduledEvents, never bucketEvents ───────────────

const calendarEntry = {
  id: 'entry-1',
  title: 'Dave is off Thursday',
  description: '',
  // Squarely inside scheduledJob's 15:00–17:00Z window (a genuine overlap, not a touching edge).
  start: '2026-06-02T15:30:00.000Z',
  end: '2026-06-02T16:30:00.000Z',
  is_all_day: false,
};

describe('useScheduleEvents — calendar entries (slice 03)', () => {
  it('a timed calendar entry lands in scheduledEvents, never in bucketEvents/visibleBucketEvents', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [],
        walkthroughLeads: [],
        unassignedJobs: [],
        unscheduledWalkthroughs: [],
        calendarEntries: [calendarEntry],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['ce-entry-1']);
    expect(result.current.bucketEvents).toHaveLength(0);
    expect(result.current.visibleBucketEvents).toHaveLength(0);
  });

  it('a calendar entry sharing a time window with a crewed job produces no conflict (ADR 0002)', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [],
        unscheduledWalkthroughs: [],
        calendarEntries: [calendarEntry],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents).toHaveLength(2);
    expect(result.current.conflictIds.size).toBe(0);
  });

  it('calendarEntries omitted entirely (pre-slice-03 callers) — behaves exactly as before', () => {
    const { result } = renderHook(() =>
      useScheduleEvents({
        scheduledJobs: [scheduledJob],
        walkthroughLeads: [],
        unassignedJobs: [unassignedJob],
        unscheduledWalkthroughs: [],
        hiddenSidebarIds: new Set<string>(),
        tz: 'America/New_York',
      }),
    );
    expect(result.current.scheduledEvents.map((e) => e.boardId)).toEqual(['job-1']);
  });
});

// ─── visits-and-task-categories slice 03 - one card per lead walkthrough visit ────────────────
//
// The L00075 shape from the demo org: one lead, two walkthroughs in the same week, each with its
// own performer. The flat `walkthrough_*` fields describe only the lead's CURRENT trip (the
// earliest live one), which is why the board used to draw one card per lead.

const BEN = { id: 'u-ben', first_name: 'Ben', last_name: 'Ortiz', phone: null };
const DANA = { id: 'u-dana', first_name: 'Dana', last_name: 'Whitfield', phone: null };
const on = (...people: (typeof BEN)[]) => people.map((u) => ({ user_id: u.id, user: u }));

function twoWalkthroughLead(visits: Array<Record<string, unknown>>) {
  return {
    id: 'lead-75',
    lead_number: 'L00075',
    status: 'CONTACTED',
    customer: { first_name: 'Elena', last_name: 'Sample', company_name: null },
    commission_owner: null,
    tags: [],
    // The flat projection: the earliest live trip only.
    walkthrough_scheduled_at: visits[0]!.scheduled_at,
    walkthrough_duration_minutes: 60,
    walkthrough_completed_at: null,
    walkthrough_performers: visits[0]!.assignees,
    walkthrough_visits: visits,
  };
}

const SEP28 = { id: 'wv-a', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-28T14:00:00.000Z', scheduled_end: '2026-09-28T15:00:00.000Z', is_all_day: false, assignees: on(BEN) };
const SEP30 = { id: 'wv-b', visit_seq: 2, status: 'SCHEDULED', scheduled_at: '2026-09-30T18:00:00.000Z', scheduled_end: '2026-09-30T19:30:00.000Z', is_all_day: false, assignees: on(DANA) };

function boardFor(leads: Array<Record<string, unknown>>, bucket: Array<Record<string, unknown>> = []) {
  return renderHook(() =>
    useScheduleEvents({
      scheduledJobs: [],
      walkthroughLeads: leads,
      unassignedJobs: [],
      unscheduledWalkthroughs: bucket,
      hiddenSidebarIds: new Set<string>(),
      tz: 'America/New_York',
    }),
  ).result.current;
}

describe('useScheduleEvents - one card per walkthrough visit (slice 03)', () => {
  it('two walkthroughs in one week are two cards, "Visit 1 of 2" and "Visit 2 of 2"', () => {
    const { scheduledEvents } = boardFor([twoWalkthroughLead([SEP28, SEP30])]);
    expect(scheduledEvents.map((e) => e.boardId)).toEqual(['wv-wv-a', 'wv-wv-b']);
    expect(scheduledEvents.map(visitLabel)).toEqual(['Visit 1 of 2', 'Visit 2 of 2']);
    // Every card still addresses the LEAD as its parent, and names its own trip.
    expect(scheduledEvents.map((e) => [e.type, e.parentId, e.visitId])).toEqual([
      ['walkthrough', 'lead-75', 'wv-a'],
      ['walkthrough', 'lead-75', 'wv-b'],
    ]);
    // Each card keeps its own time: Sep 30 14:00-15:30 in the org zone.
    const second = scheduledEvents[1]!;
    expect([second.start.getDate(), second.start.getHours(), second.end.getHours(), second.end.getMinutes()]).toEqual([30, 14, 15, 30]);
  });

  it('a past walkthrough nobody completed does not hide the next one', () => {
    const past = { ...SEP28, scheduled_at: '2026-09-21T14:00:00.000Z', scheduled_end: '2026-09-21T15:00:00.000Z' };
    const { scheduledEvents } = boardFor([twoWalkthroughLead([past, SEP30])]);
    expect(scheduledEvents.map((e) => e.visitId)).toEqual(['wv-a', 'wv-b']);
    expect(scheduledEvents[1]!.start.getDate()).toBe(30);
  });

  it('a completed first walkthrough stays on the board as a completed card, the next one does not', () => {
    const done = { ...SEP28, status: 'COMPLETED' };
    const { scheduledEvents } = boardFor([twoWalkthroughLead([done, SEP30])]);
    expect(scheduledEvents.map((e) => e.visitId)).toEqual(['wv-a', 'wv-b']);
    expect(scheduledEvents.map((e) => isCompletedEvent(e))).toEqual([true, false]);
  });

  it('each card carries its own visit\'s crew, so the Member view puts it only in that lane', () => {
    const { scheduledEvents } = boardFor([twoWalkthroughLead([SEP28, SEP30])]);
    const [first, second] = scheduledEvents;
    expect(first!.crew).toEqual(['u-ben']);
    expect(second!.crew).toEqual(['u-dana']);
    expect([isOnBoardFor(second!, 'u-dana'), isOnBoardFor(second!, 'u-ben')]).toEqual([true, false]);
    // And the card can NAME its crew, although Dana is not on the lead's current trip.
    expect(eventCrewPeople(second!).map((p) => p.first_name)).toEqual(['Dana']);
  });

  it('an uncrewed walkthrough is unassigned, whoever is on its sibling', () => {
    const { scheduledEvents } = boardFor([twoWalkthroughLead([SEP28, { ...SEP30, assignees: [] }])]);
    expect(scheduledEvents[1]!.crew).toEqual([]);
  });

  it('the Unscheduled bucket stays one card per LEAD, keyed on the lead', () => {
    const { bucketEvents } = boardFor([], [{ ...twoWalkthroughLead([SEP28]), walkthrough_scheduled_at: null, walkthrough_visits: [] }]);
    expect(bucketEvents.map((e) => e.boardId)).toEqual(['wt-lead-75']);
  });
});

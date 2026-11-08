import { useMemo } from 'react';
import { calendarEntryToEvent, jobToBucketEvent, jobToEvents, walkthroughToEvent, walkthroughToEvents } from './eventAdapters';
import {
  conflictedEventIds,
  type SchedulableEvent,
  type ScheduledBoardEvent,
} from './scheduleModel';

export interface ScheduleEventsArgs {
  scheduledJobs: Record<string, unknown>[] | undefined;
  walkthroughLeads: Record<string, unknown>[] | undefined;
  unassignedJobs: Record<string, unknown>[] | undefined;
  unscheduledWalkthroughs: Record<string, unknown>[] | undefined;
  // Slice 03 — optional so callers (and the pre-existing test suite) that predate calendar
  // entries keep compiling and behaving byte-identically without passing this key at all.
  calendarEntries?: Record<string, unknown>[] | undefined;
  hiddenSidebarIds: Set<string>;
  tz: string;
}

export interface UseScheduleEventsReturn {
  scheduledEvents: ScheduledBoardEvent[];
  bucketEvents: SchedulableEvent[];
  visibleBucketEvents: SchedulableEvent[];
  conflictIds: Set<string>;
}

/**
 * The scheduler's adapter→event transform layer, lifted verbatim out of
 * SchedulePage (scheduledEvents / bucketEvents / visibleBucketEvents / conflictIds).
 * Plan-mode-dependent merges (allEventsWithPending, ghosts, windowing) stay in
 * the page — they read plan-mode + view state this hook does not own.
 */
export function useScheduleEvents({
  scheduledJobs,
  walkthroughLeads,
  unassignedJobs,
  unscheduledWalkthroughs,
  calendarEntries,
  hiddenSidebarIds,
  tz,
}: ScheduleEventsArgs): UseScheduleEventsReturn {
  // Scheduled work for the calendar + member columns (states 2 and 4), PLUS calendar entries
  // (slice 03) — entries have no unscheduled state (start/end are required columns), so they
  // are merged straight into scheduledEvents and never reach bucketEvents below. The type
  // predicate narrows start/end to real WallClocks — downstream (calendar accessors)
  // needs no casts. This is the read boundary: every instant crosses into org-tz
  // wall-clock space here, once, via the adapters (schedule-tz.ts).
  const scheduledEvents = useMemo<ScheduledBoardEvent[]>(
    () =>
      [
        // flatMap, not map: multi-visit S6 turns one job row into one event per live trip.
        ...((scheduledJobs ?? []).flatMap((j) => jobToEvents(j, tz))),
        // Slice 03: flatMap here too - one card per walkthrough visit, the same way as jobs.
        ...((walkthroughLeads ?? []).flatMap((l) => walkthroughToEvents(l, tz))),
        ...((calendarEntries ?? []).map((e) => calendarEntryToEvent(e, tz))),
      ].filter((e): e is ScheduledBoardEvent => e.start !== null && e.end !== null),
    [scheduledJobs, walkthroughLeads, calendarEntries, tz],
  );

  // Unscheduled work for the buckets (states 1 and 3 — state 3 keeps its crew).
  const bucketEvents = useMemo<SchedulableEvent[]>(
    () => [
      // map, NOT flatMap: the bucket is a JOB-level surface (D16 - "unscheduled" means the job
      // holds no live trip), so its card addresses the job and offers first-booking. See
      // jobToBucketEvent for the `/unassign` leftover this is guarding against.
      ...((unassignedJobs ?? []).map((j) => jobToBucketEvent(j, tz))),
      ...((unscheduledWalkthroughs ?? []).map((l) => walkthroughToEvent(l, tz))),
    ],
    [unassignedJobs, unscheduledWalkthroughs, tz],
  );
  // Plan mode hides bucket cards that already have ghost drafts. Hidden ids are keyed the
  // way each entity drags: walkthroughs by bare LEAD id, jobs by job id (TG11 — the bucket
  // stack receives pre-filtered events; type splitting happens inside the component).
  const visibleBucketEvents = useMemo(
    () =>
      bucketEvents.filter((ev) =>
        ev.type === 'walkthrough'
          ? !hiddenSidebarIds.has(ev.raw.id as string)
          : !hiddenSidebarIds.has(ev.boardId),
      ),
    [bucketEvents, hiddenSidebarIds],
  );

  // ─── Client-side conflict detection ──────────────────
  // D7 — per-crew-member double-booking across jobs AND walkthroughs (visual only;
  // the backend independently enforces conflicts on write with a 409).
  const conflictIds = useMemo(() => conflictedEventIds(scheduledEvents), [scheduledEvents]);

  return { scheduledEvents, bucketEvents, visibleBucketEvents, conflictIds };
}

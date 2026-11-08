import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useFeature } from '@/lib/entitlements';
import { toInstant, type WallClock } from '@/lib/schedule-tz';

export interface ScheduleDataArgs {
  dateRange: { start: WallClock; end: WallClock };
  departmentFilter: string;
  tz: string;
}

export interface UseScheduleDataReturn {
  scheduledJobs: Record<string, unknown>[] | undefined;
  walkthroughLeads: Record<string, unknown>[] | undefined;
  unassignedJobs: Record<string, unknown>[] | undefined;
  unscheduledWalkthroughs: Record<string, unknown>[] | undefined;
  calendarEntries: Record<string, unknown>[] | undefined;
  jobsLoading: boolean;
  walkthroughsLoading: boolean;
  unassignedError: boolean;
}

/**
 * The scheduler's four read queries, lifted verbatim out of SchedulePage.
 * Query keys, params and the `data.jobs` / `data.leads` unwrap are unchanged
 * so cache hits and invalidations (which still live in the page mutations)
 * stay identical.
 */
export function useScheduleData({ dateRange, departmentFilter, tz }: ScheduleDataArgs): UseScheduleDataReturn {
  // Walkthroughs are lead-shaped, and /api/leads sits behind requireFeature('leads')
  // (Pro). Scheduling is Starter core, so the two lead queries below are skipped
  // rather than left to 402 - the calendar keeps working, minus walkthrough rows.
  const hasLeads = useFeature('leads');

  // dateRange is a WallClock window (the org-zone day/week/month boundary) — convert
  // back to the real instant before it leaves the browser, same as every other write.
  const scheduledAfter = toInstant(dateRange.start, tz).toISOString();
  const scheduledBefore = toInstant(dateRange.end, tz).toISOString();

  const { data: scheduledJobs, isLoading: jobsLoading } = useQuery({
    queryKey: ['schedule-jobs', dateRange, departmentFilter],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', {
        params: {
          // Multi-visit S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus - they describe a
          // TRIP. A job whose crew is on the way or on site now reads SCHEDULED or IN_PROGRESS,
          // so the same work is still in this window.
          status: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
          scheduled_after: scheduledAfter,
          scheduled_before: scheduledBefore,
          ...(departmentFilter !== 'all' ? { department_id: departmentFilter } : {}),
          limit: 500,
        },
      });
      return data.jobs as Record<string, unknown>[];
    },
  });

  const { data: walkthroughLeads, isLoading: walkthroughsLoading } = useQuery({
    queryKey: ['schedule-walkthroughs', dateRange],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: {
          walkthrough_after: scheduledAfter,
          walkthrough_before: scheduledBefore,
          limit: 500,
        },
      });
      return data.leads as Record<string, unknown>[];
    },
    enabled: hasLeads,
  });

  const { data: unassignedJobs, isError: unassignedError } = useQuery({
    queryKey: ['schedule-unassigned'],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', {
        params: { status: 'UNSCHEDULED', limit: 100 },
      });
      return data.jobs as Record<string, unknown>[];
    },
  });

  const { data: unscheduledWalkthroughs } = useQuery({
    queryKey: ['schedule-unscheduled-walkthroughs'],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: {
          walkthrough_status: 'needs_scheduling',
          limit: 100,
        },
      });
      return data.leads as Record<string, unknown>[];
    },
    enabled: hasLeads,
  });

  // Calendar entries (slice 03) — deliberately NOT gated by useFeature: spec §4 says core
  // scheduler for every plan tier, unlike the two lead queries above. `start_after`/
  // `start_before` match the controller's overlap filter (calendar-entry.controller.ts list()):
  // an entry included when `start <= start_before AND end >= start_after`, so a multi-day entry
  // appears in every window it spans.
  const { data: calendarEntries } = useQuery({
    queryKey: ['schedule-calendar-entries', dateRange],
    queryFn: async () => {
      const { data } = await api.get('/api/calendar-entries', {
        params: {
          start_after: scheduledAfter,
          start_before: scheduledBefore,
        },
      });
      return data.calendar_entries as Record<string, unknown>[];
    },
  });

  return {
    scheduledJobs,
    walkthroughLeads,
    unassignedJobs,
    unscheduledWalkthroughs,
    calendarEntries,
    jobsLoading,
    walkthroughsLoading,
    unassignedError,
  };
}

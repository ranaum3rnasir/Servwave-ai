import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { Job, Status } from './jobs-fixtures';
import { buildMockJobs } from './jobs-fixtures';

// Server row: same fields as `Job` but dates arrive as ISO strings over the wire.
type JobWire = Omit<Job, 'createdAt' | 'scheduledAt' | 'endAt'> & {
  createdAt: string;
  scheduledAt: string;
  endAt: string;
};

function reviveJob(w: JobWire): Job {
  return {
    ...w,
    status: w.status as Status,
    createdAt: new Date(w.createdAt),
    scheduledAt: new Date(w.scheduledAt),
    endAt: new Date(w.endAt),
  };
}

/**
 * Jobs report rows.
 *  • demo org → the deterministic sample jobs (identical to today's mock).
 *  • real org → GET /api/reports/jobs (one fully-computed row per job, money
 *    summed across linked invoices server-side); ISO dates revived to Date so
 *    the existing filters/columns/export are unchanged.
 */
export function useJobsReport(isDemo: boolean): { jobs: Job[]; isLoading: boolean } {
  const live = useQuery({
    queryKey: ['jobs-report'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/jobs');
      return ((data.jobs ?? []) as JobWire[]).map(reviveJob);
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { jobs: buildMockJobs(), isLoading: false };
  return { jobs: live.data ?? [], isLoading: live.isLoading };
}

/**
 * Multi-visit S2: the one place the job page fetches and derives a job's visits.
 *
 * The routed v2 page consumes THIS hook rather than deriving visits itself; an unrouted v1 page
 * once consumed it too, and was deleted along with its Visits card. Keeping the derivation here
 * follows S1's own precedent (lib/visits.ts feeds the lead surfaces the same way) and the
 * anti-drift rule #1551 was spent establishing - a fix landing in one tree is otherwise invisible
 * in the other.
 *
 * Its own query key rather than a field on the job payload: jobDetailSelect is shared by getById
 * and roughly ten action handlers, so one addition there would change every one of those response
 * payloads at once.
 */
import { useQuery } from '@tanstack/react-query';

import api from '@/lib/axios';
import { resolveCurrentVisit, otherVisits, type JobVisitRow } from '@/lib/visits';

export function jobVisitsQueryKey(jobId: string | undefined) {
  return ['job-visits', jobId] as const;
}

export function useJobVisits(jobId: string | undefined) {
  const query = useQuery({
    queryKey: jobVisitsQueryKey(jobId),
    queryFn: async () => {
      const { data } = await api.get(`/api/jobs/${jobId}/visits`);
      return (data.visits ?? []) as JobVisitRow[];
    },
    enabled: !!jobId,
  });

  const visits = query.data ?? [];
  return {
    ...query,
    visits,
    /**
     * S5: the list is UNKNOWN - still in flight, or the fetch failed - so `visits` being empty
     * says nothing about whether this job holds trips. Derived here, once, rather than at each
     * call site: every consumer of this hook shares the rule, and one spelled out twice is the
     * drift #1551 was spent undoing.
     */
    visitsUnknown: query.data === undefined,
    /** The trip the hero describes - the same rule the backend's D14 mirror applies. */
    current: resolveCurrentVisit(visits),
    others: otherVisits(visits),
  };
}

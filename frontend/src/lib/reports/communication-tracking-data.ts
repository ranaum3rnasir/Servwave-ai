import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { buildDemoPayload } from './communication-tracking-demo';
import type { CommReportPayload } from './communication-tracking-logic';

/**
 * Live-or-demo hook for the Communication Tracking & QA report.
 * Backend route is deferred (PRD §8), so `enabled` is false and the report
 * runs on the deterministic demo payload. When the API lands, flip `enabled`
 * to `!isDemo` and point at `/api/reports/communication-tracking`.
 */
export function useCommunicationTrackingReport(isDemo: boolean) {
  const demo = useMemo<CommReportPayload>(() => buildDemoPayload(), []);

  const live = useQuery({
    queryKey: ['communication-tracking'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/communication-tracking');
      return data as CommReportPayload;
    },
    staleTime: 60_000,
    enabled: false, // deferred — always demo for now
  });

  if (!isDemo && live.data) {
    return { data: live.data, isLoading: live.isLoading, isError: live.isError };
  }
  return { data: demo, isLoading: false, isError: false };
}

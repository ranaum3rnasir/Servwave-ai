import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { dashboardSeed } from '@/lib/api/_mock/dashboard';
import type { DashboardResponse } from '@/lib/api/_mock/dashboard';

// Default to the LIVE backend in every environment — the controller now serves
// the full payload superset. The mock seed is opt-in only, via
// VITE_DASHBOARD_USE_MOCK=true (kept for offline scaffolding).
const USE_MOCK = import.meta.env.VITE_DASHBOARD_USE_MOCK === 'true';

// Re-export the shared types so components import them from the seam, never `_mock`.
export type {
  DashboardResponse, DashboardKpis, RevenuePoint, AttentionItem,
  TechSchedule, ScheduleJob, PipelineStage, ScoreboardEntry, LeadSource,
  StatusSlice, JobTypeSlice, ComingUpJob, ActivityEvent,
} from '@/lib/api/_mock/dashboard';

export interface DashboardParams {
  period?: '3M' | '6M' | '12M';
  date?: string;
  department_id?: string;
}

export function useDashboard(params: DashboardParams) {
  return useQuery<DashboardResponse>({
    queryKey: ['dashboard', params],
    queryFn: USE_MOCK
      ? () => Promise.resolve(dashboardSeed)
      : () =>
          api
            .get('/api/dashboard', {
              params: {
                period: params.period,
                date: params.date,
                department_id: params.department_id || undefined,
              },
            })
            .then((r) => r.data as DashboardResponse),
    staleTime: 60_000,
    refetchInterval: USE_MOCK ? false : 120_000,
  });
}

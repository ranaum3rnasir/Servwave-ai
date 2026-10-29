import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';

// F2 — Revenue (Completed vs Invoiced vs Collected) data source.
//  • demo org → the deterministic weekly mock + the fabricated business-unit (BU)
//    split control, so sales can show the full vision.
//  • real org → GET /api/reports/revenue: a monthly series aggregated from real
//    Jobs/Invoices/Payments. There is NO business-unit dimension in the schema,
//    so the real path has NO BU split — the component hides that control.

/** One point of the trend the chart renders. `period` is the x-axis label
 *  (a week label in the demo, a month label like "May 26" for real orgs). */
export interface RevenuePoint {
  period: string;
  completed: number;
  invoiced: number;
  collected: number;
}

export interface RevenueData {
  series: RevenuePoint[];
  /** Whether the BU-split control should render — demo only (mock dimension). */
  hasBuSplit: boolean;
  isLoading: boolean;
}

// Weekly mock series — completed → invoiced → collected (lag is realistic).
// Identical to the data that shipped inline in RevenueReport.tsx.
export const MOCK_SERIES: RevenuePoint[] = [
  { period: 'Apr 6', completed: 41200, invoiced: 38000, collected: 33500 },
  { period: 'Apr 13', completed: 46800, invoiced: 43500, collected: 39000 },
  { period: 'Apr 20', completed: 38900, invoiced: 40100, collected: 41200 },
  { period: 'Apr 27', completed: 52400, invoiced: 47800, collected: 42600 },
  { period: 'May 4', completed: 49100, invoiced: 50300, collected: 45900 },
  { period: 'May 11', completed: 55700, invoiced: 51200, collected: 48800 },
  { period: 'May 18', completed: 47300, invoiced: 49600, collected: 50100 },
  { period: 'May 25', completed: 58200, invoiced: 53400, collected: 47200 },
];

interface ApiSeriesPoint {
  month: string;
  label: string;
  completed: number;
  invoiced: number;
  collected: number;
}

/**
 * Revenue trend + whether the BU split applies.
 *  • demo → MOCK_SERIES, BU split ON (fabricated, demo-only).
 *  • real → live monthly series, BU split OFF (no such schema dimension).
 */
export function useRevenueReport(isDemo: boolean): RevenueData {
  const live = useQuery({
    queryKey: ['revenue-report'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/revenue');
      return ((data.series ?? []) as ApiSeriesPoint[]).map((p) => ({
        period: p.label,
        completed: p.completed,
        invoiced: p.invoiced,
        collected: p.collected,
      }));
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { series: MOCK_SERIES, hasBuSplit: true, isLoading: false };
  return { series: live.data ?? [], hasBuSplit: false, isLoading: live.isLoading };
}

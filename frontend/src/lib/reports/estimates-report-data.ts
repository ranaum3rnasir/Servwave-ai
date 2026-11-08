import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { hashStr, mulberry32, rangeRnd } from './random';
import {
  type EstimateRow, type RawStatus, type ListFilters,
  statusCounts, filterEstimates, computeKpis, repBreakdown, weeklyTrend,
} from './estimates-report-logic';

const REPS = ['Jordan Mills', 'Robin Shah', 'Sam Ortiz', 'Alex Ng', 'Dana Cole', 'Casey Lee'];
const CUSTOMERS = ['Bilton Tech', 'Pacha NYC', 'Evy Stores', 'Naday Co', 'Tim Clyde', 'Brandon M.', 'Acme HVAC', 'Northgate', 'Riverside', 'Oak & Pine', 'Harbor Lofts', 'Cedar Works'];
const STATUSES: RawStatus[] = ['DRAFT', 'SENT', 'PENDING', 'PENDING', 'WON', 'WON', 'DECLINED', 'EXPIRED', 'ARCHIVED'];

/** Deterministic sample estimates (stable across renders). */
export const SAMPLE_ESTIMATES: EstimateRow[] = (() => {
  const rng = mulberry32(hashStr('estimates-report-v1'));
  const today = Date.UTC(2026, 5, 7); // 2026-06-07, fixed for stable mock dates
  return Array.from({ length: 120 }, (_, i) => {
    const rep = REPS[Math.floor(rangeRnd(rng, 0, REPS.length))] ?? REPS[0]!;
    const status = STATUSES[Math.floor(rangeRnd(rng, 0, STATUSES.length))] ?? 'SENT';
    const amount = Math.round(rangeRnd(rng, 400, 12000));
    const daysAgo = Math.floor(rangeRnd(rng, 0, 120));
    return {
      id: String(i + 1),
      number: `E${String(10000 + i)}`,
      customer: CUSTOMERS[Math.floor(rangeRnd(rng, 0, CUSTOMERS.length))] ?? 'Customer',
      rep,
      createdAt: new Date(today - daysAgo * 86400000).toISOString().slice(0, 10),
      amount,
      // SENT + PENDING both land in the "pending" bucket; give both a deposit so the column is exercised
      depositDue: status === 'SENT' || status === 'PENDING' ? Math.round(amount * 0.3) : 0,
      status,
      hasJob: status === 'WON' && rng() > 0.4, // ~60% of approved are "won"
    } satisfies EstimateRow;
  });
})();

/** The distinct rep names present in a set of estimate rows (for the rep filter). */
export function repsFrom(rows: EstimateRow[]): string[] {
  return [...new Set(rows.map((e) => e.rep))].sort();
}

/** The distinct rep names present in the sample data (demo rep filter). */
export const SAMPLE_REPS = repsFrom(SAMPLE_ESTIMATES);

/** Compute the full report payload from a set of estimate rows for the given filters. */
function computeReport(rows: EstimateRow[], filters: ListFilters) {
  // Rep + date scope the WHOLE page (cards + analytics + list); status + search
  // narrow only the list within that scope.
  const scoped = rows.filter(
    (e) => (!filters.rep || e.rep === filters.rep) && (!filters.dateFrom || e.createdAt >= filters.dateFrom),
  );
  const counts = statusCounts(scoped);
  const listRows = filterEstimates(scoped, { status: filters.status, rep: null, search: filters.search });
  const kpis = computeKpis(scoped);
  const breakdown = repBreakdown(scoped).map((r) => {
    const rng = mulberry32(hashStr(r.rep));
    // |1| floor keeps a zero-revenue rep's sparkline visible rather than flat-zero (display only)
    const weekly = Array.from({ length: 8 }, (_, i) =>
      Math.round((r.revenue / 8 || 1) * rangeRnd(rng, 0.8, 1.2) * (1 + 0.04 * (i - 3.5))),
    );
    return { ...r, weekly };
  });
  const trend = weeklyTrend(breakdown);
  return { counts, listRows, kpis, breakdown, trend };
}

/**
 * Estimate report rows + the derived payload + the rep-filter options.
 *  • demo org → the deterministic SAMPLE_ESTIMATES (identical to before).
 *  • real org → GET /api/reports/estimates → tenant-scoped estimate rows in the
 *    SAME EstimateRow shape; the SAME pure logic aggregates them (lockstep).
 * Aggregation is identical across both paths — only the row source differs.
 */
export function useEstimatesReport(filters: ListFilters, isDemo: boolean) {
  const live = useQuery({
    queryKey: ['estimates-report'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/estimates');
      return (data.rows ?? []) as EstimateRow[];
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  const rows = isDemo ? SAMPLE_ESTIMATES : live.data ?? [];
  const reps = useMemo(() => (isDemo ? SAMPLE_REPS : repsFrom(rows)), [isDemo, rows]);
  const report = useMemo(
    () => computeReport(rows, filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filters.status, filters.rep ?? '', filters.search, filters.dateFrom ?? ''],
  );

  return { ...report, reps, isLoading: isDemo ? false : live.isLoading };
}

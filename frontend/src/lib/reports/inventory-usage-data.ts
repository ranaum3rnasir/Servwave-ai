import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';

/**
 * Inventory Usage report data (P5 §3) — GET /api/reports/inventory-usage.
 * Live for demo and real orgs alike: the demo org has real inventory data, so
 * no deterministic mock layer is needed (the catalog `live: true` covers
 * real-org visibility).
 *
 * `cost`/`unpricedUnits` are ABSENT (not null) when the server cost-strips the
 * response for viewers without `read Invoice` — the UI renders a units-only
 * report in that case.
 */
export interface UsageReportRow {
  itemId: string | null;
  sku: string;
  name: string;
  /** Σ consumed qty over the window, 2-dp rounded. */
  units: number;
  movementCount: number;
  /** Σ qty×unit_cost over priced rows only. Stripped for non-canSeePricing. */
  cost?: number;
  /** Σ qty of rows with no unit_cost snapshot (honesty marker). Stripped too. */
  unpricedUnits?: number;
  /** Drill-through refs off the movements themselves. */
  jobs: { id: string; jobNumber: string }[];
  invoices: { id: string; invoiceNumber: string }[];
}

export interface InventoryUsagePayload {
  from: string;
  to: string;
  items: UsageReportRow[];
}

export function useInventoryUsage(range: { from?: string; to?: string }) {
  return useQuery({
    queryKey: ['inventory-usage-report', range],
    queryFn: async () =>
      (await api.get('/api/reports/inventory-usage', { params: range })).data as InventoryUsagePayload,
    staleTime: 60_000,
  });
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, addHours, startOfMonth, subMonths } from 'date-fns';
import api from '@/lib/axios';
import {
  buildReport,
  filterRows,
  selectDrillRows,
  toDrillDto,
  type DrillSelector,
  type EstimateStatusKey,
  type NormalizedRow,
  type ReportFilters,
  type ReportPayload,
} from './estimate-conversion-logic';

// ── Sample data ───────────────────────────────────────────────────────────────
// Deterministic rows spanning ~13 months (incl. the current partial month) so
// every section — KPIs, per-rep, aging, monthly trend — populates in demo mode.
const REPS = [
  { id: 'rep-1', name: 'Marcus Bell' },
  { id: 'rep-2', name: 'Sofia Reyes' },
  { id: 'rep-3', name: 'Devon Clark' },
  { id: 'rep-4', name: 'Priya Nair' },
];
const SOURCES = ['Google', 'Referral', 'Facebook', 'Yelp', 'Direct Mail'];
const JOB_TYPES = ['HVAC Install', 'HVAC Service', 'Plumbing', 'Electrical', 'Maintenance'];
const CUSTOMERS = [
  'Hill Country HVAC', 'Lakeside Residence', 'Cedar Park Office', 'Westgate Mall',
  'Riverside Apartments', 'Oakwood Clinic', 'Summit Builders', 'Bayview Hotel',
  'Maple Street Home', 'Northside Church', 'Pinecrest School', 'Harbor Logistics',
  'Valley Auto Group', 'Crestview Dental', 'Parkside Bakery', 'Unity Gym',
];
const STATUS_SEQ: EstimateStatusKey[] = [
  'DRAFT', 'SENT', 'SENT', 'PENDING', 'WON', 'WON', 'WON',
  'DECLINED', 'DECLINED', 'EXPIRED', 'ARCHIVED',
];
const LOST_REASONS = ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER'];

export const DEMO_ROWS: NormalizedRow[] = (() => {
  const now = new Date();
  const rows: NormalizedRow[] = [];
  for (let i = 0; i < 110; i++) {
    const monthsAgo = i % 13; // 0 = current (partial) month
    const base = startOfMonth(subMonths(now, monthsAgo));
    const day = (i * 7) % 26;
    const createdAt = new Date(base.getFullYear(), base.getMonth(), 1 + day, 9, 0, 0);
    if (createdAt > now) continue;

    const status = STATUS_SEQ[(i * 3) % STATUS_SEQ.length]!;
    const sentAt = status === 'DRAFT' ? null : addDays(createdAt, 1 + (i % 3));
    let decidedAt: Date | null = null;
    if ((status === 'WON' || status === 'DECLINED') && sentAt) {
      const d = addDays(sentAt, 2 + (i % 10));
      decidedAt = d <= now ? d : null;
    }
    const lastActivityAt = decidedAt ?? sentAt ?? createdAt;
    const leadCreatedAt = addHours(createdAt, -(2 + (i % 18)));

    rows.push({
      id: `demo-${i}`,
      number: `E${1000 + i}`,
      customerName: CUSTOMERS[i % CUSTOMERS.length]!,
      repId: REPS[i % REPS.length]!.id,
      repName: REPS[i % REPS.length]!.name,
      source: SOURCES[i % SOURCES.length]!,
      jobType: JOB_TYPES[i % JOB_TYPES.length]!,
      amount: 1500 + ((i * 137) % 60) * 100,
      status,
      createdAt,
      sentAt,
      decidedAt,
      lastActivityAt,
      leadCreatedAt,
      lostReason: status === 'DECLINED' ? LOST_REASONS[i % LOST_REASONS.length]! : null,
    });
  }
  return rows;
})();

// ── Live query param mapping ───────────────────────────────────────────────────
function toParams(f: ReportFilters) {
  return {
    anchor: f.anchor,
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    rep: f.repId,
    source: f.source,
    jobType: f.jobType,
    model: f.model,
  };
}

// Stable cache key for the filter object (Dates → ISO).
const filterKey = (f: ReportFilters) =>
  [f.anchor, f.from.toISOString(), f.to.toISOString(), f.repId, f.source, f.jobType, f.model];

// Same key collapsed to one primitive, so a memo can depend on an array literal
// of stable values instead of a spread. JSON.stringify rather than join so the
// element boundaries survive: it changes exactly when one of the seven values
// changes, which is what element-wise dependency comparison did before.
const filterKeyId = (f: ReportFilters) => JSON.stringify(filterKey(f));

export interface DrillResult {
  total: number;
  truncated: boolean;
  rows: ReturnType<typeof toDrillDto>[];
}

/** Report payload — from the live API, or computed locally from sample data. */
export function useEstimateConversionReport(filters: ReportFilters, isDemo: boolean) {
  const keyId = filterKeyId(filters);
  const demo = useMemo<ReportPayload>(
    () => buildReport(DEMO_ROWS, filters, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyId],
  );

  const live = useQuery({
    queryKey: ['estimate-conversion', ...filterKey(filters)],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/estimate-conversion', { params: toParams(filters) });
      return data as ReportPayload;
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { data: demo, isLoading: false, isError: false };
  return { data: live.data, isLoading: live.isLoading, isError: live.isError };
}

/** Drill-down rows for the side panel — live API or sample data. */
export function useConversionDrilldown(
  filters: ReportFilters,
  drill: DrillSelector | null,
  isDemo: boolean,
) {
  const keyId = filterKeyId(filters);
  const drillId = JSON.stringify(drill);
  const demo = useMemo<DrillResult>(() => {
    if (!drill) return { total: 0, truncated: false, rows: [] };
    const now = new Date();
    const scoped = filterRows(DEMO_ROWS, filters);
    const selected = selectDrillRows(scoped, drill, filters.anchor, now);
    return { total: selected.length, truncated: false, rows: selected.map((r) => toDrillDto(r, now)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId, drillId]);

  const live = useQuery({
    queryKey: ['estimate-conversion-drill', ...filterKey(filters), JSON.stringify(drill)],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/estimate-conversion/estimates', {
        params: { ...toParams(filters), ...drill },
      });
      return data as DrillResult;
    },
    staleTime: 60_000,
    enabled: !isDemo && !!drill,
  });

  if (isDemo) return { data: demo, isLoading: false };
  return { data: live.data, isLoading: live.isLoading };
}

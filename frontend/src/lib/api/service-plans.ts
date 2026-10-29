import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';

// ─── Types (mirror the backend service-plan controller responses) ───────────

export type ServicePlanStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
export type VisitCadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export type IntervalUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type PlanVisitStatus = 'SCHEDULED' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED';

export interface ServicePlanLineItem {
  id?: string;
  name: string;
  quantity: number;
  unit_price: number | string;
  position?: number;
}

/**
 * A default-materials template line (LO-5). The server snapshots `item_sku`/`item_name` from
 * `item_id` at save; `item_id` is nulled (SetNull) if the catalog item is later deleted, while the
 * snapshots survive so the row can still be shown ("removed from catalog"). `qty` is Decimal → string.
 */
export interface ServicePlanMaterialLine {
  id?: string;
  item_id: string | null;
  item_sku: string;
  item_name: string;
  qty: number | string;
  position?: number;
}

export interface PlanVisit {
  status: PlanVisitStatus;
  scheduled_date: string;
  visit_number?: number;
  completed_at?: string | null;
  job?: { id: string; job_number: string; status: string; assignees?: { user_id: string }[] } | null;
}

export interface ServicePlanInvoiceRef {
  id: string;
  invoice_number: string;
  kind: string;
  status: string;
  total_amount: string | number;
  // #1997 round 3 — `public_token` is never projected by GET /api/service-plans/:id (dropped from
  // the select entirely; no reader here ever consumed it). Do not add it back without applying the
  // same customer-read redaction the invoice/estimate detail responses use.
}

/** Stored fields + server-attached derived fields. */
export interface ServicePlan {
  id: string;
  service_plan_number: string;
  customer_id: string;
  service_location_id: string;
  name: string;
  status: ServicePlanStatus;
  visit_cadence: VisitCadence;
  // Structured (Google-Calendar-style) recurrence. Null on legacy rows → derive from visit_cadence.
  interval_unit: IntervalUnit | null;
  interval_count: number | null;
  byweekday: number[];
  occurrence_count: number | null;
  start_date: string;
  end_date: string | null;
  contract_price: string | number;
  sold_by: string | null;
  renewals_count: number;
  template_id: string | null;
  line_items: ServicePlanLineItem[];
  material_lines?: ServicePlanMaterialLine[];
  visits?: PlanVisit[];
  invoices?: ServicePlanInvoiceRef[];
  customer?: { id: string; company_name: string | null; first_name: string | null; last_name: string | null };
  service_location?: { id: string; address_line1: string; city: string; state: string };
  // Derived on read by the server:
  planned_visit_count: number | null;
  visits_remaining: number | null;
  next_due: string;
  due_soon: boolean;
  overdue: boolean;
  emphasized: boolean;
  effective_status: ServicePlanStatus;
}

export interface CreateServicePlanInput {
  customer_id: string;
  service_location_id: string;
  name: string;
  // Either send a legacy visit_cadence OR the structured recurrence fields (the server fills a
  // best-fit visit_cadence from the structure). The new builder sends the structured fields.
  visit_cadence?: VisitCadence;
  interval_unit?: IntervalUnit;
  interval_count?: number;
  byweekday?: number[];
  occurrence_count?: number | null;
  start_date: string;
  end_date?: string | null;
  contract_price: number;
  line_items: { name: string; quantity: number; unit_price: number }[];
  // LO-5 default-materials template. Absent = don't touch on PATCH; [] = clear; the server
  // snapshots sku/name from item_id, so the client only sends { item_id, qty }.
  material_lines?: { item_id: string; qty: number }[];
  sold_by?: string | null;
  template_id?: string | null;
}

export interface SchedulerBucketPlan {
  id: string;
  service_plan_number: string;
  customer: string;
  service_location: { address_line1: string; city: string; state: string };
  /** Human-readable recurrence summary (e.g. "Every 2 weeks on Mon, Thu"), computed server-side. */
  recurrence: string;
  next_due: string;
  visits_remaining: number | null;
  due_soon: boolean;
  overdue: boolean;
}

// ─── Query keys ──────────────────────────────────────────────────────────────

export const servicePlanKeys = {
  all: ['service-plans'] as const,
  detail: (id: string) => ['service-plans', id] as const,
  bucket: ['service-plans', 'scheduler-bucket'] as const,
};

// ─── Reads ───────────────────────────────────────────────────────────────────

export function useServicePlans() {
  return useQuery<ServicePlan[]>({
    queryKey: servicePlanKeys.all,
    queryFn: () => api.get('/api/service-plans').then((r) => r.data.servicePlans),
  });
}

export function useServicePlan(id: string | undefined) {
  return useQuery<ServicePlan>({
    queryKey: servicePlanKeys.detail(id ?? ''),
    queryFn: () => api.get(`/api/service-plans/${id}`).then((r) => r.data.servicePlan),
    enabled: !!id,
  });
}

export function useSchedulerBucket(enabled = true) {
  return useQuery<SchedulerBucketPlan[]>({
    queryKey: servicePlanKeys.bucket,
    queryFn: () => api.get('/api/service-plans/scheduler-bucket').then((r) => r.data.plans),
    enabled,
  });
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: servicePlanKeys.all });
}

export function useCreateServicePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: CreateServicePlanInput) => api.post('/api/service-plans', d).then((r) => r.data.servicePlan),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateServicePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...d }: { id: string } & Partial<CreateServicePlanInput>) =>
      api.patch(`/api/service-plans/${id}`, d).then((r) => r.data.servicePlan),
    onSuccess: (_d, v) => { invalidateAll(qc); qc.invalidateQueries({ queryKey: servicePlanKeys.detail(v.id) }); },
  });
}

export function useDeleteServicePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/service-plans/${id}`).then((r) => r.data),
    onSuccess: () => invalidateAll(qc),
  });
}

function useLifecycleAction(action: 'activate' | 'renew' | 'cancel') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/service-plans/${id}/${action}`).then((r) => r.data),
    onSuccess: (_d, id) => {
      invalidateAll(qc);
      qc.invalidateQueries({ queryKey: servicePlanKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export const useActivateServicePlan = () => useLifecycleAction('activate');
export const useRenewServicePlan = () => useLifecycleAction('renew');
export const useCancelServicePlan = () => useLifecycleAction('cancel');

export interface ScheduleVisitInput {
  id: string;
  scheduled_start: string;
  scheduled_end?: string | null;
  assigned_to?: string | null;
}

export function useScheduleVisit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...d }: ScheduleVisitInput) =>
      api.post(`/api/service-plans/${id}/schedule-visit`, d).then((r) => r.data),
    // The response carries the job the visit was booked on - a visit write like any other.
    onSuccess: (d: { job: { id: string } }, v) => {
      invalidateAll(qc);
      qc.invalidateQueries({ queryKey: servicePlanKeys.detail(v.id) });
      qc.invalidateQueries({ queryKey: servicePlanKeys.bucket });
      refreshAfterVisitWrite(qc, { jobId: d.job.id });
    },
  });
}

// ─── Display helpers ───────────────────────────────────────────────────────

export const CADENCE_LABEL: Record<VisitCadence, string> = {
  WEEKLY: 'Weekly', BIWEEKLY: 'Biweekly', MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly', SEMIANNUAL: 'Semiannual', ANNUAL: 'Annual',
};

// ─── Recurrence summary (mirrors backend toRule + describeRule) ──────────────

const RECURRENCE_WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECURRENCE_UNIT_NOUN: Record<IntervalUnit, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const RECURRENCE_UNIT_EVERY1: Record<IntervalUnit, string> = { DAY: 'Daily', WEEK: 'Weekly', MONTH: 'Monthly', YEAR: 'Annually' };
const LEGACY_RECURRENCE: Record<VisitCadence, { unit: IntervalUnit; count: number }> = {
  WEEKLY: { unit: 'WEEK', count: 1 }, BIWEEKLY: { unit: 'WEEK', count: 2 }, MONTHLY: { unit: 'MONTH', count: 1 },
  QUARTERLY: { unit: 'MONTH', count: 3 }, SEMIANNUAL: { unit: 'MONTH', count: 6 }, ANNUAL: { unit: 'YEAR', count: 1 },
};

export interface RecurrenceParts {
  visit_cadence: VisitCadence;
  interval_unit?: IntervalUnit | null;
  interval_count?: number | null;
  byweekday?: number[] | null;
}

/** Human-readable recurrence, e.g. "Every 2 weeks on Mon, Thu" / "Monthly". Falls back to the
 *  legacy visit_cadence when no structured fields are present. */
export function describeRecurrence(p: RecurrenceParts): string {
  const { unit, count } = p.interval_unit
    ? { unit: p.interval_unit, count: p.interval_count ?? 1 }
    : LEGACY_RECURRENCE[p.visit_cadence];
  const byweekday = p.interval_unit ? p.byweekday ?? [] : [];
  const base = count === 1 ? RECURRENCE_UNIT_EVERY1[unit] : `Every ${count} ${RECURRENCE_UNIT_NOUN[unit]}s`;
  if (unit === 'WEEK' && byweekday.length > 0) {
    const days = [...byweekday]
      .sort((a, b) => a - b)
      .map((d) => RECURRENCE_WEEKDAY_ABBR[((d % 7) + 7) % 7])
      .join(', ');
    return `${base} on ${days}`;
  }
  return base;
}

// Service-plan status labels live in the single source of truth:
// STATUS_REGISTRY.servicePlan (frontend/src/design-system/status-registry.ts).
// The local STATUS_LABEL map that used to sit here was deleted - it had zero importers
// and duplicated those four labels verbatim.

export const planLineItemsTotal = (items: { quantity: number; unit_price: number | string }[]): number =>
  items.reduce((s, li) => s + li.quantity * Number(li.unit_price), 0);

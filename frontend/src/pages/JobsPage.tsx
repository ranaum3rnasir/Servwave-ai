import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactInstant } from '@/lib/format-date';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { KpiStrip } from '@/components/data/KpiStrip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertCircle,
  CalendarDays,
  Play,
  CheckCircle2,
  Ban,
  Plus,
  Download,
  Receipt,
  Briefcase,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canOnJob } from '@/lib/ability';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { toast } from '@/components/ui/use-toast';
import { useAssignableUsers } from '@/lib/api/users';
import { useJobSubStatuses } from '@/lib/api/jobSubStatuses';
import { FilterBar } from '@/components/filters/FilterBar';
import { AppliedChips } from '@/components/filters/AppliedChips';
import { useFilterState } from '@/lib/filters/useFilterState';
import { jobsRegistry, MONTHLY_JOB_STATUSES } from '@/lib/filters/registries/jobs';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { tagsColumn } from '@/components/data/TagChips';
import { useTagFacetOptions, type Tag } from '@/lib/api/tags';
import { BulkCancelJobsDialog } from '@/components/jobs/BulkCancelJobsDialog';
import { summariseBulkResult } from '@/lib/bulk-result';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';
import { useConfirm } from '@/hooks/useConfirm';

// ─── Types ──────────────────────────────────────────

interface JobListItem {
  id: string;
  job_number: string;
  status: string;
  // SRVW-112 - rendered inside the existing Status cell, not as a new column.
  sub_status?: { id: string; label: string } | null;
  // S8 (RATIFIED, A5): DERIVED - the backend computes this off `job.visits[]` (next upcoming
  // live visit, falling back to the earliest non-cancelled one) rather than storing it. New code
  // should read `job.visits[]` directly; kept here for this list's existing Scheduled column.
  scheduled_start: string | null;
  created_at: string;
  customer: { id: string; first_name: string; last_name: string; company_name: string | null; customer_number?: string | null };
  assignees: { user: { id: string; first_name: string; last_name: string } }[];
  // Creation confers control (technician-ownership spec, Part C): canOnJob needs it to answer the
  // bulk-action gate per row. Null on rows written before creator tracking.
  created_by_id?: string | null;
  service_location: { id: string; address_line1: string; city: string; state: string } | null;
  tags?: Tag[];
}

interface JobStats {
  unassigned: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  need_invoices: number;
}

interface Department {
  id: string;
  name: string;
}

// ─── Helpers ────────────────────────────────────────

function formatJobLocation(loc: JobListItem['service_location']): string {
  if (!loc) return '';
  const { address_line1, city, state } = loc;
  // Sentinel: historical-import placeholder address -> blank per spec
  if (address_line1?.toLowerCase().includes('historical import')) return '';
  if (!address_line1) return city && state ? `${city}, ${state}` : city || '';
  if (city) return `${address_line1}, ${city}`;
  return address_line1;
}

// ─── Columns ────────────────────────────────────────

export const columns: ColumnDef<JobListItem, unknown>[] = [
  {
    id: 'job_number',
    accessorKey: 'job_number',
    header: 'Job #',
    size: 90,
    meta: { pinned: true, fixed: true, minWidth: 80 },
    cell: ({ row }) => (
      <span className="font-mono text-xs text-text-secondary">{row.original.job_number}</span>
    ),
  },
  {
    id: 'customer',
    header: 'Customer',
    size: 170,
    enableHiding: false,
    enableSorting: false,
    meta: { locked: true, pinned: true, growWeight: 1.5, minWidth: 140 },
    cell: ({ row }) => {
      const c = row.original.customer;
      return (
        <div>
          <span className="font-medium text-text-primary truncate block">
            {customerDisplayName(c)}
          </span>
          {c.customer_number && (
            <span className="font-mono text-xs text-text-secondary">{c.customer_number}</span>
          )}
        </div>
      );
    },
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    meta: { fixed: true },
    // SRVW-112 - the org-defined sub-status rides UNDER the parent badge in the same cell. No new
    // column, so the saved-view / column-visibility machinery is untouched.
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <StatusBadge domain="job" status={row.original.status} />
        {row.original.sub_status && (
          <span className="truncate text-xs text-text-secondary">{row.original.sub_status.label}</span>
        )}
      </div>
    ),
  },
  {
    id: 'location',
    accessorKey: 'service_location',
    header: 'Location',
    size: 180,
    enableSorting: false,
    meta: { growWeight: 2, minWidth: 80 },
    cell: ({ row }) => {
      const display = formatJobLocation(row.original.service_location);
      return display ? <span className="text-sm">{display}</span> : null;
    },
  },
  {
    id: 'assigned_to',
    accessorKey: 'assignees',
    header: 'Assigned To',
    size: 140,
    enableSorting: false,
    meta: { growWeight: 1, minWidth: 80 },
    cell: ({ row }) => {
      const crew = row.original.assignees ?? [];
      return crew.length > 0
        ? <span>{crew.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ')}</span>
        : <span className="text-text-secondary italic">Unassigned</span>;
    },
  },
  {
    id: 'scheduled',
    accessorKey: 'scheduled_start',
    header: 'Scheduled',
    size: 110,
    meta: { fixed: true, minWidth: 90 },
    cell: ({ row }) => {
      const d = formatExactInstant(row.original.scheduled_start);
      return d ? <span className="tabular-nums">{d}</span> : null;
    },
  },
  tagsColumn<JobListItem>(),
  {
    id: 'created',
    accessorKey: 'created_at',
    header: 'Created',
    size: 110,
    meta: { fixed: true, minWidth: 90 },
    cell: ({ row }) => (
      <span className="tabular-nums">{formatExactInstant(row.original.created_at)}</span>
    ),
  },
];

// ─── Component ──────────────────────────────────────

export default function JobsPage() {
  const { confirm, confirmDialog } = useConfirm();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');

  // Generalized filter registry (Task 11, extended): status, assigned_to,
  // department_id, scheduled (dateRange), created (dateRange), needs_invoice
  // (1-option multi) — all URL-driven via `jobsRegistry`. Deep links like
  // `?status=UNSCHEDULED&status=SCHEDULED` or `?needs_invoice=true` (e.g. the
  // Customers "Active Jobs" KPI, or the Invoices "To Be Invoiced" KPI —
  // bug #21) are decoded automatically on mount by `useFilterState`,
  // replacing the old page's manual `searchParams.get` seeding.
  const { value, setValue, listParams: filterParams } = useFilterState(jobsRegistry);

  // Standalone state — NOT registry facets: search, pagination, sort. (The
  // customer picker was removed entirely — see jobsRegistry.ts's file-level
  // comment — and needs_invoice moved into the registry above.)
  const [sorting, setSorting] = useState<SortingState>([]);
  const canManage = ability.can('create', 'Job');
  const queryClient = useQueryClient();
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // Current-month bounds for the monthly Completed/Cancelled tiles. These feed
  // the "scheduled" facet (job.controller's scheduled_after/scheduled_before) -
  // a scheduling fact, not a "when was this row made" one - so #1634 puts them
  // on the ORG's month, matching the Filter popover's "scheduled" preset (see
  // filterPopover.tsx's DateFacet) rather than the browser's.
  const scheduleTz = useScheduleTimezone();
  const monthStart = useMemo(() => startOfMonthDay(scheduleTz), [scheduleTz]);
  const monthEnd = useMemo(() => endOfMonthDay(scheduleTz), [scheduleTz]);

  // Roster for the "Assigned To" filter — assignable-role users unioned with anyone
  // actually referenced on a job, so a genuinely-assigned non-technician isn't dropped.
  // DEAD v1 twin - kept in step with pages/v2/jobs/JobsPage. Not invested in.
  const { data: techsData } = useAssignableUsers({ purpose: 'directory', includeReferencedIn: 'jobs' });
  const techs = techsData ?? [];

  // Fetch departments for filter
  const { data: departmentsData } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get('/api/departments');
      return data.departments as Department[];
    },
  });
  const departments = departmentsData ?? [];

  // WP2 - job sub-statuses filter axis. Per-org labels, so they can't be a
  // static list like JOB_STATUSES.
  const { data: subStatusesData } = useJobSubStatuses();
  const subStatuses = subStatusesData ?? [];

  // Resolved option lists for the registry's dynamic `optionSource` facets.
  // Memoized on the underlying query data (stable react-query reference, not
  // re-derived into a fresh array identity every render) per the registry-
  // stability contract. NO `{value:'UNSCHEDULED', label:'Unassigned'}`
  // sentinel here — see jobsRegistry.ts's Correction-C comment.
  const assignedToOptions = useMemo<FacetOption[]>(
    () => techs.map((t) => ({ value: t.id, label: `${t.first_name} ${t.last_name}`.trim() })),
    [techs]
  );
  const departmentOptions = useMemo<FacetOption[]>(
    () => departments.map((d) => ({ value: d.id, label: d.name })),
    [departments]
  );
  const tagFacetOptions = useTagFacetOptions();
  // Two orgs can reuse the same label word under different parent statuses,
  // so each option is prefixed with its parent's display label rather than
  // widening the shared FacetOption contract with a `group` field.
  const subStatusOptions = useMemo<FacetOption[]>(
    () =>
      subStatuses.map((s) => ({
        value: s.id,
        label: `${STATUS_REGISTRY.job[s.parent]?.label ?? s.parent}: ${s.label}`,
      })),
    [subStatuses]
  );
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'assignableUsers') return assignedToOptions;
      if (sourceId === 'departments') return departmentOptions;
      if (sourceId === 'tags') return tagFacetOptions;
      if (sourceId === 'jobSubStatuses') return subStatusOptions;
      return [];
    },
    [assignedToOptions, departmentOptions, tagFacetOptions, subStatusOptions]
  );
  // Jobs' registry has no `range` facet, so FilterBar never actually calls
  // this (only its `case 'range'` branch does) — but `resolveMax` is a
  // required prop on `FilterBarProps`, so a no-op returning 0 satisfies the
  // contract without a fake maxSource.
  const resolveMax = useCallback((_sourceId: string): number => 0, []);

  // Any filter change (facet edit, chip removal, "Clear all") snaps back to
  // page 1 — same behavior the old per-field setters had.
  const handleFilterChange = useCallback((next: FilterState) => {
    setValue(next);
    setPage(1);
  }, [setValue]);

  const sortBy = sorting[0]?.id;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  // Explicit `undefined` placeholders for every facet-owned param preserve
  // the pre-refactor `listParams` object's exact key set (see
  // `list-status-defaults.test.tsx`, which asserts `status` is present —
  // even if `undefined` — on an unfiltered mount). `filterParams` (from
  // `useFilterState`) only carries keys for ACTIVE facets, so this baseline
  // fills in the rest; axios drops `undefined`-valued params before sending
  // the request either way. The standalone bits (exclude_plan_visits, search,
  // sort) are layered on top, unaffected by the registry.
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    assigned_to: undefined as string | undefined,
    department_id: undefined as string | undefined,
    scheduled_after: undefined as string | undefined,
    scheduled_before: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    needs_invoice: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    // Service-plan visit-jobs are managed in the Service Plans module, not this list.
    // They remain on the calendar and the technician app (which omit this flag).
    exclude_plan_visits: 'true',
    ...filterParams,
  };

  // Fetch jobs
  const { data, isLoading } = useQuery({
    queryKey: ['jobs', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
  });

  const stats: JobStats | undefined = data?.stats;

  // A selected id only makes sense against the CURRENT page/sort/filter - once any of the jobs
  // query's own params change, drop the selection instead of carrying stale ids (or a
  // now-invisible row) forward. Mirrors the useQuery's own queryKey dependency set exactly.

  const { rowSelection, setRowSelection, selectedIds: selectedJobIds } =
    useScopedRowSelection(JSON.stringify([page, pageSize, search, sortBy, sortDir, value]));

  // Bulk Assign, gated PER ROW rather than at the subject level. `assign Job` is creator-scoped for
  // a technician since the technician-ownership spec (Part C), so `ability.can('assign','Job')` is
  // true for every technician and says nothing about the jobs actually selected - it would offer a
  // bulk action the API refuses row by row. EVERY selected job must be assignable, because the
  // endpoint is all-or-nothing from the user's point of view: a partial result reads as a bug.
  // Absent, not disabled, per house convention.
  const canBulkAssign =
    selectedJobIds.length > 0 &&
    selectedJobIds.every((id) => {
      const job = (data?.jobs ?? []).find((j: JobListItem) => j.id === id);
      return !!job && canOnJob(ability, 'assign', job, user?.id ?? '');
    });

  type BulkResult = { updated: string[]; failed: { id: string; error: string }[]; voided_invoice_ids?: string[] };

  function reportBulkResult(result: BulkResult) {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    setRowSelection({});
    const voidedCount = result.voided_invoice_ids?.length ?? 0;
    const voidedSuffix = voidedCount > 0 ? ` ${voidedCount} invoice${voidedCount === 1 ? '' : 's'} on those jobs were voided.` : '';
    const { title, description } = summariseBulkResult({
      okCount: result.updated.length,
      failed: result.failed,
      noun: 'job',
      nounPlural: 'jobs',
      verbPast: 'updated',
    });
    toast({ title, description: description + voidedSuffix });
  }

  const bulkStatusMutation = useMutation({
    mutationFn: async (body: { ids: string[]; action: string; cancelled_reason?: string }) => {
      const { data } = await api.post('/api/jobs/bulk-status', body);
      return data as BulkResult;
    },
    onSuccess: reportBulkResult,
    onError: () => {
      toast({ title: 'Update failed', description: 'Failed to update jobs. Please try again.', variant: 'destructive' });
    },
  });

  const bulkAssignMutation = useMutation({
    mutationFn: async (body: { ids: string[]; assignee_ids: string[] }) => {
      const { data } = await api.post('/api/jobs/bulk-assign', body);
      return data as BulkResult;
    },
    onSuccess: reportBulkResult,
    onError: () => {
      toast({ title: 'Assign failed', description: 'Failed to assign jobs. Please try again.', variant: 'destructive' });
    },
  });

  const STATUS_MENU: { label: string; action: 'arrive' | 'start' | 'complete' | 'cancel' }[] = [
    { label: 'On site', action: 'arrive' },
    { label: 'In progress', action: 'start' },
    { label: 'Completed', action: 'complete' },
    { label: 'Cancelled', action: 'cancel' },
  ];

  const handleStatusChoice = async (action: 'arrive' | 'start' | 'complete' | 'cancel') => {
    if (selectedJobIds.length === 0) return;
    if (action === 'cancel') {
      setCancelDialogOpen(true);
      return;
    }
    const count = selectedJobIds.length;
    const consequence = action === 'complete'
      ? ` Completing ${count} job${count === 1 ? '' : 's'} will fire any customer follow-ups configured in Automations for job completion, one per job.`
      : '';
    const confirmed = await confirm({
      title: `Update ${count} job${count === 1 ? '' : 's'} to ${action === 'arrive' ? 'On site' : action === 'start' ? 'In progress' : 'Completed'}?`,
      description: consequence.trim() || undefined,
      confirmLabel: 'Update',
    });
    if (!confirmed) return;
    bulkStatusMutation.mutate({ ids: selectedJobIds, action });
  };

  const handleCancelConfirm = (reason: string) => {
    bulkStatusMutation.mutate({ ids: selectedJobIds, action: 'cancel', cancelled_reason: reason });
    setCancelDialogOpen(false);
  };

  const handleAssign = async (userId: string | null) => {
    const count = selectedJobIds.length;
    if (count === 0) return;
    const confirmed = await confirm(
      userId
        ? {
            title: `Assign 1 technician to ${count} job${count === 1 ? '' : 's'}?`,
            description: `This replaces the current crew on ${count === 1 ? 'that job' : 'those jobs'}, and the newly-assigned technician is emailed an assignment notice.`,
            confirmLabel: 'Assign',
          }
        : {
            title: `Clear the crew on ${count} job${count === 1 ? '' : 's'}?`,
            description: 'Removed technicians are emailed a removal notice.',
            confirmLabel: 'Clear crew',
            tone: 'danger' as const,
          }
    );
    if (!confirmed) return;
    bulkAssignMutation.mutate({ ids: selectedJobIds, assignee_ids: userId ? [userId] : [] });
  };

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const clearAllFilters = () => {
    setValue({});
    setSearch('');
    setPage(1);
  };

  // ─── Clickable status KPIs ───────────────────────────────
  // Each tile maps 1:1 to its tile count → filtering shows exactly that many
  // rows. Clicking the active tile clears the filter.
  //   • All-time tiles (Unscheduled/Scheduled/In Progress): status-only, NO date range.
  //   • Monthly tiles (Completed/Cancelled): status + current-month Scheduled range.
  // A tile is only "active" when NOTHING else narrows the list further than the
  // tile's own count implies — every other facet/standalone filter must be unset.
  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const assignedValues = value.assigned_to?.kind === 'multi' ? value.assigned_to.values : [];
  const departmentValues = value.department_id?.kind === 'multi' ? value.department_id.values : [];
  const scheduledValue = value.scheduled?.kind === 'dateRange' ? value.scheduled : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const needsInvoiceValues = value.needs_invoice?.kind === 'multi' ? value.needs_invoice.values : [];
  const needsInvoiceActive = needsInvoiceValues.includes('true');
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here
  // too - otherwise a status-plus-tags filter leaves the status tile lit over a list
  // narrowed further than its count implies, and a repeat click routes into
  // clearAllFilters() and drops the tag filter.
  const otherFiltersActive =
    assignedValues.length > 0 ||
    departmentValues.length > 0 ||
    tagValues.length > 0 ||
    Boolean(createdValue?.from) || Boolean(createdValue?.to) ||
    Boolean(search);

  const noScheduledRange = !scheduledValue?.from && !scheduledValue?.to;
  const isMonthRange = scheduledValue?.from === monthStart && scheduledValue?.to === monthEnd;
  const soleStatus = statusValues.length === 1 ? statusValues[0] : null;

  const activeStatusKpi =
    soleStatus && !otherFiltersActive && !needsInvoiceActive
      ? MONTHLY_JOB_STATUSES.includes(soleStatus)
        ? (isMonthRange ? soleStatus : null)
        : (noScheduledRange ? soleStatus : null)
      : null;

  const handleStatusKpi = (status: string) => {
    if (activeStatusKpi === status) { clearAllFilters(); return; }
    setSearch('');
    setPage(1);
    if (MONTHLY_JOB_STATUSES.includes(status)) {
      setValue({
        status: { kind: 'multi', values: [status] },
        scheduled: { kind: 'dateRange', from: monthStart, to: monthEnd },
      });
    } else {
      setValue({ status: { kind: 'multi', values: [status] } });
    }
  };

  // Need Invoices tile: completed-but-unbilled jobs. Active only when needs_invoice
  // is the sole filter (no status, scheduled range, assignee, department, or search).
  const activeNeedInvoicesKpi =
    needsInvoiceActive && statusValues.length === 0 && noScheduledRange && !otherFiltersActive;

  const handleNeedInvoicesKpi = () => {
    if (activeNeedInvoicesKpi) { clearAllFilters(); return; }
    // `setValue` full-replaces every registry facet (see useFilterState.ts's
    // JSDoc), so this single call already clears status/assigned_to/
    // department_id/scheduled/created in the same stroke the old
    // `setValue({}) + setNeedsInvoice(true)` two-call sequence did.
    setValue({ needs_invoice: { kind: 'multi', values: ['true'] } });
    setSearch('');
    setPage(1);
  };

  // Whether the applied-filters strip has anything to show — mirrors the old
  // page's `hasActiveFilters` gate (search was never part of it either; the
  // search box is its own toolbar element, not a chip).
  const hasAnyFacetActive = Object.keys(value).length > 0;

  const toExportRow = (j: JobListItem) => ({
    'Job #': j.job_number,
    'Customer': customerDisplayName(j.customer, ''),
    'Company': j.customer.company_name ?? '',
    'Status': j.status,
    'Location': formatJobLocation(j.service_location),
    'Assigned To': (j.assignees ?? []).map((a) => `${a.user.first_name} ${a.user.last_name}`).join('; '),
    'Scheduled': formatExactInstant(j.scheduled_start),
    'Created': formatExactInstant(j.created_at),
  });

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (rows: JobListItem[], filename: string) => {
    if (!rows.length) return;
    downloadCSV(toCSV(rows.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => exportRows(data?.jobs ?? [], `jobs-page${page}-${today()}.csv`);
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/jobs/export', { params: listParams });
      exportRows(ex.jobs ?? [], `jobs-all-${today()}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export jobs. Please try again.', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page heading */}
      <Heading className="flex items-center gap-2"><Briefcase className="h-5 w-5 shrink-0 text-primary" />Jobs</Heading>

      {/* KPI Strip */}
      <KpiStrip
        loading={isLoading}
        items={[
          { icon: AlertCircle, label: 'Unscheduled', value: stats?.unassigned ?? 0, tone: 'warning', emphasize: (stats?.unassigned ?? 0) > 0, active: activeStatusKpi === 'UNSCHEDULED', onClick: () => handleStatusKpi('UNSCHEDULED') },
          { icon: CalendarDays, label: 'Scheduled', value: stats?.scheduled ?? 0, tone: 'primary', active: activeStatusKpi === 'SCHEDULED', onClick: () => handleStatusKpi('SCHEDULED') },
          { icon: Play, label: 'In Progress', value: stats?.in_progress ?? 0, tone: 'success', active: activeStatusKpi === 'IN_PROGRESS', onClick: () => handleStatusKpi('IN_PROGRESS') },
          { icon: CheckCircle2, label: 'Completed', value: stats?.completed ?? 0, sub: 'This month', tone: 'success', active: activeStatusKpi === 'COMPLETED', onClick: () => handleStatusKpi('COMPLETED') },
          { icon: Ban, label: 'Cancelled', value: stats?.cancelled ?? 0, sub: 'This month', tone: 'neutral', active: activeStatusKpi === 'CANCELLED', onClick: () => handleStatusKpi('CANCELLED') },
          { icon: Receipt, label: 'Need Invoices', value: stats?.need_invoices ?? 0, sub: 'Completed, unbilled', tone: 'warning', active: activeNeedInvoicesKpi, onClick: handleNeedInvoicesKpi },
        ]}
      />

      {/* Bulk-selection toolbar - visible only while at least one row is checked */}
      {selectedJobIds.length > 0 && (
        <div className="flex items-center justify-between rounded-card border border-border bg-surface-light px-4 py-2.5 shadow-card">
          <span className="text-sm font-medium text-text-primary">
            {selectedJobIds.length} selected
          </span>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={bulkStatusMutation.isPending}>
                  Change status
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {STATUS_MENU.filter((item) => ability.can(item.action, 'Job')).map((item) => (
                  <DropdownMenuItem key={item.action} onClick={() => handleStatusChoice(item.action)}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {canBulkAssign && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={bulkAssignMutation.isPending}>
                    Assign
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {techs.map((t) => (
                    <DropdownMenuItem key={t.id} onClick={() => handleAssign(t.id)}>
                      {t.first_name} {t.last_name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleAssign(null)}>Clear crew</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <DataTable
        columns={columns}
        data={data?.jobs ?? []}
        pagination={data?.pagination}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        getRowId={(job) => job.id}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
        searchValue={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search jobs..."
        sorting={sorting}
        onSortingChange={(s) => { setSorting(s); setPage(1); }}
        onRowClick={(job) => navigate(`/jobs/${job.id}`)}
        tableKey="jobs"
        filters={
          <FilterBar
            registry={jobsRegistry}
            value={value}
            onChange={handleFilterChange}
            resolveOptions={resolveOptions}
            resolveMax={resolveMax}
          />
        }
        activeFilters={
          hasAnyFacetActive ? (
            <div className="flex items-center gap-2 flex-wrap">
              <AppliedChips
                registry={jobsRegistry}
                value={value}
                onChange={handleFilterChange}
                resolveOptions={resolveOptions}
              />
              <Button
                variant="ghost"
                tone="subtle"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={clearAllFilters}
              >
                Clear all
              </Button>
            </div>
          ) : null
        }
        headerActions={
          <div className="flex items-center gap-2">
            {user?.role !== 'SALES' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Download className="mr-2 h-4 w-4" />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Export as CSV</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExportCurrentPage}>
                    Current page ({data?.jobs?.length ?? 0} rows)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportAll}>
                    All ({data?.pagination?.total ?? '...'})
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canManage && (
              <Button variant="solid" tone="business" onClick={() => navigate('/jobs/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Job
              </Button>
            )}
          </div>
        }
      />

      <BulkCancelJobsDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        count={selectedJobIds.length}
        isPending={bulkStatusMutation.isPending}
        onConfirm={handleCancelConfirm}
      />
      {confirmDialog}
    </div>
  );
}

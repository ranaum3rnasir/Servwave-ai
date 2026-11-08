import { useState, useCallback, useMemo, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef, SortingState, VisibilityState, RowSelectionState } from '@tanstack/react-table';
import api from '@/lib/axios';
import { DataTable } from '@/components/data/data-table';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { KpiStrip } from '@/components/data/KpiStrip';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ListPageShell } from '@/components/patterns/ListPageShell';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  DollarSign,
  AlertTriangle,
  FileText,
  Download,
  Receipt,
  Plus,
} from 'lucide-react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { formatCurrency } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactDay, formatExactInstant } from '@/lib/format-date';
import { toCSV, downloadCSV } from '@/lib/inventory/csv';
import { toast } from '@/components/ui/use-toast';
import { FilterBar } from '@/components/filters/FilterBar';
import { AppliedChips } from '@/components/filters/AppliedChips';
import { useFilterState } from '@/lib/filters/useFilterState';
import { invoicesRegistry } from '@/lib/filters/registries/invoices';
import { summariseBulkResult } from '@/lib/bulk-result';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { tagsColumn } from '@/components/data/TagChips';
import { useTagFacetOptions, type Tag } from '@/lib/api/tags';
import { useScopedRowSelection } from '@/lib/useScopedRowSelection';

// ─── Types ──────────────────────────────────────────

interface InvoiceListItem {
  id: string;
  invoice_number: string;
  status: string;
  kind: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  // §6/§8: customer is always present on the invoice; job is optional
  // (deposit/orphan invoices have no job).
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
  };
  job: {
    id: string;
    job_number: string;
  } | null;
  tags?: Tag[];
}

// #594 — rows rendered in the "To Be Invoiced" modal (GET /api/jobs?needs_invoice=true).
interface NeedInvoiceJob {
  id: string;
  job_number: string;
  scheduled_start: string | null;
  customer: { id: string; first_name: string; last_name: string; company_name: string | null };
}

interface InvoiceStats {
  due: { total: number; count: number };
  overdue: { total: number; count: number };
  collected_this_month: { total: number; count: number };
  unsent: number;
  need_invoices: number;
}

// ─── Constants ──────────────────────────────────────
// INVOICE_STATUSES/INVOICE_STATUS_LABELS now live in
// `@/lib/filters/registries/invoices` (Task 15), baked into the Status
// facet's static `options` — this page no longer needs them directly (the
// export-row mapping below writes the raw `inv.status` enum value, same as
// before this task).

// Set-equality helper for clickable status KPIs.
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && b.every((x) => a.includes(x));

// ─── Overdue helper ─────────────────────────────────

function isOverdue(invoice: InvoiceListItem): boolean {
  if (!invoice.due_date) return false;
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') return false;
  return new Date(invoice.due_date) < new Date();
}

// ─── Columns ────────────────────────────────────────
//
// Every className below used to be BLOCKED at 7f: a cell RENDERER paints the
// contents of a cell it does not own, and data-table.tsx builds the enclosing
// `<TableCell className="relative" divider>` itself with no `columnDef.meta`
// route to reach `tone`/`align`/`weight`. That blocker still stands for
// anything that would need to change TableCell or data-table.tsx - it does
// not for colour, size, weight, alignment or casing painted INSIDE a
// renderer's own return value, which is exactly Text's domain and needs
// neither file touched. Converted onto Text below; `cursor-pointer` and
// `hover:underline` stay raw className (no such Text axis).

export const columns: ColumnDef<InvoiceListItem, unknown>[] = [
  {
    accessorKey: 'invoice_number',
    header: 'Invoice #',
    size: 120,
    minSize: 100,
    cell: ({ row }) => (
      <Text as="span" weight="medium" tone="brand">{row.original.invoice_number}</Text>
    ),
  },
  {
    accessorKey: 'customer',
    header: 'Customer',
    size: 180,
    minSize: 140,
    enableSorting: false,
    cell: ({ row }) => {
      const c = row.original.customer;
      return (
        <div>
          <Text as="span" weight="medium" tone="primary">
            {customerDisplayName(c, '')}
          </Text>
          {c.company_name && (c.first_name || c.last_name) && (
            <Text as="p" size="xs" tone="secondary">{c.company_name}</Text>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'job',
    header: 'Job',
    size: 100,
    minSize: 80,
    enableSorting: false,
    cell: ({ row }) => {
      const job = row.original.job;
      if (!job) return <Text as="span" tone="secondary">—</Text>;
      return (
        <Text
          as="span"
          weight="medium"
          tone="brand"
          className="cursor-pointer hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            window.location.href = `/jobs/${job.id}`;
          }}
        >
          {job.job_number}
        </Text>
      );
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    minSize: 90,
    cell: ({ row }) => {
      const overdue = isOverdue(row.original);
      return <StatusBadge domain="invoice" status={overdue ? 'OVERDUE' : row.original.status} />;
    },
  },
  {
    accessorKey: 'subtotal',
    header: 'Subtotal',
    size: 100,
    minSize: 80,
    enableSorting: false,
    cell: ({ row }) => (
      <Text as="span" align="right" className="tabular-nums block">
        {formatCurrency(Number(row.original.subtotal))}
      </Text>
    ),
  },
  {
    accessorKey: 'discount_amount',
    header: 'Discount',
    size: 90,
    minSize: 70,
    enableSorting: false,
    cell: ({ row }) => {
      const val = Number(row.original.discount_amount);
      return (
        <Text as="span" align="right" className="tabular-nums block">
          {val === 0 ? '-' : formatCurrency(val)}
        </Text>
      );
    },
  },
  {
    accessorKey: 'tax_amount',
    header: 'Tax',
    size: 80,
    minSize: 70,
    enableSorting: false,
    cell: ({ row }) => (
      <Text as="span" align="right" className="tabular-nums block">
        {formatCurrency(Number(row.original.tax_amount))}
      </Text>
    ),
  },
  {
    accessorKey: 'deposit_credit',
    header: 'Deposit Credit',
    size: 100,
    minSize: 80,
    enableSorting: false,
    cell: ({ row }) => {
      const val = Number(row.original.deposit_credit);
      return (
        <Text as="span" align="right" className="tabular-nums block">
          {val === 0 ? '-' : formatCurrency(val)}
        </Text>
      );
    },
  },
  {
    accessorKey: 'total_amount',
    header: 'Total',
    size: 110,
    minSize: 90,
    cell: ({ row }) => (
      <Text as="span" weight="medium" align="right" className="tabular-nums block">
        {formatCurrency(Number(row.original.total_amount))}
      </Text>
    ),
  },
  {
    accessorKey: 'amount_due',
    header: 'Amount Due',
    size: 120,
    minSize: 100,
    cell: ({ row }) => {
      const val = Number(row.original.amount_due);
      return (
        <Text as="span" weight={val > 0 ? 'bold' : undefined} align="right" className="tabular-nums block">
          {formatCurrency(val)}
        </Text>
      );
    },
  },
  {
    accessorKey: 'due_date',
    header: 'Due Date',
    size: 120,
    minSize: 100,
    cell: ({ row }) => {
      const { due_date } = row.original;
      if (!due_date) return <Text as="span" tone="secondary">—</Text>;
      const overdue = isOverdue(row.original);
      return (
        <Text as="span" tone={overdue ? 'danger' : undefined}>
          {formatExactDay(due_date)}
        </Text>
      );
    },
  },
  tagsColumn<InvoiceListItem>(),
  {
    accessorKey: 'created_at',
    header: 'Created',
    size: 110,
    minSize: 90,
    cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString('en-US'),
  },
];

// ─── Default hidden columns ──────────────────────────

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  subtotal: false,
  discount_amount: false,
  tax_amount: false,
  deposit_credit: false,
};

// ─── Page ────────────────────────────────────────────

export default function InvoicesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  // Standalone-invoice creation is ADMIN + DISPATCHER (the `create Invoice` grant also
  // covers technicians, but they never reach this desktop page; SALES can only read).
  const canCreateInvoice = ability.can('create', 'Invoice');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');

  // Generalized filter registry (Task 15): status, total (range), balance
  // (range), created (dateRange), due (dateRange) — all URL-driven via
  // `invoicesRegistry`. Mirrors Estimates' Task 13 wiring (`useFilterState`
  // replaces the old page's bespoke `statuses`/`createdFrom`/`createdTo`/
  // `dueFrom`/`dueTo` `useState`s for these fields).
  const { value, setValue, listParams: filterParams } = useFilterState(invoicesRegistry);

  // Standalone state — NOT registry facets (see invoicesRegistry.ts's
  // file-level comment for why): search, pagination, sort, column
  // visibility. (`overdue` moved into the registry as a 1-option facet;
  // `customer_id`/`CustomerSelect` were removed from the page entirely —
  // the global search bar already covers customer lookup.)
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY);
  const [needInvoiceOpen, setNeedInvoiceOpen] = useState(false);
  // List-level bulk actions (bulk-send / bulk-resend) - keyed by invoice id.

  // SRVW-58 - the org's tag vocabulary for the Tags facet, this registry's first
  // dynamic `optionSource` (resolveOptions was a stable no-op before).
  const tagFacetOptions = useTagFacetOptions();
  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => (sourceId === 'tags' ? tagFacetOptions : []),
    [tagFacetOptions]
  );
  // No backend "max total"/"max balance across all invoices" stat today —
  // 100000 is a sensible static money ceiling for both (see
  // invoicesRegistry.ts's comment on the `total`/`balance` facets).
  const resolveMax = useCallback(
    (sourceId: string): number =>
      sourceId === 'invoices.maxTotal' || sourceId === 'invoices.maxBalance' ? 100000 : 0,
    []
  );

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
  // the request either way. `overdue` is now facet-owned (see
  // invoicesRegistry.ts) so its baseline placeholder lives here alongside
  // the rest, filled in by `filterParams` when the facet is active.
  const listParams = {
    search: search || undefined,
    status: undefined as string | undefined,
    total_min: undefined as string | undefined,
    total_max: undefined as string | undefined,
    balance_min: undefined as string | undefined,
    balance_max: undefined as string | undefined,
    created_after: undefined as string | undefined,
    created_before: undefined as string | undefined,
    due_after: undefined as string | undefined,
    due_before: undefined as string | undefined,
    overdue: undefined as string | undefined,
    sortBy,
    sortDir: sortBy ? sortDir : undefined,
    ...filterParams,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', { page, pageSize, search, sortBy, sortDir, value }],
    queryFn: async () => {
      const { data } = await api.get('/api/invoices', {
        params: { page, limit: pageSize, ...listParams },
      });
      return data;
    },
  });

  // #594 — lazy, gated query for the "To Be Invoiced" modal; only fetches once the
  // tile is clicked. Distinct queryKey so it can't collide with the invoices/jobs lists.
  const { data: needInvoiceData, isLoading: needInvoiceLoading } = useQuery({
    queryKey: ['jobs', 'needs-invoice'],
    queryFn: async () => {
      const { data } = await api.get('/api/jobs', { params: { needs_invoice: 'true', limit: 100 } });
      return data as { jobs: NeedInvoiceJob[] };
    },
    enabled: needInvoiceOpen,
  });

  const stats: InvoiceStats | undefined = data?.stats;

  // A selected id only makes sense against the CURRENT page/sort/filter - mirrors the invoices
  // query's own queryKey dependency set exactly (EstimatesPage.tsx does the same).

  const { rowSelection, setRowSelection, selectedIds: selectedInvoiceIds } =
    useScopedRowSelection(JSON.stringify([page, pageSize, search, sortBy, sortDir, value]));

  const bulkSendMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/invoices/bulk-send', { ids });
      return data as { sent: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setRowSelection({});
      const { title, description } = summariseBulkResult({
        okCount: result.sent.length,
        failed: result.failed,
        noun: 'invoice',
        nounPlural: 'invoices',
        verbPast: 'sent',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Send failed', description: 'Failed to send invoices. Please try again.', variant: 'destructive' });
    },
  });

  const bulkResendMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data } = await api.post('/api/invoices/bulk-resend', { ids });
      return data as { sent: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setRowSelection({});
      const { title, description } = summariseBulkResult({
        okCount: result.sent.length,
        failed: result.failed,
        noun: 'invoice',
        nounPlural: 'invoices',
        verbPast: 'sent',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Send failed', description: 'Failed to send invoice reminders. Please try again.', variant: 'destructive' });
    },
  });

  const bulkSendOverCap = selectedInvoiceIds.length > 25;
  const handleBulkSend = () => {
    if (selectedInvoiceIds.length === 0 || bulkSendOverCap) return;
    bulkSendMutation.mutate(selectedInvoiceIds);
  };
  const handleBulkResend = () => {
    if (selectedInvoiceIds.length === 0 || bulkSendOverCap) return;
    bulkResendMutation.mutate(selectedInvoiceIds);
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

  // ─── Clickable KPIs ──────────────────────────────────────
  // The stats are GLOBAL (tenant/role-scoped, independent of the active list
  // filters). For the KPI counts/sums to match the filtered list exactly, a
  // KPI click clears every other filter and sets only the relevant status (or
  // the overdue flag). `active` therefore also requires no other filters be set,
  // matching the Jobs/Estimates pattern.
  const statusValues = value.status?.kind === 'multi' ? value.status.values : [];
  const overdueValues = value.overdue?.kind === 'multi' ? value.overdue.values : [];
  const totalValue = value.total?.kind === 'range' ? value.total : undefined;
  const balanceValue = value.balance?.kind === 'range' ? value.balance : undefined;
  const createdValue = value.created?.kind === 'dateRange' ? value.created : undefined;
  const dueValue = value.due?.kind === 'dateRange' ? value.due : undefined;

  const totalActive = Boolean(totalValue && (totalValue.from != null || totalValue.to != null));
  const balanceActive = Boolean(balanceValue && (balanceValue.from != null || balanceValue.to != null));
  const createdActive = Boolean(createdValue?.from || createdValue?.to);
  const dueRangeActive = Boolean(dueValue?.from || dueValue?.to);
  const overdueActive = overdueValues.includes('true');
  const tagValues = value.tags?.kind === 'multi' ? value.tags.values : [];

  // Shared base: no other facet or standalone filter active (excludes status + overdue,
  // which each KPI tile evaluates on its own).
  // SRVW-58: this gate ENUMERATES facet keys, so a new facet has to be added here too -
  // otherwise a status-plus-tags filter leaves a tile lit over a list narrowed further
  // than its count implies, and clicking it routes into setValue({}) and drops the tag
  // filter.
  const noOtherFacetsOrStandalone =
    !totalActive && !balanceActive && !createdActive && !dueRangeActive && !search &&
    tagValues.length === 0;

  const noOtherFilters = !overdueActive && noOtherFacetsOrStandalone;

  const dueKpiActive = noOtherFilters && sameSet(statusValues, ['SENT', 'PARTIAL']);
  const unsentKpiActive = noOtherFilters && sameSet(statusValues, ['DRAFT']);
  const overdueKpiActive = overdueActive && statusValues.length === 0 && noOtherFacetsOrStandalone;

  const handleStatusKpi = (next: string[], isActive: boolean) => {
    setSearch('');
    setPage(1);
    setValue(isActive ? {} : { status: { kind: 'multi', values: next } });
  };
  const handleOverdueKpi = () => {
    setSearch('');
    setPage(1);
    // `setValue` replaces the whole registry-owned facet set in one call, so
    // this single call both applies (or clears) `overdue` AND clears every
    // other facet (status/total/balance/created/due) — overdue spans all
    // statuses, matching the pre-facet standalone-toggle behavior.
    setValue(overdueKpiActive ? {} : { overdue: { kind: 'multi', values: ['true'] } });
  };

  // Whether the applied-filters strip has anything to show — mirrors the old
  // page's `hasActiveFilters` gate (search was never part of it either; the
  // search box is its own toolbar element, not a chip).
  const hasAnyFacetActive = Object.keys(value).length > 0;

  const toExportRow = (inv: InvoiceListItem) => ({
    'Invoice #': inv.invoice_number,
    'Customer': customerDisplayName(inv.customer, ''),
    'Company': inv.customer.company_name ?? '',
    'Job': inv.job?.job_number ?? '',
    'Status': isOverdue(inv) ? 'OVERDUE' : inv.status,
    'Subtotal': Number(inv.subtotal),
    'Discount': Number(inv.discount_amount),
    'Tax': Number(inv.tax_amount),
    'Deposit Credit': Number(inv.deposit_credit),
    'Total': Number(inv.total_amount),
    'Amount Due': Number(inv.amount_due),
    'Due Date': formatExactDay(inv.due_date),
    'Created': new Date(inv.created_at).toLocaleDateString('en-US'),
  });

  const today = () => new Date().toISOString().split('T')[0];
  const exportRows = (rows: InvoiceListItem[], filename: string) => {
    if (!rows.length) return;
    downloadCSV(toCSV(rows.map(toExportRow)), filename);
  };

  const handleExportCurrentPage = () => exportRows(data?.invoices ?? [], `invoices-page${page}-${today()}.csv`);
  const handleExportAll = async () => {
    try {
      const { data: ex } = await api.get('/api/invoices/export', { params: listParams });
      exportRows(ex.invoices ?? [], `invoices-all-${today()}.csv`);
    } catch {
      toast({ title: 'Export failed', description: 'Failed to export invoices. Please try again.', variant: 'destructive' });
    }
  };

  return (
    // Phase 7f. The page shell is `ListPageShell` (header band content), so
    // this file no longer authors the page title's type, weight or colour, nor
    // the 24px rhythm between the three bands. `loading` / `empty` are
    // deliberately NOT passed: DataTable already routes both (data-table.tsx
    // renders placeholder rows while `isLoading`, then its own EmptyState on an
    // empty result), and duplicating that here would give the page two
    // competing empty states.
    <ListPageShell
      header={{
        title: 'Invoices',
        // The icon keeps its own size and colour at the call site. PageHeader
        // owns WHERE the icon sits, not how big it is or what colour it is,
        // and there is no `Icon` primitive to hand `text-primary` to yet -
        // see the residue list in the 7f report.
        icon: <Receipt className="h-5 w-5 shrink-0 text-primary" />,
      }}
      band={
        <KpiStrip
          loading={isLoading}
          items={[
            { icon: DollarSign, label: 'Due', value: formatCurrency(Number(stats?.due?.total ?? 0)), sub: `${stats?.due?.count ?? 0} invoice${stats?.due?.count !== 1 ? 's' : ''}`, tone: 'primary', active: dueKpiActive, onClick: () => handleStatusKpi(['SENT', 'PARTIAL'], dueKpiActive) },
            { icon: AlertTriangle, label: 'Overdue', value: formatCurrency(Number(stats?.overdue?.total ?? 0)), sub: `${stats?.overdue?.count ?? 0} invoice${stats?.overdue?.count !== 1 ? 's' : ''}`, tone: 'danger', emphasize: true, active: overdueKpiActive, onClick: handleOverdueKpi },
            { icon: FileText, label: 'Unsent Drafts', value: stats?.unsent ?? 0, tone: 'warning', emphasize: (stats?.unsent ?? 0) > 0, active: unsentKpiActive, onClick: () => handleStatusKpi(['DRAFT'], unsentKpiActive) },
            // Bug #21 — surface the completed-but-unbilled count (already returned in
            // stats.need_invoices) and open an in-page modal listing those jobs, each row
            // linking to the job detail page (#594).
            { icon: Receipt, label: 'To Be Invoiced', value: stats?.need_invoices ?? 0, sub: 'Completed, unbilled', tone: 'warning', emphasize: (stats?.need_invoices ?? 0) > 0, onClick: () => setNeedInvoiceOpen(true) },
          ]}
        />
      }
    >
      {/* Bulk-selection toolbar - visible only while at least one row is checked */}
      {selectedInvoiceIds.length > 0 && (
        <div className="mb-4 flex items-center justify-between rounded-card border border-border bg-surface-light px-4 py-2.5 shadow-card">
          <span className="text-sm font-medium text-text-primary">
            {selectedInvoiceIds.length} selected
          </span>
          {ability.can('send', 'Invoice') && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkSend}
                disabled={bulkSendMutation.isPending || bulkSendOverCap}
                title={bulkSendOverCap ? 'Select 25 or fewer invoices to send' : undefined}
              >
                {bulkSendMutation.isPending ? 'Sending...' : 'Send'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkResend}
                disabled={bulkResendMutation.isPending || bulkSendOverCap}
                title={bulkSendOverCap ? 'Select 25 or fewer invoices to send a reminder' : undefined}
              >
                {bulkResendMutation.isPending ? 'Sending...' : 'Send reminder'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <DataTable
        columns={columns}
        data={data?.invoices ?? []}
        pagination={data?.pagination}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        getRowId={(invoice) => invoice.id}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        isLoading={isLoading}
        searchValue={search}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search invoices..."
        sorting={sorting}
        onSortingChange={(s) => { setSorting(s); setPage(1); }}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        tableKey="invoices"
        onRowClick={(invoice) => navigate(`/invoices/${invoice.id}`)}
        filters={
          <FilterBar
            registry={invoicesRegistry}
            value={value}
            onChange={handleFilterChange}
            resolveOptions={resolveOptions}
            resolveMax={resolveMax}
          />
        }
        activeFilters={
          hasAnyFacetActive ? (
            <Stack direction="horizontal" align="center" gap={2} wrap>
              <AppliedChips
                registry={invoicesRegistry}
                value={value}
                onChange={handleFilterChange}
                resolveOptions={resolveOptions}
              />
              <Button
                variant="ghost"
                tone="subtle"
                size="3xs"
                onClick={clearAllFilters}
              >
                Clear all
              </Button>
            </Stack>
          ) : null
        }
        headerActions={
          <Stack direction="horizontal" align="center" gap={2}>
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
                  Current page ({data?.invoices?.length ?? 0} rows)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportAll}>
                  All ({data?.pagination?.total ?? '...'})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canCreateInvoice && (
              <Button variant="solid" tone="business" size="sm" onClick={() => navigate('/invoices/new')}>
                <Plus className="mr-2 h-4 w-4" />
                New Invoice
              </Button>
            )}
          </Stack>
        }
      />

      {/* #594 — "To Be Invoiced" modal: completed jobs still needing an invoice. */}
      <Dialog open={needInvoiceOpen} onOpenChange={setNeedInvoiceOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>To Be Invoiced</DialogTitle>
            <DialogDescription>Completed jobs that still need an invoice. Select a job to bill it.</DialogDescription>
          </DialogHeader>
          {/* BLOCKED at 7f, two remaining gaps - see the 7f residue list. (A third,
              the loading line's typography, retired onto Text below; `py-10`
              stays a raw className because Text has no spacing axis - that 40px
              gap is EmptyState's density ladder, still 0/6/12/24.)
              1. The dense table below cannot adopt components/data/table.tsx:
                 TableHead there is `h-10 px-4 text-[10.5px] font-bold uppercase
                 tracking-wide` and TableCell is `p-4`, against this table's
                 `py-2 font-medium` / `py-2`. Adopting them restyles every cell,
                 which the hard constraint forbids. A `density` axis on the Table
                 primitives is the fix.
              2. The job link is `font-medium text-primary hover:underline`.
                 There is no inline-link primitive: Button variant="link" is a
                 40px-tall inline-flex control, not inline text. */}
          {needInvoiceLoading ? (
            <Text as="p" size="sm" tone="secondary" align="center" className="py-10">
              Loading…
            </Text>
          ) : (needInvoiceData?.jobs.length ?? 0) === 0 ? (
            <EmptyState title="No completed jobs are waiting to be invoiced." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="py-2 font-medium">Job #</th>
                  <th className="py-2 font-medium">Customer</th>
                  <th className="py-2 font-medium">Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {needInvoiceData!.jobs.map((job) => (
                  <tr key={job.id} className="border-b border-border last:border-0">
                    <td className="py-2">
                      <Link to={`/jobs/${job.id}`} className="font-medium text-primary hover:underline">
                        {job.job_number}
                      </Link>
                    </td>
                    <td className="py-2 text-text-primary">{customerDisplayName(job.customer, '')}</td>
                    <td className="py-2 tabular-nums text-text-secondary">{formatExactInstant(job.scheduled_start)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>
    </ListPageShell>
  );
}

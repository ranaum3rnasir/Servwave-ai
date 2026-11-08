// ───────────────────────────────────────────────────────────────────────────
// Invoices report — Workiz-style list with follow-up filters.
// Filter by client search, salesperson, technician, status, job type, date.
// Export the filtered set to hand a rep/tech their follow-up list.
//  • demo org → deterministic MOCK data.
//  • real org → GET /api/reports/invoices (live, org-scoped). Salesperson is the
//    estimate→lead→commission_owner (the seller); technician is the first job
//    assignee. See invoices-data.ts.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import { DollarSign, AlertTriangle, FileText, CheckCircle2, X } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { MultiSelectFilter, ReportToolbar, ReportPager } from './_shared';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { exportCsvFile } from '@/lib/csv';
import { STATUS_INTENT_CLASSES } from '@/design-system/status-registry';
import {
  useInvoicesReport, JOB_TYPES, STATUSES, type InvoiceStatus,
} from '@/lib/reports/invoices-data';

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DAY = 86_400_000;

// Synthetic report-only taxonomy (Title Case) - not the backend InvoiceStatus enum, so
// this stays a local map, but the colours come from the status registry's intent classes.
const STATUS_STYLE: Record<InvoiceStatus, string> = {
  Paid: STATUS_INTENT_CLASSES.success,
  Due: STATUS_INTENT_CLASSES.warning,
  Overdue: STATUS_INTENT_CLASSES.danger,
  Unsent: STATUS_INTENT_CLASSES.neutral,
  Partial: STATUS_INTENT_CLASSES.info,
};

type DatePreset = 'all' | '7d' | '30d' | '90d' | 'month' | 'custom';
const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' },
];

// Cutoff for a relative preset, anchored to the report's "now" (mock anchor for
// demo, live clock for real orgs).
function dateCutoff(preset: DatePreset, now: Date): number {
  const baseMs = now.getTime();
  if (preset === '7d') return baseMs - 7 * DAY;
  if (preset === '30d') return baseMs - 30 * DAY;
  if (preset === '90d') return baseMs - 90 * DAY;
  if (preset === 'month') {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }
  if (preset === 'custom') return -Infinity; // handled separately via from/to
  return -Infinity; // all time
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function InvoicesReport() {
  const report = findReport('invoices')!;
  const isDemo = useIsDemoOrg();
  const { rows: ALL, now: NOW } = useInvoicesReport(isDemo);

  // Filter options: fixed roster for the demo, derived from the live rows for a
  // real org (so only people who actually appear are offered).
  const repOptions = useMemo(() => [...new Set(ALL.map((r) => r.salesperson))].sort(), [ALL]);
  const techOptions = useMemo(() => [...new Set(ALL.map((r) => r.technician))].sort(), [ALL]);
  const jobTypeOptions = useMemo(
    () => (isDemo ? [...JOB_TYPES] : [...new Set(ALL.map((r) => r.jobType))].sort()),
    [ALL, isDemo],
  );

  const [search, setSearch] = useState('');
  const [reps, setReps] = useState<string[]>([]);
  const [techs, setTechs] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [jobTypes, setJobTypes] = useState<string[]>([]);
  const [datePreset, setDatePreset] = useState<DatePreset>('all');

  const [customFrom, setCustomFrom] = useState(new Date(NOW.getTime() - 30 * DAY).toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(NOW.toISOString().slice(0, 10));

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);

  // Reset to first page whenever the filters change.
  useEffect(() => setPage(0), [search, reps, techs, statuses, jobTypes, datePreset, customFrom, customTo, pageSize]);

  // Everything EXCEPT the status filter — so the status KPI cards always show
  // their real totals and stay clickable as a status switcher.
  const filteredNoStatus = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = dateCutoff(datePreset, NOW);
    const customFromMs = datePreset === 'custom' && customFrom ? new Date(customFrom + 'T00:00:00').getTime() : -Infinity;
    const customToMs = datePreset === 'custom' && customTo ? new Date(customTo + 'T23:59:59.999').getTime() : Infinity;
    return ALL
      .filter((r) => {
        if (datePreset === 'custom') return r.created >= customFromMs && r.created <= customToMs;
        return r.created >= cutoff;
      })
      .filter((r) => reps.length === 0 || reps.includes(r.salesperson))
      .filter((r) => techs.length === 0 || techs.includes(r.technician))
      .filter((r) => jobTypes.length === 0 || jobTypes.includes(r.jobType))
      .filter((r) =>
        q === '' ||
        r.client.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.number.includes(q) ||
        r.job.includes(q),
      );
  }, [ALL, search, reps, techs, jobTypes, datePreset, customFrom, customTo, NOW]);

  const filtered = useMemo(
    () => filteredNoStatus
      .filter((r) => statuses.length === 0 || statuses.includes(r.status))
      .sort((a, b) => b.created - a.created),
    [filteredNoStatus, statuses],
  );

  // Toggle a status in the Status filter (driven by the KPI cards + the dropdown).
  const toggleStatus = (s: InvoiceStatus) =>
    setStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const k = useMemo(() => {
    const sumDue = (s: InvoiceStatus) => filteredNoStatus.filter((r) => r.status === s).reduce((a, r) => a + r.due, 0);
    const count = (s: InvoiceStatus) => filteredNoStatus.filter((r) => r.status === s).length;
    return {
      due: sumDue('Due'), dueN: count('Due'),
      overdue: sumDue('Overdue'), overdueN: count('Overdue'),
      unsentN: count('Unsent'),
      collected: filteredNoStatus.filter((r) => r.status === 'Paid').reduce((a, r) => a + r.amount, 0),
      collectedN: count('Paid'),
    };
  }, [filteredNoStatus]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Totals across the full filtered set (rendered as the table footer row).
  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.subtotal += r.subtotal;
          acc.tax += r.tax;
          acc.amount += r.amount;
          acc.due += r.due;
          return acc;
        },
        { subtotal: 0, tax: 0, amount: 0, due: 0 },
      ),
    [filtered],
  );

  const hasFilters = !!search || reps.length > 0 || techs.length > 0 || statuses.length > 0 || jobTypes.length > 0 || datePreset !== 'all';
  function clearFilters() {
    setSearch(''); setReps([]); setTechs([]); setStatuses([]); setJobTypes([]); setDatePreset('all');
  }

  function exportCsv() {
    exportCsvFile(
      'invoices-report.csv',
      ['Invoice #', 'Client', 'Email', 'Created', 'Subtotal', 'Tax', 'Discount %', 'Amount', 'Due', 'Status', 'Job', 'Salesperson', 'Technician', 'Job type'],
      filtered.map((r) => [r.number, r.client, r.email, fmtDate(r.created), r.subtotal, r.tax, r.discountPct, r.amount, r.due, r.status, r.job, r.salesperson, r.technician, r.jobType]),
    );
  }

  return (
    <ReportShell
      report={report}
      actions={<ReportToolbar variant="compact" onExport={exportCsv} />}
    >
      {/* Click a card to filter the table by that status. */}
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Due', value: money(k.due), sub: `${k.dueN} invoice${k.dueN === 1 ? '' : 's'}`, tone: 'primary', active: statuses.includes('Due'), onClick: () => toggleStatus('Due') },
          { icon: AlertTriangle, label: 'Overdue', value: money(k.overdue), sub: `${k.overdueN} invoice${k.overdueN === 1 ? '' : 's'}`, tone: 'danger', emphasize: true, active: statuses.includes('Overdue'), onClick: () => toggleStatus('Overdue') },
          { icon: FileText, label: 'Unsent', value: k.unsentN, tone: 'warning', emphasize: k.unsentN > 0, active: statuses.includes('Unsent'), onClick: () => toggleStatus('Unsent') },
          { icon: CheckCircle2, label: 'Collected', value: money(k.collected), sub: `${k.collectedN} invoice${k.collectedN === 1 ? '' : 's'}`, tone: 'success', emphasize: true, active: statuses.includes('Paid'), onClick: () => toggleStatus('Paid') },
        ]}
      />

      {/* Filter bar */}
      <div className="rounded-xl border border-border bg-surface-light p-3 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client, email, invoice # or job #"
            className="h-8 w-72 rounded-lg border border-border bg-surface-light px-3 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <MultiSelectFilter label="Salesperson" options={repOptions} selected={reps} onChange={setReps} />
          <MultiSelectFilter label="Technician" options={techOptions} selected={techs} onChange={setTechs} />
          <MultiSelectFilter label="Status" options={[...STATUSES]} selected={statuses} onChange={setStatuses} />
          <MultiSelectFilter label="Job type" options={jobTypeOptions} selected={jobTypes} onChange={setJobTypes} />
          <SelectField
            aria-label="Date range"
            className="h-8"
            value={datePreset}
            onValueChange={(v) => setDatePreset(v as DatePreset)}
            options={DATE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
          />
          {datePreset === 'custom' && (
            <>
              <DatePicker
                value={customFrom}
                max={customTo || undefined}
                onChange={setCustomFrom}
                inputClassName="h-8 text-xs"
              />
              <span className="text-xs text-text-secondary">to</span>
              <DatePicker
                value={customTo}
                min={customFrom || undefined}
                onChange={setCustomTo}
                inputClassName="h-8 text-xs"
              />
            </>
          )}
          {hasFilters && (
            // ghost/subtle, size="3xs" - idle text-text-secondary and hover
            // text-text-primary are an exact colour match (same recipe as
            // PaymentsReport.tsx's "Clear"); the rung adds an
            // hover:bg-background-light the raw icon+label control didn't have,
            // and shrinks the raw's unset (no padding, no height) footprint to
            // the 3xs rung's fixed h-6/px-2 - disclosed.
            <Button variant="ghost" tone="subtle" size="3xs" onClick={clearFilters} className="gap-1">
              <X className="h-3.5 w-3.5" /> Clear filters
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Heading level={2}>Invoices</Heading>
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span>Rows</span>
            <SelectField
              aria-label="Rows per page"
              className="h-8"
              value={String(pageSize)}
              onValueChange={(v) => setPageSize(Number(v))}
              options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        </div>

        {/* Shared resizable grid — drag column edges to resize, click headers to sort. */}
        <ResizableTable
          rows={pageRows}
          getRowKey={(r) => r.number}
          empty={<EmptyState title="No invoices match these filters." />}
          columns={[
            {
              id: 'number',
              header: 'Invoice #',
              width: 110,
              min: 90,
              sortValue: (r) => r.number,
              cell: (r) => <span className="font-medium text-primary">{r.number}</span>,
            },
            {
              id: 'client',
              header: 'Client',
              width: 200,
              min: 160,
              sortValue: (r) => r.client,
              cell: (r) => (
                <div className="min-w-0">
                  <div className="truncate font-medium text-text-primary">{r.client}</div>
                  <div className="truncate text-xs text-text-secondary">{r.email}</div>
                </div>
              ),
            },
            {
              id: 'created',
              header: 'Created',
              width: 140,
              min: 125,
              sortValue: (r) => r.created,
              cell: (r) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(r.created)}</span>,
            },
            {
              id: 'subtotal',
              header: 'Subtotal',
              width: 110,
              min: 95,
              align: 'right',
              sortValue: (r) => r.subtotal,
              cell: (r) => <span className="tabular-nums text-text-secondary">{money(r.subtotal)}</span>,
              footer: <span className="tabular-nums">{money(totals.subtotal)}</span>,
            },
            {
              id: 'tax',
              header: 'Tax',
              width: 110,
              min: 95,
              align: 'right',
              sortValue: (r) => r.tax,
              cell: (r) => <span className="tabular-nums text-text-secondary">{money(r.tax)}</span>,
              footer: <span className="tabular-nums">{money(totals.tax)}</span>,
            },
            {
              id: 'discount',
              header: 'Discount',
              width: 100,
              min: 90,
              align: 'right',
              sortValue: (r) => r.discountPct,
              cell: (r) => <span className="tabular-nums text-text-secondary">{r.discountPct.toFixed(2)}%</span>,
            },
            {
              id: 'amount',
              header: 'Amount',
              width: 120,
              min: 100,
              align: 'right',
              sortValue: (r) => r.amount,
              cell: (r) => <span className="tabular-nums font-medium">{money(r.amount)}</span>,
              footer: <span className="tabular-nums">{money(totals.amount)}</span>,
            },
            {
              id: 'due',
              header: 'Due',
              width: 120,
              min: 100,
              align: 'right',
              sortValue: (r) => r.due,
              cell: (r) => <span className="tabular-nums">{money(r.due)}</span>,
              footer: <span className="tabular-nums">{money(totals.due)}</span>,
            },
            {
              id: 'status',
              header: 'Status',
              width: 120,
              min: 105,
              sortValue: (r) => r.status,
              cell: (r) => (
                <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span>
              ),
            },
            {
              id: 'job',
              header: 'Job',
              width: 100,
              min: 85,
              sortValue: (r) => r.job,
              cell: (r) => <span className="text-primary">{r.job}</span>,
            },
            {
              id: 'salesperson',
              header: 'Salesperson',
              width: 150,
              min: 130,
              sortValue: (r) => r.salesperson,
              cell: (r) => <span className="text-text-primary">{r.salesperson}</span>,
            },
            {
              id: 'technician',
              header: 'Technician',
              width: 150,
              min: 130,
              sortValue: (r) => r.technician,
              cell: (r) => <span className="text-text-primary">{r.technician}</span>,
            },
          ]}
        />

        {/* Pagination */}
        <ReportPager
          variant="compact"
          page={clampedPage}
          pageCount={pageCount}
          pageSize={pageSize}
          totalItems={filtered.length}
          onPageChange={setPage}
          emptyLabel="No invoices"
        />
      </div>

      <p className="text-xs text-text-secondary">
        {isDemo && 'Sample data shown so the layout is reviewable without a backend. '}
        Filter by salesperson or technician (plus status/date/job type), then Export CSV to hand them
        their follow-up list. Technician maps to the job assignee; salesperson maps to the estimate's
        seller (lead commission owner).
      </p>
    </ReportShell>
  );
}

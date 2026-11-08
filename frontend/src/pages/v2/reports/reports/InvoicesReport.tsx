import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, DollarSign, FileText, X } from 'lucide-react';

import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import {
  JOB_TYPES, STATUSES, useInvoicesReport, type InvoiceStatus,
} from '@/lib/reports/invoices-data';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Input } from '@/ui-kit/components/ui/input';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { MultiSelectFilter, ReportPager, ReportToolbar } from '../components/shared';
import { DatePicker } from '../../_shared/datePicker';

/**
 * Invoices report - a filtered follow-up list you can hand to a rep or a tech.
 *
 * `useInvoicesReport(isDemo)` is imported and is the whole demo-vs-live fork,
 * including what "salesperson" and "technician" mean (the estimate's seller via
 * lead commission owner, and the first job assignee). Every filter, the
 * status-KPI switcher and the two-stage `filteredNoStatus` / `filtered`
 * derivation are carried over exactly - the first stage is what keeps the
 * status cards showing their real totals while acting as filters.
 *
 * The status pills used `STATUS_INTENT_CLASSES` from the app's status registry;
 * on the kit the same five intents become the Badge's five soft variants. The
 * taxonomy itself is unchanged and still local to this report (it is a
 * synthetic report-only vocabulary, not the backend InvoiceStatus enum).
 *
 * The `<tfoot>` totals row is a `ReportTableTotals` strip - see reportTable.tsx.
 */

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DAY = 86_400_000;

// Same five intents the status registry gave these pills, expressed as the
// kit's soft badge variants.
const STATUS_VARIANT: Record<InvoiceStatus, NonNullable<BadgeProps['variant']>> = {
  Paid: 'softGreen',
  Due: 'softAmber',
  Overdue: 'softRed',
  Unsent: 'softNeutral',
  Partial: 'softBlue',
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
  if (preset === 'month') return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filters or page size change
  useEffect(() => setPage(0), [search, reps, techs, statuses, jobTypes, datePreset, customFrom, customTo, pageSize]);

  // Everything EXCEPT the status filter - so the status KPI cards always show
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

  // Totals across the full filtered set.
  const totals = useMemo(
    () => filtered.reduce(
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

  type InvoiceRow = (typeof ALL)[number];

  const columns: ReportColumn<InvoiceRow>[] = [
    { id: 'number', header: 'Invoice #', width: 110, min: 90, sortValue: (r) => r.number, cell: (r) => <span className="text-brand font-medium">{r.number}</span> },
    {
      id: 'client', header: 'Client', width: 200, min: 160, sortValue: (r) => r.client,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.client}</div>
          <div className="text-muted-foreground truncate text-xs">{r.email}</div>
        </div>
      ),
    },
    { id: 'created', header: 'Created', width: 140, min: 125, sortValue: (r) => r.created, cell: (r) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(r.created)}</span> },
    { id: 'subtotal', header: 'Subtotal', width: 110, min: 95, align: 'right', sortValue: (r) => r.subtotal, cell: (r) => <span className="text-muted-foreground tabular-nums">{money(r.subtotal)}</span>, footer: <span className="tabular-nums">{money(totals.subtotal)}</span> },
    { id: 'tax', header: 'Tax', width: 110, min: 95, align: 'right', sortValue: (r) => r.tax, cell: (r) => <span className="text-muted-foreground tabular-nums">{money(r.tax)}</span>, footer: <span className="tabular-nums">{money(totals.tax)}</span> },
    { id: 'discount', header: 'Discount', width: 100, min: 90, align: 'right', sortValue: (r) => r.discountPct, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.discountPct.toFixed(2)}%</span> },
    { id: 'amount', header: 'Amount', width: 120, min: 100, align: 'right', sortValue: (r) => r.amount, cell: (r) => <span className="font-medium tabular-nums">{money(r.amount)}</span>, footer: <span className="tabular-nums">{money(totals.amount)}</span> },
    { id: 'due', header: 'Due', width: 120, min: 100, align: 'right', sortValue: (r) => r.due, cell: (r) => <span className="tabular-nums">{money(r.due)}</span>, footer: <span className="tabular-nums">{money(totals.due)}</span> },
    { id: 'status', header: 'Status', width: 120, min: 105, sortValue: (r) => r.status, cell: (r) => <Badge variant={STATUS_VARIANT[r.status]} size="pill">{r.status}</Badge> },
    { id: 'job', header: 'Job', width: 100, min: 85, sortValue: (r) => r.job, cell: (r) => <span className="text-brand">{r.job}</span> },
    { id: 'salesperson', header: 'Salesperson', width: 150, min: 130, sortValue: (r) => r.salesperson, cell: (r) => <span>{r.salesperson}</span> },
    { id: 'technician', header: 'Technician', width: 150, min: 130, sortValue: (r) => r.technician, cell: (r) => <span>{r.technician}</span> },
  ];

  return (
    <ReportShell report={report} actions={<ReportToolbar variant="compact" onExport={exportCsv} />}>
      {/* Click a card to filter the table by that status. */}
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Due', value: money(k.due), tone: 'primary', active: statuses.includes('Due'), onClick: () => toggleStatus('Due') },
          { icon: AlertTriangle, label: 'Overdue', value: money(k.overdue), tone: 'danger', emphasize: true, active: statuses.includes('Overdue'), onClick: () => toggleStatus('Overdue') },
          { icon: FileText, label: 'Unsent', value: k.unsentN, tone: 'warning', emphasize: k.unsentN > 0, active: statuses.includes('Unsent'), onClick: () => toggleStatus('Unsent') },
          { icon: CheckCircle2, label: 'Collected', value: money(k.collected), tone: 'success', emphasize: true, active: statuses.includes('Paid'), onClick: () => toggleStatus('Paid') },
        ]}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search invoices"
            placeholder="Search client, email, invoice # or job #"
            className="h-9 w-72"
          />
          <MultiSelectFilter label="Salesperson" options={repOptions} selected={reps} onChange={setReps} />
          <MultiSelectFilter label="Technician" options={techOptions} selected={techs} onChange={setTechs} />
          <MultiSelectFilter label="Status" options={[...STATUSES]} selected={statuses} onChange={setStatuses} />
          <MultiSelectFilter label="Job type" options={jobTypeOptions} selected={jobTypes} onChange={setJobTypes} />
          <SelectField
            value={datePreset}
            onValueChange={(v) => setDatePreset(v as DatePreset)}
            aria-label="Date range"
            size="sm"
            className="w-[150px]"
            options={DATE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
          />
          {datePreset === 'custom' && (
            <>
              <DatePicker
                aria-label="From" value={customFrom} max={customTo || undefined}
                onChange={setCustomFrom} className="w-[10.5rem]" inputClassName="h-9"
              />
              <span className="text-muted-foreground text-xs">to</span>
              <DatePicker
                aria-label="To" value={customTo} min={customFrom || undefined}
                onChange={setCustomTo} className="w-[10.5rem]" inputClassName="h-9"
              />
            </>
          )}
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X />
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <ReportHeading level={2} scale="lg">Invoices</ReportHeading>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span>Rows</span>
            <SelectField
              value={String(pageSize)}
              onValueChange={(v) => setPageSize(Number(v))}
              aria-label="Rows per page"
              size="sm"
              className="w-[80px]"
              options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        </div>

        <ReportTable
          rows={pageRows}
          getRowKey={(r) => r.number}
          empty={<EmptyState title="No invoices match these filters." />}
          columns={columns}
          initialPageSize={pageSize}
        />
        <ReportTableTotals columns={columns} className="mt-2" />

        <ReportPager
          variant="compact"
          page={clampedPage}
          pageCount={pageCount}
          pageSize={pageSize}
          totalItems={filtered.length}
          onPageChange={setPage}
          emptyLabel="No invoices"
        />
      </Card>

      <p className="text-muted-foreground text-xs">
        {isDemo && 'Sample data shown so the layout is reviewable without a backend. '}
        Filter by salesperson or technician (plus status/date/job type), then Export CSV to hand them
        their follow-up list. Technician maps to the job assignee; salesperson maps to the estimate&apos;s
        seller (lead commission owner).
      </p>
    </ReportShell>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { formatPhone } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import { useJobsReport } from '@/lib/reports/jobs-data';
import type { Job, Status } from '@/lib/reports/jobs-fixtures';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard } from '@/ui-kit/components/data/statCard';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Card } from '@/ui-kit/components/ui/card';
import { Progress } from '@/ui-kit/components/ui/progress';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportPager, ReportToolbar } from '../components/shared';
import { FieldsPicker, FilterChecklistPanel } from '../components/fieldsPicker';
import { ReportTable } from '../components/reportTable';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * Jobs report - the Workiz-style operations report for the Jobs entity.
 *
 * THE DATA LIVES IN THE LEGACY MODULE AND IS IMPORTED, not copied.
 * `jobs-data.ts` imports `buildMockJobs` from `pages/reports/JobsReport` and
 * serves it to demo orgs while swapping in the live DB-backed rows for real
 * ones - same `Job[]` shape either way. A second copy of that 64-row fixture
 * here would drift from the one the live rows are shaped to match, so this file
 * imports `useJobsReport` and the `Job`/`Status` types and re-declares only the
 * columns and the filter vocabularies, which are presentation.
 *
 * TWO SCOPES, AND THE DIFFERENCE IS LOAD-BEARING. `filtered` is the panel +
 * date + search result and it feeds the KPI numbers, so every count stays
 * visible. `scoped` adds the active KPI card's own predicate and feeds the
 * table and the two breakdowns. Reversing that would make a pressed card zero
 * out the very number it is showing.
 *
 * The per-user visible-field list keeps its own localStorage key
 * (`jobsReport.visibleFields.v1`), so a saved column set survives the cutover.
 *
 * Shape differences: the filter checklist and Fields dialog come from the
 * shared `components/fieldsPicker`, the KPI row is kit `StatCard`s, the status
 * and tag pills are kit `Badge`s carrying the same intents, and the breakdown
 * bars are the kit's `Progress` (they were a single brand-filled bar, so no
 * tone is lost).
 */

const STATUSES = [
  'Submitted',
  'In progress',
  'In progress - Scheduled',
  'On the way',
  'On site',
  'Pending',
  'Done',
  'done pending',
  'Canceled',
] as const;

const TYPES = [
  'Alarm System', 'Burglar Alarm', 'Access Control', 'Buzzer System', 'Business Lockout',
  'Bullet Proof', 'AV + Network', 'Gate', 'Garage', 'CALL BACK', 'Troubleshoot',
  'Commercial', 'Residential',
];

const SOURCES = [
  'Office', 'Google', 'Account', 'Returning customer', 'Village', 'Village - Ret',
  'Return Customer', 'Reserve with',
];

const ORIGINS = ['Lead', 'New'];

const TECHS = [
  'Emanuel Dahan', 'Ohad', 'Rami', 'Priya', 'Shaked', 'Liran-Dor', 'Ofir Sub',
  'Adam Elkar', 'Robert Bresnick',
];

const CREATORS = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Priya', 'Robert Bresnick'];

const TAGS = [
  'Followup', 'Callback', 'NEED TO COLLECT', 'NOT ANSWERING', 'NEED TO ORDER',
  'Waiting for pickup', 'Need more info', 'TODAY JOB',
];

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtDate = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDateShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Synthetic report-only taxonomy (Workiz labels) - not the backend JobStatus
// enum, so this stays a local map. It carried the status registry's intents; on
// the kit those are the soft Badge variants, and 'done pending' keeps its own
// so it stays distinguishable from plain 'Done'.
const STATUS_VARIANT: Record<Status, NonNullable<BadgeProps['variant']>> = {
  Submitted: 'softBlue',
  'In progress': 'softAmber',
  'In progress - Scheduled': 'softAmber',
  'On the way': 'softAmber',
  'On site': 'softAmber',
  Pending: 'softNeutral',
  Done: 'softGreen',
  'done pending': 'softPurple',
  Canceled: 'softRed',
};

// Tag urgency, same buckets as before, as solid badge variants.
const TAG_VARIANT = (tag: string): NonNullable<BadgeProps['variant']> => {
  const t = tag.toLowerCase();
  if (t.includes('today')) return 'blue';
  if (t.includes('collect') || t.includes('answer') || t.includes('order') || t.includes('callback')) return 'red';
  if (t.includes('waiting')) return 'amber';
  if (t.includes('more info')) return 'green';
  return 'amber';
};

interface ColumnSpec {
  key: string;
  label: string;
  render: (j: Job) => ReactNode;
  csv: (j: Job) => string;
  alwaysOn?: boolean;
  /** Sort key for the table; falls back to `csv` when omitted. */
  sort?: (j: Job) => string | number | null;
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnSpec[] = [
  { key: 'jobNumber', label: 'Job #', alwaysOn: true, width: 100, min: 85, render: (j) => <span className="font-medium tabular-nums">{j.jobNumber}</span>, csv: (j) => String(j.jobNumber), sort: (j) => j.jobNumber },
  { key: 'jobName', label: 'Job name', width: 150, min: 130, render: (j) => j.jobName || <span className="text-muted-foreground">-</span>, csv: (j) => j.jobName, sort: (j) => j.jobName },
  {
    key: 'client', label: 'Client', width: 180, min: 150, sort: (j) => j.client,
    render: (j) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{j.client}</div>
        <div className="text-muted-foreground truncate text-xs">{j.email}</div>
      </div>
    ),
    csv: (j) => j.client,
  },
  {
    key: 'tags', label: 'Tags', width: 160, min: 130,
    render: (j) => (
      <div className="flex flex-wrap gap-1">
        {j.tags.map((t) => (
          <Badge key={t} variant={TAG_VARIANT(t)} size="sm" className="max-w-[120px] truncate">{t}</Badge>
        ))}
      </div>
    ),
    csv: (j) => j.tags.join('; '),
  },
  { key: 'type', label: 'Type', width: 150, min: 120, render: (j) => <span>{j.type}</span>, csv: (j) => j.type, sort: (j) => j.type },
  { key: 'createdAt', label: 'Job Created', width: 180, min: 175, render: (j) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(j.createdAt)}</span>, csv: (j) => fmtDate(j.createdAt), sort: (j) => j.createdAt.getTime() },
  { key: 'phone', label: 'Phone', width: 150, min: 140, render: (j) => <span className="text-status-blue-emphasis whitespace-nowrap">{formatPhone(j.phone)}</span>, csv: (j) => formatPhone(j.phone), sort: (j) => j.phone },
  { key: 'email', label: 'Email', width: 200, min: 160, render: (j) => <span className="text-muted-foreground truncate">{j.email}</span>, csv: (j) => j.email, sort: (j) => j.email },
  {
    key: 'status', label: 'Status', width: 150, min: 130,
    render: (j) => <Badge variant={STATUS_VARIANT[j.status]} size="pill">{j.status}</Badge>,
    csv: (j) => j.status,
    sort: (j) => j.status,
  },
  { key: 'tech', label: 'Tech', width: 160, min: 130, render: (j) => <span>{j.tech.join(', ')}</span>, csv: (j) => j.tech.join('; '), sort: (j) => j.tech.join(', ') },
  { key: 'createdBy', label: 'Created by', width: 150, min: 130, render: (j) => <span className="text-muted-foreground">{j.createdBy}</span>, csv: (j) => j.createdBy, sort: (j) => j.createdBy },
  { key: 'address', label: 'Address', width: 210, min: 170, render: (j) => <span className="text-muted-foreground truncate">{j.address}</span>, csv: (j) => j.address, sort: (j) => j.address },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (j) => <span>{j.source}</span>, csv: (j) => j.source, sort: (j) => j.source },
  { key: 'origin', label: 'Origin', width: 110, min: 95, render: (j) => <span className="text-muted-foreground">{j.origin}</span>, csv: (j) => j.origin, sort: (j) => j.origin },
  { key: 'scheduledAt', label: 'Scheduled', width: 140, min: 130, render: (j) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateShort(j.scheduledAt)}</span>, csv: (j) => fmtDateShort(j.scheduledAt), sort: (j) => j.scheduledAt.getTime() },
  { key: 'endAt', label: 'End', width: 140, min: 130, render: (j) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateShort(j.endAt)}</span>, csv: (j) => fmtDateShort(j.endAt), sort: (j) => j.endAt.getTime() },
  { key: 'billed', label: 'Billed', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums">{money0(j.billed)}</span>, csv: (j) => String(j.billed), sort: (j) => j.billed },
  { key: 'paid', label: 'Collected', width: 110, min: 100, align: 'right', render: (j) => <span className="text-status-green-emphasis tabular-nums">{money0(j.paid)}</span>, csv: (j) => String(j.paid), sort: (j) => j.paid },
  { key: 'subtotal', label: 'Subtotal', width: 110, min: 100, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.subtotal)}</span>, csv: (j) => String(j.subtotal), sort: (j) => j.subtotal },
  { key: 'itemCost', label: 'Item cost', width: 110, min: 100, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.itemCost)}</span>, csv: (j) => String(j.itemCost), sort: (j) => j.itemCost },
  { key: 'laborCost', label: 'Labor cost', width: 110, min: 100, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.laborCost)}</span>, csv: (j) => String(j.laborCost), sort: (j) => j.laborCost },
  { key: 'cardExpenses', label: 'Card Expenses', width: 130, min: 115, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.cardExpenses)}</span>, csv: (j) => String(j.cardExpenses), sort: (j) => j.cardExpenses },
  { key: 'techExpenses', label: 'Tech expenses', width: 130, min: 115, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.techExpenses)}</span>, csv: (j) => String(j.techExpenses), sort: (j) => j.techExpenses },
  { key: 'tax', label: 'Tax', width: 100, min: 90, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.tax)}</span>, csv: (j) => String(j.tax), sort: (j) => j.tax },
  { key: 'profit', label: 'Profit', width: 110, min: 100, align: 'right', render: (j) => <span className="text-status-green-emphasis tabular-nums">{money0(j.profit)}</span>, csv: (j) => String(j.profit), sort: (j) => j.profit },
  { key: 'tip', label: 'Tip', width: 100, min: 90, align: 'right', render: (j) => <span className="text-muted-foreground tabular-nums">{j.tip ? money0(j.tip) : '-'}</span>, csv: (j) => String(j.tip), sort: (j) => j.tip },
];

const DEFAULT_VISIBLE = ['jobNumber', 'jobName', 'client', 'tags', 'type', 'createdAt', 'phone', 'email', 'status', 'tech', 'createdBy', 'address'];
const FIELDS_KEY = 'jobsReport.visibleFields.v1';

type DateField = 'createdAt' | 'scheduledAt' | 'endAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { createdAt: 'Job created', scheduledAt: 'Scheduled', endAt: 'Job end date' };

type Preset = 'week' | '7d' | 'month' | 'lastMonth' | 'year' | 'all' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  week: 'This week (Mon-Today)',
  '7d': 'Last 7 days',
  month: 'This month',
  lastMonth: 'Last month',
  year: 'This year',
  all: 'All time',
  custom: 'Custom',
};

function presetRange(p: Preset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  if (p === 'custom') {
    const from = customFrom ? new Date(customFrom + 'T00:00:00') : null;
    const to = customTo ? new Date(customTo + 'T23:59:59.999') : null;
    return { from, to };
  }
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (p) {
    case 'week': {
      const day = (now.getDay() + 6) % 7; // Mon = 0
      start.setDate(now.getDate() - day);
      return { from: start, to: end };
    }
    case '7d':
      start.setDate(now.getDate() - 6);
      return { from: start, to: end };
    case 'month':
      start.setDate(1);
      return { from: start, to: end };
    case 'lastMonth': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from: s, to: e };
    }
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1), to: end };
    case 'all':
    default:
      return { from: null, to: null };
  }
}

type FilterKey = 'status' | 'tech' | 'createdBy' | 'tags' | 'type' | 'origin' | 'source';
type Filters = Record<FilterKey, string[]>;
const EMPTY_FILTERS: Filters = { status: [], tech: [], createdBy: [], tags: [], type: [], origin: [], source: [] };

const FILTER_COLUMNS: { key: FilterKey; label: string; options: readonly string[] }[] = [
  { key: 'status', label: 'Status', options: STATUSES },
  { key: 'tech', label: 'Team', options: TECHS },
  { key: 'createdBy', label: 'Created by', options: CREATORS },
  { key: 'tags', label: 'Tags', options: TAGS },
  { key: 'type', label: 'Job type', options: TYPES },
  { key: 'origin', label: 'Job origin', options: ORIGINS },
  { key: 'source', label: 'Source', options: SOURCES },
];

function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number; revenue: number }[] }) {
  const top = rows.sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <Card>
      <ReportHeading level={2} scale="lg" className="mb-3">{title}</ReportHeading>
      {top.length === 0 ? (
        <p className="text-muted-foreground text-xs">No jobs in range.</p>
      ) : (
        <div className="space-y-2.5">
          {top.map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="truncate">{r.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {r.count} · {money0(r.revenue)}
                </span>
              </div>
              <Progress value={(r.count / max) * 100} className="h-2" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Which KPI card is driving the list filter (null = Total Jobs / show all). */
type CardFilter = 'done' | 'inProgress' | 'open' | 'billed' | 'collected';

export default function JobsReport() {
  const report = findReport('jobs')!;
  // Demo orgs keep the deterministic mock (sales vision); real orgs get the
  // live, DB-backed rows. Same `Job[]` shape either way -> aliased to JOBS so
  // the filters / breakdowns / columns / export below are unchanged.
  const isDemo = useIsDemoOrg();
  const { jobs: JOBS } = useJobsReport(isDemo);
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const [dateField, setDateField] = useState<DateField>('createdAt');
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [cardFilter, setCardFilter] = useState<CardFilter | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [visible, setVisible] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(FIELDS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {
      /* ignore */
    }
    return DEFAULT_VISIBLE;
  });

  const now = new Date();
  const defaultFrom = new Date(now); defaultFrom.setDate(now.getDate() - 30);
  const [customFrom, setCustomFrom] = useState(defaultFrom.toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(now.toISOString().slice(0, 10));

  const range = useMemo(() => presetRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return JOBS.filter((j) => {
      if (filters.status.length && !filters.status.includes(j.status)) return false;
      if (filters.tech.length && !j.tech.some((t) => filters.tech.includes(t))) return false;
      if (filters.createdBy.length && !filters.createdBy.includes(j.createdBy)) return false;
      if (filters.tags.length && !j.tags.some((t) => filters.tags.includes(t))) return false;
      if (filters.type.length && !filters.type.includes(j.type)) return false;
      if (filters.origin.length && !filters.origin.includes(j.origin)) return false;
      if (filters.source.length && !filters.source.includes(j.source)) return false;
      if (range.from && j[dateField] < range.from) return false;
      if (range.to && j[dateField] > range.to) return false;
      if (q) {
        const hay = `${j.jobNumber} ${j.jobName} ${j.client} ${j.email} ${j.phone} ${j.type} ${j.address}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [JOBS, filters, search, range, dateField]);

  // The active KPI card scopes the list + breakdowns (the KPI numbers stay full
  // so every count is still visible while one card drives the table below).
  const scoped = useMemo(() => {
    if (!cardFilter) return filtered;
    return filtered.filter((j) => {
      switch (cardFilter) {
        case 'done':
          return j.status === 'Done';
        case 'inProgress':
          return j.status === 'In progress' || j.status === 'In progress - Scheduled'
            || j.status === 'On the way' || j.status === 'On site';
        case 'open':
          return j.status === 'Submitted' || j.status === 'Pending' || j.status === 'done pending';
        case 'billed':
          return j.billed > 0;
        case 'collected':
          return j.paid > 0;
        default:
          return true;
      }
    });
  }, [filtered, cardFilter]);

  // reset to first page whenever the result set changes
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filters or page size change
  useEffect(() => setPage(0), [filters, search, preset, dateField, pageSize, cardFilter]);

  const stats = useMemo(() => {
    const byStatus = (s: Status) => filtered.filter((j) => j.status === s).length;
    return {
      total: filtered.length,
      done: byStatus('Done'),
      inProgress: byStatus('In progress') + byStatus('In progress - Scheduled') + byStatus('On the way') + byStatus('On site'),
      open: byStatus('Submitted') + byStatus('Pending') + byStatus('done pending'),
      canceled: byStatus('Canceled'),
      billed: filtered.reduce((s, j) => s + j.billed, 0),
      paid: filtered.reduce((s, j) => s + j.paid, 0),
    };
  }, [filtered]);

  // Breakdowns reflect the active KPI-card scope.
  const breakdown = useMemo(() => {
    const group = (keyFn: (j: Job) => string) => {
      const m = new Map<string, { count: number; revenue: number }>();
      for (const j of scoped) {
        const k = keyFn(j);
        const cur = m.get(k) ?? { count: 0, revenue: 0 };
        cur.count += 1;
        cur.revenue += j.billed;
        m.set(k, cur);
      }
      return Array.from(m, ([label, v]) => ({ label, ...v }));
    };
    return { byType: group((j) => j.type), bySource: group((j) => j.source) };
  }, [scoped]);

  const cols = COLUMNS.filter((c) => c.alwaysOn || visible.includes(c.key));
  const pageRows = scoped.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(scoped.length / pageSize));

  function exportCsv() {
    exportCsvFile('jobs-report.csv', cols.map((c) => c.label), scoped.map((j) => cols.map((c) => c.csv(j))));
  }

  function saveFields(keys: string[]) {
    setVisible(keys);
    try {
      localStorage.setItem(FIELDS_KEY, JSON.stringify(keys));
    } catch {
      /* ignore */
    }
    setFieldsOpen(false);
  }

  const kpis = [
    { key: 'total', label: 'Total Jobs', value: stats.total, active: false, onClick: () => setCardFilter(null) },
    { key: 'done', label: 'Done', value: stats.done, active: cardFilter === 'done', onClick: () => setCardFilter((c) => (c === 'done' ? null : 'done')) },
    { key: 'inProgress', label: 'In Progress', value: stats.inProgress, active: cardFilter === 'inProgress', onClick: () => setCardFilter((c) => (c === 'inProgress' ? null : 'inProgress')) },
    { key: 'open', label: 'Open', value: stats.open, active: cardFilter === 'open', onClick: () => setCardFilter((c) => (c === 'open' ? null : 'open')) },
    { key: 'billed', label: 'Billed', value: money0(stats.billed), active: cardFilter === 'billed', onClick: () => setCardFilter((c) => (c === 'billed' ? null : 'billed')) },
    { key: 'collected', label: 'Collected', value: money0(stats.paid), active: cardFilter === 'collected', onClick: () => setCardFilter((c) => (c === 'collected' ? null : 'collected')) },
  ];
  // The legacy tiles carried Briefcase / CheckCircle2 / Loader2 / Clock /
  // DollarSign / Wallet icons. StatCard has no icon slot by design - see
  // components/kpi.tsx - so they are dropped rather than faked.

  return (
    <ReportShell report={report}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="lg:flex-1">
          <FilterChecklistPanel columns={FILTER_COLUMNS} filters={filters} onChange={setFilters} empty={EMPTY_FILTERS} />
        </div>
        <DateRangeControl
          presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
          preset={preset}
          onPreset={(k) => setPreset(k as Preset)}
          from={range.from}
          to={range.to}
          fields={(Object.keys(DATE_FIELD_LABEL) as DateField[]).map((k) => ({ key: k, label: DATE_FIELD_LABEL[k] }))}
          field={dateField}
          onField={(k) => setDateField(k as DateField)}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
      </div>

      {/* Stats strip - one row, recalculates with filters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((it) => (
          <StatCard
            key={it.key}
            label={it.label}
            value={it.value}
            active={it.active}
            onClick={it.onClick}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="Jobs by type" rows={breakdown.byType} />
        <Breakdown title="Jobs by source" rows={breakdown.bySource} />
      </div>

      <ReportToolbar
        search={search}
        onSearchChange={setSearch}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
        onExport={exportCsv}
        onFields={() => setFieldsOpen(true)}
      />

      <ReportTable
        rows={pageRows}
        getRowKey={(j) => String(j.jobNumber)}
        empty={<EmptyState title="No jobs match these filters." />}
        initialPageSize={pageSize}
        columns={cols.map((c) => ({
          id: c.key,
          header: c.label,
          cell: c.render,
          sortValue: c.sort ?? c.csv,
          width: c.width,
          min: c.min,
          grow: c.grow,
          align: c.align,
        }))}
      />

      {/* `totalItems` is `filtered`, not `scoped`, exactly as before - see the
          ledger's "Observed but not fixed" row; changing it here would be a
          behaviour fix smuggled into a restyle. */}
      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
      />

      <p className="text-muted-foreground text-xs">
        {isDemo
          ? 'Sample data shown so the layout is reviewable without a backend.'
          : 'Live data from GET /api/reports/jobs - money is summed across each job’s linked invoices.'}
      </p>

      {fieldsOpen && <FieldsPicker columns={COLUMNS} visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

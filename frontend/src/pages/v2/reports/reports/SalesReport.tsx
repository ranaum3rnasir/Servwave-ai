import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, DollarSign, PiggyBank, Wallet } from 'lucide-react';

import { ChartCard, WaveAreaChart } from '@/components/charts';
import { token } from '@/design-system';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { hashStr, mulberry32 } from '@/lib/reports/random';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportKpis } from '../components/kpi';
import { ReportPager, ReportToolbar } from '../components/shared';
import { FieldsPicker, FilterChecklistPanel } from '../components/fieldsPicker';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * Sales report - the Workiz-style sales/revenue report.
 *
 * Deterministic MOCK data, seeded from the shared `hashStr`/`mulberry32` PRNG
 * so the eighty rows are identical on every render. Carried over unchanged
 * (including `total = subtotal`, i.e. tax-exclusive, consistent with invoices,
 * POs and the other reports) - wire to `GET /api/sales` later by replacing
 * `ROWS`; the view stays.
 *
 * THE CHART IS UNTOUCHED: Sales is amber and Profit is green, on the shared
 * `WaveAreaChart`. Those are the money signals, not decoration.
 *
 * The "Total:" summary row is a `ReportTableTotals` strip - the kit's DataTable
 * has no `<tfoot>`. Only the MONEY_KEYS columns total, exactly as before, so a
 * visible non-money column contributes no bogus sum.
 *
 * The filter checklist and the Fields dialog come from the shared
 * `components/fieldsPicker`; Jobs, Leads and Sales each had their own identical
 * copy of both.
 */

const STATUSES = ['Submitted', 'In progress', 'Pending', 'Done', 'done pending', 'Canceled'] as const;
type Status = (typeof STATUSES)[number];

const JOB_TYPES = [
  'AV + NETWORK + CCTV', 'Access Control System', 'Access control', 'Alarm System', 'Bullet Proof',
  'Burglar Alarm', 'Business Lockout', 'Buzzer System', 'CALL BACK', 'Gate', 'Garage', 'Troubleshoot',
  'Commercial', 'Residential',
];
const SOURCES = ['Office', 'Google', 'Account', 'Returning customer', 'Village', 'Google Local Service', 'Reserve with Google', 'Return Customer'];
const TEAM = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Priya', 'Shaked', 'Liran - Dor', 'Ofir Sub'];
const CREATORS = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Priya', 'Robert Bresnick'];
const TAGS = ['Followup', 'Callback', 'NEED TO COLLECT', 'NOT ANSWERING', 'Waiting for pictures', 'Need more info', 'Today job'];

const CLIENTS: [string, string][] = [
  ['Bilton', 'tomer.gat@bilton.tech'],
  ['Aiden Evans', 'ajevans@hud.gov'],
  ['Patrick Patel', 'prateshp@gmail.com'],
  ['Congregation', 'mjzwig@msn.com'],
  ['Arnesa Cengic', 'acekic@centric.com'],
  ['Dee Carter', 'dcarter@gmail.com'],
  ['Bao Nguyen', 'bnguyen@yahoo.com'],
  ['Ian Webb', 'iwebb@webbco.com'],
  ['Victor Hayes', 'vhayes@gmail.com'],
  ['Ana Flores', 'aflores@hotmail.com'],
  ['Greg Shaw', 'gshaw@gmail.com'],
  ['Lia Vega', 'lvega@vega.com'],
  ['Cole Bauer', 'cbauer@bauer.net'],
  ['Mara Diaz', 'mdiaz@gmail.com'],
  ['Neil Pope', 'npope@pope.org'],
  ['Sara Klein', 'sklein@klein.com'],
];

interface Row {
  jobId: number;
  client: string;
  email: string;
  status: Status;
  jobType: string;
  source: string;
  team: string;
  createdBy: string;
  tags: string[];
  invoice: number;
  subtotal: number;
  total: number;
  paid: number;
  due: number;
  itemCost: number;
  laborCost: number;
  cardExpenses: number;
  techExpenses: number;
  tip: number;
  profit: number;
  jobDate: Date;
  createdAt: Date;
  paidAt: Date | null;
}

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

function buildRows(): Row[] {
  const rng = mulberry32(hashStr('alpha-sales-report'));
  const now = new Date();
  const rows: Row[] = [];
  const N = 80;
  for (let i = 0; i < N; i++) {
    const [client, email] = pick(rng, CLIENTS);
    const status = pick(rng, STATUSES);
    const jobDate = new Date(now);
    jobDate.setDate(now.getDate() - Math.floor(rng() * 45));
    jobDate.setHours(8 + Math.floor(rng() * 9), Math.floor(rng() * 60), 0, 0);
    const createdAt = new Date(jobDate);
    createdAt.setDate(jobDate.getDate() - Math.floor(rng() * 3));

    const subtotal = Math.round((300 + rng() * 4500) / 5) * 5;
    const total = subtotal; // tax-exclusive, consistent with invoices/POs/reports
    const done = status === 'Done';
    const paid = done ? total : status === 'done pending' ? Math.round(total * 0.5 * 100) / 100 : status === 'Canceled' ? 0 : Math.round(total * rng() * 0.4 * 100) / 100;
    const due = Math.round((total - paid) * 100) / 100;
    const paidAt = paid > 0 ? new Date(jobDate.getTime() + Math.floor(rng() * 5) * 86400000) : null;

    // Cost / expense / profit breakdown (statistics).
    const itemCost = Math.round(subtotal * (0.15 + rng() * 0.15) * 100) / 100;
    const laborCost = Math.round(subtotal * (0.1 + rng() * 0.15) * 100) / 100;
    const techExpenses = Math.round(subtotal * (rng() * 0.05) * 100) / 100;
    const cardExpenses = Math.round(paid * 0.029 * 100) / 100;
    const tip = rng() < 0.15 ? Math.round(rng() * 50) : 0;
    const profit = Math.max(0, Math.round((subtotal - itemCost - laborCost - techExpenses - cardExpenses) * 100) / 100);

    const tagCount = rng() < 0.4 ? 1 : 0;
    const tags = tagCount ? [pick(rng, TAGS)] : [];

    rows.push({
      jobId: 698499 - i,
      client,
      email,
      status,
      jobType: pick(rng, JOB_TYPES),
      source: pick(rng, SOURCES),
      team: pick(rng, TEAM),
      createdBy: pick(rng, CREATORS),
      tags,
      invoice: 596719 - i,
      subtotal,
      total,
      paid,
      due,
      itemCost,
      laborCost,
      cardExpenses,
      techExpenses,
      tip,
      profit,
      jobDate,
      createdAt,
      paidAt,
    });
  }
  return rows;
}

const ROWS = buildRows();

const money = (n: number) => formatCurrency(n);
const money0 = (n: number) => formatCurrencyWhole(n);
const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });

const STATUS_VARIANT: Record<Status, NonNullable<BadgeProps['variant']>> = {
  Submitted: 'softBlue',
  'In progress': 'softAmber',
  Pending: 'softNeutral',
  Done: 'softGreen',
  'done pending': 'softPurple',
  Canceled: 'softRed',
};

const MONEY_KEYS = ['total', 'subtotal', 'itemCost', 'laborCost', 'cardExpenses', 'techExpenses', 'profit', 'tip', 'paid', 'due'] as const;

interface ColumnSpec {
  key: string;
  label: string;
  render: (r: Row) => ReactNode;
  csv: (r: Row) => string;
  alwaysOn?: boolean;
  /** Sort key for the table; falls back to `csv` when omitted. */
  sort?: (r: Row) => string | number | null;
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnSpec[] = [
  { key: 'jobId', label: 'Job ID', alwaysOn: true, width: 100, min: 90, render: (r) => <span className="font-medium tabular-nums">{r.jobId}</span>, csv: (r) => String(r.jobId), sort: (r) => r.jobId },
  {
    key: 'client', label: 'Client', width: 190, min: 160, sort: (r) => r.client,
    render: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{r.client}</div>
        <div className="text-muted-foreground truncate text-xs">{r.email}</div>
      </div>
    ),
    csv: (r) => r.client,
  },
  {
    key: 'status', label: 'Status', width: 120, min: 110,
    render: (r) => <Badge variant={STATUS_VARIANT[r.status]} size="pill">{r.status}</Badge>,
    csv: (r) => r.status,
    sort: (r) => r.status,
  },
  { key: 'jobType', label: 'Job type', width: 160, min: 130, render: (r) => <span className="block truncate">{r.jobType}</span>, csv: (r) => r.jobType, sort: (r) => r.jobType },
  { key: 'total', label: 'Total', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums">{money(r.total)}</span>, csv: (r) => String(r.total), sort: (r) => r.total },
  { key: 'subtotal', label: 'Subtotal', width: 120, min: 100, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{money(r.subtotal)}</span>, csv: (r) => String(r.subtotal), sort: (r) => r.subtotal },
  { key: 'paid', label: 'Paid amount', width: 130, min: 110, align: 'right', render: (r) => <span className="text-status-green-emphasis tabular-nums">{money(r.paid)}</span>, csv: (r) => String(r.paid), sort: (r) => r.paid },
  { key: 'due', label: 'Due', width: 120, min: 100, align: 'right', render: (r) => <span className={cn('tabular-nums', r.due > 0 ? 'text-status-red-emphasis' : 'text-muted-foreground')}>{money(r.due)}</span>, csv: (r) => String(r.due), sort: (r) => r.due },
  { key: 'invoice', label: 'Invoice', width: 110, min: 95, align: 'right', render: (r) => <span className="text-status-blue-emphasis tabular-nums">{r.invoice}</span>, csv: (r) => String(r.invoice), sort: (r) => r.invoice },
  { key: 'itemCost', label: 'Item cost', width: 120, min: 100, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{money(r.itemCost)}</span>, csv: (r) => String(r.itemCost), sort: (r) => r.itemCost },
  { key: 'laborCost', label: 'Labor cost', width: 120, min: 100, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{money(r.laborCost)}</span>, csv: (r) => String(r.laborCost), sort: (r) => r.laborCost },
  { key: 'cardExpenses', label: 'Card Expenses', width: 130, min: 115, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{money(r.cardExpenses)}</span>, csv: (r) => String(r.cardExpenses), sort: (r) => r.cardExpenses },
  { key: 'techExpenses', label: 'Tech expenses', width: 130, min: 115, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{money(r.techExpenses)}</span>, csv: (r) => String(r.techExpenses), sort: (r) => r.techExpenses },
  { key: 'profit', label: 'Profit', width: 120, min: 100, align: 'right', render: (r) => <span className="text-status-green-emphasis tabular-nums">{money(r.profit)}</span>, csv: (r) => String(r.profit), sort: (r) => r.profit },
  { key: 'tip', label: 'Tip', width: 100, min: 85, align: 'right', render: (r) => <span className="text-muted-foreground tabular-nums">{r.tip ? money(r.tip) : '-'}</span>, csv: (r) => String(r.tip), sort: (r) => r.tip },
  { key: 'team', label: 'Team', width: 150, min: 130, render: (r) => <span>{r.team}</span>, csv: (r) => r.team, sort: (r) => r.team },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (r) => <span>{r.source}</span>, csv: (r) => r.source, sort: (r) => r.source },
  { key: 'jobDate', label: 'Job date', width: 140, min: 120, render: (r) => <span className="text-muted-foreground whitespace-nowrap">{fmtDay(r.jobDate)}</span>, csv: (r) => fmtDay(r.jobDate), sort: (r) => r.jobDate.getTime() },
];

const DEFAULT_VISIBLE = ['jobId', 'client', 'status', 'jobType', 'total', 'subtotal', 'paid', 'due', 'invoice'];
const FIELDS_KEY = 'salesReport.visibleFields.v1';

type DateField = 'jobDate' | 'createdAt' | 'paidAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { jobDate: 'Job date', createdAt: 'Created', paidAt: 'Paid date' };

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
      const day = (now.getDay() + 6) % 7;
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

type FilterKey = 'status' | 'team' | 'createdBy' | 'tags' | 'jobType' | 'source';
type Filters = Record<FilterKey, string[]>;
const EMPTY_FILTERS: Filters = { status: [], team: [], createdBy: [], tags: [], jobType: [], source: [] };

const FILTER_COLUMNS: { key: FilterKey; label: string; options: readonly string[] }[] = [
  { key: 'status', label: 'Status', options: STATUSES },
  { key: 'team', label: 'Team', options: TEAM },
  { key: 'createdBy', label: 'Created by', options: CREATORS },
  { key: 'tags', label: 'Tags', options: TAGS },
  { key: 'jobType', label: 'Job type', options: JOB_TYPES },
  { key: 'source', label: 'Source', options: SOURCES },
];

export default function SalesReport() {
  const report = findReport('sales')!;
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<Preset>('month');
  const [dateField, setDateField] = useState<DateField>('jobDate');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
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
    return ROWS.filter((r) => {
      if (filters.status.length && !filters.status.includes(r.status)) return false;
      if (filters.team.length && !filters.team.includes(r.team)) return false;
      if (filters.createdBy.length && !filters.createdBy.includes(r.createdBy)) return false;
      if (filters.tags.length && !r.tags.some((t) => filters.tags.includes(t))) return false;
      if (filters.jobType.length && !filters.jobType.includes(r.jobType)) return false;
      if (filters.source.length && !filters.source.includes(r.source)) return false;
      const d = r[dateField];
      if (range.from && (!d || d < range.from)) return false;
      if (range.to && (!d || d > range.to)) return false;
      if (q) {
        const hay = `${r.jobId} ${r.client} ${r.email} ${r.jobType} ${r.invoice}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filters, search, range, dateField]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filters or page size change
  useEffect(() => setPage(0), [filters, search, preset, dateField, pageSize]);

  const totals = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const k of MONEY_KEYS) acc[k] = filtered.reduce((s, r) => s + ((r as unknown as Record<string, number>)[k] ?? 0), 0);
    return acc;
  }, [filtered]);

  const chartData = useMemo(() => {
    const m = new Map<string, { date: string; Sales: number; Profit: number; t: number }>();
    for (const r of filtered) {
      const key = fmtDay(r.jobDate);
      const cur = m.get(key) ?? { date: key, Sales: 0, Profit: 0, t: new Date(r.jobDate).setHours(0, 0, 0, 0) };
      cur.Sales += r.total;
      cur.Profit += r.profit;
      m.set(key, cur);
    }
    return Array.from(m.values()).sort((a, b) => a.t - b.t);
  }, [filtered]);

  const cols = COLUMNS.filter((c) => c.alwaysOn || visible.includes(c.key));
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const totalsFor = (key: string): number | null => (MONEY_KEYS.includes(key as (typeof MONEY_KEYS)[number]) ? (totals as Record<string, number>)[key]! : null);

  const tableColumns: ReportColumn<Row>[] = cols.map((c, i) => {
    const t = totalsFor(c.key);
    return {
      id: c.key,
      header: c.label,
      cell: c.render,
      sortValue: c.sort ?? c.csv,
      width: c.width,
      min: c.min,
      grow: c.grow,
      align: c.align,
      footer: i === 0 ? 'Total:' : t != null ? <span className="tabular-nums">{money(t)}</span> : undefined,
    };
  });

  function exportCsv() {
    exportCsvFile('sales-report.csv', cols.map((c) => c.label), filtered.map((r) => cols.map((c) => c.csv(r))));
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

  return (
    <ReportShell report={report}>
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Total Sales', value: money0(totals.total ?? 0), tone: 'primary', emphasize: true },
          { icon: PiggyBank, label: 'Profit', value: money0(totals.profit ?? 0), tone: 'success', emphasize: true },
          { icon: Wallet, label: 'Collected', value: money0(totals.paid ?? 0), tone: 'success' },
          { icon: AlertCircle, label: 'Due', value: money0(totals.due ?? 0), tone: 'danger', emphasize: true },
        ]}
      />

      <ChartCard>
        <WaveAreaChart
          data={chartData}
          xKey="date"
          height={280}
          valueFormatter={money0}
          series={[
            { dataKey: 'Sales', name: 'Sales', color: token('--warning') },
            { dataKey: 'Profit', name: 'Profit', color: token('--success') },
          ]}
        />
      </ChartCard>

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

      <ReportToolbar
        search={search}
        onSearchChange={setSearch}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[10, 25, 50, 100]}
        onExport={exportCsv}
        onFields={() => setFieldsOpen(true)}
      />

      <ReportTable
        rows={pageRows}
        getRowKey={(r) => String(r.jobId)}
        empty={<EmptyState title="No sales match these filters." />}
        columns={tableColumns}
        initialPageSize={pageSize}
      />
      <ReportTableTotals columns={tableColumns} />

      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
      />

      <p className="text-muted-foreground text-xs">
        Sample data shown so the layout is reviewable without a backend. Once the backend is connected, this wires to{' '}
        <code className="bg-muted rounded px-1">GET /api/sales</code> with the same filters, columns and export.
      </p>

      {fieldsOpen && <FieldsPicker columns={COLUMNS} visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

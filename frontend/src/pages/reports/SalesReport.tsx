// ───────────────────────────────────────────────────────────────────────────
// Sales Report — Workiz-style sales/revenue report.
//
// Profit-vs-Sales area chart over the selected date range, a multi-column
// filter panel (Status · Team · Created By · Tags · Job Type · Source), a
// date-range control with a selectable date field, a money table with a
// "Total:" summary row, search, page size, CSV export and a Fields picker.
//
// Deterministic MOCK data so it renders without a backend. Wire to
// GET /api/sales later (replace ROWS / generate); the view stays.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChartCard, WaveAreaChart } from '@/components/charts';
import { token } from '@/design-system';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import {
  DollarSign,
  PiggyBank,
  Wallet,
  AlertCircle,
  Search,
  Check,
} from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { DateRangeControl } from './DateRangeControl';
import { ReportToolbar, ReportPager, ReportSelectTrigger } from './_shared';
import { hashStr, mulberry32 } from '@/lib/reports/random';
import { exportCsvFile } from '@/lib/csv';

// ── Domain vocab (Northwind Services) ─────────────────────────────────────────
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

// ── Mock data ────────────────────────────────────────────────────────────────
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

// ── Formatting helpers ───────────────────────────────────────────────────────
const money = (n: number) => formatCurrency(n);
const money0 = (n: number) => formatCurrencyWhole(n);
const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });

const STATUS_STYLE: Record<Status, string> = {
  Submitted: 'bg-info/10 text-info',
  'In progress': 'bg-warning/10 text-warning',
  Pending: 'bg-background-light text-text-secondary',
  Done: 'bg-success/10 text-success',
  'done pending': 'bg-primary/10 text-primary',
  Canceled: 'bg-danger/10 text-danger',
};

// ── Columns (the "Fields" picker drives which are visible) ────────────────────
const MONEY_KEYS = ['total', 'subtotal', 'itemCost', 'laborCost', 'cardExpenses', 'techExpenses', 'profit', 'tip', 'paid', 'due'] as const;
interface ColumnDef {
  key: string;
  label: string;
  render: (r: Row) => ReactNode;
  csv: (r: Row) => string;
  alwaysOn?: boolean;
  /** Sort key for the resizable table; falls back to `csv` when omitted. */
  sort?: (r: Row) => string | number | null;
  /** Default column width (px) for the resizable grid. */
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnDef[] = [
  { key: 'jobId', label: 'Job ID', alwaysOn: true, width: 100, min: 90, render: (r) => <span className="font-medium tabular-nums text-text-primary">{r.jobId}</span>, csv: (r) => String(r.jobId), sort: (r) => r.jobId },
  {
    key: 'client',
    label: 'Client',
    width: 190,
    min: 160,
    sort: (r) => r.client,
    render: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-text-primary">{r.client}</div>
        <div className="truncate text-xs text-text-secondary">{r.email}</div>
      </div>
    ),
    csv: (r) => r.client,
  },
  {
    key: 'status',
    label: 'Status',
    width: 120,
    min: 110,
    render: (r) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}>{r.status}</span>,
    csv: (r) => r.status,
    sort: (r) => r.status,
  },
  { key: 'jobType', label: 'Job type', width: 160, min: 130, render: (r) => <span className="block truncate text-text-primary">{r.jobType}</span>, csv: (r) => r.jobType, sort: (r) => r.jobType },
  { key: 'total', label: 'Total', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums text-text-primary">{money(r.total)}</span>, csv: (r) => String(r.total), sort: (r) => r.total },
  { key: 'subtotal', label: 'Subtotal', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{money(r.subtotal)}</span>, csv: (r) => String(r.subtotal), sort: (r) => r.subtotal },
  { key: 'paid', label: 'Paid amount', width: 130, min: 110, align: 'right', render: (r) => <span className="tabular-nums text-success">{money(r.paid)}</span>, csv: (r) => String(r.paid), sort: (r) => r.paid },
  { key: 'due', label: 'Due', width: 120, min: 100, align: 'right', render: (r) => <span className={`tabular-nums ${r.due > 0 ? 'text-danger' : 'text-text-secondary'}`}>{money(r.due)}</span>, csv: (r) => String(r.due), sort: (r) => r.due },
  { key: 'invoice', label: 'Invoice', width: 110, min: 95, align: 'right', render: (r) => <span className="tabular-nums text-info">{r.invoice}</span>, csv: (r) => String(r.invoice), sort: (r) => r.invoice },
  { key: 'itemCost', label: 'Item cost', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{money(r.itemCost)}</span>, csv: (r) => String(r.itemCost), sort: (r) => r.itemCost },
  { key: 'laborCost', label: 'Labor cost', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{money(r.laborCost)}</span>, csv: (r) => String(r.laborCost), sort: (r) => r.laborCost },
  { key: 'cardExpenses', label: 'Card Expenses', width: 130, min: 115, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{money(r.cardExpenses)}</span>, csv: (r) => String(r.cardExpenses), sort: (r) => r.cardExpenses },
  { key: 'techExpenses', label: 'Tech expenses', width: 130, min: 115, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{money(r.techExpenses)}</span>, csv: (r) => String(r.techExpenses), sort: (r) => r.techExpenses },
  { key: 'profit', label: 'Profit', width: 120, min: 100, align: 'right', render: (r) => <span className="tabular-nums text-success">{money(r.profit)}</span>, csv: (r) => String(r.profit), sort: (r) => r.profit },
  { key: 'tip', label: 'Tip', width: 100, min: 85, align: 'right', render: (r) => <span className="tabular-nums text-text-secondary">{r.tip ? money(r.tip) : '—'}</span>, csv: (r) => String(r.tip), sort: (r) => r.tip },
  { key: 'team', label: 'Team', width: 150, min: 130, render: (r) => <span className="text-text-primary">{r.team}</span>, csv: (r) => r.team, sort: (r) => r.team },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (r) => <span className="text-text-primary">{r.source}</span>, csv: (r) => r.source, sort: (r) => r.source },
  { key: 'jobDate', label: 'Job date', width: 140, min: 120, render: (r) => <span className="whitespace-nowrap text-text-secondary">{fmtDay(r.jobDate)}</span>, csv: (r) => fmtDay(r.jobDate), sort: (r) => r.jobDate.getTime() },
];

const DEFAULT_VISIBLE = ['jobId', 'client', 'status', 'jobType', 'total', 'subtotal', 'paid', 'due', 'invoice'];
const FIELDS_KEY = 'salesReport.visibleFields.v1';

// ── Date presets ─────────────────────────────────────────────────────────────
type DateField = 'jobDate' | 'createdAt' | 'paidAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { jobDate: 'Job date', createdAt: 'Created', paidAt: 'Paid date' };

type Preset = 'week' | '7d' | 'month' | 'lastMonth' | 'year' | 'all' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  week: 'This week (Mon–Today)',
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

// ── Multi-column filter panel ─────────────────────────────────────────────────
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

function FilterPanel({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);

  const toggle = (k: FilterKey, v: string) => {
    const cur = filters[k];
    onChange({ ...filters, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const total = Object.values(filters).reduce((s, a) => s + a.length, 0);

  return (
    <ReportSelectTrigger
      label="Filter results"
      activeCount={total}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      onClear={() => onChange({ ...EMPTY_FILTERS })}
    >
      <div className="grid max-h-[420px] grid-cols-2 gap-x-4 gap-y-3 overflow-auto p-4 sm:grid-cols-3 lg:grid-cols-6">
        {FILTER_COLUMNS.map((col) => (
          <div key={col.key} className="min-w-0">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{col.label}</div>
            <div className="space-y-0.5">
              {col.options.map((opt) => {
                const on = filters[col.key].includes(opt);
                return (
                  // raw: checklist / dropdown-item row, not Button-shaped
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggle(col.key, opt)}
                    className={`flex w-full items-center justify-between gap-1 rounded-md px-2 py-1 text-left text-[13px] ${
                      on ? 'bg-primary-subtle font-medium text-primary' : 'text-text-primary hover:bg-background-light'
                    }`}
                  >
                    <span className="truncate">{opt}</span>
                    {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ReportSelectTrigger>
  );
}

// ── Fields modal ─────────────────────────────────────────────────────────────
function FieldsModal({ visible, onSave, onClose }: { visible: string[]; onSave: (keys: string[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<string[]>(visible);
  const [q, setQ] = useState('');
  const shown = COLUMNS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (key: string, alwaysOn?: boolean) => {
    if (alwaysOn) return;
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Visible fields"
      size="sm"
      footer={
        <>
          {/* ghost/subtle matches the raw's idle text-text-secondary and
              hover:text-text-primary exactly. size={null} suppresses the
              default 40px box - the raw had no box-model classes at all, just
              text-sm sized to line-height. Two remaining disclosed deltas:
              ghost/subtle adds hover:bg-background-light (no hover bg before),
              and the base font-semibold replaces the raw's font-medium. */}
          <Button type="button" variant="ghost" tone="subtle" size={null} onClick={onClose}>
            Cancel
          </Button>
          {/* solid/brand - bg-primary, text-on-fill and font-semibold all match exactly.
              Two disclosed deltas: the raw's rounded-full pill becomes Button's
              rounded-button (adding rounded-full as a call-site override would
              be a HARD layering-guard violation), and solid/brand's hover
              (hover:bg-primary-dark) replaces the raw's hover:opacity-90 -
              different technique, not an exact match. */}
          <Button
            type="button"
            variant="solid"
            tone="brand"
            onClick={() => onSave(COLUMNS.filter((c) => c.alwaysOn || draft.includes(c.key)).map((c) => c.key))}
          >
            Save fields
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type field name here"
            className="h-10 w-full rounded-lg border border-border pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="max-h-[50vh] space-y-4 overflow-auto">
          {[
            { title: 'Selected fields', items: shown.filter((c) => c.alwaysOn || draft.includes(c.key)) },
            { title: 'Unselected fields', items: shown.filter((c) => !(c.alwaysOn || draft.includes(c.key))) },
          ].map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.title} className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{group.title}</div>
                {group.items.map((c) => {
                  const on = c.alwaysOn || draft.includes(c.key);
                  return (
                    // raw: checklist row with its own checkbox indicator, not Button-shaped
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggle(c.key, c.alwaysOn)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left ${
                        c.alwaysOn ? 'cursor-default border-border bg-background-light' : 'border-border hover:bg-background-light'
                      }`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded ${on ? 'bg-primary text-on-fill' : 'border border-border bg-surface-light'}`}>
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                      <span className="text-sm font-medium text-text-primary">{c.label}</span>
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
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
      {/* KPI strip — headline sales numbers */}
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Total Sales', value: money0(totals.total ?? 0), tone: 'primary', emphasize: true },
          { icon: PiggyBank, label: 'Profit', value: money0(totals.profit ?? 0), tone: 'success', emphasize: true },
          { icon: Wallet, label: 'Collected', value: money0(totals.paid ?? 0), tone: 'success' },
          { icon: AlertCircle, label: 'Due', value: money0(totals.due ?? 0), tone: 'danger', emphasize: true },
        ]}
      />

      {/* Profit vs Sales chart */}
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

      {/* Filter + date row */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="lg:flex-1">
          <FilterPanel filters={filters} onChange={setFilters} />
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

      {/* Toolbar */}
      <ReportToolbar
        search={search}
        onSearchChange={setSearch}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[10, 25, 50, 100]}
        onExport={exportCsv}
        onFields={() => setFieldsOpen(true)}
      />

      {/* Table — shared resizable grid (drag column edges to resize, click headers to sort) */}
      <ResizableTable
        rows={pageRows}
        getRowKey={(r) => String(r.jobId)}
        empty={<EmptyState title="No sales match these filters." />}
        columns={cols.map((c, i) => {
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
        })}
      />

      {/* Pagination */}
      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
      />

      <p className="text-xs text-text-secondary">
        Sample data shown so the layout is reviewable without a backend. Once the backend is connected, this wires to{' '}
        <code className="rounded bg-background-light px-1">GET /api/sales</code> with the same filters, columns and export.
      </p>

      {fieldsOpen && <FieldsModal visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

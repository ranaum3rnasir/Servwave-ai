// ───────────────────────────────────────────────────────────────────────────
// Jobs Report — Workiz-style operations report for the Jobs entity.
//
// Multi-column filter panel (Status · Team · Created By · Tags · Job Type ·
// Job Origin · Source), a date-range control with a selectable date field,
// a live-recalculating stats strip (counts by status, revenue, by type, by
// source), a configurable-columns table ("Fields"), search, page size, and
// CSV export of the full filtered set.
//
// Deterministic MOCK data so it renders without a backend. Wire to
// GET /api/jobs (+ /report-stats, /export) later (replace JOBS / generate);
// the view, filters, columns and export stay.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Briefcase,
  CheckCircle2,
  Loader2,
  Clock,
  DollarSign,
  Wallet,
  Search,
  Check,
} from 'lucide-react';
import { KpiTile } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Heading } from '@/components/ui/heading';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { DateRangeControl } from './DateRangeControl';
import { ReportToolbar, ReportPager, ReportSelectTrigger } from './_shared';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { formatPhone } from '@/lib/utils';
import { useJobsReport } from '@/lib/reports/jobs-data';
import { exportCsvFile } from '@/lib/csv';
import { STATUS_INTENT_CLASSES } from '@/design-system/status-registry';

import {
  STATUSES, TYPES, SOURCES, ORIGINS, TECHS, CREATORS, TAGS,
  type Job, type Status,
} from '@/lib/reports/jobs-fixtures';

// ── Formatting helpers ───────────────────────────────────────────────────────
const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtDate = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDateShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Synthetic report-only taxonomy (Workiz labels) - not the backend JobStatus enum, so
// this stays a local map, but the colours come from the status registry's intent classes.
// 'done pending' takes the brand intent so it stays distinguishable from plain 'Done'.
const STATUS_STYLE: Record<Status, string> = {
  Submitted: STATUS_INTENT_CLASSES.info,
  'In progress': STATUS_INTENT_CLASSES.warning,
  'In progress - Scheduled': STATUS_INTENT_CLASSES.warning,
  'On the way': STATUS_INTENT_CLASSES.warning,
  'On site': STATUS_INTENT_CLASSES.warning,
  Pending: STATUS_INTENT_CLASSES.neutral,
  Done: STATUS_INTENT_CLASSES.success,
  'done pending': STATUS_INTENT_CLASSES.brand,
  Canceled: STATUS_INTENT_CLASSES.danger,
};

const TAG_STYLE = (tag: string): string => {
  const t = tag.toLowerCase();
  if (t.includes('today')) return 'bg-info-strong text-on-fill';
  if (t.includes('collect') || t.includes('answer') || t.includes('order') || t.includes('callback')) return 'bg-danger-strong text-on-fill';
  if (t.includes('waiting')) return 'bg-warning-strong text-on-fill';
  if (t.includes('more info')) return 'bg-success-strong text-on-fill';
  return 'bg-warning-strong text-on-fill';
};

// ── Columns (the "Fields" picker drives which are visible) ────────────────────
interface ColumnDef {
  key: string;
  label: string;
  render: (j: Job) => ReactNode;
  csv: (j: Job) => string;
  alwaysOn?: boolean;
  /** Sort key for the resizable table; falls back to `csv` when omitted. */
  sort?: (j: Job) => string | number | null;
  /** Default column width (px) for the resizable grid. */
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnDef[] = [
  { key: 'jobNumber', label: 'Job #', alwaysOn: true, width: 100, min: 85, render: (j) => <span className="font-medium tabular-nums text-text-primary">{j.jobNumber}</span>, csv: (j) => String(j.jobNumber), sort: (j) => j.jobNumber },
  { key: 'jobName', label: 'Job name', width: 150, min: 130, render: (j) => j.jobName || <span className="text-text-secondary">—</span>, csv: (j) => j.jobName, sort: (j) => j.jobName },
  {
    key: 'client',
    label: 'Client',
    width: 180,
    min: 150,
    sort: (j) => j.client,
    render: (j) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-text-primary">{j.client}</div>
        <div className="truncate text-xs text-text-secondary">{j.email}</div>
      </div>
    ),
    csv: (j) => j.client,
  },
  {
    key: 'tags',
    label: 'Tags',
    width: 160,
    min: 130,
    render: (j) => (
      <div className="flex flex-wrap gap-1">
        {j.tags.map((t) => (
          <span key={t} className={`inline-block max-w-[120px] truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${TAG_STYLE(t)}`}>{t}</span>
        ))}
      </div>
    ),
    csv: (j) => j.tags.join('; '),
  },
  { key: 'type', label: 'Type', width: 150, min: 120, render: (j) => <span className="text-text-primary">{j.type}</span>, csv: (j) => j.type, sort: (j) => j.type },
  { key: 'createdAt', label: 'Job Created', width: 180, min: 175, render: (j) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(j.createdAt)}</span>, csv: (j) => fmtDate(j.createdAt), sort: (j) => j.createdAt.getTime() },
  { key: 'phone', label: 'Phone', width: 150, min: 140, render: (j) => <span className="whitespace-nowrap text-info">{formatPhone(j.phone)}</span>, csv: (j) => formatPhone(j.phone), sort: (j) => j.phone },
  { key: 'email', label: 'Email', width: 200, min: 160, render: (j) => <span className="truncate text-text-secondary">{j.email}</span>, csv: (j) => j.email, sort: (j) => j.email },
  {
    key: 'status',
    label: 'Status',
    width: 150,
    min: 130,
    render: (j) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[j.status]}`}>{j.status}</span>,
    csv: (j) => j.status,
    sort: (j) => j.status,
  },
  { key: 'tech', label: 'Tech', width: 160, min: 130, render: (j) => <span className="text-text-primary">{j.tech.join(', ')}</span>, csv: (j) => j.tech.join('; '), sort: (j) => j.tech.join(', ') },
  { key: 'createdBy', label: 'Created by', width: 150, min: 130, render: (j) => <span className="text-text-secondary">{j.createdBy}</span>, csv: (j) => j.createdBy, sort: (j) => j.createdBy },
  { key: 'address', label: 'Address', width: 210, min: 170, render: (j) => <span className="truncate text-text-secondary">{j.address}</span>, csv: (j) => j.address, sort: (j) => j.address },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (j) => <span className="text-text-primary">{j.source}</span>, csv: (j) => j.source, sort: (j) => j.source },
  { key: 'origin', label: 'Origin', width: 110, min: 95, render: (j) => <span className="text-text-secondary">{j.origin}</span>, csv: (j) => j.origin, sort: (j) => j.origin },
  { key: 'scheduledAt', label: 'Scheduled', width: 140, min: 130, render: (j) => <span className="whitespace-nowrap text-text-secondary">{fmtDateShort(j.scheduledAt)}</span>, csv: (j) => fmtDateShort(j.scheduledAt), sort: (j) => j.scheduledAt.getTime() },
  { key: 'endAt', label: 'End', width: 140, min: 130, render: (j) => <span className="whitespace-nowrap text-text-secondary">{fmtDateShort(j.endAt)}</span>, csv: (j) => fmtDateShort(j.endAt), sort: (j) => j.endAt.getTime() },
  { key: 'billed', label: 'Billed', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-text-primary">{money0(j.billed)}</span>, csv: (j) => String(j.billed), sort: (j) => j.billed },
  { key: 'paid', label: 'Collected', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-success-text">{money0(j.paid)}</span>, csv: (j) => String(j.paid), sort: (j) => j.paid },
  { key: 'subtotal', label: 'Subtotal', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.subtotal)}</span>, csv: (j) => String(j.subtotal), sort: (j) => j.subtotal },
  { key: 'itemCost', label: 'Item cost', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.itemCost)}</span>, csv: (j) => String(j.itemCost), sort: (j) => j.itemCost },
  { key: 'laborCost', label: 'Labor cost', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.laborCost)}</span>, csv: (j) => String(j.laborCost), sort: (j) => j.laborCost },
  { key: 'cardExpenses', label: 'Card Expenses', width: 130, min: 115, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.cardExpenses)}</span>, csv: (j) => String(j.cardExpenses), sort: (j) => j.cardExpenses },
  { key: 'techExpenses', label: 'Tech expenses', width: 130, min: 115, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.techExpenses)}</span>, csv: (j) => String(j.techExpenses), sort: (j) => j.techExpenses },
  { key: 'tax', label: 'Tax', width: 100, min: 90, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{money0(j.tax)}</span>, csv: (j) => String(j.tax), sort: (j) => j.tax },
  { key: 'profit', label: 'Profit', width: 110, min: 100, align: 'right', render: (j) => <span className="tabular-nums text-success-text">{money0(j.profit)}</span>, csv: (j) => String(j.profit), sort: (j) => j.profit },
  { key: 'tip', label: 'Tip', width: 100, min: 90, align: 'right', render: (j) => <span className="tabular-nums text-text-secondary">{j.tip ? money0(j.tip) : '—'}</span>, csv: (j) => String(j.tip), sort: (j) => j.tip },
];

const DEFAULT_VISIBLE = ['jobNumber', 'jobName', 'client', 'tags', 'type', 'createdAt', 'phone', 'email', 'status', 'tech', 'createdBy', 'address'];
const FIELDS_KEY = 'jobsReport.visibleFields.v1';

// ── Date presets ─────────────────────────────────────────────────────────────
type DateField = 'createdAt' | 'scheduledAt' | 'endAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { createdAt: 'Job created', scheduledAt: 'Scheduled', endAt: 'Job end date' };

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

// ── Multi-column filter panel (the signature Workiz control) ──────────────────
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

function FilterPanel({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);

  const toggle = (k: FilterKey, v: string) => {
    const cur = filters[k];
    onChange({ ...filters, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const total = Object.values(filters).reduce((s, a) => s + a.length, 0);

  return (
    <ReportSelectTrigger
      label="Select…"
      activeCount={total}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      onClear={() => onChange({ ...EMPTY_FILTERS })}
    >
      <div className="grid max-h-[420px] grid-cols-2 gap-x-4 gap-y-3 overflow-auto p-4 sm:grid-cols-4 lg:grid-cols-7">
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
function FieldsModal({
  visible,
  onSave,
  onClose,
}: {
  visible: string[];
  onSave: (keys: string[]) => void;
  onClose: () => void;
}) {
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

// ── Breakdown bar panel ──────────────────────────────────────────────────────
function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number; revenue: number }[] }) {
  const top = rows.sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
      <Heading level={2} className="mb-3">{title}</Heading>
      {top.length === 0 ? (
        <p className="text-xs text-text-secondary">No jobs in range.</p>
      ) : (
        <div className="space-y-2.5">
          {top.map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="truncate text-text-primary">{r.label}</span>
                <span className="tabular-nums text-text-secondary">
                  {r.count} · {money0(r.revenue)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-background-light">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
/** Which KPI card is driving the list filter (null = Total Jobs / show all). */
type CardFilter = 'done' | 'inProgress' | 'open' | 'billed' | 'collected';

export default function JobsReport() {
  const report = findReport('jobs')!;
  // Demo orgs keep the deterministic mock (sales vision); real orgs get the
  // live, DB-backed rows. Same `Job[]` shape either way → aliased to JOBS so the
  // filters / breakdowns / columns / export below are unchanged.
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

  return (
    <ReportShell report={report}>
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

      {/* Stats strip — one row, recalculates with filters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { icon: Briefcase, label: 'Total Jobs', value: stats.total, tone: 'primary' as const, emphasize: true, active: false, onClick: () => setCardFilter(null) },
          { icon: CheckCircle2, label: 'Done', value: stats.done, tone: 'success' as const, active: cardFilter === 'done', onClick: () => setCardFilter((c) => (c === 'done' ? null : 'done')) },
          { icon: Loader2, label: 'In Progress', value: stats.inProgress, tone: 'warning' as const, active: cardFilter === 'inProgress', onClick: () => setCardFilter((c) => (c === 'inProgress' ? null : 'inProgress')) },
          { icon: Clock, label: 'Open', value: stats.open, tone: 'neutral' as const, sub: `${stats.canceled} canceled`, active: cardFilter === 'open', onClick: () => setCardFilter((c) => (c === 'open' ? null : 'open')) },
          { icon: DollarSign, label: 'Billed', value: money0(stats.billed), tone: 'neutral' as const, emphasize: true, active: cardFilter === 'billed', onClick: () => setCardFilter((c) => (c === 'billed' ? null : 'billed')) },
          { icon: Wallet, label: 'Collected', value: money0(stats.paid), tone: 'success' as const, emphasize: true, active: cardFilter === 'collected', onClick: () => setCardFilter((c) => (c === 'collected' ? null : 'collected')) },
        ].map((it) => (
          <KpiTile key={it.label} {...it} />
        ))}
      </div>

      {/* Two breakdown panels */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="Jobs by type" rows={breakdown.byType} />
        <Breakdown title="Jobs by source" rows={breakdown.bySource} />
      </div>

      {/* Toolbar */}
      <ReportToolbar
        search={search}
        onSearchChange={setSearch}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
        onExport={exportCsv}
        onFields={() => setFieldsOpen(true)}
      />

      {/* Table — shared resizable grid (drag column edges to resize, click headers to sort) */}
      <ResizableTable
        rows={pageRows}
        getRowKey={(j) => String(j.jobNumber)}
        empty={<EmptyState title="No jobs match these filters." />}
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

      {/* Pagination */}
      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
      />

      <p className="text-xs text-text-secondary">
        {isDemo
          ? 'Sample data shown so the layout is reviewable without a backend.'
          : 'Live data from GET /api/reports/jobs — money is summed across each job’s linked invoices.'}
      </p>

      {fieldsOpen && <FieldsModal visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Leads Report — Workiz-style report for the Leads entity.
//
// KPI strip (Leads · Converted · Conversion Rate · Sold $), a multi-column
// filter panel (Status · Assigned · Created By · Source), a date-range control
// with a selectable date field, by-source / by-status breakdowns, a
// configurable-columns table ("Fields"), search, page size, and CSV export.
//
// Deterministic MOCK data so it renders without a backend. Wire to
// GET /api/leads later (replace LEADS / generate); the view stays.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Target,
  CheckCircle2,
  Percent,
  DollarSign,
  Search,
  Check,
} from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Heading } from '@/components/ui/heading';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { DateRangeControl } from './DateRangeControl';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useLeadsReport } from '@/lib/reports/leads-data';
import { formatPhone } from '@/lib/utils';
import { ReportToolbar, ReportPager, ReportSelectTrigger } from './_shared';
import { exportCsvFile } from '@/lib/csv';
import { STATUS_INTENT_CLASSES } from '@/design-system/status-registry';

import {
  STATUSES, WON_STATUSES, SOURCES, TEAM, CREATORS, TAGS, JOB_TYPES, LEADS,
  type Lead, type Status,
} from '@/lib/reports/leads-fixtures';

// ── Formatting helpers ───────────────────────────────────────────────────────
const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtDate = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDateShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Synthetic report-only taxonomy (Workiz labels) - not the backend LeadStatus enum, so
// this stays a local map, but the colours come from the status registry's intent classes.
// 'Sold-done' takes the brand intent so it stays distinguishable from plain 'Sold'.
const STATUS_STYLE: Record<Status, string> = {
  Open: STATUS_INTENT_CLASSES.info,
  Converted: STATUS_INTENT_CLASSES.warning,
  Sold: STATUS_INTENT_CLASSES.success,
  'Sold-done': STATUS_INTENT_CLASSES.brand,
  Lost: STATUS_INTENT_CLASSES.danger,
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
  render: (l: Lead) => ReactNode;
  csv: (l: Lead) => string;
  alwaysOn?: boolean;
  /** Sort key for the resizable table; falls back to `csv` when omitted. */
  sort?: (l: Lead) => string | number | null;
  /** Default column width (px) for the resizable grid. */
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnDef[] = [
  { key: 'leadNumber', label: 'Id', alwaysOn: true, width: 90, min: 80, render: (l) => <span className="font-medium tabular-nums text-text-primary">{l.leadNumber}</span>, csv: (l) => String(l.leadNumber), sort: (l) => l.leadNumber },
  {
    key: 'status',
    label: 'Status',
    width: 120,
    min: 110,
    render: (l) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[l.status]}`}>{l.status}</span>,
    csv: (l) => l.status,
    sort: (l) => l.status,
  },
  {
    key: 'client',
    label: 'Client name',
    width: 180,
    min: 150,
    sort: (l) => l.client,
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate font-medium text-text-primary">{l.client}</div>
        <div className="truncate text-xs text-info">{formatPhone(l.phone)}</div>
      </div>
    ),
    csv: (l) => l.client,
  },
  { key: 'address', label: 'Address', width: 200, min: 160, render: (l) => <span className="truncate text-text-secondary">{l.address}</span>, csv: (l) => l.address, sort: (l) => l.address },
  { key: 'email', label: 'Email', width: 190, min: 160, render: (l) => (l.email ? <span className="truncate text-text-secondary">{l.email}</span> : <span className="text-text-secondary">—</span>), csv: (l) => l.email, sort: (l) => l.email },
  { key: 'phone', label: 'Phone', width: 150, min: 140, render: (l) => <span className="whitespace-nowrap text-text-secondary">{formatPhone(l.phone)}</span>, csv: (l) => formatPhone(l.phone), sort: (l) => l.phone },
  { key: 'createdAt', label: 'Created', width: 180, min: 175, render: (l) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(l.createdAt)}</span>, csv: (l) => fmtDate(l.createdAt), sort: (l) => l.createdAt.getTime() },
  { key: 'estimates', label: 'Estimates', width: 110, min: 105, align: 'right', render: (l) => <span className="tabular-nums text-text-primary">{l.estimates || ''}</span>, csv: (l) => String(l.estimates), sort: (l) => l.estimates },
  { key: 'assigned', label: 'Assigned', width: 130, min: 115, render: (l) => <span className="text-text-primary">{l.assigned || '—'}</span>, csv: (l) => l.assigned, sort: (l) => l.assigned },
  { key: 'createdBy', label: 'Created by', width: 150, min: 130, render: (l) => <span className="text-text-secondary">{l.createdBy}</span>, csv: (l) => l.createdBy, sort: (l) => l.createdBy },
  { key: 'scheduledAt', label: 'Scheduled', width: 140, min: 130, render: (l) => <span className="whitespace-nowrap text-text-secondary">{fmtDateShort(l.scheduledAt)}</span>, csv: (l) => fmtDateShort(l.scheduledAt), sort: (l) => l.scheduledAt.getTime() },
  { key: 'convertedAt', label: 'Lead Converted date', width: 180, min: 165, render: (l) => (l.convertedAt ? <span className="whitespace-nowrap text-success-text">{fmtDateShort(l.convertedAt)}</span> : <span className="text-text-secondary">—</span>), csv: (l) => (l.convertedAt ? fmtDateShort(l.convertedAt) : ''), sort: (l) => (l.convertedAt ? l.convertedAt.getTime() : null) },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (l) => <span className="text-text-primary">{l.source}</span>, csv: (l) => l.source, sort: (l) => l.source },
  {
    key: 'tags',
    label: 'Tags',
    render: (l) => (
      <div className="flex flex-wrap gap-1">
        {l.tags.map((t) => (
          <span key={t} className={`inline-block max-w-[120px] truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${TAG_STYLE(t)}`}>{t}</span>
        ))}
      </div>
    ),
    csv: (l) => l.tags.join('; '),
  },
  { key: 'jobType', label: 'Job type', render: (l) => <span className="text-text-primary">{l.jobType}</span>, csv: (l) => l.jobType, sort: (l) => l.jobType },
  { key: 'value', label: 'Sold value', align: 'right', render: (l) => (l.value ? <span className="tabular-nums text-success-text">{money0(l.value)}</span> : <span className="text-text-secondary">—</span>), csv: (l) => String(l.value), sort: (l) => l.value },
];

const DEFAULT_VISIBLE = ['leadNumber', 'status', 'client', 'address', 'email', 'phone', 'createdAt', 'estimates', 'assigned', 'createdBy', 'scheduledAt', 'convertedAt'];
const FIELDS_KEY = 'leadsReport.visibleFields.v1';

// ── Date presets ─────────────────────────────────────────────────────────────
type DateField = 'createdAt' | 'scheduledAt' | 'convertedAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { createdAt: 'Created', scheduledAt: 'Scheduled', convertedAt: 'Lead converted date' };

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
type FilterKey = 'status' | 'assigned' | 'createdBy' | 'tags' | 'jobType' | 'source';
type Filters = Record<FilterKey, string[]>;
const EMPTY_FILTERS: Filters = { status: [], assigned: [], createdBy: [], tags: [], jobType: [], source: [] };

const FILTER_COLUMNS: { key: FilterKey; label: string; options: readonly string[] }[] = [
  { key: 'status', label: 'Status', options: STATUSES },
  { key: 'assigned', label: 'Team', options: TEAM },
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

// ── Breakdown bar panel ──────────────────────────────────────────────────────
function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number; value: number }[] }) {
  const top = rows.sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
      <Heading level={2} className="mb-3">{title}</Heading>
      {top.length === 0 ? (
        <p className="text-xs text-text-secondary">No leads in range.</p>
      ) : (
        <div className="space-y-2.5">
          {top.map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="truncate text-text-primary">{r.label}</span>
                <span className="tabular-nums text-text-secondary">
                  {r.count}
                  {r.value ? ` · ${money0(r.value)}` : ''}
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
export default function LeadsReport() {
  const report = findReport('leads')!;
  const isDemo = useIsDemoOrg();
  // demo org → deterministic sample leads; real org → GET /api/reports/leads.
  const { leads } = useLeadsReport(isDemo);
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const [dateField, setDateField] = useState<DateField>('createdAt');
  const [pageSize, setPageSize] = useState(25);
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
    return leads.filter((l) => {
      if (filters.status.length && !filters.status.includes(l.status)) return false;
      if (filters.assigned.length && !filters.assigned.includes(l.assigned)) return false;
      if (filters.createdBy.length && !filters.createdBy.includes(l.createdBy)) return false;
      if (filters.tags.length && !l.tags.some((t) => filters.tags.includes(t))) return false;
      if (filters.jobType.length && !filters.jobType.includes(l.jobType)) return false;
      if (filters.source.length && !filters.source.includes(l.source)) return false;
      const d = l[dateField];
      if (range.from && (!d || d < range.from)) return false;
      if (range.to && (!d || d > range.to)) return false;
      if (q) {
        const hay = `${l.leadNumber} ${l.client} ${l.email} ${l.phone} ${l.address} ${l.assigned}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // `leads` is in deps so the report recomputes when the live query resolves from [] to data.
  }, [leads, filters, search, range, dateField]);

  useEffect(() => setPage(0), [filters, search, preset, dateField, pageSize]);

  const stats = useMemo(() => {
    const converted = filtered.filter((l) => WON_STATUSES.includes(l.status));
    const sold = converted.reduce((s, l) => s + l.value, 0);
    const group = (keyFn: (l: Lead) => string) => {
      const m = new Map<string, { count: number; value: number }>();
      for (const l of filtered) {
        const k = keyFn(l);
        const cur = m.get(k) ?? { count: 0, value: 0 };
        cur.count += 1;
        cur.value += l.value;
        m.set(k, cur);
      }
      return Array.from(m, ([label, v]) => ({ label, ...v }));
    };
    return {
      total: filtered.length,
      converted: converted.length,
      rate: filtered.length ? Math.round((converted.length / filtered.length) * 100) : 0,
      sold,
      bySource: group((l) => l.source),
      byStatus: group((l) => l.status),
    };
  }, [filtered]);

  const cols = COLUMNS.filter((c) => c.alwaysOn || visible.includes(c.key));
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  function exportCsv() {
    exportCsvFile('leads-report.csv', cols.map((c) => c.label), filtered.map((l) => cols.map((c) => c.csv(l))));
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
      {/* KPI strip — Workiz headline numbers */}
      <KpiStrip
        items={[
          { icon: Target, label: 'Leads', value: stats.total, tone: 'primary', emphasize: true },
          { icon: CheckCircle2, label: 'Converted', value: stats.converted, tone: 'warning' },
          { icon: Percent, label: 'Conversion Rate', value: `${stats.rate}%`, tone: 'danger', emphasize: true },
          { icon: DollarSign, label: 'Sold for', value: money0(stats.sold), tone: 'success', emphasize: true },
        ]}
      />

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

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="Leads by source" rows={stats.bySource} />
        <Breakdown title="Leads by status" rows={stats.byStatus} />
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
        getRowKey={(l) => String(l.leadNumber)}
        empty={<EmptyState title="No leads match these filters." />}
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
        {isDemo ? (
          <>
            Sample data shown so the layout is reviewable without a backend. Real organizations load live leads from{' '}
            <code className="rounded bg-background-light px-1">GET /api/reports/leads</code> with the same filters, columns and export.
          </>
        ) : (
          <>Live leads from <code className="rounded bg-background-light px-1">GET /api/reports/leads</code> — filters, columns and export apply to your real data.</>
        )}
      </p>

      {fieldsOpen && <FieldsModal visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

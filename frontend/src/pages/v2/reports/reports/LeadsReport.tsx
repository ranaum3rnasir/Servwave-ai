import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, DollarSign, Percent, Target } from 'lucide-react';

import { formatPhone } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import { useLeadsReport } from '@/lib/reports/leads-data';
import type { Lead } from '@/lib/reports/leads-fixtures';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Progress } from '@/ui-kit/components/ui/progress';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportPager, ReportToolbar } from '../components/shared';
import { FieldsPicker, FilterChecklistPanel } from '../components/fieldsPicker';
import { ReportTable } from '../components/reportTable';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * Leads report - the Workiz-style report for the Leads entity.
 *
 * THE DATA LIVES IN THE LEGACY MODULE AND IS IMPORTED, not copied.
 * `leads-data.ts` imports `LEADS` from `pages/reports/LeadsReport` and serves
 * it to demo orgs while swapping in `GET /api/reports/leads` for real ones. A
 * second copy of that 70-row deterministic fixture here would drift from the
 * one the live DTO is rehydrated to match, so this file imports
 * `useLeadsReport` and the `Lead` type and re-declares only the columns, which
 * are presentation.
 *
 * The domain vocabularies (statuses, team, creators, tags, job types, sources)
 * ARE restated, because they are the filter panel's option lists and the legacy
 * module does not export them. `WON_STATUSES` is restated with them and is the
 * one to watch: it decides what counts as converted for the KPI strip.
 *
 * The per-user visible-field list keeps its own localStorage key
 * (`leadsReport.visibleFields.v1`), so a user's saved column set carries across
 * the cutover rather than resetting.
 *
 * Shape differences: the Fields modal and the filter checklist move to the
 * shared `components/fieldsPicker` - Jobs, Leads and Sales each had a
 * byte-identical copy of both - and the breakdown bars are the kit's
 * `Progress`.
 */

const STATUSES = ['Open', 'Converted', 'Sold', 'Sold-done', 'Lost'] as const;
type Status = (typeof STATUSES)[number];
// Statuses that count as a win for the conversion KPIs.
const WON_STATUSES: Status[] = ['Converted', 'Sold', 'Sold-done'];

const SOURCES = [
  'Office', 'Google', 'Account', 'Returning customer', 'Village',
  'Village - Returned Customer', 'Google Local Service', 'Reserve with Google', 'Return Customer',
];
const TEAM = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Nadia', 'Shaked', 'Liran - Dor', 'Ofir Sub'];
const CREATORS = ['Emanuel Dahan', 'Dispatch', 'Ohad', 'Rami', 'Logistics', 'Nadia', 'Robert Bresnick', 'Efrain & Zhao', 'Onboarding'];
const TAGS = [
  'Followup', 'Callback', 'NEED TO COLLECT', 'NOT ANSWERING', 'NEED TO ORDER PART',
  'Waiting for pictures', 'Waiting for the client', 'Need more info', 'Today job',
];
const JOB_TYPES = [
  'AV + NETWORK + CCTV', 'Access Control System', 'Access control', 'Alarm System', 'Bullet Proof',
  'Burglar Alarm', 'Business Lockout', 'Buzzer System', 'CALL BACK', 'Gate', 'Garage', 'Troubleshoot',
  'Commercial', 'Residential',
];

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtDate = (d: Date) =>
  d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDateShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Synthetic report-only taxonomy (Workiz labels) - not the backend LeadStatus
// enum, so this stays a local map. It carried the status registry's five
// intents; on the kit those are the five soft Badge variants, and 'Sold-done'
// keeps its own (brand) so it stays distinguishable from plain 'Sold'.
const STATUS_VARIANT: Record<Status, NonNullable<BadgeProps['variant']>> = {
  Open: 'softBlue',
  Converted: 'softAmber',
  Sold: 'softGreen',
  'Sold-done': 'softPurple',
  Lost: 'softRed',
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
  render: (l: Lead) => ReactNode;
  csv: (l: Lead) => string;
  alwaysOn?: boolean;
  /** Sort key for the table; falls back to `csv` when omitted. */
  sort?: (l: Lead) => string | number | null;
  width?: number;
  min?: number;
  grow?: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: ColumnSpec[] = [
  { key: 'leadNumber', label: 'Id', alwaysOn: true, width: 90, min: 80, render: (l) => <span className="font-medium tabular-nums">{l.leadNumber}</span>, csv: (l) => String(l.leadNumber), sort: (l) => l.leadNumber },
  {
    key: 'status', label: 'Status', width: 120, min: 110,
    render: (l) => <Badge variant={STATUS_VARIANT[l.status]} size="pill">{l.status}</Badge>,
    csv: (l) => l.status,
    sort: (l) => l.status,
  },
  {
    key: 'client', label: 'Client name', width: 180, min: 150, sort: (l) => l.client,
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{l.client}</div>
        <div className="text-status-blue-emphasis truncate text-xs">{formatPhone(l.phone)}</div>
      </div>
    ),
    csv: (l) => l.client,
  },
  { key: 'address', label: 'Address', width: 200, min: 160, render: (l) => <span className="text-muted-foreground truncate">{l.address}</span>, csv: (l) => l.address, sort: (l) => l.address },
  { key: 'email', label: 'Email', width: 190, min: 160, render: (l) => (l.email ? <span className="text-muted-foreground truncate">{l.email}</span> : <span className="text-muted-foreground">-</span>), csv: (l) => l.email, sort: (l) => l.email },
  { key: 'phone', label: 'Phone', width: 150, min: 140, render: (l) => <span className="text-muted-foreground whitespace-nowrap">{formatPhone(l.phone)}</span>, csv: (l) => formatPhone(l.phone), sort: (l) => l.phone },
  { key: 'createdAt', label: 'Created', width: 180, min: 175, render: (l) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(l.createdAt)}</span>, csv: (l) => fmtDate(l.createdAt), sort: (l) => l.createdAt.getTime() },
  { key: 'estimates', label: 'Estimates', width: 110, min: 105, align: 'right', render: (l) => <span className="tabular-nums">{l.estimates || ''}</span>, csv: (l) => String(l.estimates), sort: (l) => l.estimates },
  { key: 'assigned', label: 'Assigned', width: 130, min: 115, render: (l) => <span>{l.assigned || '-'}</span>, csv: (l) => l.assigned, sort: (l) => l.assigned },
  { key: 'createdBy', label: 'Created by', width: 150, min: 130, render: (l) => <span className="text-muted-foreground">{l.createdBy}</span>, csv: (l) => l.createdBy, sort: (l) => l.createdBy },
  { key: 'scheduledAt', label: 'Scheduled', width: 140, min: 130, render: (l) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateShort(l.scheduledAt)}</span>, csv: (l) => fmtDateShort(l.scheduledAt), sort: (l) => l.scheduledAt.getTime() },
  { key: 'convertedAt', label: 'Lead Converted date', width: 180, min: 165, render: (l) => (l.convertedAt ? <span className="text-status-green-emphasis whitespace-nowrap">{fmtDateShort(l.convertedAt)}</span> : <span className="text-muted-foreground">-</span>), csv: (l) => (l.convertedAt ? fmtDateShort(l.convertedAt) : ''), sort: (l) => (l.convertedAt ? l.convertedAt.getTime() : null) },
  { key: 'source', label: 'Source', width: 150, min: 120, render: (l) => <span>{l.source}</span>, csv: (l) => l.source, sort: (l) => l.source },
  {
    key: 'tags', label: 'Tags',
    render: (l) => (
      <div className="flex flex-wrap gap-1">
        {l.tags.map((t) => (
          <Badge key={t} variant={TAG_VARIANT(t)} size="sm" className="max-w-[120px] truncate">{t}</Badge>
        ))}
      </div>
    ),
    csv: (l) => l.tags.join('; '),
  },
  { key: 'jobType', label: 'Job type', render: (l) => <span>{l.jobType}</span>, csv: (l) => l.jobType, sort: (l) => l.jobType },
  { key: 'value', label: 'Sold value', align: 'right', render: (l) => (l.value ? <span className="text-status-green-emphasis tabular-nums">{money0(l.value)}</span> : <span className="text-muted-foreground">-</span>), csv: (l) => String(l.value), sort: (l) => l.value },
];

const DEFAULT_VISIBLE = ['leadNumber', 'status', 'client', 'address', 'email', 'phone', 'createdAt', 'estimates', 'assigned', 'createdBy', 'scheduledAt', 'convertedAt'];
const FIELDS_KEY = 'leadsReport.visibleFields.v1';

type DateField = 'createdAt' | 'scheduledAt' | 'convertedAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { createdAt: 'Created', scheduledAt: 'Scheduled', convertedAt: 'Lead converted date' };

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

function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number; value: number }[] }) {
  const top = rows.sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(1, ...top.map((r) => r.count));
  return (
    <Card>
      <ReportHeading level={2} scale="lg" className="mb-3">{title}</ReportHeading>
      {top.length === 0 ? (
        <p className="text-muted-foreground text-xs">No leads in range.</p>
      ) : (
        <div className="space-y-2.5">
          {top.map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="truncate">{r.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {r.count}
                  {r.value ? ` · ${money0(r.value)}` : ''}
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

export default function LeadsReport() {
  const report = findReport('leads')!;
  const isDemo = useIsDemoOrg();
  // demo org -> deterministic sample leads; real org -> GET /api/reports/leads.
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
    // `leads` is in deps so the report recomputes when the live query resolves
    // from [] to data.
  }, [leads, filters, search, range, dateField]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filters or page size change
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
      <ReportKpis
        items={[
          { icon: Target, label: 'Leads', value: stats.total, tone: 'primary', emphasize: true },
          { icon: CheckCircle2, label: 'Converted', value: stats.converted, tone: 'warning' },
          { icon: Percent, label: 'Conversion Rate', value: `${stats.rate}%`, tone: 'danger', emphasize: true },
          { icon: DollarSign, label: 'Sold for', value: money0(stats.sold), tone: 'success', emphasize: true },
        ]}
      />

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Breakdown title="Leads by source" rows={stats.bySource} />
        <Breakdown title="Leads by status" rows={stats.byStatus} />
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
        getRowKey={(l) => String(l.leadNumber)}
        empty={<EmptyState title="No leads match these filters." />}
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

      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={filtered.length}
        onPageChange={setPage}
      />

      <p className="text-muted-foreground text-xs">
        {isDemo ? (
          <>
            Sample data shown so the layout is reviewable without a backend. Real organizations load live leads from{' '}
            <code className="bg-muted rounded px-1">GET /api/reports/leads</code> with the same filters, columns and export.
          </>
        ) : (
          <>Live leads from <code className="bg-muted rounded px-1">GET /api/reports/leads</code> - filters, columns and export apply to your real data.</>
        )}
      </p>

      {fieldsOpen && <FieldsPicker columns={COLUMNS} visible={visible} onSave={saveFields} onClose={() => setFieldsOpen(false)} />}
    </ReportShell>
  );
}

import { useMemo, useState, useEffect, useRef } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Cell,
  Tooltip,
  PieChart,
  Pie,
  LabelList,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  startOfYear, startOfDay, endOfDay, startOfWeek, endOfWeek, subDays, subWeeks, subMonths, parseISO, format,
} from 'date-fns';
import {
  FileText, Send, CheckCircle2, XCircle, TrendingUp, DollarSign, Clock, FlaskConical,
  Info, SlidersHorizontal, ChevronDown,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { severityRamp, token } from '@/design-system/tokens';
import { StatusBadge } from '@/components/data/status-badge';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable, type ResizableColumn } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import {
  AGING_BUCKETS,
  type DateAnchor, type ConversionModel, type ReportFilters, type EstimateStatusKey,
  type RepRow, type DrillSelector, type AgingBucketKey, type Bucket,
} from '@/lib/reports/estimate-conversion-logic';
import { useEstimateConversionReport, useConversionDrilldown, type DrillResult } from '@/lib/reports/estimate-conversion-data';

interface DrillState { selector: DrillSelector; title: string }

// Status → label + brand-semantic color, read from design tokens (no raw hex).
const STATUS_META: { key: EstimateStatusKey; label: string; color: string }[] = [
  { key: 'DRAFT', label: 'Draft', color: token('--text-soft') },
  { key: 'SENT', label: 'Awaiting response', color: token('--info') },
  { key: 'PENDING', label: 'Approved — Deposit Pending', color: token('--warning') },
  { key: 'WON', label: 'Won', color: token('--success') },
  { key: 'DECLINED', label: 'Declined', color: token('--danger') },
  { key: 'EXPIRED', label: 'Expired', color: token('--ai') },
  { key: 'ARCHIVED', label: 'Archived', color: token('--text-soft') },
  { key: 'SUPERSEDED', label: 'Superseded', color: token('--text-soft') },
];

// Won / Open / Lost outcome colors (success = won data signal, info = open, danger = lost).
const OUTCOME_WON = token('--success');
const OUTCOME_OPEN = token('--info');
const OUTCOME_LOST = token('--danger');

// ── Date anchor + range presets ───────────────────────────────────────────────
const ANCHORS: { key: DateAnchor; label: string }[] = [
  { key: 'created', label: 'Created' },
  { key: 'sent', label: 'Sent' },
  { key: 'decided', label: 'Decided' },
];
const ANCHOR_SUBTITLE: Record<DateAnchor, string> = {
  created: 'By created date',
  sent: 'By sent date',
  decided: 'By decided date',
};

type RangeKey = 'last7' | 'lastWeek' | 'last30' | 'last90' | 'r12' | 'ytd' | 'custom';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'last7', label: 'Last 7 days' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'r12', label: 'Last 12 months' },
  { key: 'ytd', label: 'This year' },
  { key: 'custom', label: 'Custom' },
];

function resolveRange(preset: RangeKey, now: Date, customFrom: string, customTo: string): { from: Date; to: Date } {
  if (preset === 'custom') {
    return { from: startOfDay(parseISO(customFrom)), to: endOfDay(parseISO(customTo)) };
  }
  if (preset === 'last7') return { from: subDays(now, 7), to: now };
  if (preset === 'lastWeek') {
    // Previous full calendar week (Mon–Sun).
    const lastWeek = subWeeks(now, 1);
    return { from: startOfWeek(lastWeek, { weekStartsOn: 1 }), to: endOfWeek(lastWeek, { weekStartsOn: 1 }) };
  }
  if (preset === 'last30') return { from: subDays(now, 30), to: now };
  if (preset === 'last90') return { from: subDays(now, 90), to: now };
  if (preset === 'ytd') return { from: startOfYear(now), to: now };
  return { from: subMonths(now, 12), to: now }; // r12
}

// Full comma-grouped currency for chart axes (never abbreviate money with k/M).
const axisCurrency = (v: number) => formatCurrency(v);

// Prior-period comparison strings (PoP). Rendered as text — KpiTile.sub is a string.
function pctDeltaStr(curr: number, prev: number): string {
  if (prev === 0) return curr > 0 ? 'new vs prev' : '— vs prev';
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}% vs prev`;
}
function ppDeltaStr(curr: number, prev: number): string {
  const diff = curr - prev;
  return `${diff > 0 ? '+' : ''}${diff}pp vs prev`;
}
// Append a PoP delta to a base sub-label when both periods are known.
function withDelta(base: string, curr?: number | null, prev?: number | null): string {
  if (curr == null || prev == null) return base;
  return base ? `${base} · ${pctDeltaStr(curr, prev)}` : pctDeltaStr(curr, prev);
}
const moneyOrDash = (v: number | null | undefined) => (v == null ? '—' : formatCurrency(v));

// ── Per-rep breakdown (sortable on every column) ──────────────────────────────
type RepSortKey = keyof Pick<
  RepRow,
  'repName' | 'sentCount' | 'sentValue' | 'wonCount' | 'wonValue' | 'lostValue' | 'openValue' | 'conversionPct' | 'avgTicketWon'
>;
const REP_COLUMNS: {
  key: RepSortKey;
  label: string;
  align: 'left' | 'right';
  width: number;
  min: number;
  fmt: (r: RepRow) => string;
  sort: (r: RepRow) => string | number | null;
}[] = [
  { key: 'repName', label: 'Rep', align: 'left', width: 180, min: 150, fmt: (r) => r.repName, sort: (r) => r.repName },
  { key: 'sentCount', label: 'Sent #', align: 'right', width: 110, min: 95, fmt: (r) => String(r.sentCount), sort: (r) => r.sentCount },
  { key: 'sentValue', label: 'Sent $', align: 'right', width: 130, min: 110, fmt: (r) => formatCurrency(r.sentValue), sort: (r) => r.sentValue },
  { key: 'wonCount', label: 'Won #', align: 'right', width: 110, min: 95, fmt: (r) => String(r.wonCount), sort: (r) => r.wonCount },
  { key: 'wonValue', label: 'Won $', align: 'right', width: 130, min: 110, fmt: (r) => formatCurrency(r.wonValue), sort: (r) => r.wonValue },
  { key: 'lostValue', label: 'Lost $', align: 'right', width: 130, min: 110, fmt: (r) => formatCurrency(r.lostValue), sort: (r) => r.lostValue },
  { key: 'openValue', label: 'Open $', align: 'right', width: 130, min: 110, fmt: (r) => formatCurrency(r.openValue), sort: (r) => r.openValue },
  { key: 'conversionPct', label: 'Conv. %', align: 'right', width: 110, min: 95, fmt: (r) => `${r.conversionPct}%`, sort: (r) => r.conversionPct },
  { key: 'avgTicketWon', label: 'Avg ticket won', align: 'right', width: 150, min: 130, fmt: (r) => (r.avgTicketWon == null ? '—' : formatCurrency(r.avgTicketWon)), sort: (r) => r.avgTicketWon },
];

function RepTable({ rows, onDrillRep }: { rows: RepRow[]; onDrillRep?: (r: RepRow) => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface-light shadow-card">
      <div className="border-b border-border px-6 py-4">
        <Heading level={2}>By rep</Heading>
        <p className="text-xs text-text-secondary">Per-rep conversion for the selected period · click a column to sort</p>
      </div>
      <div className="p-4">
        <ResizableTable
          rows={rows}
          getRowKey={(r) => r.repId ?? '__unassigned__'}
          onRowClick={onDrillRep}
          empty={<EmptyState title="No rep activity in this range." />}
          columns={REP_COLUMNS.map((c) => ({
            id: c.key,
            header: c.label,
            align: c.align,
            width: c.width,
            min: c.min,
            sortValue: c.sort,
            cell: (r: RepRow) => (
              <span
                className={
                  c.align === 'right'
                    ? 'tabular-nums'
                    : c.key === 'repName'
                      ? 'font-medium text-text-primary'
                      : 'text-text-secondary'
                }
              >
                {c.fmt(r)}
              </span>
            ),
          }))}
        />
      </div>
    </div>
  );
}

// ── Single-select filter chips (lead source, job type) ───────────────────────
function FilterChips({
  label, options, value, onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  // raw: segmented toggle control (filter-chip pill), not Button-shaped
  const chip = (key: string, text: string) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(key)}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        value === key ? 'border-primary bg-primary text-on-fill' : 'border-border bg-surface-light text-text-secondary hover:bg-background-light'
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs font-medium text-text-secondary">{label}:</span>
      {chip('all', 'All')}
      {options.map((o) => chip(o, o))}
    </div>
  );
}

// ── Collapsed filter menu — one button that opens the Source / Job type chips ─
function FilterMenu({
  source, jobType, sources, jobTypes, onSource, onJobType,
}: {
  source: string;
  jobType: string;
  sources: string[];
  jobTypes: string[];
  onSource: (v: string) => void;
  onJobType: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const active = [source !== 'all' ? source : null, jobType !== 'all' ? jobType : null].filter(Boolean) as string[];

  return (
    <div className="relative" ref={ref}>
      {/* outline/neutral, size="3xs" - closest text-xs rung; shrinks the trigger's
          footprint from the raw's py-1.5/px-3 (~30px tall) to the 3xs rung's fixed
          h-6/px-2 (24px) - the closest available match, disclosed rather than
          claimed exact. Idle text was explicit text-text-primary; outline/neutral
          sets no idle colour, so this relies on the inherited near-black default,
          which reads visually identical to the token (unlike the muted
          text-secondary case, this is not the risky trap). One more disclosed
          delta: the base font-semibold replaces the raw's font-medium. */}
      <Button
        type="button"
        variant="outline"
        tone="neutral"
        size="3xs"
        onClick={() => setOpen((o) => !o)}
        className="gap-1.5"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-text-secondary" />
        Filters
        {active.length > 0 && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-on-fill">{active.length}</span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
      </Button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-72 space-y-3 rounded-xl border border-border bg-surface-light p-3 shadow-lg">
          {sources.length > 0 && <FilterChips label="Source" options={sources} value={source} onChange={onSource} />}
          {jobTypes.length > 0 && <FilterChips label="Job type" options={jobTypes} value={jobType} onChange={onJobType} />}
          {active.length > 0 && (
            // link/brand, size={null} - keeps this an inline link, not a 40px
            // control; Button's base text-sm font-semibold replaces the raw's
            // text-xs and font-medium (SOFT ratchet has no slack to restore it -
            // disclosed, not fought, matching the NewPODialog.tsx link/brand
            // precedent). hover:underline + text-primary are an exact match.
            <Button variant="link" tone="brand" size={null} type="button" onClick={() => { onSource('all'); onJobType('all'); }}>
              Clear filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Open-quote aging ──────────────────────────────────────────────────────────
// Days-since-sent worsens left→right → green→terracotta severity ramp.
const rampStop = (i: number) => severityRamp[i] ?? severityRamp[severityRamp.length - 1] ?? token('--danger');
const AGING_COLOR: Record<AgingBucketKey, string> = {
  '0-7': rampStop(0),
  '8-14': rampStop(2),
  '15-30': rampStop(3),
  '30+': rampStop(5),
};

function AgingSection({
  aging, onDrill,
}: {
  aging: Record<AgingBucketKey, Bucket>;
  onDrill: (bucket: AgingBucketKey, label: string) => void;
}) {
  const totalCount = AGING_BUCKETS.reduce((s, b) => s + aging[b.key].count, 0);
  const totalValue = AGING_BUCKETS.reduce((s, b) => s + aging[b.key].value, 0);
  return (
    <div className="rounded-xl border border-border bg-surface-light p-6 shadow-card">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <Heading level={2}>Open quotes aging</Heading>
          <p className="text-xs text-text-secondary">Open quotes by days since sent — click a bucket to follow up</p>
        </div>
        <span className="text-xs text-text-secondary tabular-nums">
          {totalCount} open · {formatCurrency(totalValue)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {AGING_BUCKETS.map((b) => {
          const cell = aging[b.key];
          const color = AGING_COLOR[b.key];
          return (
            // raw: grid-tile click target with heterogeneous content (dot + label
            // + count + value), not Button-shaped
            <button
              key={b.key}
              type="button"
              onClick={() => onDrill(b.key, `Open quotes · ${b.label}`)}
              className="rounded-xl border border-border p-4 text-left transition-colors hover:bg-background-light focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">{b.label}</span>
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-text-primary">{cell.count}</p>
              <p className="text-xs text-text-secondary tabular-nums">{formatCurrency(cell.value)}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const fmtDate = (iso: string | null) => (iso ? format(parseISO(iso), 'MMM d, yyyy') : '—');

// ── Shared estimate list (used by the bottom table AND the drill-down panel) ──
function DrillTable({
  rows, isDemo, showFollowUp = false, limit,
}: {
  rows: DrillResult['rows'];
  isDemo: boolean;
  showFollowUp?: boolean;
  limit?: number;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  type DrillRow = DrillResult['rows'][number];
  const columns: ResizableColumn<DrillRow>[] = [
    {
      id: 'estimate',
      header: 'Estimate',
      width: 130,
      min: 110,
      sortValue: (r) => r.number,
      cell: (r) =>
        isDemo ? (
          <span className="font-medium text-text-primary" title="Sample data — no detail page">{r.number}</span>
        ) : (
          <Link to={`/estimates/${r.id}`} className="font-medium text-primary hover:underline">{r.number}</Link>
        ),
    },
    { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (r) => r.customerName, cell: (r) => <span className="text-text-secondary">{r.customerName}</span> },
    { id: 'rep', header: 'Rep', width: 160, min: 130, sortValue: (r) => r.repName, cell: (r) => <span className="text-text-secondary">{r.repName}</span> },
    { id: 'sent', header: 'Sent', width: 150, min: 130, sortValue: (r) => (r.sentAt ? new Date(r.sentAt).getTime() : null), cell: (r) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(r.sentAt)}</span> },
    { id: 'decided', header: 'Decided', width: 150, min: 130, sortValue: (r) => (r.decidedAt ? new Date(r.decidedAt).getTime() : null), cell: (r) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(r.decidedAt)}</span> },
    { id: 'daysOpen', header: 'Days open', align: 'right', width: 110, min: 95, sortValue: (r) => r.daysOpen, cell: (r) => <span className="tabular-nums text-text-secondary">{r.daysOpen ?? '—'}</span> },
    { id: 'status', header: 'Status', width: 150, min: 130, sortValue: (r) => r.status, cell: (r) => <StatusBadge domain="estimate" status={r.status} /> },
    { id: 'total', header: 'Total', align: 'right', width: 120, min: 105, sortValue: (r) => r.amount, cell: (r) => <span className="tabular-nums text-text-primary">{formatCurrency(r.amount)}</span> },
    ...(showFollowUp
      ? ([
          { id: 'lastActivity', header: 'Last activity', width: 150, min: 130, sortValue: (r: DrillRow) => (r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : null), cell: (r: DrillRow) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(r.lastActivityAt)}</span> },
          {
            id: 'followUp',
            header: '',
            width: 110,
            min: 95,
            grow: 0,
            cell: (r: DrillRow) =>
              isDemo ? (
                <span className="cursor-not-allowed text-xs text-text-secondary opacity-50" title="Sample data">Follow up</span>
              ) : (
                <Link to={`/estimates/${r.id}`} className="text-xs font-medium text-primary hover:underline">Follow up</Link>
              ),
          },
        ] as ResizableColumn<DrillRow>[])
      : []),
  ];

  return (
    <ResizableTable
      rows={shown}
      getRowKey={(r) => r.id}
      empty={<EmptyState title="No estimates match." />}
      flat
      columns={columns}
    />
  );
}

function DrillPanel({
  state, onClose, result, loading, isDemo,
}: {
  state: DrillState | null;
  onClose: () => void;
  result: DrillResult | undefined;
  loading: boolean;
  isDemo: boolean;
}) {
  const showFollowUp = !!state?.selector.agingBucket;
  return (
    <Sheet open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader className="text-left">
          <SheetTitle>{state?.title ?? 'Estimates'}</SheetTitle>
          <p className="text-xs text-text-secondary">
            {loading ? 'Loading…' : `${result?.total ?? 0} estimate${(result?.total ?? 0) === 1 ? '' : 's'}`}
            {result?.truncated && ` · showing first ${result.rows.length}`}
          </p>
        </SheetHeader>
        <div className="mt-4">
          {state && <DrillTable rows={result?.rows ?? []} isDemo={isDemo} showFollowUp={showFollowUp} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function EstimateConversionReport() {
  const report = findReport('estimate-conversion')!;
  const isDemoOrg = useIsDemoOrg();
  // Demo orgs default to sample data (full vision for sales); real orgs default
  // to live numbers and never see the sample-data escape hatch. `?demo=0|1`
  // still overrides for either (handy when demoing live data on a demo org).
  const [isDemo, setIsDemo] = useState(() => {
    const param = new URLSearchParams(window.location.search).get('demo');
    if (param === '0') return false;
    if (param === '1') return true;
    return isDemoOrg;
  });

  // Stable "now" so derived ranges don't churn the query every render.
  const now = useMemo(() => new Date(), []);
  const [anchor, setAnchor] = useState<DateAnchor>('sent');
  const [preset, setPreset] = useState<RangeKey>('r12');
  const [customFrom, setCustomFrom] = useState(() => format(subMonths(now, 1), 'yyyy-MM-dd'));
  const [customTo, setCustomTo] = useState(() => format(now, 'yyyy-MM-dd'));
  const [rep, setRep] = useState('all');
  const [source, setSource] = useState('all');
  const [jobType, setJobType] = useState('all');
  const [model, setModel] = useState<ConversionModel>('sent');

  const { from, to } = useMemo(
    () => resolveRange(preset, now, customFrom, customTo),
    [preset, now, customFrom, customTo],
  );

  const filters: ReportFilters = useMemo(
    () => ({ anchor, from, to, repId: rep, source, jobType, model }),
    [anchor, from, to, rep, source, jobType, model],
  );

  const { data, isLoading } = useEstimateConversionReport(filters, isDemo);
  const { data: tableData } = useConversionDrilldown(filters, {}, isDemo);

  const [drill, setDrill] = useState<DrillState | null>(null);
  const { data: drillData, isLoading: drillLoading } = useConversionDrilldown(
    filters, drill?.selector ?? null, isDemo,
  );
  const openDrill = (selector: DrillSelector, title: string) => setDrill({ selector, title });

  const s = data?.summary;
  const pr = data?.prior;
  const ctx = data?.context;
  const prc = data?.priorContext;
  const formulaLabel = model === 'decided' ? 'Won / (Won + Lost)' : 'Won / (Won + Lost + Open)';
  const conv = s?.conversion;
  const conversionHelp =
    `Conversion = ${formulaLabel} (Won = Approved, Lost = Declined, Open = Sent + Pending). ` +
    `Cancelled and expired estimates are excluded from the denominator.`;

  const breakdown = useMemo(
    () =>
      STATUS_META.map((m) => ({ key: m.key, name: m.label, count: s?.buckets[m.key].count ?? 0, color: m.color }))
        .filter((d) => d.count > 0),
    [s],
  );

  const winLoss = useMemo(
    () =>
      [
        { name: 'Won', value: s?.won.count ?? 0, color: OUTCOME_WON },
        { name: 'Open', value: s?.open.count ?? 0, color: OUTCOME_OPEN },
        { name: 'Lost', value: s?.lost.count ?? 0, color: OUTCOME_LOST },
      ].filter((d) => d.value > 0),
    [s],
  );

  const monthly = useMemo(
    () =>
      (data?.byMonth ?? []).map((m) => ({
        month: m.label,
        key: m.month,
        sent: Math.round(m.sentValue),
        won: Math.round(m.wonValue),
        // Partial current month is excluded from the trend line so it doesn't cliff-dive.
        rate: m.partial ? null : m.conversionPct,
        partial: m.partial,
      })),
    [data],
  );

  const tableRows = tableData?.rows ?? [];
  const hasData = (s?.totalCount ?? 0) > 0;

  const rangeSubtitle = `${ANCHOR_SUBTITLE[anchor]} · ${format(from, 'MMM d, yyyy')} – ${format(to, 'MMM d, yyyy')}${isDemo ? ' · sample data' : ''}`;

  return (
    <ReportShell
      report={report}
      subtitle={rangeSubtitle}
      actions={
        // Sample-data toggle is a demo-org affordance only — real orgs always
        // show live numbers and never get a path to fabricated data.
        isDemoOrg ? (
          // raw: two-state toggle whose "on" state uses a warning tone and "off"
          // state uses a neutral outline - no minted cell reproduces a
          // conditionally-retoned outline (outline only has neutral/danger), same
          // shape as the deferred ScopeOfWorkCard.tsx Taxable pill precedent
          <button
            type="button"
            onClick={() => setIsDemo((d) => !d)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              isDemo
                ? 'border-warning-border bg-warning-surface text-warning-text hover:bg-warning-border/30'
                : 'border-border bg-surface-light text-text-secondary hover:bg-background-light'
            }`}
          >
            <FlaskConical className="h-4 w-4" />
            {isDemo ? 'Sample data: on' : 'Sample data'}
          </button>
        ) : undefined
      }
    >
      {isDemo && (
        <div className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-xs font-medium text-warning-text">
          <FlaskConical className="h-3.5 w-3.5" />
          Showing representative sample data — not your real estimates. Toggle off to see live numbers.
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Date anchor */}
        <div className="inline-flex items-center gap-1.5">
          <span className="text-xs text-text-secondary">Date anchor:</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-border">
            {/* raw: segmented toggle control, not Button-shaped */}
            {ANCHORS.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setAnchor(a.key)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  anchor === a.key ? 'bg-primary text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* Range preset */}
        <SelectField
          aria-label="Range preset"
          value={preset}
          onValueChange={(v) => setPreset(v as RangeKey)}
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
        />

        {/* Custom range pickers */}
        {preset === 'custom' && (
          <div className="inline-flex items-center gap-1.5">
            <DatePicker value={customFrom} max={customTo} onChange={setCustomFrom} inputClassName="text-sm" />
            <span className="text-xs text-text-secondary">to</span>
            <DatePicker value={customTo} min={customFrom} onChange={setCustomTo} inputClassName="text-sm" />
          </div>
        )}

        {/* Rep filter */}
        <SelectField
          aria-label="Rep"
          value={rep}
          onValueChange={setRep}
          options={[
            { value: 'all', label: 'All reps' },
            ...(data?.options.reps ?? []).map((r) => ({ value: r.id, label: r.name })),
          ]}
        />

        {/* Conversion-formula toggle */}
        <div className="ml-auto inline-flex items-center gap-2">
          <span className="text-xs text-text-secondary">Conversion:</span>
          <div className="inline-flex overflow-hidden rounded-lg border border-border">
            {([
              { key: 'decided' as ConversionModel, label: 'Won / Decided' },
              { key: 'sent' as ConversionModel, label: 'Won / Sent' },
            ]).map((f) => (
              // raw: segmented toggle control, not Button-shaped
              <button
                key={f.key}
                type="button"
                onClick={() => setModel(f.key)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  model === f.key ? 'bg-primary text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Source / job-type — collapsed into one filter menu */}
      {((data?.options.sources.length ?? 0) > 0 || (data?.options.jobTypes.length ?? 0) > 0) && (
        <FilterMenu
          source={source}
          jobType={jobType}
          sources={data?.options.sources ?? []}
          jobTypes={data?.options.jobTypes ?? []}
          onSource={setSource}
          onJobType={setJobType}
        />
      )}

      <KpiStrip
        loading={isLoading || !data}
        maxColumns={4}
        items={[
          { icon: FileText, label: 'Total Quotes', value: s?.totalCount ?? 0, sub: withDelta('', s?.totalCount, pr?.totalCount), tone: 'neutral', onClick: () => openDrill({}, 'All estimates') },
          { icon: Send, label: 'Total sent', value: s?.sentEverCount ?? 0, sub: withDelta(formatCurrency(s?.sentEverValue ?? 0), s?.sentEverCount, pr?.sentEverCount), tone: 'primary', onClick: () => openDrill({}, 'Sent estimates') },
          { icon: Clock, label: 'Open', value: s?.open.count ?? 0, sub: withDelta(formatCurrency(s?.open.value ?? 0), s?.open.count, pr?.open.count), tone: 'warning', onClick: () => openDrill({ outcome: 'open' }, 'Open quotes') },
          { icon: CheckCircle2, label: 'Won', value: s?.won.count ?? 0, sub: withDelta(formatCurrency(s?.won.value ?? 0), s?.won.count, pr?.won.count), tone: 'success', onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
          { icon: XCircle, label: 'Lost', value: s?.lost.count ?? 0, sub: withDelta(formatCurrency(s?.lost.value ?? 0), s?.lost.count, pr?.lost.count), tone: 'danger', onClick: () => openDrill({ outcome: 'lost' }, 'Lost estimates') },
          { icon: TrendingUp, label: 'Conversion', value: `${conv?.rate ?? 0}%`, sub: conv && pr ? `${conv.num}/${conv.denom} · ${ppDeltaStr(conv.rate, pr.conversion.rate)}` : `${conv?.num ?? 0}/${conv?.denom ?? 0} · ${formulaLabel}`, tone: 'success', emphasize: true, onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
          { icon: DollarSign, label: 'Quoted Value', value: formatCurrencyWhole(s?.totalValue ?? 0), sub: withDelta('', s?.totalValue, pr?.totalValue), tone: 'neutral', onClick: () => openDrill({}, 'All estimates') },
          { icon: DollarSign, label: 'Won Value', value: formatCurrencyWhole(s?.won.value ?? 0), sub: withDelta('', s?.won.value, pr?.won.value), tone: 'success', onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
        ]}
      />

      {/* Context metrics */}
      <KpiStrip
        loading={isLoading || !data}
        items={[
          { icon: DollarSign, label: 'Avg ticket (won)', value: moneyOrDash(ctx?.avgTicketWon), sub: withDelta('', ctx?.avgTicketWon, prc?.avgTicketWon), tone: 'success' },
          { icon: DollarSign, label: 'Avg ticket (lost)', value: moneyOrDash(ctx?.avgTicketLost), sub: withDelta('', ctx?.avgTicketLost, prc?.avgTicketLost), tone: 'danger' },
          { icon: Clock, label: 'Median days to decision', value: ctx?.medianDaysToDecision == null ? '—' : `${ctx.medianDaysToDecision}d`, sub: withDelta('', ctx?.medianDaysToDecision, prc?.medianDaysToDecision), tone: 'neutral' },
          { icon: Clock, label: 'Median hrs request→sent', value: ctx?.medianHoursRequestToSent == null ? '—' : `${ctx.medianHoursRequestToSent}h`, sub: withDelta('', ctx?.medianHoursRequestToSent, prc?.medianHoursRequestToSent), tone: 'neutral' },
        ]}
      />

      {hasData && (
        <RepTable
          rows={data?.byRep ?? []}
          onDrillRep={(r) => openDrill({ repId: r.repId ?? '__unassigned__' }, `${r.repName} · estimates`)}
        />
      )}

      {!hasData && !isLoading ? (
        <EmptyState
          variant="card"
          title="No estimates in this range"
          description="Adjust the date anchor or range above, or create estimates to see conversion metrics."
        />
      ) : (
        <>
          {/* Monthly trend (full width) */}
          <ChartCard
            title="Sent vs Won by month"
            subtitle="Quoted $ vs won $ (left axis) and conversion % (right axis). The current partial month is hatched and excluded from the conversion line."
          >
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={monthly} margin={{ left: 12, right: 12, bottom: 4 }}>
                <defs>
                  <pattern id="hatchSent" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                    <rect width="6" height="6" fill={token('--border-color')} fillOpacity={0.4} />
                    <line x1="0" y1="0" x2="0" y2="6" stroke={token('--text-soft')} strokeWidth={2} />
                  </pattern>
                  <pattern id="hatchWon" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                    <rect width="6" height="6" fill={OUTCOME_WON} fillOpacity={0.35} />
                    <line x1="0" y1="0" x2="0" y2="6" stroke={OUTCOME_WON} strokeWidth={2} />
                  </pattern>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={token('--border-color')} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                <YAxis
                  yAxisId="left"
                  tickFormatter={axisCurrency}
                  width={96}
                  tick={{ fontSize: 11, fill: token('--text-secondary') }}
                  label={{ value: 'Quoted / Won ($)', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: token('--text-soft') } }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  unit="%"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: token('--text-secondary') }}
                  label={{ value: 'Conversion (%)', angle: 90, position: 'insideRight', style: { fontSize: 11, fill: token('--text-soft') } }}
                />
                <Tooltip
                  formatter={(val: number, name: string) =>
                    name === 'Conversion %' ? `${val}%` : formatCurrency(val)
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="left" dataKey="sent" name="Quoted $" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(d: any) => { const r = d?.payload ?? d; if (r?.key) openDrill({ month: r.key }, `${r.month} · estimates`); }}>
                  {monthly.map((m) => (
                    <Cell key={`s-${m.key}`} fill={m.partial ? 'url(#hatchSent)' : token('--border-color')} />
                  ))}
                </Bar>
                <Bar yAxisId="left" dataKey="won" name="Won $" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(d: any) => { const r = d?.payload ?? d; if (r?.key) openDrill({ month: r.key, outcome: 'won' }, `${r.month} · won`); }}>
                  {monthly.map((m) => (
                    <Cell key={`w-${m.key}`} fill={m.partial ? 'url(#hatchWon)' : OUTCOME_WON} />
                  ))}
                </Bar>
                <Line yAxisId="right" type="monotone" dataKey="rate" name="Conversion %" stroke={token('--primary')} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Status breakdown */}
            <ChartCard
              title="Estimates by status"
              subtitle="Count of estimates in each stage"
              className="lg:col-span-2"
            >
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={breakdown} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                  <YAxis type="category" dataKey="name" width={116} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                  <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} cursor="pointer"
                    onClick={(d: any) => { const r = d?.payload ?? d; if (r?.key) openDrill({ status: r.key }, `${r.name} estimates`); }}>
                    <LabelList dataKey="count" position="right" style={chartLabelStyle} />
                    {breakdown.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Outcome donut */}
            <ChartCard
              title={
                <span className="flex items-center gap-1.5">
                  Conversion
                  <span title={conversionHelp} className="cursor-help text-text-secondary">
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </span>
              }
              subtitle={`${formulaLabel} · cancelled excluded`}
            >
              <div className="relative">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={winLoss.length ? winLoss : [{ name: 'No data', value: 1, color: token('--border-color') }]}
                      dataKey="value"
                      innerRadius={62}
                      outerRadius={90}
                      paddingAngle={2}
                      stroke="none"
                      cursor={winLoss.length ? 'pointer' : undefined}
                      onClick={(d: any) => {
                        const name = (d?.payload ?? d)?.name as string | undefined;
                        const outcome = name === 'Won' ? 'won' : name === 'Lost' ? 'lost' : name === 'Open' ? 'open' : undefined;
                        if (outcome) openDrill({ outcome }, `${name} estimates`);
                      }}
                    >
                      {(winLoss.length ? winLoss : [{ name: 'No data', value: 1, color: token('--border-color') }]).map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    {winLoss.length > 0 && <Tooltip />}
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-semibold text-text-primary">{conv?.rate ?? 0}%</span>
                  <span className="text-xs text-text-secondary">conversion</span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap justify-center gap-3 text-xs">
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: OUTCOME_WON }} /> Won {s?.won.count ?? 0}
                </span>
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: OUTCOME_OPEN }} /> Open {s?.open.count ?? 0}
                </span>
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: OUTCOME_LOST }} /> Lost {s?.lost.count ?? 0}
                </span>
              </div>
            </ChartCard>
          </div>

          {/* Open-quote aging */}
          {data?.aging && (
            <AgingSection
              aging={data.aging}
              onDrill={(bucket, label) => openDrill({ outcome: 'open', agingBucket: bucket }, label)}
            />
          )}

          {/* Estimates table */}
          <div className="rounded-xl border border-border bg-surface-light shadow-card">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <Heading level={2}>Estimates</Heading>
                <p className="text-xs text-text-secondary">
                  Showing {Math.min(tableRows.length, 15)} of {tableData?.total ?? tableRows.length}
                </p>
              </div>
            </div>
            <DrillTable rows={tableRows} isDemo={isDemo} limit={15} />
          </div>
        </>
      )}

      <DrillPanel
        state={drill}
        onClose={() => setDrill(null)}
        result={drillData}
        loading={drillLoading}
        isDemo={isDemo}
      />
    </ReportShell>
  );
}

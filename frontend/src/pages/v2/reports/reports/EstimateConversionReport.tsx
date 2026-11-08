import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  endOfDay, endOfWeek, format, parseISO, startOfDay, startOfWeek, startOfYear,
  subDays, subMonths, subWeeks,
} from 'date-fns';
import {
  CheckCircle2, ChevronDown, Clock, DollarSign, FileText, FlaskConical, Info,
  Send, SlidersHorizontal, TrendingUp, XCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { severityRamp, token } from '@/design-system/tokens';
import { StatusBadge } from '@/components/data/status-badge';
import { findReport } from '@/lib/reports/report-catalog';
import {
  AGING_BUCKETS,
  type AgingBucketKey, type Bucket, type ConversionModel, type DateAnchor,
  type DrillSelector, type EstimateStatusKey, type ReportFilters, type RepRow,
} from '@/lib/reports/estimate-conversion-logic';
import {
  useConversionDrilldown, useEstimateConversionReport, type DrillResult,
} from '@/lib/reports/estimate-conversion-data';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, type ReportColumn } from '../components/reportTable';
import { DatePicker } from '../../_shared/datePicker';
import { preferV2Path } from '../../uiV2';

/**
 * S1 - Estimate / Quote Conversion.
 *
 * EVERY NUMBER COMES FROM `estimate-conversion-data` AND `-logic`, imported:
 * `useEstimateConversionReport` for the summary, the prior period, the context
 * metrics, the monthly series, the per-rep rows and the aging buckets, and
 * `useConversionDrilldown` for both the bottom table and the drill panel. The
 * `AGING_BUCKETS` order and every type come from the logic module. Nothing is
 * recomputed here.
 *
 * FOUR BEHAVIOURS ARE LOAD-BEARING and are carried over exactly:
 *   1. `?demo=0|1` overrides the org's own demo flag in BOTH directions, and
 *      the sample-data toggle only renders for a demo org - a real org can
 *      never reach fabricated numbers through the UI.
 *   2. The conversion FORMULA is a user choice: 'decided' is Won/(Won+Lost),
 *      'sent' is Won/(Won+Lost+Open). `formulaLabel` and the help text are
 *      derived from it, so the tooltip can never describe the other model.
 *   3. The CURRENT PARTIAL MONTH is excluded from the conversion line
 *      (`rate: null` + `connectNulls={false}`) and hatched in both bar series,
 *      so a half-finished month cannot look like a cliff.
 *   4. Every KPI, bar, donut slice and aging tile OPENS A DRILL with its own
 *      selector; the panel then re-queries through the same hook.
 *
 * CHARTS ARE UNTOUCHED. `STATUS_META` still carries a token per status,
 * `OUTCOME_WON/OPEN/LOST` are still success/info/danger, the aging ramp is
 * still `severityRamp` (it worsens left to right, which is the entire reading),
 * and both `<pattern>` hatch defs are byte-identical. The donut's centre label
 * and its three legend swatches read the same three constants as the slices.
 *
 * Shape differences: the two segmented toggles and the filter chips are kit
 * Buttons, the collapsed filter menu is a kit `Popover`, and the drill panel is
 * the kit's `Sheet`.
 */

interface DrillState { selector: DrillSelector; title: string }

// Chart datum shapes. Each is the element type of the memo that feeds one chart,
// and the same shape Recharts hands back to that chart's onClick.
interface MonthlyPoint {
  month: string;
  key: string;
  sent: number;
  won: number;
  rate: number | null;
  partial: boolean;
}
interface StatusSlice { key: EstimateStatusKey; name: string; count: number; color: string }
interface OutcomeSlice { name: string; value: number; color: string }

/**
 * What a Recharts click handler actually receives. Depending on the chart
 * element it is either the datum itself or a wrapper carrying it as `payload`,
 * and neither is guaranteed to be complete - hence `Partial`. Every call site
 * below reads it as `d.payload ?? d` and guards the field it needs.
 */
type ChartClickTarget<T> = Partial<T> & { payload?: T };

// Status -> label + brand-semantic color, read from design tokens (no raw hex).
const STATUS_META: { key: EstimateStatusKey; label: string; color: string }[] = [
  { key: 'DRAFT', label: 'Draft', color: token('--text-soft') },
  { key: 'SENT', label: 'Awaiting response', color: token('--info') },
  { key: 'PENDING', label: 'Approved - Deposit Pending', color: token('--warning') },
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
    // Previous full calendar week (Mon-Sun).
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

const moneyOrDash = (v: number | null | undefined) => (v == null ? '-' : formatCurrency(v));

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
  { key: 'avgTicketWon', label: 'Avg ticket won', align: 'right', width: 150, min: 130, fmt: (r) => (r.avgTicketWon == null ? '-' : formatCurrency(r.avgTicketWon)), sort: (r) => r.avgTicketWon },
];

function RepTable({ rows, onDrillRep }: { rows: RepRow[]; onDrillRep?: (r: RepRow) => void }) {
  return (
    <div className="space-y-2">
      <div>
        <ReportHeading level={2} scale="lg">By rep</ReportHeading>
        <p className="text-muted-foreground text-xs">
          Per-rep conversion for the selected period · click a column to sort
        </p>
      </div>
      <ReportTable
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
                    ? 'font-medium'
                    : 'text-muted-foreground'
              }
            >
              {c.fmt(r)}
            </span>
          ),
        }))}
      />
    </div>
  );
}

function FilterChips({
  label, options, value, onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  const chip = (key: string, text: string) => (
    <Button
      key={key}
      type="button"
      role="radio"
      aria-checked={value === key}
      variant={value === key ? 'default' : 'outline'}
      size="sm"
      onClick={() => onChange(key)}
    >
      {text}
    </Button>
  );
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground mr-0.5 text-xs font-medium">{label}:</span>
      {chip('all', 'All')}
      {options.map((o) => chip(o, o))}
    </div>
  );
}

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
  const active = [source !== 'all' ? source : null, jobType !== 'all' ? jobType : null].filter(Boolean) as string[];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <SlidersHorizontal />
          Filters
          {active.length > 0 && <Badge variant="blue" size="sm">{active.length}</Badge>}
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        {sources.length > 0 && <FilterChips label="Source" options={sources} value={source} onChange={onSource} />}
        {jobTypes.length > 0 && <FilterChips label="Job type" options={jobTypes} value={jobType} onChange={onJobType} />}
        {active.length > 0 && (
          <Button variant="link" size="sm" type="button" onClick={() => { onSource('all'); onJobType('all'); }}>
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Days-since-sent worsens left to right -> green to terracotta severity ramp.
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
    <Card>
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <ReportHeading level={2} scale="lg">Open quotes aging</ReportHeading>
          <p className="text-muted-foreground text-xs">
            Open quotes by days since sent - click a bucket to follow up
          </p>
        </div>
        <span className="text-muted-foreground text-xs tabular-nums">
          {totalCount} open · {formatCurrency(totalValue)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {AGING_BUCKETS.map((b) => {
          const cell = aging[b.key];
          // The ramp stop IS the severity reading, so it stays an inline fill.
          const color = AGING_COLOR[b.key];
          return (
            <Button
              key={b.key}
              type="button"
              variant="outline"
              size={null}
              onClick={() => onDrill(b.key, `Open quotes · ${b.label}`)}
              className="h-auto flex-col items-start gap-0 p-4 text-left font-normal"
            >
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: color }} />
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{b.label}</span>
              </span>
              <span className="mt-2 text-2xl font-bold tabular-nums">{cell.count}</span>
              <span className="text-muted-foreground text-xs tabular-nums">{formatCurrency(cell.value)}</span>
            </Button>
          );
        })}
      </div>
    </Card>
  );
}

const fmtDate = (iso: string | null) => (iso ? format(parseISO(iso), 'MMM d, yyyy') : '-');

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
  const columns: ReportColumn<DrillRow>[] = [
    {
      id: 'estimate', header: 'Estimate', width: 130, min: 110, sortValue: (r) => r.number,
      cell: (r) =>
        isDemo ? (
          <span className="font-medium" title="Sample data - no detail page">{r.number}</span>
        ) : (
          <Link to={preferV2Path(`/estimates/${r.id}`)} className="text-brand font-medium hover:underline">{r.number}</Link>
        ),
    },
    { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (r) => r.customerName, cell: (r) => <span className="text-muted-foreground">{r.customerName}</span> },
    { id: 'rep', header: 'Rep', width: 160, min: 130, sortValue: (r) => r.repName, cell: (r) => <span className="text-muted-foreground">{r.repName}</span> },
    { id: 'sent', header: 'Sent', width: 150, min: 130, sortValue: (r) => (r.sentAt ? new Date(r.sentAt).getTime() : null), cell: (r) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(r.sentAt)}</span> },
    { id: 'decided', header: 'Decided', width: 150, min: 130, sortValue: (r) => (r.decidedAt ? new Date(r.decidedAt).getTime() : null), cell: (r) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(r.decidedAt)}</span> },
    { id: 'daysOpen', header: 'Days open', align: 'right', width: 110, min: 95, sortValue: (r) => r.daysOpen, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.daysOpen ?? '-'}</span> },
    { id: 'status', header: 'Status', width: 150, min: 130, sortValue: (r) => r.status, cell: (r) => <StatusBadge domain="estimate" status={r.status} /> },
    { id: 'total', header: 'Total', align: 'right', width: 120, min: 105, sortValue: (r) => r.amount, cell: (r) => <span className="tabular-nums">{formatCurrency(r.amount)}</span> },
    ...(showFollowUp
      ? ([
          { id: 'lastActivity', header: 'Last activity', width: 150, min: 130, sortValue: (r: DrillRow) => (r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : null), cell: (r: DrillRow) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(r.lastActivityAt)}</span> },
          {
            id: 'followUp', header: '', width: 110, min: 95, grow: 0,
            cell: (r: DrillRow) =>
              isDemo ? (
                <span className="text-muted-foreground cursor-not-allowed text-xs opacity-50" title="Sample data">Follow up</span>
              ) : (
                <Link to={preferV2Path(`/estimates/${r.id}`)} className="text-brand text-xs font-medium hover:underline">Follow up</Link>
              ),
          },
        ] as ReportColumn<DrillRow>[])
      : []),
  ];

  return (
    <ReportTable
      rows={shown}
      getRowKey={(r) => r.id}
      empty={<EmptyState title="No estimates match." />}
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
      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{state?.title ?? 'Estimates'}</SheetTitle>
          <SheetDescription>
            {loading ? 'Loading...' : `${result?.total ?? 0} estimate${(result?.total ?? 0) === 1 ? '' : 's'}`}
            {result?.truncated && ` · showing first ${result.rows.length}`}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {state && <DrillTable rows={result?.rows ?? []} isDemo={isDemo} showFollowUp={showFollowUp} />}
        </SheetBody>
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

  const breakdown = useMemo<StatusSlice[]>(
    () =>
      STATUS_META.map((m) => ({ key: m.key, name: m.label, count: s?.buckets[m.key].count ?? 0, color: m.color }))
        .filter((d) => d.count > 0),
    [s],
  );

  const winLoss = useMemo<OutcomeSlice[]>(
    () =>
      [
        { name: 'Won', value: s?.won.count ?? 0, color: OUTCOME_WON },
        { name: 'Open', value: s?.open.count ?? 0, color: OUTCOME_OPEN },
        { name: 'Lost', value: s?.lost.count ?? 0, color: OUTCOME_LOST },
      ].filter((d) => d.value > 0),
    [s],
  );

  const monthly = useMemo<MonthlyPoint[]>(
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

  const rangeSubtitle = `${ANCHOR_SUBTITLE[anchor]} · ${format(from, 'MMM d, yyyy')} - ${format(to, 'MMM d, yyyy')}${isDemo ? ' · sample data' : ''}`;

  return (
    <ReportShell
      report={report}
      subtitle={rangeSubtitle}
      actions={
        // Sample-data toggle is a demo-org affordance only - real orgs always
        // show live numbers and never get a path to fabricated data.
        isDemoOrg ? (
          <Button
            type="button"
            aria-pressed={isDemo}
            variant={isDemo ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setIsDemo((d) => !d)}
          >
            <FlaskConical />
            {isDemo ? 'Sample data: on' : 'Sample data'}
          </Button>
        ) : undefined
      }
    >
      {isDemo && (
        <div className="bg-status-amber-subtle text-status-amber-emphasis flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium">
          <FlaskConical className="size-3.5" />
          Showing representative sample data - not your real estimates. Toggle off to see live numbers.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Date anchor:</span>
          <div role="radiogroup" aria-label="Date anchor" className="flex items-center gap-1">
            {ANCHORS.map((a) => (
              <Button
                key={a.key}
                type="button"
                role="radio"
                aria-checked={anchor === a.key}
                variant={anchor === a.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAnchor(a.key)}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </div>

        <SelectField
          value={preset}
          onValueChange={(v) => setPreset(v as RangeKey)}
          aria-label="Range preset"
          size="sm"
          className="w-[170px]"
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
        />

        {preset === 'custom' && (
          <div className="inline-flex items-center gap-1.5">
            <DatePicker aria-label="From" className="w-[10.5rem]" inputClassName="h-9" value={customFrom} max={customTo} onChange={setCustomFrom} />
            <span className="text-muted-foreground text-xs">to</span>
            <DatePicker aria-label="To" className="w-[10.5rem]" inputClassName="h-9" value={customTo} min={customFrom} onChange={setCustomTo} />
          </div>
        )}

        <SelectField
          value={rep}
          onValueChange={setRep}
          aria-label="Rep"
          size="sm"
          className="w-[180px]"
          options={[
            { value: 'all', label: 'All reps' },
            ...(data?.options.reps ?? []).map((r) => ({ value: r.id, label: r.name })),
          ]}
        />

        <div className="ml-auto inline-flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Conversion:</span>
          <div role="radiogroup" aria-label="Conversion formula" className="flex items-center gap-1">
            {([
              { key: 'decided' as ConversionModel, label: 'Won / Decided' },
              { key: 'sent' as ConversionModel, label: 'Won / Sent' },
            ]).map((f) => (
              <Button
                key={f.key}
                type="button"
                role="radio"
                aria-checked={model === f.key}
                variant={model === f.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setModel(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

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

      <ReportKpis
        loading={isLoading || !data}
        maxColumns={4}
        items={[
          { icon: FileText, label: 'Total Quotes', value: s?.totalCount ?? 0, tone: 'neutral', onClick: () => openDrill({}, 'All estimates') },
          { icon: Send, label: 'Total sent', value: s?.sentEverCount ?? 0, tone: 'primary', onClick: () => openDrill({}, 'Sent estimates') },
          { icon: Clock, label: 'Open', value: s?.open.count ?? 0, tone: 'warning', onClick: () => openDrill({ outcome: 'open' }, 'Open quotes') },
          { icon: CheckCircle2, label: 'Won', value: s?.won.count ?? 0, tone: 'success', onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
          { icon: XCircle, label: 'Lost', value: s?.lost.count ?? 0, tone: 'danger', onClick: () => openDrill({ outcome: 'lost' }, 'Lost estimates') },
          { icon: TrendingUp, label: 'Conversion', value: `${conv?.rate ?? 0}%`, tone: 'success', emphasize: true, onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
          { icon: DollarSign, label: 'Quoted Value', value: formatCurrencyWhole(s?.totalValue ?? 0), tone: 'neutral', onClick: () => openDrill({}, 'All estimates') },
          { icon: DollarSign, label: 'Won Value', value: formatCurrencyWhole(s?.won.value ?? 0), tone: 'success', onClick: () => openDrill({ outcome: 'won' }, 'Won estimates') },
        ]}
      />

      <ReportKpis
        loading={isLoading || !data}
        items={[
          { icon: DollarSign, label: 'Avg ticket (won)', value: moneyOrDash(ctx?.avgTicketWon), tone: 'success' },
          { icon: DollarSign, label: 'Avg ticket (lost)', value: moneyOrDash(ctx?.avgTicketLost), tone: 'danger' },
          { icon: Clock, label: 'Median days to decision', value: ctx?.medianDaysToDecision == null ? '-' : `${ctx.medianDaysToDecision}d`, tone: 'neutral' },
          { icon: Clock, label: 'Median hrs request to sent', value: ctx?.medianHoursRequestToSent == null ? '-' : `${ctx.medianHoursRequestToSent}h`, tone: 'neutral' },
        ]}
      />

      {hasData && (
        <RepTable
          rows={data?.byRep ?? []}
          onDrillRep={(r) => openDrill({ repId: r.repId ?? '__unassigned__' }, `${r.repName} · estimates`)}
        />
      )}

      {!hasData && !isLoading ? (
        <Card>
          <EmptyState
            title="No estimates in this range"
            description="Adjust the date anchor or range above, or create estimates to see conversion metrics."
          />
        </Card>
      ) : (
        <>
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
                  onClick={(d: ChartClickTarget<MonthlyPoint>) => { const r = d?.payload ?? d; if (r?.key) openDrill({ month: r.key }, `${r.month} · estimates`); }}>
                  {monthly.map((m) => (
                    <Cell key={`s-${m.key}`} fill={m.partial ? 'url(#hatchSent)' : token('--border-color')} />
                  ))}
                </Bar>
                <Bar yAxisId="left" dataKey="won" name="Won $" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(d: ChartClickTarget<MonthlyPoint>) => { const r = d?.payload ?? d; if (r?.key) openDrill({ month: r.key, outcome: 'won' }, `${r.month} · won`); }}>
                  {monthly.map((m) => (
                    <Cell key={`w-${m.key}`} fill={m.partial ? 'url(#hatchWon)' : OUTCOME_WON} />
                  ))}
                </Bar>
                <Line yAxisId="right" type="monotone" dataKey="rate" name="Conversion %" stroke={token('--primary')} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
                    onClick={(d: ChartClickTarget<StatusSlice>) => { const r = d?.payload ?? d; if (r?.key) openDrill({ status: r.key }, `${r.name} estimates`); }}>
                    <LabelList dataKey="count" position="right" style={chartLabelStyle} />
                    {breakdown.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title={
                <span className="flex items-center gap-1.5">
                  Conversion
                  <span title={conversionHelp} className="text-muted-foreground cursor-help">
                    <Info className="size-3.5" />
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
                      onClick={(d: ChartClickTarget<OutcomeSlice>) => {
                        const name = (d?.payload ?? d)?.name;
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
                  <span className="text-3xl font-semibold">{conv?.rate ?? 0}%</span>
                  <span className="text-muted-foreground text-xs">conversion</span>
                </div>
              </div>
              {/* Legend swatches read the same three constants as the slices. */}
              <div className="mt-2 flex flex-wrap justify-center gap-3 text-xs">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: OUTCOME_WON }} /> Won {s?.won.count ?? 0}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: OUTCOME_OPEN }} /> Open {s?.open.count ?? 0}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: OUTCOME_LOST }} /> Lost {s?.lost.count ?? 0}
                </span>
              </div>
            </ChartCard>
          </div>

          {data?.aging && (
            <AgingSection
              aging={data.aging}
              onDrill={(bucket, label) => openDrill({ outcome: 'open', agingBucket: bucket }, label)}
            />
          )}

          <div className="space-y-2">
            <div>
              <ReportHeading level={2} scale="lg">Estimates</ReportHeading>
              <p className="text-muted-foreground text-xs">
                Showing {Math.min(tableRows.length, 15)} of {tableData?.total ?? tableRows.length}
              </p>
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

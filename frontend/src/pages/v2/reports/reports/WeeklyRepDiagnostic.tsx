import { useMemo, useState } from 'react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts';
import {
  CalendarRange, CheckCircle2, DollarSign, Layers, Send, TrendingUp, Users,
} from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { chartPalette, token } from '@/design-system';
import { findReport } from '@/lib/reports/report-catalog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportKpis } from '../components/kpi';
import { ReportToolbar } from '../components/shared';

/**
 * S9 - Weekly Rep Diagnostic.
 *
 * Deterministic MOCK data, carried over unchanged, so the report renders
 * identically without a backend. Wire to `GET /api/reports/weekly-rep-diagnostic`
 * later (replace `REPS` + `derive`); the presentational layer can stay.
 *
 * THE CONVERSION-FORMULA TOGGLE IS THE POINT OF THIS REPORT and both formulas
 * are preserved exactly: the HCP model is Won / (Won+Lost+Open), which cannot
 * exceed 100%, and the Jobber model is Won / Sent, which can. `convRate` is the
 * single place either is computed, and the footnote still names whichever is
 * active. `CLOSE_BENCHMARK` (45% resi) is the reference line on every rep's
 * sparkline.
 *
 * CHARTS UNTOUCHED: the sparkline is green when the rep is above their prior
 * four-week average and red when below, the prior-4 average itself is a dashed
 * neutral `ReferenceLine`, and the pipeline bar segments read `chartPalette` so
 * a stage keeps its colour across every card.
 *
 * Shape differences: the formula toggle is a `role="radiogroup"` of two kit
 * Buttons rather than a raw segmented pill, the rep initials use the kit's
 * `Avatar`, and the four filters are kit `Select`s.
 */

type BU = 'HVAC' | 'Plumbing' | 'Electrical';
const SOURCES = ['Google Ads', 'Local Services', 'Referral', 'Repeat'] as const;
type Source = (typeof SOURCES)[number];

const WEEKS = [
  { id: 'w0', label: 'May 25 - 31 (last week)', factor: 1 },
  { id: 'w1', label: 'May 18 - 24', factor: 0.92 },
  { id: 'w2', label: 'May 11 - 17', factor: 1.06 },
  { id: 'w3', label: 'May 4 - 10', factor: 0.85 },
] as const;

// HVAC replacement close benchmark (catalog S1/S9): 45% resi average.
const CLOSE_BENCHMARK = 0.45;

interface Rep {
  id: string;
  name: string;
  bu: BU;
  leads: number;
  sent: number;
  sentValue: number;
  won: number; // closed-won opportunities = leads sold = conversions
  lost: number;
  open: number;
  revenue: number; // sold-by attribution
  stages: { label: string; value: number }[]; // open pipeline $ by stage
  sourceMix: Record<Source, number>; // shares (~sum to 1)
  spark: number[]; // weekly revenue, oldest -> newest (5 pts)
}

const REPS: Rep[] = [
  {
    id: 'maria', name: 'Maria Lopez', bu: 'HVAC',
    leads: 38, sent: 30, sentValue: 142_000, won: 18, lost: 7, open: 9, revenue: 96_400,
    stages: [{ label: 'New', value: 28_000 }, { label: 'Estimate', value: 32_000 }, { label: 'Negotiation', value: 18_000 }],
    sourceMix: { 'Google Ads': 0.45, 'Local Services': 0.2, Referral: 0.2, Repeat: 0.15 },
    spark: [82_000, 90_000, 88_000, 94_000, 96_400],
  },
  {
    id: 'james', name: 'James Carter', bu: 'Plumbing',
    leads: 31, sent: 26, sentValue: 98_500, won: 14, lost: 9, open: 6, revenue: 71_200,
    stages: [{ label: 'New', value: 16_000 }, { label: 'Estimate', value: 21_000 }, { label: 'Negotiation', value: 9_000 }],
    sourceMix: { 'Google Ads': 0.3, 'Local Services': 0.35, Referral: 0.2, Repeat: 0.15 },
    spark: [60_000, 58_000, 66_000, 69_000, 71_200],
  },
  {
    id: 'aisha', name: 'Aisha Khan', bu: 'Electrical',
    leads: 27, sent: 24, sentValue: 88_000, won: 16, lost: 4, open: 7, revenue: 83_900,
    stages: [{ label: 'New', value: 12_000 }, { label: 'Estimate', value: 26_000 }, { label: 'Negotiation', value: 14_000 }],
    sourceMix: { 'Google Ads': 0.25, 'Local Services': 0.15, Referral: 0.35, Repeat: 0.25 },
    spark: [70_000, 74_000, 79_000, 81_000, 83_900],
  },
  {
    id: 'tom', name: 'Tom Becker', bu: 'HVAC',
    leads: 22, sent: 17, sentValue: 64_000, won: 7, lost: 8, open: 5, revenue: 38_500,
    stages: [{ label: 'New', value: 9_000 }, { label: 'Estimate', value: 11_000 }, { label: 'Negotiation', value: 4_000 }],
    sourceMix: { 'Google Ads': 0.5, 'Local Services': 0.25, Referral: 0.15, Repeat: 0.1 },
    spark: [48_000, 44_000, 41_000, 40_000, 38_500],
  },
  {
    id: 'sofia', name: 'Sofia Rossi', bu: 'Plumbing',
    leads: 29, sent: 23, sentValue: 79_000, won: 13, lost: 6, open: 8, revenue: 62_800,
    stages: [{ label: 'New', value: 15_000 }, { label: 'Estimate', value: 18_000 }, { label: 'Negotiation', value: 11_000 }],
    sourceMix: { 'Google Ads': 0.35, 'Local Services': 0.2, Referral: 0.3, Repeat: 0.15 },
    spark: [55_000, 58_000, 60_000, 61_000, 62_800],
  },
];

type ConvFormula = 'hcp' | 'jobber';

// Apply the active source + week filters to a rep's numbers (deterministic).
function derive(rep: Rep, source: Source | 'all', wf: number) {
  const share = source === 'all' ? 1 : rep.sourceMix[source] ?? 0;
  const f = share * wf;
  const r = (n: number) => Math.round(n * f);
  return {
    ...rep,
    hidden: source !== 'all' && share === 0,
    leads: r(rep.leads),
    sent: r(rep.sent),
    sentValue: r(rep.sentValue),
    won: r(rep.won),
    lost: r(rep.lost),
    open: r(rep.open),
    revenue: r(rep.revenue),
    pipelineValue: rep.stages.reduce((s, st) => s + r(st.value), 0),
    stages: rep.stages.map((st) => ({ ...st, value: r(st.value) })),
    spark: rep.spark.map((v) => r(v)),
  };
}

type DerivedRep = ReturnType<typeof derive>;

function convRate(r: { won: number; lost: number; open: number; sent: number }, formula: ConvFormula) {
  if (formula === 'jobber') return r.sent > 0 ? r.won / r.sent : 0;
  const denom = r.won + r.lost + r.open;
  return denom > 0 ? r.won / denom : 0;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
// Compact money for the KPI strip - no cents so 6 tiles fit on one row.
const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export default function WeeklyRepDiagnostic() {
  const report = findReport('weekly-rep-diagnostic')!;

  const [week, setWeek] = useState<string>(WEEKS[0].id);
  const [repFilter, setRepFilter] = useState<string>('all');
  const [bu, setBu] = useState<BU | 'all'>('all');
  const [source, setSource] = useState<Source | 'all'>('all');
  const [formula, setFormula] = useState<ConvFormula>('hcp');

  const weekFactor = WEEKS.find((w) => w.id === week)?.factor ?? 1;

  const rows: DerivedRep[] = useMemo(() => {
    return REPS
      .filter((r) => repFilter === 'all' || r.id === repFilter)
      .filter((r) => bu === 'all' || r.bu === bu)
      .map((r) => derive(r, source, weekFactor))
      .filter((r) => !r.hidden);
  }, [repFilter, bu, source, weekFactor]);

  // Team totals across the visible rows.
  const t = useMemo(() => {
    const sum = (k: keyof DerivedRep) => rows.reduce((s, r) => s + (r[k] as number), 0);
    const won = sum('won'), lost = sum('lost'), open = sum('open'), sent = sum('sent');
    return {
      leads: sum('leads'),
      sent,
      sentValue: sum('sentValue'),
      won,
      revenue: sum('revenue'),
      pipelineValue: sum('pipelineValue'),
      rate: convRate({ won, lost, open, sent }, formula),
    };
  }, [rows, formula]);

  function exportCsv() {
    exportCsvFile(
      `weekly-rep-diagnostic-${week}.csv`,
      ['Rep', 'Business Unit', 'Leads', 'Estimates Sent', 'Sent $', 'Conversions', 'Conversion Rate', 'Leads Sold', 'Revenue', 'Pipeline $'],
      rows.map((r) => [r.name, r.bu, r.leads, r.sent, r.sentValue, r.won, pct(convRate(r, formula)), r.won, r.revenue, r.pipelineValue]),
    );
  }

  return (
    <ReportShell
      report={report}
      actions={
        <>
          {/* Conversion-formula toggle - a documented Servwave standard */}
          <div role="radiogroup" aria-label="Conversion-rate formula" className="flex items-center gap-1">
            {([
              { id: 'hcp', label: 'Won / (Won+Lost+Open)' },
              { id: 'jobber', label: 'Won / Sent' },
            ] as const).map((o) => (
              <Button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={formula === o.id}
                variant={formula === o.id ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFormula(o.id)}
                title="Conversion-rate formula"
              >
                {o.label}
              </Button>
            ))}
          </div>
          <ReportToolbar variant="compact" onExport={exportCsv} />
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
          <CalendarRange className="size-4" /> Week
        </span>
        <SelectField
          value={week}
          onValueChange={setWeek}
          aria-label="Week"
          size="sm"
          className="w-[220px]"
          options={WEEKS.map((w) => ({ value: w.id, label: w.label }))}
        />
        <SelectField
          value={repFilter}
          onValueChange={setRepFilter}
          aria-label="Rep"
          size="sm"
          className="w-[170px]"
          options={[
            { value: 'all', label: 'All reps' },
            ...REPS.map((r) => ({ value: r.id, label: r.name })),
          ]}
        />
        <Select value={bu} onValueChange={(v) => setBu(v as BU | 'all')}>
          <SelectTrigger aria-label="Business unit" size="sm" className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All business units</SelectItem>
            <SelectItem value="HVAC">HVAC</SelectItem>
            <SelectItem value="Plumbing">Plumbing</SelectItem>
            <SelectItem value="Electrical">Electrical</SelectItem>
          </SelectContent>
        </Select>
        <SelectField
          value={source}
          onValueChange={(v) => setSource(v as Source | 'all')}
          aria-label="Lead source"
          size="sm"
          className="w-[190px]"
          options={[
            { value: 'all', label: 'All lead sources' },
            ...SOURCES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <Badge variant="softNeutral" className="ml-auto">Sample data · sold-by attribution</Badge>
      </div>

      <ReportKpis
        items={[
          { icon: Users, label: 'Leads', value: t.leads, tone: 'neutral' },
          { icon: Send, label: 'Estimates Sent', value: t.sent, tone: 'primary' },
          { icon: CheckCircle2, label: 'Conversions', value: t.won, tone: 'success' },
          { icon: TrendingUp, label: 'Conv. Rate', value: pct(t.rate), tone: 'success', emphasize: true },
          { icon: DollarSign, label: 'Revenue', value: money0(t.revenue), tone: 'success' },
          { icon: Layers, label: 'Pipeline', value: money0(t.pipelineValue), tone: 'warning' },
        ]}
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No reps match these filters"
            description="Try widening the business unit or lead source."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <RepCard key={r.id} rep={r} formula={formula} />
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Sample data shown so the layout is reviewable without a backend. Conversion rate uses the{' '}
        {formula === 'hcp' ? 'HCP model (Won / Won+Lost+Open, at most 100%)' : 'Jobber model (Won / Sent, can exceed 100%)'}.
        Benchmark line = {pct(CLOSE_BENCHMARK)} resi close rate. Scheduled Monday-morning email is planned next.
      </p>
    </ReportShell>
  );
}

function RepCard({ rep, formula }: { rep: DerivedRep; formula: ConvFormula }) {
  const rate = convRate(rep, formula);
  const aboveBench = rate >= CLOSE_BENCHMARK;
  const prior4 = rep.spark.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
  const current = rep.spark[rep.spark.length - 1] ?? 0;
  const delta = prior4 > 0 ? (current - prior4) / prior4 : 0;
  const sparkData = rep.spark.map((v, i) => ({ i, v }));

  return (
    <Card>
      <div className="flex items-center gap-3">
        {/* The kit's Avatar derives its own initials and its stable per-name
            tint from `name`, so the legacy `getInitials` call goes away. */}
        <Avatar name={rep.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{rep.name}</p>
          <p className="text-muted-foreground text-xs">{rep.bu}</p>
        </div>
        <Badge
          variant={aboveBench ? 'softGreen' : 'softAmber'}
          size="pill"
          className="ml-auto"
          title={`vs ${pct(CLOSE_BENCHMARK)} benchmark`}
        >
          {pct(rate)} conv
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-y-3 text-sm">
        <Metric label="Leads" value={String(rep.leads)} />
        <Metric label="Sent" value={`${rep.sent}`} sub={formatCurrency(rep.sentValue)} />
        <Metric label="Won" value={String(rep.won)} />
        <Metric label="Lost" value={String(rep.lost)} />
        <Metric label="Open" value={String(rep.open)} />
        <Metric label="Revenue" value={formatCurrency(rep.revenue)} accent />
      </div>

      <div className="mt-4">
        <p className="text-muted-foreground mb-1 text-xs font-medium">
          Open pipeline · {formatCurrency(rep.pipelineValue)}
        </p>
        {/* Stage segments read chartPalette so a stage keeps one colour across
            every card - the same rule as a chart legend swatch. */}
        <div className="bg-muted flex h-2 overflow-hidden rounded-full">
          {rep.stages.map((st, i) => {
            const wpct = rep.pipelineValue > 0 ? (st.value / rep.pipelineValue) * 100 : 0;
            return (
              <div
                key={st.label}
                style={{ width: `${wpct}%`, background: chartPalette[i % chartPalette.length] }}
                title={`${st.label}: ${formatCurrency(st.value)}`}
              />
            );
          })}
        </div>
        <div className="text-muted-foreground mt-1 flex justify-between text-[11px]">
          {rep.stages.map((st) => <span key={st.label}>{st.label}</span>)}
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-xs">Revenue trend (5 wks)</p>
          <p className={cn('text-sm font-semibold', delta >= 0 ? 'text-status-green-emphasis' : 'text-status-red-emphasis')}>
            {delta >= 0 ? '▲' : '▼'} {pct(Math.abs(delta))} vs 4-wk avg
          </p>
        </div>
        <div className="h-12 w-28">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
              <ReferenceLine y={prior4} stroke={token('--border-color')} strokeDasharray="3 3" />
              <Tooltip
                formatter={(v: number) => formatCurrency(v)}
                labelFormatter={() => ''}
                contentStyle={{ fontSize: 11, padding: '2px 6px' }}
              />
              <Line
                type="monotone"
                dataKey="v"
                stroke={delta >= 0 ? token('--success') : token('--danger')}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className={cn('font-semibold tabular-nums', accent && 'text-status-green-emphasis')}>{value}</p>
      {sub && <p className="text-muted-foreground text-[11px]">{sub}</p>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// S9 — Weekly Rep Diagnostic (owner-requested, Wave 1)
// Per-salesperson weekly digest: leads → estimates → conversions → revenue +
// open pipeline, with a conversion-formula toggle (HCP vs Jobber) and a
// sparkline vs the prior 4-week average.
//
// Data is deterministic MOCK data so the report renders identically without a
// backend. Wire to GET /api/reports/weekly-rep-diagnostic later (replace
// `REPS` + `derive`); the presentational layer can stay as-is.
// ───────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
  Tooltip,
} from 'recharts';
import {
  Users,
  Send,
  CheckCircle2,
  TrendingUp,
  DollarSign,
  Layers,
  CalendarRange,
} from 'lucide-react';
import { formatCurrency, getInitials } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { KpiStrip } from '@/components/data/KpiStrip';
import { EmptyState } from '@/components/ui/empty-state';
import { SelectField } from '@/components/form/SelectField';
import { chartPalette, token } from '@/design-system';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { ReportToolbar } from './_shared';

// ── Dimensions ───────────────────────────────────────────────────────────────
type BU = 'HVAC' | 'Plumbing' | 'Electrical';
const SOURCES = ['Google Ads', 'Local Services', 'Referral', 'Repeat'] as const;
type Source = (typeof SOURCES)[number];

const WEEKS = [
  { id: 'w0', label: 'May 25 – 31 (last week)', factor: 1 },
  { id: 'w1', label: 'May 18 – 24', factor: 0.92 },
  { id: 'w2', label: 'May 11 – 17', factor: 1.06 },
  { id: 'w3', label: 'May 4 – 10', factor: 0.85 },
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
  spark: number[]; // weekly revenue, oldest → newest (5 pts)
}

// Deterministic sample roster.
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
// Compact money for the KPI strip — no cents so 6 tiles fit on one row.
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
          {/* Conversion-formula toggle — a documented Servwave standard */}
          <div className="inline-flex rounded-full border border-border bg-surface-light p-0.5 text-xs font-medium">
            {([
              { id: 'hcp', label: 'Won ÷ (Won+Lost+Open)' },
              { id: 'jobber', label: 'Won ÷ Sent' },
            ] as const).map((o) => (
              // Segmented conversion-formula toggle, not Button-shaped - left raw.
              <button
                key={o.id}
                onClick={() => setFormula(o.id)}
                className={`rounded-full px-3 py-1 transition-colors ${
                  formula === o.id ? 'bg-primary text-on-fill' : 'text-text-secondary hover:text-text-primary'
                }`}
                title="Conversion-rate formula"
              >
                {o.label}
              </button>
            ))}
          </div>
          <ReportToolbar variant="compact" onExport={exportCsv} />
        </>
      }
    >
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <CalendarRange className="h-4 w-4" /> Week
        </span>
        <SelectField
          aria-label="Week"
          value={week}
          onValueChange={setWeek}
          className="h-9"
          options={WEEKS.map((w) => ({ value: w.id, label: w.label }))}
        />
        <SelectField
          aria-label="Rep"
          value={repFilter}
          onValueChange={setRepFilter}
          className="h-9"
          options={[
            { value: 'all', label: 'All reps' },
            ...REPS.map((r) => ({ value: r.id, label: r.name })),
          ]}
        />
        <SelectField
          aria-label="Business unit"
          value={bu}
          onValueChange={(v) => setBu(v as BU | 'all')}
          className="h-9"
          options={[
            { value: 'all', label: 'All business units' },
            { value: 'HVAC', label: 'HVAC' },
            { value: 'Plumbing', label: 'Plumbing' },
            { value: 'Electrical', label: 'Electrical' },
          ]}
        />
        <SelectField
          aria-label="Lead source"
          value={source}
          onValueChange={(v) => setSource(v as Source | 'all')}
          className="h-9"
          options={[
            { value: 'all', label: 'All lead sources' },
            ...SOURCES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <span className="ml-auto rounded-md bg-background-light px-2 py-1 text-xs text-text-secondary">
          Sample data · sold-by attribution
        </span>
      </div>

      {/* Team totals */}
      <KpiStrip
        items={[
          { icon: Users, label: 'Leads', value: t.leads, tone: 'neutral' },
          { icon: Send, label: 'Estimates Sent', value: t.sent, sub: money0(t.sentValue), tone: 'primary' },
          { icon: CheckCircle2, label: 'Conversions', value: t.won, tone: 'success' },
          { icon: TrendingUp, label: 'Conv. Rate', value: pct(t.rate), tone: 'success', emphasize: true },
          { icon: DollarSign, label: 'Revenue', value: money0(t.revenue), tone: 'success' },
          { icon: Layers, label: 'Pipeline', value: money0(t.pipelineValue), tone: 'warning' },
        ]}
      />

      {/* Per-rep cards */}
      {rows.length === 0 ? (
        <EmptyState
          variant="card"
          title="No reps match these filters"
          description="Try widening the business unit or lead source."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <RepCard key={r.id} rep={r} formula={formula} />
          ))}
        </div>
      )}

      <p className="text-xs text-text-secondary">
        Sample data shown so the layout is reviewable without a backend. Conversion rate uses the{' '}
        {formula === 'hcp' ? 'HCP model (Won ÷ Won+Lost+Open, ≤100%)' : 'Jobber model (Won ÷ Sent, can exceed 100%)'}.
        Benchmark line = {pct(CLOSE_BENCHMARK)} resi close rate. Scheduled Monday-morning email is planned next.
      </p>
    </ReportShell>
  );
}

// ── Per-rep card ─────────────────────────────────────────────────────────────
function RepCard({ rep, formula }: { rep: DerivedRep; formula: ConvFormula }) {
  const rate = convRate(rep, formula);
  const aboveBench = rate >= CLOSE_BENCHMARK;
  const prior4 = rep.spark.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
  const current = rep.spark[rep.spark.length - 1] ?? 0;
  const delta = prior4 > 0 ? (current - prior4) / prior4 : 0;
  const sparkData = rep.spark.map((v, i) => ({ i, v }));
  const initials = getInitials(rep.name);

  return (
    <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-on-fill">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{rep.name}</p>
          <p className="text-xs text-text-secondary">{rep.bu}</p>
        </div>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${
            aboveBench ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
          }`}
          title={`vs ${pct(CLOSE_BENCHMARK)} benchmark`}
        >
          {pct(rate)} conv
        </span>
      </div>

      {/* Metric grid */}
      <div className="mt-4 grid grid-cols-3 gap-y-3 text-sm">
        <Metric label="Leads" value={String(rep.leads)} />
        <Metric label="Sent" value={`${rep.sent}`} sub={formatCurrency(rep.sentValue)} />
        <Metric label="Won" value={String(rep.won)} />
        <Metric label="Lost" value={String(rep.lost)} />
        <Metric label="Open" value={String(rep.open)} />
        <Metric label="Revenue" value={formatCurrency(rep.revenue)} accent />
      </div>

      {/* Pipeline by stage */}
      <div className="mt-4">
        <p className="mb-1 text-xs font-medium text-text-secondary">
          Open pipeline · {formatCurrency(rep.pipelineValue)}
        </p>
        <div className="flex h-2 overflow-hidden rounded-full bg-background-light">
          {rep.stages.map((st, i) => {
            const wpct = rep.pipelineValue > 0 ? (st.value / rep.pipelineValue) * 100 : 0;
            return <div key={st.label} style={{ width: `${wpct}%`, background: chartPalette[i % chartPalette.length] }} title={`${st.label}: ${formatCurrency(st.value)}`} />;
          })}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-text-secondary">
          {rep.stages.map((st) => <span key={st.label}>{st.label}</span>)}
        </div>
      </div>

      {/* Sparkline vs prior 4-week avg */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-text-secondary">Revenue trend (5 wks)</p>
          <p className={`text-sm font-semibold ${delta >= 0 ? 'text-success' : 'text-danger'}`}>
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
    </div>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p className={`font-semibold tabular-nums ${accent ? 'text-success' : 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}

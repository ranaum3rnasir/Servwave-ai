// ───────────────────────────────────────────────────────────────────────────
// F2 — Revenue: Completed vs Invoiced vs Collected (Wave 1)
// The three numbers never match the P&L; this shows all three + collection rate,
// a 3-series trend, and a reconciliation bridge.
//  • demo org → deterministic weekly MOCK + fabricated business-unit (BU) split.
//  • real org → GET /api/reports/revenue (monthly series). NO BU split exists in
//    the schema, so that control + scaling render for demo orgs only.
// ───────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, LabelList,
} from 'recharts';
import { CheckCircle2, FileText, Banknote, Percent, Hourglass } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard, WaveAreaChart } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { token } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useRevenueReport } from '@/lib/reports/revenue-data';

const money0 = (n: number) => formatCurrencyWhole(n);
const pct = (n: number) => `${Math.round(n)}%`;

export default function RevenueReport() {
  const report = findReport('revenue')!;
  const isDemo = useIsDemoOrg();
  const { series, hasBuSplit } = useRevenueReport(isDemo);
  const [bu, setBu] = useState('all');

  // BU filter just scales the series deterministically — a DEMO-only fabrication
  // (no business-unit dimension exists in the schema). Real orgs keep factor = 1.
  const factor = !hasBuSplit ? 1 : bu === 'all' ? 1 : bu === 'HVAC' ? 0.5 : bu === 'Plumbing' ? 0.3 : 0.2;
  const data = useMemo(
    () => series.map((d) => ({
      period: d.period,
      completed: Math.round(d.completed * factor),
      invoiced: Math.round(d.invoiced * factor),
      collected: Math.round(d.collected * factor),
    })),
    [series, factor],
  );

  const t = useMemo(() => {
    const completed = data.reduce((s, d) => s + d.completed, 0);
    const invoiced = data.reduce((s, d) => s + d.invoiced, 0);
    const collected = data.reduce((s, d) => s + d.collected, 0);
    return {
      completed, invoiced, collected,
      collRate: invoiced ? (collected / invoiced) * 100 : 0,
      outstanding: invoiced - collected,
    };
  }, [data]);

  // Reconciliation bridge: Completed → (not yet invoiced) → Invoiced → (not yet collected) → Collected.
  // Totals = neutral ocean/indigo chrome; the two "gap" steps = warning; collected = success.
  const bridge = [
    { name: 'Completed', value: t.completed, tone: token('--primary') },
    { name: 'Not invoiced', value: -(t.completed - t.invoiced), tone: token('--warning') },
    { name: 'Invoiced', value: t.invoiced, tone: token('--ai') },
    { name: 'Uncollected', value: -t.outstanding, tone: token('--warning') },
    { name: 'Collected', value: t.collected, tone: token('--success') },
  ];

  return (
    <ReportShell
      report={report}
      actions={
        hasBuSplit ? (
          <SelectField
            aria-label="Business unit"
            value={bu}
            onValueChange={setBu}
            className="h-9"
            options={[
              { value: 'all', label: 'All business units' },
              { value: 'HVAC', label: 'HVAC' },
              { value: 'Plumbing', label: 'Plumbing' },
              { value: 'Electrical', label: 'Electrical' },
            ]}
          />
        ) : undefined
      }
    >
      <KpiStrip
        items={[
          { icon: CheckCircle2, label: 'Completed', value: money0(t.completed), tone: 'primary' },
          { icon: FileText, label: 'Invoiced', value: money0(t.invoiced), tone: 'neutral' },
          { icon: Banknote, label: 'Collected', value: money0(t.collected), tone: 'success', emphasize: true },
          { icon: Percent, label: 'Collection Rate', value: pct(t.collRate), tone: 'success' },
          { icon: Hourglass, label: 'Outstanding', value: money0(t.outstanding), tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <ChartCard
          className="lg:col-span-3"
          title="Completed vs Invoiced vs Collected"
          subtitle={`${isDemo ? 'Weekly' : 'Monthly'} — collection lags completion`}
        >
          <WaveAreaChart
            data={data}
            xKey="period"
            height={280}
            valueFormatter={money0}
            series={[
              { dataKey: 'completed', name: 'Completed', color: token('--primary') },
              { dataKey: 'invoiced', name: 'Invoiced', color: token('--ai') },
              { dataKey: 'collected', name: 'Collected', color: token('--success') },
            ]}
          />
        </ChartCard>

        <ChartCard
          className="lg:col-span-2"
          title="Reconciliation bridge"
          subtitle="Why completed ≠ collected"
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={bridge} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: token('--text-secondary') }} interval={0} />
              <YAxis tickFormatter={money0} tick={{ fontSize: 11, fill: token('--text-secondary') }} width={84} />
              <Tooltip formatter={(v: number) => money0(Math.abs(v))} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                <LabelList dataKey="value" position="top" formatter={(v: number) => money0(Math.abs(v))} style={chartLabelStyle} />
                {bridge.map((b) => <Cell key={b.name} fill={b.tone} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <p className="text-xs text-text-secondary">
        {isDemo
          ? 'Sample data shown so the layout is reviewable without a backend. Date-basis toggle (completed / invoiced / paid) and job-type / lead-source filters are planned next.'
          : 'Completed = job value at completion · Invoiced = invoice totals by invoice date · Collected = payments by paid date.'}
      </p>
    </ReportShell>
  );
}

import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { DollarSign, Hash, Percent, Trophy, Users } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { chartPalette, token } from '@/design-system/tokens';
import type { ReportDef, ReportGroup } from '@/lib/reports/report-catalog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, type ReportColumn } from '../components/reportTable';
import { Delta, MultiSelectFilter, Sparkline, hashStr, mulberry32, rangeRnd } from '../components/shared';

/**
 * The generic, data-rich report page: any catalog slug with no bespoke
 * component renders through here, so every card opens real (sample) data
 * instead of a stub.
 *
 * CHART SUBTREE IS UNTOUCHED. `TREND_UP`/`TREND_DOWN` are the same two
 * design-system accessors as before - a bar is green when the entity is up on
 * last month and red when it is down, and the same pair colours the row's
 * sparkline so the table and the chart agree. Substituting a kit token there
 * would change what the colour MEANS, so everything from `<ResponsiveContainer>`
 * down, plus `chartPalette` for the per-entity line series, is carried over from
 * `pages/reports/GenericReport.tsx` verbatim. Only the frames moved: the KPI
 * row, the table and the page shell.
 *
 * The sample-data generator is imported, not copied: `hashStr`/`mulberry32`
 * seed off the slug so a given report shows the same numbers on every render,
 * and a second copy of that arithmetic would be a second answer.
 */

// Trend up/down = positive/negative data signal -> success / danger.
const TREND_UP = chartPalette[0] ?? token('--success');
const TREND_DOWN = token('--danger');

type Kind = 'currency' | 'percent' | 'number';
interface MetricDef { label: string; kind: Kind; base: number }
interface GroupConfig {
  entityLabel: string;
  names: string[];
  primary: MetricDef;
  rate: MetricDef;
  secondary: MetricDef;
  /** How tile 3 aggregates the secondary metric. */
  secondaryAgg: 'sum' | 'avg';
}

const GROUPS: Record<ReportGroup, GroupConfig> = {
  Sales: {
    entityLabel: 'Rep',
    names: ['Jordan Mills', 'Casey Lee', 'Robin Shah', 'Alex Ng', 'Sam Ortiz', 'Dana Cole'],
    primary: { label: 'Revenue', kind: 'currency', base: 150000 },
    rate: { label: 'Win rate', kind: 'percent', base: 55 },
    secondary: { label: 'Deal size', kind: 'currency', base: 3800 },
    secondaryAgg: 'avg',
  },
  Finance: {
    entityLabel: 'Business unit',
    names: ['HVAC', 'Plumbing', 'Electrical', 'Drain', 'Install'],
    primary: { label: 'Revenue', kind: 'currency', base: 220000 },
    rate: { label: 'Gross margin', kind: 'percent', base: 42 },
    secondary: { label: 'Collected', kind: 'currency', base: 185000 },
    secondaryAgg: 'sum',
  },
  Operations: {
    entityLabel: 'Technician',
    names: ['Marcus Bell', 'Sofia Reyes', 'Devon Clark', 'Priya Nair', 'Tyler Brooks', 'Aisha Khan'],
    primary: { label: 'Completed jobs', kind: 'number', base: 120 },
    rate: { label: 'First-time fix', kind: 'percent', base: 78 },
    secondary: { label: 'Utilization', kind: 'percent', base: 68 },
    secondaryAgg: 'avg',
  },
  Marketing: {
    entityLabel: 'Channel',
    names: ['Google LSA', 'Google Search', 'Facebook', 'Yelp', 'Direct Mail', 'Referral'],
    primary: { label: 'Attributed revenue', kind: 'currency', base: 90000 },
    rate: { label: 'ROAS', kind: 'number', base: 4 },
    secondary: { label: 'Leads', kind: 'number', base: 140 },
    secondaryAgg: 'sum',
  },
};

const fmt = (v: number, kind: Kind) =>
  kind === 'currency' ? formatCurrency(v) : kind === 'percent' ? `${Math.round(v)}%` : Math.round(v).toLocaleString();

interface Row {
  name: string;
  primary: number;
  prevPrimary: number;
  rate: number;
  prevRate: number;
  secondary: number;
  prevSecondary: number;
  weekly: number[];
  /** Stable rank by primary metric (1-based) so the # column survives re-sorting. */
  rank: number;
}

const pctDelta = (cur: number, prev: number) => (prev === 0 ? null : ((cur - prev) / prev) * 100);

export default function GenericReport({ report }: { report: ReportDef }) {
  const cfg = GROUPS[report.group];
  const [selected, setSelected] = useState<string[]>([]);

  // Deterministic dataset per report slug.
  const allRows = useMemo<Row[]>(() => {
    const rng = mulberry32(hashStr(report.slug));
    return cfg.names.map((name) => {
      const primary = Math.round(cfg.primary.base * rangeRnd(rng, 0.5, 1.4));
      const prevPrimary = Math.round(primary * rangeRnd(rng, 0.82, 1.16));
      const rate = Math.round(cfg.rate.base * rangeRnd(rng, 0.78, 1.18) * 10) / 10;
      const prevRate = Math.round((rate + rangeRnd(rng, -6, 6)) * 10) / 10;
      const secondary = Math.round(cfg.secondary.base * rangeRnd(rng, 0.7, 1.25));
      const prevSecondary = Math.round(secondary * rangeRnd(rng, 0.85, 1.15));
      const drift = rangeRnd(rng, -0.06, 0.08);
      const weekly = Array.from({ length: 8 }, (_, i) =>
        Math.round((primary / 8) * (1 + drift * (i - 3.5)) * rangeRnd(rng, 0.9, 1.1)),
      );
      return { name, primary, prevPrimary, rate, prevRate, secondary, prevSecondary, weekly, rank: 0 };
    });
  }, [report.slug, cfg]);

  const rows = useMemo(
    () =>
      allRows
        .filter((r) => selected.length === 0 || selected.includes(r.name))
        .sort((a, b) => b.primary - a.primary)
        .map((r, i) => ({ ...r, rank: i + 1 })),
    [allRows, selected],
  );

  const sum = (k: (r: Row) => number) => rows.reduce((a, r) => a + k(r), 0);
  const avg = (k: (r: Row) => number) => (rows.length ? sum(k) / rows.length : 0);

  const totalPrimary = sum((r) => r.primary);
  const prevTotalPrimary = sum((r) => r.prevPrimary);
  const avgRate = avg((r) => r.rate);
  const prevAvgRate = avg((r) => r.prevRate);
  const sec = cfg.secondaryAgg === 'sum' ? sum((r) => r.secondary) : avg((r) => r.secondary);
  const prevSec = cfg.secondaryAgg === 'sum' ? sum((r) => r.prevSecondary) : avg((r) => r.prevSecondary);
  const top = rows[0];


  // Weekly trend -> one series per visible entity.
  const trend = Array.from({ length: 8 }, (_, i) => {
    const obj: Record<string, number | string> = { week: `W${i + 1}` };
    rows.forEach((r) => (obj[r.name] = r.weekly[i] ?? 0));
    return obj;
  });
  const SERIES = chartPalette;
  const currencyPrimary = cfg.primary.kind === 'currency';
  // Full comma-grouped money on axes; plain integers for count/percent kinds.
  const axisFmt = (v: number) => (currencyPrimary ? formatCurrency(v) : `${v}`);

  const columns: ReportColumn<Row>[] = [
    {
      id: 'rank',
      header: '#',
      width: 70,
      min: 55,
      grow: 0,
      cell: (r) => <span className="text-muted-foreground tabular-nums">{r.rank}</span>,
      sortValue: (r) => r.rank,
    },
    {
      id: 'name',
      header: cfg.entityLabel,
      width: 180,
      min: 150,
      cell: (r) => <span className="font-medium">{r.name}</span>,
      sortValue: (r) => r.name,
    },
    {
      id: 'primary',
      header: cfg.primary.label,
      width: 150,
      min: 130,
      align: 'right',
      cell: (r) => (
        <div>
          <div className="font-semibold tabular-nums">{fmt(r.primary, cfg.primary.kind)}</div>
          <div className="flex justify-end"><Delta value={pctDelta(r.primary, r.prevPrimary)} /></div>
        </div>
      ),
      sortValue: (r) => r.primary,
    },
    {
      id: 'rate',
      header: cfg.rate.label,
      width: 150,
      min: 130,
      align: 'right',
      cell: (r) => (
        <div>
          <div className="tabular-nums">{fmt(r.rate, cfg.rate.kind)}</div>
          <div className="flex justify-end">
            <Delta
              value={cfg.rate.kind === 'percent' ? r.rate - r.prevRate : pctDelta(r.rate, r.prevRate)}
              suffix={cfg.rate.kind === 'percent' ? 'pp' : '%'}
            />
          </div>
        </div>
      ),
      sortValue: (r) => r.rate,
    },
    {
      id: 'secondary',
      header: cfg.secondary.label,
      width: 130,
      min: 110,
      align: 'right',
      cell: (r) => <span className="tabular-nums">{fmt(r.secondary, cfg.secondary.kind)}</span>,
      sortValue: (r) => r.secondary,
    },
    {
      id: 'trend',
      header: '8-wk trend',
      width: 140,
      min: 120,
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end">
          <Sparkline data={r.weekly} color={r.primary >= r.prevPrimary ? TREND_UP : TREND_DOWN} />
        </div>
      ),
    },
  ];

  return (
    <ReportShell
      report={report}
      actions={
        <>
          <Badge variant="softAmber" size="pill">Sample data</Badge>
          <MultiSelectFilter label={cfg.entityLabel} options={cfg.names} selected={selected} onChange={setSelected} />
        </>
      }
    >
      {report.deferred && (
        <div className="bg-status-amber-subtle text-status-amber-emphasis rounded-lg border px-4 py-2 text-xs font-medium">
          Deferred - not selected for build in the current plan. Shown here for reference.
        </div>
      )}

      <ReportKpis
        items={[
          { icon: DollarSign, label: `Total ${cfg.primary.label}`, value: fmt(totalPrimary, cfg.primary.kind), tone: 'success', emphasize: true },
          { icon: Percent, label: `Avg ${cfg.rate.label}`, value: fmt(avgRate, cfg.rate.kind), tone: 'primary' },
          { icon: Hash, label: `${cfg.secondaryAgg === 'sum' ? 'Total' : 'Avg'} ${cfg.secondary.label}`, value: fmt(sec, cfg.secondary.kind), tone: 'neutral' },
          { icon: Users, label: `${cfg.entityLabel}s`, value: rows.length, tone: 'neutral' },
          { icon: Trophy, label: `Top ${cfg.entityLabel}`, value: top?.name ?? '-', tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Ranking by primary metric */}
        <ChartCard
          title={`${cfg.primary.label} by ${cfg.entityLabel.toLowerCase()}`}
          subtitle="Bar color = trending up (green) or down (red) vs last month"
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 72 }}>
              <XAxis type="number" tickFormatter={axisFmt} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v: number) => fmt(v, cfg.primary.kind)} />
              <Bar dataKey="primary" radius={[0, 6, 6, 0]} barSize={20}>
                <LabelList dataKey="primary" position="right" formatter={(v: number) => fmt(v, cfg.primary.kind)} style={chartLabelStyle} />
                {rows.map((r) => (
                  <Cell key={r.name} fill={r.primary >= r.prevPrimary ? TREND_UP : TREND_DOWN} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Weekly trend */}
        <ChartCard
          title="Weekly trend"
          subtitle={`Last 8 weeks of ${cfg.primary.label.toLowerCase()} per ${cfg.entityLabel.toLowerCase()}`}
        >
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trend} margin={{ left: 4, right: 8, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={axisFmt} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={currencyPrimary ? 96 : 40} />
              <Tooltip formatter={(v: number) => fmt(v, cfg.primary.kind)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              {rows.map((r, i) => (
                <Line key={r.name} type="monotone" dataKey={r.name} stroke={SERIES[i % SERIES.length] ?? TREND_UP} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Leaderboard - drag a column edge to resize, click a header to sort */}
      <div className="space-y-2">
        <div>
          <ReportHeading level={2} scale="lg">{cfg.entityLabel} breakdown</ReportHeading>
          <p className="text-muted-foreground text-xs">
            Ranked by {cfg.primary.label.toLowerCase()} · deltas vs last month
          </p>
        </div>
        <ReportTable
          rows={rows}
          getRowKey={(r) => r.name}
          empty={<EmptyState title={`No ${cfg.entityLabel.toLowerCase()}s match this filter.`} />}
          columns={columns}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        Sample data for layout review - shaped to the {report.group} category. This is a shared template;
        high-priority reports (like S3) get a bespoke build. Filters, date anchors, and live data are wired
        after the layout is approved.
      </p>
    </ReportShell>
  );
}

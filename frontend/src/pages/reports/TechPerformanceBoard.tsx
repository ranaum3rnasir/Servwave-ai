import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ReferenceLine,
  LabelList,
  Legend,
} from 'recharts';
import {
  DollarSign,
  Percent,
  Receipt,
  BadgeCheck,
  Users,
  Trophy,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { chartPalette, token } from '@/design-system';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { MultiSelectFilter } from './_shared';

/**
 * S3 · Technician Performance Board.
 *
 * NOTE: rendered from in-file SAMPLE data so the layout/visuals can be reviewed
 * and corrected before we wire real backend aggregations. Per the triage
 * attribution standard this is an ops/tech report — 100% of job revenue credits
 * the *performed-by* technician. Spec: docs/reporting/SERVWAVE_REPORT_CATALOG.md (S3).
 */

type BU = 'HVAC' | 'Plumbing' | 'Electrical';

interface Tech {
  name: string;
  bu: BU;
  active: boolean;
  revenue: number;
  prevRevenue: number;
  closeRate: number; // %
  prevCloseRate: number;
  avgTicket: number;
  prevAvgTicket: number;
  memberships: number;
  prevMemberships: number;
  leadsSet: number;
  prevLeadsSet: number;
  weekly: number[]; // last 8 weeks of completed revenue
}

// ── Sample data (8-week window, "this month" vs prior month) ──────────────────
const TECHS: Tech[] = [
  { name: 'Marcus Bell', bu: 'HVAC', active: true, revenue: 184200, prevRevenue: 162400, closeRate: 72, prevCloseRate: 68, avgTicket: 4120, prevAvgTicket: 3980, memberships: 14, prevMemberships: 11, leadsSet: 22, prevLeadsSet: 19, weekly: [19500, 21000, 20400, 23800, 22600, 24900, 25200, 26800] },
  { name: 'Sofia Reyes', bu: 'HVAC', active: true, revenue: 167800, prevRevenue: 171200, closeRate: 64, prevCloseRate: 70, avgTicket: 3870, prevAvgTicket: 4010, memberships: 9, prevMemberships: 12, leadsSet: 18, prevLeadsSet: 17, weekly: [22400, 21600, 20800, 19900, 20100, 19400, 21800, 21800] },
  { name: 'Devon Clark', bu: 'Plumbing', active: true, revenue: 142500, prevRevenue: 118300, closeRate: 58, prevCloseRate: 49, avgTicket: 3260, prevAvgTicket: 2980, memberships: 7, prevMemberships: 5, leadsSet: 20, prevLeadsSet: 16, weekly: [14200, 15600, 16100, 17400, 18200, 19800, 20300, 20900] },
  { name: 'Priya Nair', bu: 'Electrical', active: true, revenue: 131900, prevRevenue: 134800, closeRate: 61, prevCloseRate: 63, avgTicket: 3540, prevAvgTicket: 3610, memberships: 6, prevMemberships: 6, leadsSet: 15, prevLeadsSet: 16, weekly: [17800, 16900, 16400, 16800, 16200, 15900, 15600, 16300] },
  { name: 'Tyler Brooks', bu: 'HVAC', active: true, revenue: 98600, prevRevenue: 88200, closeRate: 47, prevCloseRate: 44, avgTicket: 2890, prevAvgTicket: 2750, memberships: 4, prevMemberships: 3, leadsSet: 12, prevLeadsSet: 11, weekly: [11200, 11800, 12100, 12600, 12900, 12400, 13100, 12500] },
  { name: 'Aisha Khan', bu: 'Plumbing', active: false, revenue: 54300, prevRevenue: 79900, closeRate: 39, prevCloseRate: 52, avgTicket: 2480, prevAvgTicket: 2710, memberships: 2, prevMemberships: 4, leadsSet: 7, prevLeadsSet: 12, weekly: [13800, 11200, 9600, 8100, 6400, 3200, 1100, 900] },
];

// Close-rate benchmark bands (from S3 spec).
const CLOSE_FLOOR = 30;
const CLOSE_GOOD = 70;

const pctDelta = (cur: number, prev: number) =>
  prev === 0 ? null : ((cur - prev) / prev) * 100;

// Severity-style band colors read from semantic tokens (good → acceptable → poor).
const closeBandColor = (r: number) =>
  r >= CLOSE_GOOD ? token('--success') : r >= CLOSE_FLOOR ? token('--warning') : token('--danger');

/** Up/down delta pill — green when rising, rose when falling. */
function Delta({ value, suffix = '%', flipColor = false }: { value: number | null; suffix?: string; flipColor?: boolean }) {
  if (value === null || Math.abs(value) < 0.05) {
    return <span className="text-xs text-text-secondary">—</span>;
  }
  const up = value > 0;
  const good = flipColor ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${good ? 'text-success' : 'text-danger'}`}>
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(value).toFixed(suffix === 'pp' ? 1 : value >= 100 ? 0 : 1)}{suffix === 'pp' ? '' : suffix}
    </span>
  );
}

/** Tiny inline SVG sparkline of weekly revenue. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 88;
  const h = 26;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function TechPerformanceBoard() {
  const report = findReport('tech-performance')!;
  const [bu, setBu] = useState<'All' | BU>('All');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedTechs, setSelectedTechs] = useState<string[]>([]);

  const techs = useMemo(
    () =>
      TECHS.filter(
        (t) =>
          (bu === 'All' || t.bu === bu) &&
          (showInactive || t.active) &&
          (selectedTechs.length === 0 || selectedTechs.includes(t.name)),
      )
        .sort((a, b) => b.revenue - a.revenue)
        .map((t, i) => ({ ...t, rank: i + 1 })),
    [bu, showInactive, selectedTechs],
  );

  // Team rollups (current vs prior).
  const sum = (k: (t: Tech) => number) => techs.reduce((acc, t) => acc + k(t), 0);
  const totalRev = sum((t) => t.revenue);
  const prevTotalRev = sum((t) => t.prevRevenue);
  const avgClose = techs.length ? Math.round(sum((t) => t.closeRate) / techs.length) : 0;
  const prevAvgClose = techs.length ? Math.round(sum((t) => t.prevCloseRate) / techs.length) : 0;
  const avgTicket = techs.length ? Math.round(sum((t) => t.avgTicket) / techs.length) : 0;
  const prevAvgTicket = techs.length ? Math.round(sum((t) => t.prevAvgTicket) / techs.length) : 0;
  const memberships = sum((t) => t.memberships);
  const prevMemberships = sum((t) => t.prevMemberships);
  const leadsSet = sum((t) => t.leadsSet);
  const top = techs[0];

  const arrow = (v: number | null) => (v === null ? '' : `${v > 0 ? '↑' : v < 0 ? '↓' : ''} ${Math.abs(v).toFixed(0)}% vs last mo`);

  // Weekly trend → one series per tech.
  const weeks = Array.from({ length: 8 }, (_, i) => `W${i + 1}`);
  const trendData = weeks.map((week, i) => {
    const row: Record<string, number | string> = { week };
    techs.forEach((t) => (row[t.name] = t.weekly[i] ?? 0));
    return row;
  });

  return (
    <ReportShell
      report={report}
      actions={
        <>
          <span className="rounded-full bg-warning/10 px-2 py-1 text-xs font-medium text-warning">Sample data</span>
          <MultiSelectFilter
            label="Technician"
            options={TECHS.map((t) => t.name)}
            selected={selectedTechs}
            onChange={setSelectedTechs}
          />
          <SelectField
            aria-label="Business unit"
            value={bu}
            onValueChange={(v) => setBu(v as 'All' | BU)}
            className="h-9"
            options={[
              { value: 'All', label: 'All business units' },
              { value: 'HVAC', label: 'HVAC' },
              { value: 'Plumbing', label: 'Plumbing' },
              { value: 'Electrical', label: 'Electrical' },
            ]}
          />
          {/* Raw by design: two-state filter toggle. Active state is a brand-tinted
              pill (bg-primary-subtle text-primary) with no matching Button cell (solid/
              brand is opaque, not this tint), and the idle state hits the same
              outline/neutral idle-text-colour trap as the Export button elsewhere in
              this batch. No cell covers both states - left raw. */}
          <button
            type="button"
            onClick={() => setShowInactive((s) => !s)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors ${
              showInactive ? 'border-primary/40 bg-primary-subtle text-primary' : 'border-border bg-surface-light text-text-secondary hover:text-text-primary'
            }`}
          >
            {showInactive ? 'Showing inactive' : 'Active techs only'}
          </button>
        </>
      }
    >
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Completed Revenue', value: formatCurrency(totalRev), sub: arrow(pctDelta(totalRev, prevTotalRev)), tone: 'success', emphasize: true },
          { icon: Percent, label: 'Avg Close Rate', value: `${avgClose}%`, sub: `${avgClose - prevAvgClose >= 0 ? '↑' : '↓'} ${Math.abs(avgClose - prevAvgClose)}pp vs last mo`, tone: 'primary' },
          { icon: Receipt, label: 'Avg Ticket', value: formatCurrency(avgTicket), sub: arrow(pctDelta(avgTicket, prevAvgTicket)), tone: 'neutral' },
          { icon: BadgeCheck, label: 'Memberships Sold', value: memberships, sub: arrow(pctDelta(memberships, prevMemberships)), tone: 'primary' },
          { icon: Users, label: 'Leads Set', value: leadsSet, tone: 'neutral' },
          { icon: Trophy, label: 'Top Performer', value: top?.name ?? '—', sub: top ? formatCurrency(top.revenue) : '', tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Revenue by technician — ranking, colored by month-over-month direction */}
        <ChartCard
          title="Completed revenue by technician"
          subtitle="Bar color = trending up (green) or down (red) vs last month"
        >
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={techs} layout="vertical" margin={{ left: 8, right: 36 }}>
              <XAxis type="number" tickFormatter={(v: number) => formatCurrency(v)} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: token('--border-soft'), opacity: 0.5 }} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="revenue" radius={[0, 6, 6, 0]} barSize={20}>
                <LabelList dataKey="revenue" position="right" formatter={(v: number) => formatCurrency(v)} style={chartLabelStyle} />
                {techs.map((t) => (
                  <Cell key={t.name} fill={t.revenue >= t.prevRevenue ? token('--success') : token('--danger')} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Weekly revenue trend — who's rising / falling over 8 weeks */}
        <ChartCard
          title="Weekly revenue trend"
          subtitle="Last 8 weeks of completed revenue per tech"
        >
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendData} margin={{ left: 4, right: 8, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v: number) => formatCurrency(v)} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={88} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              {techs.map((t, i) => (
                <Line key={t.name} type="monotone" dataKey={t.name} stroke={chartPalette[i % chartPalette.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Close rate vs benchmark bands */}
      <ChartCard
        title="Close rate vs benchmark"
        subtitle={`Floor ${CLOSE_FLOOR}% · Excellence ${CLOSE_GOOD}%+ — bars: red below floor, amber acceptable, green excellent`}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={techs} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={36} />
            <Tooltip cursor={{ fill: token('--border-soft'), opacity: 0.5 }} formatter={(v: number) => `${v}%`} />
            <ReferenceLine y={CLOSE_FLOOR} stroke={token('--danger')} strokeDasharray="6 4" strokeOpacity={0.6} label={{ value: 'floor 30%', position: 'right', fill: token('--danger'), fontSize: 10 }} />
            <ReferenceLine y={CLOSE_GOOD} stroke={token('--success')} strokeDasharray="6 4" strokeOpacity={0.6} label={{ value: 'goal 70%', position: 'right', fill: token('--success'), fontSize: 10 }} />
            <Bar dataKey="closeRate" radius={[6, 6, 0, 0]} barSize={36}>
              <LabelList dataKey="closeRate" position="top" formatter={(v: number) => `${v}%`} style={chartLabelStyle} />
              {techs.map((t) => (
                <Cell key={t.name} fill={closeBandColor(t.closeRate)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Leaderboard */}
      <div className="space-y-3">
        <div>
          <Heading level={2}>Leaderboard</Heading>
          <p className="text-xs text-text-secondary">Ranked by completed revenue · deltas vs last month · drag column edges to resize, click headers to sort</p>
        </div>
        <ResizableTable
          rows={techs}
          getRowKey={(t) => t.name}
          empty={<EmptyState title="No technicians match these filters." />}
          columns={[
            {
              id: 'rank',
              header: '#',
              width: 70,
              min: 55,
              grow: 0,
              align: 'right',
              cell: (t) => <span className="tabular-nums text-text-secondary">{t.rank}</span>,
              sortValue: (t) => t.rank,
              footer: <span className="text-text-secondary">{techs.length}</span>,
            },
            {
              id: 'name',
              header: 'Technician',
              width: 200,
              min: 170,
              sortValue: (t) => t.name,
              cell: (t) => (
                <div className="min-w-0">
                  <div className="font-medium text-text-primary">
                    {t.name}
                    {!t.active && <span className="ml-2 rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">inactive</span>}
                  </div>
                  <div className="text-xs text-text-secondary">{t.bu}</div>
                </div>
              ),
              footer: <span>Team total</span>,
            },
            {
              id: 'revenue',
              header: 'Revenue',
              width: 140,
              min: 120,
              align: 'right',
              sortValue: (t) => t.revenue,
              cell: (t) => (
                <div>
                  <div className="font-semibold tabular-nums text-text-primary">{formatCurrency(t.revenue)}</div>
                  <div className="flex justify-end"><Delta value={pctDelta(t.revenue, t.prevRevenue)} /></div>
                </div>
              ),
              footer: <span className="tabular-nums">{formatCurrency(totalRev)}</span>,
            },
            {
              id: 'closeRate',
              header: 'Close rate',
              width: 130,
              min: 110,
              align: 'right',
              sortValue: (t) => t.closeRate,
              cell: (t) => (
                <div>
                  <div className="tabular-nums text-text-primary">{t.closeRate}%</div>
                  <div className="flex justify-end"><Delta value={t.closeRate - t.prevCloseRate} suffix="pp" /></div>
                </div>
              ),
              footer: <span className="tabular-nums">{avgClose}%</span>,
            },
            {
              id: 'avgTicket',
              header: 'Avg ticket',
              width: 130,
              min: 110,
              align: 'right',
              sortValue: (t) => t.avgTicket,
              cell: (t) => (
                <div>
                  <div className="tabular-nums text-text-primary">{formatCurrency(t.avgTicket)}</div>
                  <div className="flex justify-end"><Delta value={pctDelta(t.avgTicket, t.prevAvgTicket)} /></div>
                </div>
              ),
              footer: <span className="tabular-nums">{formatCurrency(avgTicket)}</span>,
            },
            {
              id: 'memberships',
              header: 'Memb.',
              width: 100,
              min: 85,
              align: 'right',
              sortValue: (t) => t.memberships,
              cell: (t) => <span className="tabular-nums text-text-primary">{t.memberships}</span>,
              footer: <span className="tabular-nums">{memberships}</span>,
            },
            {
              id: 'leadsSet',
              header: 'Leads',
              width: 100,
              min: 85,
              align: 'right',
              sortValue: (t) => t.leadsSet,
              cell: (t) => <span className="tabular-nums text-text-primary">{t.leadsSet}</span>,
              footer: <span className="tabular-nums">{leadsSet}</span>,
            },
            {
              id: 'trend',
              header: '8-wk trend',
              width: 130,
              min: 110,
              align: 'right',
              cell: (t) => (
                <div className="flex justify-end">
                  <Sparkline data={t.weekly} color={t.revenue >= t.prevRevenue ? token('--success') : token('--danger')} />
                </div>
              ),
            },
          ]}
        />
      </div>

      <p className="text-xs text-text-secondary">
        Sample data for layout review. Revenue credits the performed-by technician (full credit; multiple techs on a
        job each get full credit). Filters, date anchors, and live data are wired after this layout is approved.
      </p>
    </ReportShell>
  );
}

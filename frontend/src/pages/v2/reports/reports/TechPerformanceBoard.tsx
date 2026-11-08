import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { BadgeCheck, DollarSign, Percent, Receipt, Trophy, Users } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { chartPalette, token } from '@/design-system';
import { findReport } from '@/lib/reports/report-catalog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { Delta, MultiSelectFilter, Sparkline } from '../components/shared';

/**
 * S3 · Technician Performance Board.
 *
 * Rendered from in-file SAMPLE data so the layout can be reviewed before the
 * backend aggregations are wired. The dataset is carried over unchanged. Per
 * the triage attribution standard this is an ops/tech report: 100% of job
 * revenue credits the PERFORMED-BY technician, and multiple techs on one job
 * each get full credit. Spec: docs/reporting/SERVWAVE_REPORT_CATALOG.md (S3).
 *
 * THREE CHART COLOUR DECISIONS ARE DATA AND ARE UNTOUCHED:
 *   - the revenue bar is green when the tech is up on last month, red when down;
 *   - the close-rate bar reads the benchmark band (below the 30% floor red,
 *     acceptable amber, at or above the 70% goal green) and the two
 *     `ReferenceLine`s use the matching tokens;
 *   - each row's sparkline uses the same up/down pair as its revenue bar.
 * `chartPalette` still gives each tech a stable line colour in the weekly trend.
 *
 * `Delta` and `Sparkline` were defined twice - once here and once in the shared
 * module - with identical bodies. This file now imports the shared pair, which
 * is the same behaviour with one definition.
 *
 * Shape difference: the active/inactive filter was a raw two-state pill (a
 * brand-tinted active state with no matching Button cell). It is now a kit
 * Button that toggles `variant`, and it carries `aria-pressed`, which the raw
 * control never did.
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

// Sample data (8-week window, "this month" vs prior month).
const TECHS: Tech[] = [
  { name: 'Marcus Bell', bu: 'HVAC', active: true, revenue: 184200, prevRevenue: 162400, closeRate: 72, prevCloseRate: 68, avgTicket: 4120, prevAvgTicket: 3980, memberships: 14, prevMemberships: 11, leadsSet: 22, prevLeadsSet: 19, weekly: [19500, 21000, 20400, 23800, 22600, 24900, 25200, 26800] },
  { name: 'Sofia Reyes', bu: 'HVAC', active: true, revenue: 167800, prevRevenue: 171200, closeRate: 64, prevCloseRate: 70, avgTicket: 3870, prevAvgTicket: 4010, memberships: 9, prevMemberships: 12, leadsSet: 18, prevLeadsSet: 17, weekly: [22400, 21600, 20800, 19900, 20100, 19400, 21800, 21800] },
  { name: 'Devon Clark', bu: 'Plumbing', active: true, revenue: 142500, prevRevenue: 118300, closeRate: 58, prevCloseRate: 49, avgTicket: 3260, prevAvgTicket: 2980, memberships: 7, prevMemberships: 5, leadsSet: 20, prevLeadsSet: 16, weekly: [14200, 15600, 16100, 17400, 18200, 19800, 20300, 20900] },
  { name: 'Priya Nair', bu: 'Electrical', active: true, revenue: 131900, prevRevenue: 134800, closeRate: 61, prevCloseRate: 63, avgTicket: 3540, prevAvgTicket: 3610, memberships: 6, prevMemberships: 6, leadsSet: 15, prevLeadsSet: 16, weekly: [17800, 16900, 16400, 16800, 16200, 15900, 15600, 16300] },
  { name: 'Tyler Brooks', bu: 'HVAC', active: true, revenue: 98600, prevRevenue: 88200, closeRate: 47, prevCloseRate: 44, avgTicket: 2890, prevAvgTicket: 2750, memberships: 4, prevMemberships: 3, leadsSet: 12, prevLeadsSet: 11, weekly: [11200, 11800, 12100, 12600, 12900, 12400, 13100, 12500] },
  { name: 'Aisha Khan', bu: 'Plumbing', active: false, revenue: 54300, prevRevenue: 79900, closeRate: 39, prevCloseRate: 52, avgTicket: 2480, prevAvgTicket: 2710, memberships: 2, prevMemberships: 4, leadsSet: 7, prevLeadsSet: 12, weekly: [13800, 11200, 9600, 8100, 6400, 3200, 1100, 900] },
];

// Close-rate benchmark bands (from the S3 spec).
const CLOSE_FLOOR = 30;
const CLOSE_GOOD = 70;

const pctDelta = (cur: number, prev: number) => (prev === 0 ? null : ((cur - prev) / prev) * 100);

// Severity-style band colors read from semantic tokens (good -> acceptable -> poor).
const closeBandColor = (r: number) =>
  r >= CLOSE_GOOD ? token('--success') : r >= CLOSE_FLOOR ? token('--warning') : token('--danger');

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


  // Weekly trend -> one series per tech.
  const weeks = Array.from({ length: 8 }, (_, i) => `W${i + 1}`);
  const trendData = weeks.map((week, i) => {
    const row: Record<string, number | string> = { week };
    techs.forEach((t) => (row[t.name] = t.weekly[i] ?? 0));
    return row;
  });

  type Row = (typeof techs)[number];

  const columns: ReportColumn<Row>[] = [
    {
      id: 'rank', header: '#', width: 70, min: 55, grow: 0, align: 'right',
      cell: (t) => <span className="text-muted-foreground tabular-nums">{t.rank}</span>,
      sortValue: (t) => t.rank,
      footer: <span>{techs.length}</span>,
    },
    {
      id: 'name', header: 'Technician', width: 200, min: 170, sortValue: (t) => t.name,
      cell: (t) => (
        <div className="min-w-0">
          <div className="font-medium">
            {t.name}
            {!t.active && <Badge variant="softNeutral" size="sm" className="ml-2">inactive</Badge>}
          </div>
          <div className="text-muted-foreground text-xs">{t.bu}</div>
        </div>
      ),
      footer: <span>Team total</span>,
    },
    {
      id: 'revenue', header: 'Revenue', width: 140, min: 120, align: 'right', sortValue: (t) => t.revenue,
      cell: (t) => (
        <div>
          <div className="font-semibold tabular-nums">{formatCurrency(t.revenue)}</div>
          <div className="flex justify-end"><Delta value={pctDelta(t.revenue, t.prevRevenue)} /></div>
        </div>
      ),
      footer: <span className="tabular-nums">{formatCurrency(totalRev)}</span>,
    },
    {
      id: 'closeRate', header: 'Close rate', width: 130, min: 110, align: 'right', sortValue: (t) => t.closeRate,
      cell: (t) => (
        <div>
          <div className="tabular-nums">{t.closeRate}%</div>
          <div className="flex justify-end"><Delta value={t.closeRate - t.prevCloseRate} suffix="pp" /></div>
        </div>
      ),
      footer: <span className="tabular-nums">{avgClose}%</span>,
    },
    {
      id: 'avgTicket', header: 'Avg ticket', width: 130, min: 110, align: 'right', sortValue: (t) => t.avgTicket,
      cell: (t) => (
        <div>
          <div className="tabular-nums">{formatCurrency(t.avgTicket)}</div>
          <div className="flex justify-end"><Delta value={pctDelta(t.avgTicket, t.prevAvgTicket)} /></div>
        </div>
      ),
      footer: <span className="tabular-nums">{formatCurrency(avgTicket)}</span>,
    },
    {
      id: 'memberships', header: 'Memb.', width: 100, min: 85, align: 'right', sortValue: (t) => t.memberships,
      cell: (t) => <span className="tabular-nums">{t.memberships}</span>,
      footer: <span className="tabular-nums">{memberships}</span>,
    },
    {
      id: 'leadsSet', header: 'Leads', width: 100, min: 85, align: 'right', sortValue: (t) => t.leadsSet,
      cell: (t) => <span className="tabular-nums">{t.leadsSet}</span>,
      footer: <span className="tabular-nums">{leadsSet}</span>,
    },
    {
      id: 'trend', header: '8-wk trend', width: 130, min: 110, align: 'right',
      cell: (t) => (
        <div className="flex justify-end">
          <Sparkline data={t.weekly} color={t.revenue >= t.prevRevenue ? token('--success') : token('--danger')} />
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
          <MultiSelectFilter
            label="Technician"
            options={TECHS.map((t) => t.name)}
            selected={selectedTechs}
            onChange={setSelectedTechs}
          />
          <Select value={bu} onValueChange={(v) => setBu(v as 'All' | BU)}>
            <SelectTrigger aria-label="Business unit" size="sm" className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All business units</SelectItem>
              <SelectItem value="HVAC">HVAC</SelectItem>
              <SelectItem value="Plumbing">Plumbing</SelectItem>
              <SelectItem value="Electrical">Electrical</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            aria-pressed={showInactive}
            variant={showInactive ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setShowInactive((s) => !s)}
          >
            {showInactive ? 'Showing inactive' : 'Active techs only'}
          </Button>
        </>
      }
    >
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Completed Revenue', value: formatCurrency(totalRev), tone: 'success', emphasize: true },
          { icon: Percent, label: 'Avg Close Rate', value: `${avgClose}%`, tone: 'primary' },
          { icon: Receipt, label: 'Avg Ticket', value: formatCurrency(avgTicket), tone: 'neutral' },
          { icon: BadgeCheck, label: 'Memberships Sold', value: memberships, tone: 'primary' },
          { icon: Users, label: 'Leads Set', value: leadsSet, tone: 'neutral' },
          { icon: Trophy, label: 'Top Performer', value: top?.name ?? '-', tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <ChartCard title="Weekly revenue trend" subtitle="Last 8 weeks of completed revenue per tech">
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

      <ChartCard
        title="Close rate vs benchmark"
        subtitle={`Floor ${CLOSE_FLOOR}% · Excellence ${CLOSE_GOOD}%+ - bars: red below floor, amber acceptable, green excellent`}
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

      <div className="space-y-3">
        <div>
          <ReportHeading level={2} scale="lg">Leaderboard</ReportHeading>
          <p className="text-muted-foreground text-xs">
            Ranked by completed revenue · deltas vs last month · drag column edges to resize, click headers to sort
          </p>
        </div>
        <ReportTable
          rows={techs}
          getRowKey={(t) => t.name}
          empty={<EmptyState title="No technicians match these filters." />}
          columns={columns}
        />
        <ReportTableTotals columns={columns} />
      </div>

      <p className="text-muted-foreground text-xs">
        Sample data for layout review. Revenue credits the performed-by technician (full credit; multiple techs on a
        job each get full credit). Filters, date anchors, and live data are wired after this layout is approved.
      </p>
    </ReportShell>
  );
}

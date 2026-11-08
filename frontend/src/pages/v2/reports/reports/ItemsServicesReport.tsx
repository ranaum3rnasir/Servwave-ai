import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, Building2, ChevronRight, DollarSign, Hash, Hourglass, Percent, User,
} from 'lucide-react';

import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { token } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { buildItemsServices, buildWeeklyVariance } from '@/lib/reports/items-services-data';
import {
  companyKpis, technicianIds, technicianRows, technicianSummary,
  type ItemServiceStat,
} from '@/lib/reports/items-services-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, type ReportColumn } from '../components/reportTable';
import { MultiSelectFilter } from '../components/shared';

/**
 * Items & Services - two views over the same stats, Company and Technician.
 *
 * All the arithmetic is imported: `buildItemsServices` / `buildWeeklyVariance`
 * make the deterministic dataset, and `companyKpis` / `technicianIds` /
 * `technicianRows` / `technicianSummary` are the roll-ups that
 * `items-services-logic.ts` exists to mirror to the future backend service.
 * Nothing here recomputes any of it.
 *
 * THE TWO CHARTS ARE UNTOUCHED - a bar is red when a job ran OVER expected and
 * green when it ran under, in both the weekly-movers chart and the eight-week
 * trend, and `varianceColor` gives the table cells the same reading.
 *
 * Two shape differences, both from the kit:
 *   - the Company/Technician segmented pill is a `role="radiogroup"` of two kit
 *     Buttons (the kit ships no toggle group, and the raw-tag ratchet is at its
 *     floor so it could not stay a raw button pair);
 *   - the "over by more than 15%" row tint is gone. The kit's DataTable has no
 *     per-row className, and the same signal is already in the vs-Exp cell,
 *     which is red past +5%.
 */

const min = (n: number) => `${Math.round(n)}m`;
const pct = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const usd0 = (n: number) => formatCurrencyWhole(n);
const varianceColor = (v: number) =>
  v > 5 ? 'text-status-red-emphasis' : v < -5 ? 'text-status-green-emphasis' : 'text-muted-foreground';

type View = 'company' | 'technician';

export default function ItemsServicesReport() {
  const report = findReport('items-and-services')!;
  const allStats = useMemo(() => buildItemsServices(), []);
  const categories = useMemo(() => Array.from(new Set(allStats.map((s) => s.category))), [allStats]);
  const techs = useMemo(() => technicianIds(allStats), [allStats]);

  const [view, setView] = useState<View>('company');
  const [cats, setCats] = useState<string[]>([]);
  const [techId, setTechId] = useState<string>(techs[0]?.id ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);

  const stats = useMemo(
    () => allStats.filter((s) => cats.length === 0 || cats.includes(s.category)),
    [allStats, cats],
  );
  const kpis = useMemo(() => companyKpis(stats), [stats]);
  const weekly = useMemo(() => buildWeeklyVariance(), []);

  const techName = (id: string) => techs.find((t) => t.id === id)?.name ?? '-';

  // "Took longer than expected this week" - top movers by weekly variance.
  const weekChart = useMemo(
    () => [...stats]
      .sort((a, b) => b.weekVariancePct - a.weekVariancePct)
      .slice(0, 8)
      .map((s) => ({ name: s.name, v: Math.round(s.weekVariancePct) })),
    [stats],
  );

  return (
    <ReportShell
      report={report}
      subtitle="Per-item & per-service margin, time vs expected, and who does each best"
      actions={
        <>
          <Badge variant="softAmber" size="pill">Sample data</Badge>
          <div role="radiogroup" aria-label="View" className="flex items-center gap-1">
            <Button
              type="button"
              role="radio"
              aria-checked={view === 'company'}
              variant={view === 'company' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setView('company')}
            >
              <Building2 />
              Company
            </Button>
            <Button
              type="button"
              role="radio"
              aria-checked={view === 'technician'}
              variant={view === 'technician' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setView('technician')}
            >
              <User />
              Technician
            </Button>
          </div>
          <MultiSelectFilter label="Category" options={categories} selected={cats} onChange={setCats} />
        </>
      }
    >
      {view === 'company' ? (
        <CompanyView
          stats={stats}
          kpis={kpis}
          weekChart={weekChart}
          weekly={weekly}
          expanded={expanded}
          setExpanded={setExpanded}
          techName={techName}
        />
      ) : (
        <TechnicianView stats={stats} techs={techs} techId={techId} setTechId={setTechId} />
      )}
    </ReportShell>
  );
}

function CompanyView({
  stats, kpis, weekChart, weekly, expanded, setExpanded, techName,
}: {
  stats: ItemServiceStat[];
  kpis: ReturnType<typeof companyKpis>;
  weekChart: { name: string; v: number }[];
  weekly: { week: string; variancePct: number }[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  techName: (id: string) => string;
}) {
  const expandedStat = expanded ? stats.find((s) => s.id === expanded) ?? null : null;

  const columns: ReportColumn<ItemServiceStat>[] = [
    {
      id: 'name', header: 'Item / Service', width: 220, min: 180,
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5 font-medium">
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded === s.id && 'rotate-90')} />
          <span className="truncate">{s.name}</span>
        </span>
      ),
    },
    { id: 'category', header: 'Category', width: 150, min: 120, sortValue: (s) => s.category, cell: (s) => <span className="text-muted-foreground">{s.category}</span> },
    { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (s) => s.timesDone, cell: (s) => <span className="tabular-nums">{s.timesDone}</span> },
    { id: 'expectedMin', header: 'Expected', width: 110, min: 90, align: 'right', sortValue: (s) => s.expectedMin, cell: (s) => <span className="text-muted-foreground tabular-nums">{min(s.expectedMin)}</span> },
    { id: 'actualMin', header: 'Actual', width: 100, min: 85, align: 'right', sortValue: (s) => s.actualMin, cell: (s) => <span className="tabular-nums">{min(s.actualMin)}</span> },
    { id: 'variancePct', header: 'Variance', width: 110, min: 95, align: 'right', sortValue: (s) => s.variancePct, cell: (s) => <span className={cn('font-medium tabular-nums', varianceColor(s.variancePct))}>{pct(s.variancePct)}</span> },
    { id: 'gpPct', header: 'GP%', width: 90, min: 75, align: 'right', sortValue: (s) => s.gpPct, cell: (s) => <span className="tabular-nums">{Math.round(s.gpPct)}%</span> },
    { id: 'bestTech', header: 'Best tech', width: 150, min: 120, sortValue: (s) => (s.bestTechId ? techName(s.bestTechId) : null), cell: (s) => <span className="text-status-green-emphasis">{s.bestTechId ? techName(s.bestTechId) : '-'}</span> },
    { id: 'slowestTech', header: 'Slowest', width: 150, min: 120, sortValue: (s) => (s.slowestTechId ? techName(s.slowestTechId) : null), cell: (s) => <span className="text-status-red-emphasis">{s.slowestTechId ? techName(s.slowestTechId) : '-'}</span> },
  ];

  return (
    <>
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Gross profit', value: usd0(kpis.gpDollars), tone: 'success', emphasize: true },
          { icon: Percent, label: 'Avg margin', value: `${Math.round(kpis.marginPct)}%`, tone: 'primary' },
          { icon: Hourglass, label: 'Time vs expected', value: pct(kpis.timeVsExpectedPct), tone: kpis.timeVsExpectedPct > 0 ? 'danger' : 'success' },
          { icon: Hash, label: 'Items / services', value: kpis.itemCount, tone: 'neutral' },
          { icon: AlertTriangle, label: 'Biggest slip (wk)', value: kpis.biggestSlip?.name ?? '-', tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Took longer than expected - this week"
          subtitle="% over/under expected time · red = over, green = under"
        >
          <ResponsiveContainer width="100%" height={Math.max(160, weekChart.length * 34)}>
            <BarChart data={weekChart} layout="vertical" margin={{ left: 8, right: 48 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={token('--border-color')} />
              <XAxis type="number" tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v: number) => `${v}%`} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
              <Bar dataKey="v" radius={[0, 6, 6, 0]} barSize={16} isAnimationActive={false}>
                <LabelList dataKey="v" position="right" formatter={(v: number) => `${v}%`} style={chartLabelStyle} />
                {weekChart.map((d) => <Cell key={d.name} fill={d.v > 0 ? token('--danger') : token('--success')} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard
          title="Actual vs expected - last 8 weeks"
          subtitle="Avg variance per week · red = over, green = under"
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={weekly} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={token('--border-color')} />
              <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={40} />
              <Tooltip formatter={(v: number) => `${v}%`} />
              <Bar dataKey="variancePct" radius={[6, 6, 0, 0]} barSize={20} isAnimationActive={false}>
                {weekly.map((d) => <Cell key={d.week} fill={d.variancePct > 0 ? token('--danger') : token('--success')} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="space-y-3">
        <Card>
          <ReportHeading level={2} scale="lg">Items &amp; Services breakdown</ReportHeading>
          <p className="text-muted-foreground text-xs">Click a row to see the per-technician breakdown</p>
        </Card>
        <ReportTable
          rows={stats}
          getRowKey={(s) => s.id}
          onRowClick={(s) => setExpanded(expanded === s.id ? null : s.id)}
          empty={<EmptyState title="No items or services match these filters." />}
          columns={columns}
        />
        {expandedStat && (
          <div className="space-y-2">
            <ReportHeading level={3} scale="sm" className="text-muted-foreground tracking-wide uppercase">
              {expandedStat.name} - per-technician breakdown
            </ReportHeading>
            <ReportTable
              rows={expandedStat.byTech}
              getRowKey={(t) => t.techId}
              empty={<EmptyState title="No technician data for this item." />}
              columns={[
                {
                  id: 'tech', header: 'Technician', width: 200, min: 160,
                  sortValue: (t) => t.techName,
                  cell: (t) => (
                    <span className="font-medium">
                      {t.techName}
                      {t.lowConfidence && (
                        <Badge variant="softNeutral" size="sm" className="ml-1.5">low confidence</Badge>
                      )}
                    </span>
                  ),
                },
                { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (t) => t.timesDone, cell: (t) => <span className="tabular-nums">{t.timesDone}</span> },
                { id: 'actualMin', header: 'Actual', width: 100, min: 85, align: 'right', sortValue: (t) => t.actualMin, cell: (t) => <span className="tabular-nums">{min(t.actualMin)}</span> },
                { id: 'vsExpectedPct', header: 'vs Exp', width: 100, min: 85, align: 'right', sortValue: (t) => t.vsExpectedPct, cell: (t) => <span className={cn('tabular-nums', varianceColor(t.vsExpectedPct))}>{pct(t.vsExpectedPct)}</span> },
                { id: 'ftfPct', header: 'FTF', width: 90, min: 75, align: 'right', sortValue: (t) => t.ftfPct, cell: (t) => <span className="tabular-nums">{Math.round(t.ftfPct)}%</span> },
                { id: 'gpPct', header: 'GP%', width: 90, min: 75, align: 'right', sortValue: (t) => t.gpPct, cell: (t) => <span className="tabular-nums">{Math.round(t.gpPct)}%</span> },
                { id: 'grade', header: 'Score', width: 90, min: 75, align: 'right', sortValue: (t) => t.score, cell: (t) => <span className="font-semibold tabular-nums">{t.grade}</span> },
              ]}
            />
          </div>
        )}
      </div>
    </>
  );
}

function TechnicianView({
  stats, techs, techId, setTechId,
}: {
  stats: ItemServiceStat[];
  techs: { id: string; name: string }[];
  techId: string;
  setTechId: (id: string) => void;
}) {
  const rows = useMemo(() => technicianRows(stats, techId), [stats, techId]);
  const summary = useMemo(() => technicianSummary(rows), [rows]);

  return (
    <>
      <div className="flex items-center gap-3">
        <SelectField
          value={techId}
          onValueChange={setTechId}
          aria-label="Technician"
          size="sm"
          className="w-[200px]"
          options={techs.map((t) => ({ value: t.id, label: t.name }))}
        />
        <span className="text-muted-foreground text-sm">
          Overall grade <b className="text-foreground">{summary.grade}</b> · {summary.jobs} jobs
        </span>
      </div>

      <ReportKpis
        items={[
          { icon: Hourglass, label: 'His time vs expected', value: pct(summary.vsExpectedPct), tone: summary.vsExpectedPct > 0 ? 'danger' : 'success' },
          { icon: Percent, label: 'First-time fix', value: `${Math.round(summary.ftfPct)}%`, tone: 'primary' },
          { icon: DollarSign, label: 'GP / job', value: usd0(summary.gpPerJob), tone: 'success', emphasize: true },
          { icon: Building2, label: 'Best at', value: summary.bestAt?.itemName ?? '-', tone: 'success' },
          { icon: AlertTriangle, label: 'Needs work', value: summary.needsWork?.itemName ?? '-', tone: 'danger' },
        ]}
      />

      <div className="space-y-3">
        <Card>
          <ReportHeading level={2} scale="lg">Every item / service this technician performs</ReportHeading>
          <p className="text-muted-foreground text-xs">vs their expected time and vs the team average</p>
        </Card>
        <ReportTable
          rows={rows}
          getRowKey={(r) => r.itemId}
          empty={<EmptyState title="No items on record for this technician." />}
          columns={[
            { id: 'itemName', header: 'Item / Service', width: 220, min: 180, sortValue: (r) => r.itemName, cell: (r) => <span className="font-medium">{r.itemName}</span> },
            { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (r) => r.timesDone, cell: (r) => <span className="tabular-nums">{r.timesDone}</span> },
            { id: 'expectedMin', header: 'Expected', width: 110, min: 90, align: 'right', sortValue: (r) => r.expectedMin, cell: (r) => <span className="text-muted-foreground tabular-nums">{min(r.expectedMin)}</span> },
            { id: 'actualMin', header: 'His actual', width: 110, min: 90, align: 'right', sortValue: (r) => r.actualMin, cell: (r) => <span className="tabular-nums">{min(r.actualMin)}</span> },
            { id: 'vsExpectedPct', header: 'vs Exp', width: 100, min: 85, align: 'right', sortValue: (r) => r.vsExpectedPct, cell: (r) => <span className={cn('tabular-nums', varianceColor(r.vsExpectedPct))}>{pct(r.vsExpectedPct)}</span> },
            { id: 'vsTeamPct', header: 'vs Team', width: 100, min: 85, align: 'right', sortValue: (r) => r.vsTeamPct, cell: (r) => <span className={cn('tabular-nums', varianceColor(r.vsTeamPct))}>{r.vsTeamPct < -5 ? 'faster' : r.vsTeamPct > 5 ? 'slower' : '~ avg'}</span> },
            { id: 'ftfPct', header: 'FTF', width: 90, min: 75, align: 'right', sortValue: (r) => r.ftfPct, cell: (r) => <span className="tabular-nums">{Math.round(r.ftfPct)}%</span> },
            { id: 'gpPct', header: 'GP%', width: 90, min: 75, align: 'right', sortValue: (r) => r.gpPct, cell: (r) => <span className="tabular-nums">{Math.round(r.gpPct)}%</span> },
            { id: 'grade', header: 'Score', width: 90, min: 75, align: 'right', sortValue: (r) => r.score, cell: (r) => <span className="font-semibold tabular-nums">{r.grade}</span> },
          ]}
        />
      </div>
    </>
  );
}

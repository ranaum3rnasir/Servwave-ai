// ───────────────────────────────────────────────────────────────────────────
// Items & Services report (mock-first, bespoke). Two views:
//   • Company    — every item/service, grouped logic-side by category, with a
//                  per-technician expandable breakdown.
//   • Technician — one tech's scorecard for every item/service they perform.
// Wire to GET /api/reports/items-and-services later; items-services-logic.ts
// mirrors to the backend service.
// ───────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList,
} from 'recharts';
import { DollarSign, Percent, Hourglass, Hash, AlertTriangle, Building2, User, ChevronRight } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { token } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { MultiSelectFilter } from './_shared';
import { buildItemsServices, buildWeeklyVariance } from '@/lib/reports/items-services-data';
import {
  companyKpis, technicianIds, technicianRows, technicianSummary,
  type ItemServiceStat, type TechItemStat, type TechRow,
} from '@/lib/reports/items-services-logic';

const min = (n: number) => `${Math.round(n)}m`;
const pct = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const usd0 = (n: number) => formatCurrencyWhole(n);
const varianceColor = (v: number) => (v > 5 ? 'text-danger' : v < -5 ? 'text-success' : 'text-text-secondary');

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

  const techName = (id: string) => techs.find((t) => t.id === id)?.name ?? '—';

  // "Took longer than expected this week" — top movers by weekly variance.
  const weekChart = useMemo(
    () => [...stats].sort((a, b) => b.weekVariancePct - a.weekVariancePct).slice(0, 8)
      .map((s) => ({ name: s.name, v: Math.round(s.weekVariancePct) })),
    [stats],
  );

  return (
    <ReportShell
      report={report}
      subtitle="Per-item & per-service margin, time vs expected, and who does each best"
      actions={
        <>
          <span className="rounded-full bg-warning/10 px-2 py-1 text-xs font-medium text-warning">Sample data</span>
          {/* Segmented Company/Technician view toggle (persistent bg-primary active
              pill vs muted idle), not Button-shaped - left raw, matching the same
              pattern in LinkedEntitySelect.tsx's type toggle. */}
          <div className="inline-flex rounded-lg bg-background-light p-0.5 text-sm font-medium">
            <button
              type="button"
              aria-pressed={view === 'company'}
              onClick={() => setView('company')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${view === 'company' ? 'bg-primary text-on-fill' : 'text-text-secondary hover:text-text-primary'}`}
            >
              <Building2 className="h-4 w-4" /> Company
            </button>
            <button
              type="button"
              aria-pressed={view === 'technician'}
              onClick={() => setView('technician')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 ${view === 'technician' ? 'bg-primary text-on-fill' : 'text-text-secondary hover:text-text-primary'}`}
            >
              <User className="h-4 w-4" /> Technician
            </button>
          </div>
          <MultiSelectFilter label="Category" options={categories} selected={cats} onChange={setCats} />
        </>
      }
    >
      {view === 'company'
        ? <CompanyView stats={stats} kpis={kpis} weekChart={weekChart} weekly={weekly} expanded={expanded} setExpanded={setExpanded} techName={techName} />
        : <TechnicianView stats={stats} techs={techs} techId={techId} setTechId={setTechId} />}
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
  return (
    <>
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Gross profit', value: usd0(kpis.gpDollars), tone: 'success', emphasize: true },
          { icon: Percent, label: 'Avg margin', value: `${Math.round(kpis.marginPct)}%`, tone: 'primary' },
          { icon: Hourglass, label: 'Time vs expected', value: pct(kpis.timeVsExpectedPct), tone: kpis.timeVsExpectedPct > 0 ? 'danger' : 'success' },
          { icon: Hash, label: 'Items / services', value: kpis.itemCount, tone: 'neutral' },
          { icon: AlertTriangle, label: 'Biggest slip (wk)', value: kpis.biggestSlip?.name ?? '—', sub: kpis.biggestSlip ? pct(kpis.biggestSlip.weekVariancePct) : '', tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Took longer than expected — this week"
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
          title="Actual vs expected — last 8 weeks"
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
        <div className="rounded-xl border border-border bg-surface-light px-5 py-4 shadow-card">
          <Heading level={2}>Items &amp; Services breakdown</Heading>
          <p className="text-xs text-text-secondary">Click a row to see the per-technician breakdown</p>
        </div>
        <ResizableTable
          rows={stats}
          getRowKey={(s) => s.id}
          onRowClick={(s) => setExpanded(expanded === s.id ? null : s.id)}
          empty={<EmptyState title="No items or services match these filters." />}
          columns={[
            {
              id: 'name', header: 'Item / Service', width: 220, min: 180,
              sortValue: (s) => s.name,
              cell: (s) => (
                <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded === s.id ? 'rotate-90' : ''}`} />
                  <span className="truncate">{s.name}</span>
                </span>
              ),
            },
            { id: 'category', header: 'Category', width: 150, min: 120, sortValue: (s) => s.category, cell: (s) => <span className="text-text-secondary">{s.category}</span> },
            { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (s) => s.timesDone, cell: (s) => <span className="tabular-nums">{s.timesDone}</span> },
            { id: 'expectedMin', header: 'Expected', width: 110, min: 90, align: 'right', sortValue: (s) => s.expectedMin, cell: (s) => <span className="tabular-nums text-text-secondary">{min(s.expectedMin)}</span> },
            { id: 'actualMin', header: 'Actual', width: 100, min: 85, align: 'right', sortValue: (s) => s.actualMin, cell: (s) => <span className="tabular-nums">{min(s.actualMin)}</span> },
            { id: 'variancePct', header: 'Variance', width: 110, min: 95, align: 'right', sortValue: (s) => s.variancePct, cell: (s) => <span className={`font-medium tabular-nums ${varianceColor(s.variancePct)}`}>{pct(s.variancePct)}</span> },
            { id: 'gpPct', header: 'GP%', width: 90, min: 75, align: 'right', sortValue: (s) => s.gpPct, cell: (s) => <span className="tabular-nums">{Math.round(s.gpPct)}%</span> },
            { id: 'bestTech', header: 'Best tech', width: 150, min: 120, sortValue: (s) => (s.bestTechId ? techName(s.bestTechId) : null), cell: (s) => <span className="text-success">{s.bestTechId ? techName(s.bestTechId) : '—'}</span> },
            { id: 'slowestTech', header: 'Slowest', width: 150, min: 120, sortValue: (s) => (s.slowestTechId ? techName(s.slowestTechId) : null), cell: (s) => <span className="text-danger">{s.slowestTechId ? techName(s.slowestTechId) : '—'}</span> },
          ]}
        />
        {expandedStat && (
          <div className="space-y-2">
            {/* eyebrow style, no matching Heading variant - left raw */}
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {expandedStat.name} — per-technician breakdown
            </h3>
            <ResizableTable
              rows={expandedStat.byTech}
              getRowKey={(t) => t.techId}
              empty={<EmptyState title="No technician data for this item." />}
              columns={[
                {
                  id: 'tech', header: 'Technician', width: 200, min: 160,
                  sortValue: (t) => t.techName,
                  cell: (t) => (
                    <span className="font-medium text-text-primary">
                      {t.techName}
                      {t.lowConfidence && <span className="ml-1.5 rounded bg-background-light px-1 py-0.5 text-[10px] text-text-secondary">low confidence</span>}
                    </span>
                  ),
                },
                { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (t) => t.timesDone, cell: (t) => <span className="tabular-nums">{t.timesDone}</span> },
                { id: 'actualMin', header: 'Actual', width: 100, min: 85, align: 'right', sortValue: (t) => t.actualMin, cell: (t) => <span className="tabular-nums">{min(t.actualMin)}</span> },
                { id: 'vsExpectedPct', header: 'vs Exp', width: 100, min: 85, align: 'right', sortValue: (t) => t.vsExpectedPct, cell: (t) => <span className={`tabular-nums ${varianceColor(t.vsExpectedPct)}`}>{pct(t.vsExpectedPct)}</span> },
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
          aria-label="Technician"
          value={techId}
          onValueChange={setTechId}
          className="h-9"
          options={techs.map((t) => ({ value: t.id, label: t.name }))}
        />
        <span className="text-sm text-text-secondary">Overall grade <b className="text-text-primary">{summary.grade}</b> · {summary.jobs} jobs</span>
      </div>

      <KpiStrip
        items={[
          { icon: Hourglass, label: 'His time vs expected', value: pct(summary.vsExpectedPct), tone: summary.vsExpectedPct > 0 ? 'danger' : 'success' },
          { icon: Percent, label: 'First-time fix', value: `${Math.round(summary.ftfPct)}%`, tone: 'primary' },
          { icon: DollarSign, label: 'GP / job', value: usd0(summary.gpPerJob), tone: 'success', emphasize: true },
          { icon: Building2, label: 'Best at', value: summary.bestAt?.itemName ?? '—', sub: summary.bestAt ? pct(summary.bestAt.vsExpectedPct) : '', tone: 'success' },
          { icon: AlertTriangle, label: 'Needs work', value: summary.needsWork?.itemName ?? '—', sub: summary.needsWork ? pct(summary.needsWork.vsExpectedPct) : '', tone: 'danger' },
        ]}
      />

      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-surface-light px-5 py-4 shadow-card">
          <Heading level={2}>Every item / service this technician performs</Heading>
          <p className="text-xs text-text-secondary">vs their expected time and vs the team average</p>
        </div>
        <ResizableTable
          rows={rows}
          getRowKey={(r) => r.itemId}
          empty={<EmptyState title="No items on record for this technician." />}
          rowClassName={(r) => (r.vsExpectedPct > 15 ? 'bg-danger/5' : '')}
          columns={[
            { id: 'itemName', header: 'Item / Service', width: 220, min: 180, sortValue: (r) => r.itemName, cell: (r) => <span className="font-medium text-text-primary">{r.itemName}</span> },
            { id: 'timesDone', header: 'Done', width: 90, min: 75, align: 'right', sortValue: (r) => r.timesDone, cell: (r) => <span className="tabular-nums">{r.timesDone}</span> },
            { id: 'expectedMin', header: 'Expected', width: 110, min: 90, align: 'right', sortValue: (r) => r.expectedMin, cell: (r) => <span className="tabular-nums text-text-secondary">{min(r.expectedMin)}</span> },
            { id: 'actualMin', header: 'His actual', width: 110, min: 90, align: 'right', sortValue: (r) => r.actualMin, cell: (r) => <span className="tabular-nums">{min(r.actualMin)}</span> },
            { id: 'vsExpectedPct', header: 'vs Exp', width: 100, min: 85, align: 'right', sortValue: (r) => r.vsExpectedPct, cell: (r) => <span className={`tabular-nums ${varianceColor(r.vsExpectedPct)}`}>{pct(r.vsExpectedPct)}</span> },
            { id: 'vsTeamPct', header: 'vs Team', width: 100, min: 85, align: 'right', sortValue: (r) => r.vsTeamPct, cell: (r) => <span className={`tabular-nums ${varianceColor(r.vsTeamPct)}`}>{r.vsTeamPct < -5 ? 'faster' : r.vsTeamPct > 5 ? 'slower' : '~ avg'}</span> },
            { id: 'ftfPct', header: 'FTF', width: 90, min: 75, align: 'right', sortValue: (r) => r.ftfPct, cell: (r) => <span className="tabular-nums">{Math.round(r.ftfPct)}%</span> },
            { id: 'gpPct', header: 'GP%', width: 90, min: 75, align: 'right', sortValue: (r) => r.gpPct, cell: (r) => <span className="tabular-nums">{Math.round(r.gpPct)}%</span> },
            { id: 'grade', header: 'Score', width: 90, min: 75, align: 'right', sortValue: (r) => r.score, cell: (r) => <span className="font-semibold tabular-nums">{r.grade}</span> },
          ]}
        />
      </div>
    </>
  );
}

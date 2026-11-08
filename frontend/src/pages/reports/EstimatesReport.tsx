import { useState } from 'react';
import { FileText, FileEdit, Send, CheckCircle2, Trophy, XCircle, Archive, LayoutList, BarChart3, DollarSign, Percent, Hash } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { chartPalette, token } from '@/design-system/tokens';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { MultiSelectFilter } from './_shared';
import { Sparkline } from '@/components/reports/ReportIndicators';
import { EstimateDetailPanel } from './EstimateDetailPanel';
import { useEstimatesReport } from '@/lib/reports/estimates-report-data';
import { bucketStatus, BUCKET_LABEL, type EstimateRow, type StatusKey } from '@/lib/reports/estimates-report-logic';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, LabelList, Legend,
} from 'recharts';

type ViewMode = 'list' | 'by-rep';

// Revenue (won) is a positive data signal → brand green (chartPalette[0]).
const REVENUE_COLOR = chartPalette[0] ?? token('--success');

const STATUS_CARDS: { key: StatusKey; label: string; icon: typeof FileText }[] = [
  { key: 'all', label: 'All', icon: FileText },
  { key: 'unsent', label: 'Unsent', icon: FileEdit },
  // SENT only — see BUCKET_LABEL in estimates-report-logic.ts for why this is not "Pending".
  { key: 'pending', label: 'Awaiting Response', icon: Send },
  { key: 'approved', label: 'Approved', icon: CheckCircle2 },
  { key: 'won', label: 'Won', icon: Trophy },
  { key: 'declined', label: 'Declined', icon: XCircle },
  { key: 'archived', label: 'Archived', icon: Archive },
];

const DATE_PRESETS = [
  { key: 'all', label: 'All time' },
  { key: '30', label: '30d' },
  { key: '90', label: '90d' },
  { key: '365', label: '1y' },
];

// Per-rep trend series — calm categorical palette (cycles if more reps than colors).
const SERIES = chartPalette;

export default function EstimatesReport() {
  const report = findReport('estimates')!;
  const isDemo = useIsDemoOrg();
  const [view, setView] = useState<ViewMode>('list');
  const [status, setStatus] = useState<StatusKey>('all');
  const [repSel, setRepSel] = useState<string[]>([]); // MultiSelectFilter is multi; we keep the last pick as the single scope
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [openEstimate, setOpenEstimate] = useState<EstimateRow | null>(null);

  const rep = repSel[0] ?? null;
  const dateFrom = datePreset === 'all'
    ? null
    : new Date(Date.now() - Number(datePreset) * 86400000).toISOString().slice(0, 10);
  const { counts, listRows, kpis, breakdown, trend, reps } = useEstimatesReport({ status, rep, search, dateFrom }, isDemo);

  return (
    <ReportShell
      report={report}
      actions={isDemo ? <span className="rounded-full bg-warning-surface px-2 py-1 text-xs font-medium text-warning-text">Sample data</span> : undefined}
    >
      {/* Big status cards — clickable filters (count + worth) */}
      <KpiStrip
        items={STATUS_CARDS.map((c) => ({
          icon: c.icon,
          label: c.label,
          value: counts[c.key].count,
          sub: formatCurrency(counts[c.key].worth),
          tone: c.key === 'won' ? 'success' : c.key === 'declined' ? 'danger' : 'neutral',
          active: status === c.key,
          activeLabel: 'Filtered',
          onClick: () => setStatus(c.key),
        }))}
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* raw: segmented toggle control, not Button-shaped */}
        <div className="flex rounded-lg border border-border bg-surface-light p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => setView('list')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${view === 'list' ? 'bg-text-primary text-on-fill' : 'text-text-secondary hover:bg-background-light'}`}
          >
            <LayoutList className="h-3.5 w-3.5" /> List
          </button>
          <button
            type="button"
            onClick={() => setView('by-rep')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${view === 'by-rep' ? 'bg-text-primary text-on-fill' : 'text-text-secondary hover:bg-background-light'}`}
          >
            <BarChart3 className="h-3.5 w-3.5" /> By rep
          </button>
        </div>
        <MultiSelectFilter label="Rep" options={reps} selected={repSel} onChange={(next) => setRepSel(next.slice(-1))} />
        <div className="flex rounded-lg border border-border bg-surface-light p-0.5 shadow-sm">
          {/* raw: segmented toggle control, not Button-shaped */}
          {DATE_PRESETS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDatePreset(d.key)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${datePreset === d.key ? 'bg-text-primary text-on-fill' : 'text-text-secondary hover:bg-background-light'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search estimates"
          placeholder="Search estimate # or customer…"
          className="h-9 min-w-[220px] flex-1 rounded-lg border border-border bg-surface-light px-3 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        {/* outline/neutral, size="3xs" - closest text-xs rung; shrinks the raw's
            px-3/py-2 footprint to the 3xs rung's fixed h-6/px-2, disclosed rather
            than claimed exact. Idle text was explicit text-text-primary;
            outline/neutral leaves idle unset and relies on the inherited
            near-black default, which reads visually identical to the token. One
            more disclosed delta: the base font-semibold replaces the raw's
            font-medium. */}
        <Button type="button" variant="outline" tone="neutral" size="3xs" title="Coming soon">
          Export
        </Button>
      </div>

      {rep && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            Scoped to {rep}
            {/* raw: small close-X affordance, not Button-shaped */}
            <button type="button" onClick={() => setRepSel([])} aria-label="Clear rep scope" className="rounded-full p-0.5 hover:bg-primary/20">✕</button>
          </span>
        </div>
      )}

      {view === 'list' ? (
        <ResizableTable
          rows={listRows}
          getRowKey={(r) => r.id}
          onRowClick={(r) => setOpenEstimate(r)}
          empty={<EmptyState title="No estimates match these filters." />}
          columns={[
            { id: 'number', header: 'Estimate #', width: 120, min: 100, cell: (r) => <span className="font-medium text-text-primary">{r.number}</span>, sortValue: (r) => r.number },
            { id: 'customer', header: 'Customer', width: 180, min: 140, cell: (r) => r.customer, sortValue: (r) => r.customer },
            { id: 'rep', header: 'Rep', width: 140, min: 110, cell: (r) => r.rep, sortValue: (r) => r.rep },
            { id: 'created', header: 'Created', width: 120, min: 100, cell: (r) => r.createdAt, sortValue: (r) => r.createdAt },
            { id: 'amount', header: 'Amount', width: 120, min: 100, align: 'right', cell: (r) => <span className="font-semibold tabular-nums">{formatCurrency(r.amount)}</span>, sortValue: (r) => r.amount },
            { id: 'status', header: 'Status', width: 120, min: 100, cell: (r) => BUCKET_LABEL[bucketStatus(r)], sortValue: (r) => bucketStatus(r) },
            { id: 'deposit', header: 'Deposit due', width: 130, min: 110, align: 'right', cell: (r) => <span className="tabular-nums text-text-secondary">{formatCurrency(r.depositDue)}</span>, sortValue: (r) => r.depositDue },
          ]}
        />
      ) : (
        <div className="space-y-4">
          <KpiStrip
            items={[
              { icon: DollarSign, label: 'Total Revenue', value: formatCurrency(kpis.revenue), tone: 'success', emphasize: true },
              { icon: Percent, label: 'Win Rate', value: `${kpis.winRate}%`, tone: 'primary' },
              { icon: Hash, label: 'Avg Deal', value: formatCurrency(kpis.avgDeal), tone: 'neutral' },
              { icon: Trophy, label: 'Top Rep', value: kpis.topRep, tone: 'warning' },
            ]}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="Revenue by rep" subtitle="Won revenue per rep">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={breakdown} layout="vertical" margin={{ left: 8, right: 72 }}>
                  <XAxis type="number" tickFormatter={(v) => formatCurrency(Number(v))} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="rep" width={96} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} formatter={(v) => formatCurrency(Number(v))} />
                  <Bar dataKey="revenue" radius={[0, 6, 6, 0]} barSize={20} isAnimationActive={false}>
                    <LabelList dataKey="revenue" position="right" formatter={(v: number | string) => formatCurrency(Number(v))} style={chartLabelStyle} />
                    {breakdown.map((r) => (<Cell key={r.rep} fill={REVENUE_COLOR} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Weekly trend" subtitle="Last 8 weeks of revenue per rep">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trend} margin={{ left: 4, right: 8, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                  <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => formatCurrency(Number(v))} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={96} />
                  <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
                  {breakdown.map((r, i) => (
                    <Line key={r.rep} type="monotone" dataKey={r.rep} stroke={SERIES[i % SERIES.length] ?? REVENUE_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="space-y-2">
            <div>
              <Heading level={2}>Rep breakdown</Heading>
              <p className="text-xs text-text-secondary">Ranked by revenue · click a rep to scope the whole page to them</p>
            </div>
            <ResizableTable
              rows={breakdown}
              getRowKey={(r) => r.rep}
              onRowClick={(r) => setRepSel([r.rep])}
              empty={<EmptyState title="No reps match this filter." />}
              columns={[
                { id: 'rank', header: '#', width: 64, min: 50, grow: 0, cell: (r) => <span className="tabular-nums text-text-secondary">{r.rank}</span>, sortValue: (r) => r.rank },
                { id: 'rep', header: 'Rep', width: 170, min: 140, cell: (r) => <span className="font-medium text-text-primary">{r.rep}</span>, sortValue: (r) => r.rep },
                { id: 'revenue', header: 'Revenue', width: 140, min: 120, align: 'right', cell: (r) => <span className="font-semibold tabular-nums">{formatCurrency(r.revenue)}</span>, sortValue: (r) => r.revenue },
                { id: 'winRate', header: 'Win rate', width: 110, min: 90, align: 'right', cell: (r) => <span className="tabular-nums">{r.winRate}%</span>, sortValue: (r) => r.winRate },
                { id: 'avgDeal', header: 'Avg deal', width: 130, min: 110, align: 'right', cell: (r) => <span className="tabular-nums">{formatCurrency(r.avgDeal)}</span>, sortValue: (r) => r.avgDeal },
                { id: 'open', header: 'Open $', width: 130, min: 110, align: 'right', cell: (r) => <span className="tabular-nums text-text-secondary">{formatCurrency(r.openDollars)}</span>, sortValue: (r) => r.openDollars },
                { id: 'trend', header: '8-wk trend', width: 140, min: 120, align: 'right', cell: (r) => <div className="flex justify-end"><Sparkline data={r.weekly} color={REVENUE_COLOR} /></div> },
              ]}
            />
          </div>
        </div>
      )}

      <EstimateDetailPanel estimate={openEstimate} onClose={() => setOpenEstimate(null)} />
    </ReportShell>
  );
}

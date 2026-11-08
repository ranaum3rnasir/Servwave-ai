import { useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  Archive, BarChart3, CheckCircle2, DollarSign, FileEdit, FileText, Hash,
  LayoutList, Percent, Send, Trophy, X, XCircle,
} from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { chartPalette, token } from '@/design-system/tokens';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import { useEstimatesReport } from '@/lib/reports/estimates-report-data';
import { BUCKET_LABEL, bucketStatus, type EstimateRow, type StatusKey } from '@/lib/reports/estimates-report-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable } from '../components/reportTable';
import { MultiSelectFilter, Sparkline } from '../components/shared';
import { EstimateDetailPanel } from '../components/estimateDetailPanel';

/**
 * Estimates report - a status-card filter over a list, plus a by-rep view.
 *
 * `useEstimatesReport` is imported and does all of it: the seven status
 * buckets and their worth, the filtered list, the by-rep breakdown, the KPIs
 * and the eight-week trend, for both the demo and the live path. The status
 * vocabulary is `estimates-report-logic`'s - note `pending` is SENT only, which
 * is why the card reads "Awaiting Response".
 *
 * REVENUE_COLOR IS UNTOUCHED: won revenue is a positive signal, so the bars are
 * `chartPalette[0]` (brand green) and the per-row sparkline uses the same
 * value, which is what ties the table to the chart. `SERIES` keeps cycling the
 * categorical palette for the per-rep lines.
 *
 * Three shape differences, all from the kit having no segmented control: the
 * List/By-rep toggle and the four date presets are `role="radiogroup"` runs of
 * kit Buttons, and the rep scope chip is a kit Badge with a Button close.
 */

type ViewMode = 'list' | 'by-rep';

// Revenue (won) is a positive data signal -> brand green (chartPalette[0]).
const REVENUE_COLOR = chartPalette[0] ?? token('--success');

const STATUS_CARDS: { key: StatusKey; label: string; icon: typeof FileText }[] = [
  { key: 'all', label: 'All', icon: FileText },
  { key: 'unsent', label: 'Unsent', icon: FileEdit },
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

// Per-rep trend series - calm categorical palette (cycles if more reps than colors).
const SERIES = chartPalette;

export default function EstimatesReport() {
  const report = findReport('estimates')!;
  const isDemo = useIsDemoOrg();
  const [view, setView] = useState<ViewMode>('list');
  const [status, setStatus] = useState<StatusKey>('all');
  // MultiSelectFilter is multi; the last pick is kept as the single scope.
  const [repSel, setRepSel] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState('all');
  const [openEstimate, setOpenEstimate] = useState<EstimateRow | null>(null);

  const rep = repSel[0] ?? null;
  // The clock is read once, at mount: reading it during render is impure, and
  // the preset only ever measures back from "now" at day precision, so a value
  // fixed at mount is the same string every render of that mount.
  const [nowMs] = useState(() => Date.now());
  const dateFrom = datePreset === 'all'
    ? null
    : new Date(nowMs - Number(datePreset) * 86400000).toISOString().slice(0, 10);
  const { counts, listRows, kpis, breakdown, trend, reps } = useEstimatesReport({ status, rep, search, dateFrom }, isDemo);

  return (
    <ReportShell
      report={report}
      actions={isDemo ? <Badge variant="softAmber" size="pill">Sample data</Badge> : undefined}
    >
      {/* Status cards - clickable filters (count + worth) */}
      <ReportKpis
        items={STATUS_CARDS.map((c) => ({
          icon: c.icon,
          label: c.label,
          value: counts[c.key].count,
          tone: c.key === 'won' ? 'success' : c.key === 'declined' ? 'danger' : 'neutral',
          active: status === c.key,
          activeLabel: 'Filtered',
          onClick: () => setStatus(c.key),
        }))}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="View" className="flex items-center gap-1">
          <Button
            type="button" role="radio" aria-checked={view === 'list'} size="sm"
            variant={view === 'list' ? 'default' : 'ghost'} onClick={() => setView('list')}
          >
            <LayoutList />
            List
          </Button>
          <Button
            type="button" role="radio" aria-checked={view === 'by-rep'} size="sm"
            variant={view === 'by-rep' ? 'default' : 'ghost'} onClick={() => setView('by-rep')}
          >
            <BarChart3 />
            By rep
          </Button>
        </div>
        <MultiSelectFilter label="Rep" options={reps} selected={repSel} onChange={(next) => setRepSel(next.slice(-1))} />
        <div role="radiogroup" aria-label="Date range" className="flex items-center gap-1">
          {DATE_PRESETS.map((d) => (
            <Button
              key={d.key}
              type="button" role="radio" aria-checked={datePreset === d.key} size="sm"
              variant={datePreset === d.key ? 'default' : 'ghost'} onClick={() => setDatePreset(d.key)}
            >
              {d.label}
            </Button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search estimates"
          placeholder="Search estimate # or customer..."
          className="min-w-[220px] flex-1"
        />
        <Button type="button" variant="outline" size="sm" title="Coming soon">Export</Button>
      </div>

      {rep && (
        <div className="flex items-center gap-2">
          <Badge variant="softBlue" size="pill" className="gap-1">
            Scoped to {rep}
            <Button
              type="button" variant="ghost" size="icon-sm" className="size-4"
              onClick={() => setRepSel([])} aria-label="Clear rep scope"
            >
              <X />
            </Button>
          </Badge>
        </div>
      )}

      {view === 'list' ? (
        <ReportTable
          rows={listRows}
          getRowKey={(r) => r.id}
          onRowClick={(r) => setOpenEstimate(r)}
          empty={<EmptyState title="No estimates match these filters." />}
          columns={[
            { id: 'number', header: 'Estimate #', width: 120, min: 100, cell: (r) => <span className="font-medium">{r.number}</span>, sortValue: (r) => r.number },
            { id: 'customer', header: 'Customer', width: 180, min: 140, cell: (r) => r.customer, sortValue: (r) => r.customer },
            { id: 'rep', header: 'Rep', width: 140, min: 110, cell: (r) => r.rep, sortValue: (r) => r.rep },
            { id: 'created', header: 'Created', width: 120, min: 100, cell: (r) => r.createdAt, sortValue: (r) => r.createdAt },
            { id: 'amount', header: 'Amount', width: 120, min: 100, align: 'right', cell: (r) => <span className="font-semibold tabular-nums">{formatCurrency(r.amount)}</span>, sortValue: (r) => r.amount },
            { id: 'status', header: 'Status', width: 120, min: 100, cell: (r) => BUCKET_LABEL[bucketStatus(r)], sortValue: (r) => bucketStatus(r) },
            { id: 'deposit', header: 'Deposit due', width: 130, min: 110, align: 'right', cell: (r) => <span className="text-muted-foreground tabular-nums">{formatCurrency(r.depositDue)}</span>, sortValue: (r) => r.depositDue },
          ]}
        />
      ) : (
        <div className="space-y-4">
          <ReportKpis
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
              <ReportHeading level={2} scale="lg">Rep breakdown</ReportHeading>
              <p className="text-muted-foreground text-xs">
                Ranked by revenue · click a rep to scope the whole page to them
              </p>
            </div>
            <ReportTable
              rows={breakdown}
              getRowKey={(r) => r.rep}
              onRowClick={(r) => setRepSel([r.rep])}
              empty={<EmptyState title="No reps match this filter." />}
              columns={[
                { id: 'rank', header: '#', width: 64, min: 50, grow: 0, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.rank}</span>, sortValue: (r) => r.rank },
                { id: 'rep', header: 'Rep', width: 170, min: 140, cell: (r) => <span className="font-medium">{r.rep}</span>, sortValue: (r) => r.rep },
                { id: 'revenue', header: 'Revenue', width: 140, min: 120, align: 'right', cell: (r) => <span className="font-semibold tabular-nums">{formatCurrency(r.revenue)}</span>, sortValue: (r) => r.revenue },
                { id: 'winRate', header: 'Win rate', width: 110, min: 90, align: 'right', cell: (r) => <span className="tabular-nums">{r.winRate}%</span>, sortValue: (r) => r.winRate },
                { id: 'avgDeal', header: 'Avg deal', width: 130, min: 110, align: 'right', cell: (r) => <span className="tabular-nums">{formatCurrency(r.avgDeal)}</span>, sortValue: (r) => r.avgDeal },
                { id: 'open', header: 'Open $', width: 130, min: 110, align: 'right', cell: (r) => <span className="text-muted-foreground tabular-nums">{formatCurrency(r.openDollars)}</span>, sortValue: (r) => r.openDollars },
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

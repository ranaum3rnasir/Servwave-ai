import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { DollarSign, Download, Hourglass, Target, TrendingUp, Users, Wallet } from 'lucide-react';

import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system/tokens';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { hashStr, mulberry32, rangeRnd } from '@/lib/reports/random';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, type ReportColumn } from '../components/reportTable';

/**
 * M1 - Campaign ROI Scorecard.
 *
 * Deterministic MOCK data, unchanged. The month weighting is the subtle part
 * and is carried over exactly: per-source month weights are seeded from the
 * shared `hashStr`/`mulberry32` PRNG and normalised to sum to 1, so a month is
 * a realistic slice of the source's totals and "All time" equals the base
 * numbers. A user-added source is seeded the same way from its own name.
 *
 * ROAS, ROI AND PROFIT ARE COMPUTED ON WON (REALIZED) REVENUE ONLY - pipeline
 * never inflates them. That is the report's central claim and `metrics()` is
 * unchanged.
 *
 * The forecast is `open pipeline × closing rate`, with the rate prefilled from
 * `closed / all estimates` and overridable to model the opportunity; the
 * override resets to the derived value. Also unchanged.
 *
 * CHART UNTOUCHED: won is brand green (money already made), pipeline is amber
 * (money not yet made), stacked to total revenue per source.
 *
 * Shape differences: the add-source field and the closing-rate spinner are kit
 * `Input`s, the "Add" CTA is a kit Button (its raw near-black fill has no
 * minted cell), and the most-profitable row tint is gone - the kit's DataTable
 * has no per-row className, and the row already carries a "Most profitable"
 * badge, which is the same information without the wash.
 */

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n: number) => `${Math.round(n)}%`;

// Won (realized) = brand green (positive data signal); pipeline (open) = amber.
const COLOR_WON = chartPalette[0] ?? token('--success');
const COLOR_PIPELINE = chartPalette[3] ?? token('--warning');

interface Campaign {
  name: string;
  source: string;
  keyword: string;        // "-" when the source has no keyword (Referral, Direct Mail, Local)
  jobType: string;        // HVAC | Plumbing | Electrical | Mixed
  spend: number;
  leads: number;
  booked: number;
  newCustomers: number;
  won: number;            // money created - revenue from closed jobs
  pipeline: number;       // open estimate value not yet closed
  jobsClosed: number;     // estimates that closed -> jobs
  openEstimates: number;  // estimates still open (count behind pipeline $)
  leadsOpen: number;      // leads with no estimate yet
}

const CAMPAIGNS: Campaign[] = [
  { name: 'Google Ads - HVAC', source: 'Google Ads', keyword: 'ac repair near me', jobType: 'HVAC', spend: 6200, leads: 58, booked: 22, newCustomers: 17, won: 41800, pipeline: 12400, jobsClosed: 22, openEstimates: 12, leadsOpen: 24 },
  { name: 'Local Services Ads', source: 'LSA', keyword: 'water heater repair', jobType: 'Plumbing', spend: 3100, leads: 41, booked: 19, newCustomers: 15, won: 33600, pipeline: 8200, jobsClosed: 19, openEstimates: 9, leadsOpen: 13 },
  { name: 'Referral Program', source: 'Referral', keyword: '-', jobType: 'Mixed', spend: 900, leads: 24, booked: 16, newCustomers: 11, won: 38200, pipeline: 5400, jobsClosed: 16, openEstimates: 5, leadsOpen: 3 },
  { name: 'Facebook - Plumbing', source: 'Meta', keyword: '-', jobType: 'Plumbing', spend: 2400, leads: 33, booked: 9, newCustomers: 7, won: 12400, pipeline: 9100, jobsClosed: 9, openEstimates: 10, leadsOpen: 14 },
  { name: 'Direct Mail (spring)', source: 'Direct Mail', keyword: '-', jobType: 'HVAC', spend: 4100, leads: 19, booked: 6, newCustomers: 5, won: 9800, pipeline: 3000, jobsClosed: 6, openEstimates: 4, leadsOpen: 9 },
  { name: 'Yard Signs / Local', source: 'Local', keyword: '-', jobType: 'Electrical', spend: 600, leads: 11, booked: 5, newCustomers: 3, won: 7600, pipeline: 2100, jobsClosed: 5, openEstimates: 3, leadsOpen: 3 },
];

const REAL_MONTHS = ['2026-06', '2026-05', '2026-04', '2026-03'];
const MONTHS: { key: string; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '2026-06', label: 'Jun 2026' },
  { key: '2026-05', label: 'May 2026' },
  { key: '2026-04', label: 'Apr 2026' },
  { key: '2026-03', label: 'Mar 2026' },
];

// Deterministic per-source month weights that sum to 1, so a month is a
// realistic slice of the source's totals and "All time" equals the base numbers.
const _weightCache = new Map<string, Record<string, number>>();
function monthWeights(source: string): Record<string, number> {
  const cached = _weightCache.get(source);
  if (cached) return cached;
  const rng = mulberry32(hashStr('mw-' + source));
  const raw = REAL_MONTHS.map(() => rangeRnd(rng, 0.5, 1.5));
  const sum = raw.reduce((a, b) => a + b, 0);
  const w: Record<string, number> = {};
  REAL_MONTHS.forEach((m, i) => { w[m] = (raw[i] ?? 0) / sum; });
  _weightCache.set(source, w);
  return w;
}

function scaleCampaign(c: Campaign, monthKey: string): Campaign {
  if (monthKey === 'all') return c;
  const w = monthWeights(c.source)[monthKey] ?? 0;
  const s = (n: number) => Math.round(n * w);
  return {
    ...c,
    spend: s(c.spend), leads: s(c.leads), booked: s(c.booked), newCustomers: s(c.newCustomers),
    won: s(c.won), pipeline: s(c.pipeline), jobsClosed: s(c.jobsClosed),
    openEstimates: s(c.openEstimates), leadsOpen: s(c.leadsOpen),
  };
}

// ROAS / ROI / profit are computed on WON (realized) revenue - pipeline never
// inflates them.
function metrics(c: Campaign) {
  const cpl = c.leads ? c.spend / c.leads : 0;
  const profit = c.won - c.spend;
  const roas = c.spend ? c.won / c.spend : 0;
  const roi = c.spend ? ((c.won - c.spend) / c.spend) * 100 : 0;
  const total = c.won + c.pipeline;
  return { cpl, profit, roas, roi, total };
}

// Deterministic sample numbers for a user-added source (seeded from its name).
function seedCampaign(name: string): Campaign {
  const rng = mulberry32(hashStr(name.toLowerCase()));
  const spend = Math.round(rangeRnd(rng, 500, 6000));
  const leads = Math.max(5, Math.round(rangeRnd(rng, 8, 60)));
  const booked = Math.round(leads * rangeRnd(rng, 0.2, 0.5));
  const newCustomers = Math.max(1, Math.round(booked * rangeRnd(rng, 0.5, 0.9)));
  const won = Math.round(rangeRnd(rng, 5000, 45000));
  const pipeline = Math.round(won * rangeRnd(rng, 0.1, 0.5));
  const jobsClosed = booked;
  const openEstimates = Math.max(1, Math.round(rangeRnd(rng, 2, 14)));
  const leadsOpen = Math.max(0, leads - jobsClosed - openEstimates);
  const jobTypes = ['HVAC', 'Plumbing', 'Electrical'];
  const jobType = jobTypes[Math.floor(rangeRnd(rng, 0, jobTypes.length)) % jobTypes.length] ?? 'HVAC';
  return { name, source: name, keyword: '-', jobType, spend, leads, booked, newCustomers, won, pipeline, jobsClosed, openEstimates, leadsOpen };
}

type SortKey = 'revenue' | 'profit' | 'roas' | 'won' | 'pipeline' | 'leads' | 'spend';

const SORT_BY: Record<SortKey, (r: { total: number; profit: number; roas: number; won: number; pipeline: number; leads: number; spend: number }) => number> = {
  revenue: (r) => r.total,
  profit: (r) => r.profit,
  roas: (r) => r.roas,
  won: (r) => r.won,
  pipeline: (r) => r.pipeline,
  leads: (r) => r.leads,
  spend: (r) => r.spend,
};

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'revenue', label: 'Sort by total revenue' },
  { key: 'won', label: 'Sort by money created' },
  { key: 'pipeline', label: 'Sort by pipeline' },
  { key: 'profit', label: 'Sort by profit' },
  { key: 'roas', label: 'Sort by ROAS' },
  { key: 'leads', label: 'Sort by leads' },
  { key: 'spend', label: 'Sort by ad spend' },
];

export default function CampaignRoiReport() {
  const report = findReport('campaign-roi')!;
  const [sort, setSort] = useState<SortKey>('revenue');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [month, setMonth] = useState<string>('all');
  const [customCampaigns, setCustomCampaigns] = useState<Campaign[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [closeRateOverride, setCloseRateOverride] = useState<number | null>(null);

  const allCampaigns = useMemo(() => [...CAMPAIGNS, ...customCampaigns], [customCampaigns]);
  const sources = useMemo(() => Array.from(new Set(allCampaigns.map((c) => c.source))), [allCampaigns]);

  const rows = useMemo(
    () => allCampaigns
      .filter((c) => sourceFilter === 'all' || c.source === sourceFilter)
      .map((c) => scaleCampaign(c, month))
      .map((c) => ({ ...c, ...metrics(c) }))
      .sort((a, b) => SORT_BY[sort](b) - SORT_BY[sort](a)),
    [allCampaigns, sourceFilter, month, sort],
  );

  const t = useMemo(() => {
    const sum = (k: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + k(r), 0);
    const spend = sum((r) => r.spend);
    const won = sum((r) => r.won);
    const pipeline = sum((r) => r.pipeline);
    const leads = sum((r) => r.leads);
    const jobsClosed = sum((r) => r.jobsClosed);
    const openEstimates = sum((r) => r.openEstimates);
    const leadsOpen = sum((r) => r.leadsOpen);
    const leadsWithEstimate = jobsClosed + openEstimates;
    const derivedRate = jobsClosed + openEstimates > 0 ? (jobsClosed / (jobsClosed + openEstimates)) * 100 : 0;
    return { spend, won, pipeline, total: won + pipeline, leads, cpl: leads ? spend / leads : 0, jobsClosed, openEstimates, leadsOpen, leadsWithEstimate, derivedRate };
  }, [rows]);

  // Editable closing rate: prefilled from data, overridable to model the opportunity.
  const rate = closeRateOverride ?? Math.round(t.derivedRate);
  const forecast = t.pipeline * (rate / 100);
  const forecastDeals = Math.round(t.openEstimates * (rate / 100));

  // Most profitable campaign in the current view (max profit = won - spend).
  const topProfitName = useMemo(() => {
    let top: (typeof rows)[number] | null = null;
    for (const r of rows) if (!top || r.profit > top.profit) top = r;
    return top?.name ?? null;
  }, [rows]);

  const chartData = rows.map((r) => ({ name: r.source, won: r.won, pipeline: r.pipeline }));
  const monthLabel = MONTHS.find((m) => m.key === month)?.label ?? 'All time';
  const sourceLabel = sourceFilter === 'all' ? 'All sources' : sourceFilter;

  function addSource() {
    const name = newName.trim();
    if (!name) return;
    if (!sources.some((s) => s.toLowerCase() === name.toLowerCase())) {
      setCustomCampaigns((prev) => [...prev, seedCampaign(name)]);
    }
    setSourceFilter(name);
    setNewName('');
    setAdding(false);
  }

  function exportCsv() {
    exportCsvFile(
      'campaign-roi.csv',
      ['Campaign', 'Source', 'Keyword', 'Job Type', 'Spend', 'Leads', 'CPL', 'Money created', 'Pipeline', 'Jobs closed', 'Open estimates', 'Open leads', 'Profit', 'ROAS', 'ROI %'],
      rows.map((r) => [r.name, r.source, r.keyword, r.jobType, r.spend, r.leads, Math.round(r.cpl), r.won, r.pipeline, r.jobsClosed, r.openEstimates, r.leadsOpen, r.profit, `${r.roas.toFixed(1)}x`, `${Math.round(r.roi)}%`]),
    );
  }

  type Row = (typeof rows)[number];

  const columns: ReportColumn<Row>[] = [
    {
      id: 'campaign', header: 'Campaign', width: 220, min: 180, sortValue: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{r.name}</span>
            {r.name === topProfitName && (
              <Badge variant="softGreen" size="pill" className="shrink-0">Most profitable</Badge>
            )}
          </div>
          <div className="text-muted-foreground truncate text-xs">{r.source}</div>
        </div>
      ),
    },
    { id: 'keyword', header: 'Keyword', width: 170, min: 140, sortValue: (r) => r.keyword, cell: (r) => <span className="text-muted-foreground truncate">{r.keyword}</span> },
    { id: 'jobType', header: 'Job type', width: 130, min: 110, sortValue: (r) => r.jobType, cell: (r) => <span className="text-muted-foreground">{r.jobType}</span> },
    { id: 'spend', header: 'Spend', width: 110, min: 95, align: 'right', sortValue: (r) => r.spend, cell: (r) => <span className="text-muted-foreground tabular-nums">{money0(r.spend)}</span> },
    { id: 'leads', header: 'Leads', width: 100, min: 85, align: 'right', sortValue: (r) => r.leads, cell: (r) => <span className="tabular-nums">{r.leads}</span> },
    { id: 'won', header: 'Money created', width: 140, min: 120, align: 'right', sortValue: (r) => r.won, cell: (r) => <span className="font-medium tabular-nums">{money0(r.won)}</span> },
    { id: 'pipeline', header: 'Pipeline', width: 120, min: 100, align: 'right', sortValue: (r) => r.pipeline, cell: (r) => <span className="text-muted-foreground tabular-nums">{money0(r.pipeline)}</span> },
    {
      id: 'profit', header: 'Profit', width: 120, min: 100, align: 'right', sortValue: (r) => r.profit,
      cell: (r) => <span className={cn('font-medium tabular-nums', r.profit >= 0 ? 'text-status-green-emphasis' : 'text-status-red-emphasis')}>{money0(r.profit)}</span>,
    },
    {
      id: 'roi', header: 'ROI', width: 110, min: 95, align: 'right', sortValue: (r) => r.roi,
      cell: (r) => <Badge variant={r.roi >= 0 ? 'softGreen' : 'softRed'} size="pill">{pct(r.roi)}</Badge>,
    },
  ];

  return (
    <ReportShell
      report={report}
      actions={
        <>
          {adding ? (
            <span className="inline-flex items-center gap-1.5">
              <Input
                autoFocus
                value={newName}
                aria-label="New source name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addSource();
                  if (e.key === 'Escape') { setAdding(false); setNewName(''); }
                }}
                placeholder="New source name"
                className="w-44"
              />
              <Button onClick={addSource}>Add</Button>
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setNewName(''); }}>Cancel</Button>
            </span>
          ) : (
            <SelectField
              value={sourceFilter}
              onValueChange={(v) => {
                if (v === '__add__') setAdding(true);
                else setSourceFilter(v);
              }}
              aria-label="Source"
              className="min-w-[190px]"
              options={[
                { value: 'all', label: 'All sources' },
                ...sources.map((s) => ({ value: s, label: s })),
                { value: '__add__', label: '+ Add source...' },
              ]}
            />
          )}

          <SelectField
            value={month}
            onValueChange={setMonth}
            aria-label="Month"
            className="w-[150px]"
            options={MONTHS.map((m) => ({ value: m.key, label: m.label }))}
          />

          <SelectField
            value={sort}
            onValueChange={(v) => setSort(v as SortKey)}
            aria-label="Sort"
            className="w-[210px]"
            options={SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
          />

          <Button variant="outline" onClick={exportCsv}>
            <Download />
            Export CSV
          </Button>
        </>
      }
    >
      {/* Click a card to sort the table + chart by that metric. */}
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Money created', value: money0(t.won), tone: 'success', emphasize: true, active: sort === 'won', activeLabel: 'Sorted', onClick: () => setSort('won') },
          { icon: Hourglass, label: 'Pipeline', value: money0(t.pipeline), tone: 'warning', active: sort === 'pipeline', activeLabel: 'Sorted', onClick: () => setSort('pipeline') },
          { icon: TrendingUp, label: 'Total revenue', value: money0(t.total), tone: 'success', emphasize: true, active: sort === 'revenue', activeLabel: 'Sorted', onClick: () => setSort('revenue') },
          { icon: Users, label: 'Est. Leads', value: t.leads, tone: 'neutral', active: sort === 'leads', activeLabel: 'Sorted', onClick: () => setSort('leads') },
          { icon: Wallet, label: 'Ad Spend', value: money0(t.spend), tone: 'danger', active: sort === 'spend', activeLabel: 'Sorted', onClick: () => setSort('spend') },
        ]}
      />

      {/* Pipeline forecast - funnel + opportunity for the current source + month. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <ReportHeading level={2} scale="lg" className="flex items-center gap-2">
              <Target className="text-brand size-4" /> Pipeline forecast
            </ReportHeading>
            <p className="text-muted-foreground text-xs">{sourceLabel} · {monthLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* The label sits to the LEFT of the control, inline with the heading
                row - a layout the kit's FormField cannot express without
                stacking it, so it is a bare kit Label plus an htmlFor/id pair. */}
            <Label htmlFor="campaign-roi-close-rate" className="text-muted-foreground text-xs">
              Closing rate
            </Label>
            <div className="flex items-center gap-1">
              <Input
                id="campaign-roi-close-rate"
                type="number"
                min={0}
                max={100}
                value={rate}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                  setCloseRateOverride(v);
                }}
                className="h-9 w-20 text-right font-semibold"
              />
              <span className="text-muted-foreground text-sm">%</span>
            </div>
            {closeRateOverride !== null && (
              <Button variant="ghost" size="sm" onClick={() => setCloseRateOverride(null)}>reset</Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <FunnelCell label="Money generated" value={money0(t.won)} accent />
          <FunnelCell label="Jobs closed" value={String(t.jobsClosed)} />
          <FunnelCell label="Open pipeline" value={money0(t.pipeline)} sub={`${t.openEstimates} estimates`} />
          <FunnelCell label="Open leads" value={String(t.leadsOpen)} />
          <FunnelCell label="Leads w/ estimate" value={String(t.leadsWithEstimate)} />
        </div>

        <div className="bg-status-green-subtle text-status-green-emphasis mt-4 flex flex-wrap items-end justify-between gap-3 rounded-lg border p-4">
          <div>
            <p className="text-xs font-semibold tracking-wide uppercase">Forecast / opportunity</p>
            <p className="text-3xl font-bold tabular-nums">{money0(forecast)}</p>
          </div>
          <p className="max-w-md text-right text-xs leading-relaxed">
            about {forecastDeals} more job{forecastDeals === 1 ? '' : 's'} from {t.openEstimates} open estimate{t.openEstimates === 1 ? '' : 's'} at {rate}% close rate
            <br />
            {money0(t.pipeline)} open pipeline × {rate}%
          </p>
        </div>
      </Card>

      <ChartCard
        title="Revenue by source"
        subtitle="Money created (won) vs open pipeline - stacked to total revenue per source."
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: token('--text-secondary') }} interval={0} />
            <YAxis tickFormatter={money0} tick={{ fontSize: 11, fill: token('--text-secondary') }} width={96} />
            <Tooltip formatter={(v: number) => money0(v)} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="won" stackId="rev" name="Money created" fill={COLOR_WON} />
            <Bar dataKey="pipeline" stackId="rev" name="Pipeline" fill={COLOR_PIPELINE} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card>
        <ReportHeading level={2} scale="lg" className="mb-3">Campaign scorecard</ReportHeading>
        <ReportTable
          rows={rows}
          getRowKey={(r) => r.name}
          empty={<EmptyState title="No campaigns match these filters." />}
          columns={columns}
        />
      </Card>

      <p className="text-muted-foreground text-xs">
        Sample data shown so the layout is reviewable without a backend. Money created = revenue from
        closed jobs; pipeline = open estimates not yet closed. Forecast = open pipeline × closing rate
        (editable; prefilled from closed / all estimates). Source, month, and added sources are
        session-only until live data is wired.
      </p>
    </ReportShell>
  );
}

function FunnelCell({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-muted rounded-lg border p-3">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className={cn('mt-0.5 text-xl font-bold tabular-nums', accent && 'text-status-green-emphasis')}>{value}</p>
      {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
    </div>
  );
}

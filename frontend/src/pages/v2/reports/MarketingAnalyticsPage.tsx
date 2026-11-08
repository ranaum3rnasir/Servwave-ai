import { useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, DollarSign, Megaphone,
  PhoneMissed, Target, TrendingUp, Users,
} from 'lucide-react';

import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Td } from './components/td';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { cn } from '@/ui-kit/lib/utils';

import { useRecordVisit } from '../pageBreadcrumbs';
import { ReportHeading } from './components/heading';
import { ReportKpis } from './components/kpi';

/**
 * /v2/marketing - Marketing Analytics, on the CRM UI kit.
 *
 * Still a mock-data scaffold: there is no `/api/marketing`, which is why the
 * route is `DemoOnlyRoute`-gated in both layers. Every constant below - the
 * seven channels, the pipeline, the funnel, the profit lines, the organic
 * table - is carried over unchanged, because changing a number here would
 * change what the page claims.
 *
 * THE CHARTS ARE UNTOUCHED. `SOURCE_COLORS` cycles `chartPalette` so a channel
 * keeps the same colour in the donut, its legend swatch and the revenue bars -
 * that identity is the only thing tying the three together, so the legend
 * swatches keep their inline `background` from the same array rather than
 * moving to a kit token. `C` is the same six design-system accessors, and the
 * two `style={{ color }}` / `style={{ background }}` sites in the profitability
 * table are the margin-band signal (green >= 60, amber >= 50, red below), which
 * is data meaning, not decoration.
 *
 * WHAT CHANGED: the header is the kit's `PageHeader`, the owner/director
 * segmented control is two kit Buttons, the date range is a kit `Select`, the
 * five hero tiles are the shared `ReportKpis` (kit `StatCard`), the two banners
 * and the three panels are kit `Card`s, and all three hand-built `<table>`s are
 * the kit's `Table` - the raw-tag ratchet for `<table>`, `<th>`-bearing markup
 * and `<h3>` is at its floor, so none of them could stay raw.
 */

// Semantic palette - all values read from design-system tokens.
const C = {
  charcoal: token('--primary'),
  success: token('--success'),
  danger: token('--danger'),
  warning: token('--warning'),
  info: token('--info'),
  muted: token('--text-soft'),
};

type Status = 'good' | 'watch' | 'bad';

interface Channel {
  name: string;
  spend: number;
  leads: number;
  booked: number;
  revenue: number;
  status: Status;
}

const CHANNELS: Channel[] = [
  { name: 'Google LSA', spend: 4200, leads: 78, booked: 34, revenue: 52000, status: 'good' },
  { name: 'Google Ads', spend: 6800, leads: 64, booked: 26, revenue: 41000, status: 'watch' },
  { name: 'Meta (FB/IG)', spend: 3100, leads: 41, booked: 11, revenue: 14500, status: 'watch' },
  { name: 'Angi', spend: 2400, leads: 33, booked: 7, revenue: 8900, status: 'bad' },
  { name: 'Referral', spend: 0, leads: 48, booked: 31, revenue: 58000, status: 'good' },
  { name: 'Organic / GBP', spend: 0, leads: 29, booked: 14, revenue: 22400, status: 'good' },
  { name: 'Offline (wraps/signs)', spend: 1500, leads: 19, booked: 8, revenue: 12600, status: 'good' },
];

// Categorical channel colors - cycle the on-brand chart palette (no rainbow).
const SOURCE_COLORS = CHANNELS.map((_, i) => chartPalette[i % chartPalette.length]);

const PIPELINE = [
  { stage: 'Proposal', raw: 180000, weighted: 54000 },
  { stage: 'Negotiation', raw: 120000, weighted: 72000 },
  { stage: 'Verbal yes', raw: 84000, weighted: 71000 },
  { stage: 'Scheduled', raw: 52000, weighted: 52000 },
];

const FUNNEL = [
  { stage: 'Leads', count: 312 },
  { stage: 'Booked', count: 131 },
  { stage: 'Ran', count: 118 },
  { stage: 'Sold', count: 101 },
];

const PROFIT = [
  { line: 'Repair / Service', revenue: 88000, margin: 61 },
  { line: 'Maintenance plans', revenue: 24000, margin: 68 },
  { line: 'Install / Replacement', revenue: 97000, margin: 47 },
];

const ORGANIC: [string, string, string][] = [
  ['Google Business calls', '142', '▲ 9%'],
  ['Direction requests', '88', '▲ 4%'],
  ['Website clicks (GBP)', '210', '▲ 15%'],
  ['Average rating', '4.8 ★', '+0.1'],
  ['New reviews this month', '19', '▲ 6'],
  ['Review response rate', '92%', '-'],
];

// Full comma-grouped money everywhere (no k/M abbreviations), org-aware.
const money = (n: number) => formatCurrencyWhole(n);

const STATUS_PILL: Record<Status, { variant: 'softGreen' | 'softAmber' | 'softRed'; label: string }> = {
  good: { variant: 'softGreen', label: '🟢 Performing' },
  watch: { variant: 'softAmber', label: '🟡 Watch' },
  bad: { variant: 'softRed', label: '🔴 Underperform' },
};

export default function MarketingAnalyticsPage() {
  useRecordVisit('marketing');
  const [view, setView] = useState<'owner' | 'director'>('owner');
  const [dateRange, setDateRange] = useState('Last 30 days');
  const director = view === 'director';

  const totals = CHANNELS.reduce(
    (a, c) => ({ leads: a.leads + c.leads, booked: a.booked + c.booked, revenue: a.revenue + c.revenue, spend: a.spend + c.spend }),
    { leads: 0, booked: 0, revenue: 0, spend: 0 },
  );
  const cpbj = Math.round(totals.spend / totals.booked);
  const bookingRate = Math.round((totals.booked / totals.leads) * 100);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Megaphone className="text-brand size-5 shrink-0" />
            Marketing Analytics
          </span>
        }
        description={`Northside Heating & Air · ${director ? 'Director view' : 'Owner view'} · May 2026`}
        actions={
          <>
            <SelectField
              value={dateRange}
              onValueChange={setDateRange}
              aria-label="Date range"
              size="sm"
              className="w-[150px]"
              options={['Last 30 days', 'This month', 'This quarter', 'Year to date'].map((o) => ({ value: o, label: o }))}
            />
            {/* Segmented control: a radiogroup of two kit Buttons. The legacy
                pair was a raw rounded-full toggle with no roles at all. */}
            <div role="radiogroup" aria-label="View" className="flex items-center gap-1">
              <Button
                type="button"
                role="radio"
                aria-checked={!director}
                variant={director ? 'ghost' : 'default'}
                size="sm"
                onClick={() => setView('owner')}
              >
                Owner
              </Button>
              <Button
                type="button"
                role="radio"
                aria-checked={director}
                variant={director ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setView('director')}
              >
                Director
              </Button>
            </div>
          </>
        }
      />

      <div className="space-y-4">
        {/* Trust + alert banners */}
        <div className="bg-status-green-subtle text-status-green-emphasis flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[13px] font-medium">
          <CheckCircle2 className="size-4 shrink-0" />
          Data trust: 94% of leads have a source · Unknown-source rate 6% (target under 10%) · Last updated 7 min ago
        </div>
        <div className="bg-status-amber-subtle text-status-amber-emphasis flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[13px] font-medium">
          <AlertTriangle className="size-4 shrink-0" />
          Monday alert: Angi cost-per-booked-job is $343 - 96% above your $175 benchmark for 3 weeks. Consider pausing.
        </div>

        {/* 5 hero KPI cards */}
        <ReportKpis
          items={[
            { icon: DollarSign, label: 'Cost / Booked Job', value: money(cpbj), },
            { icon: Target, label: 'Booking Rate', value: `${bookingRate}%`, },
            { icon: TrendingUp, label: 'Revenue by Source', value: money(totals.revenue), },
            { icon: PhoneMissed, label: 'Missed-Call $ at Risk', value: money(15456), },
            { icon: Users, label: 'Lead Volume', value: String(totals.leads), },
          ]}
        />

        {/* Source + revenue charts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="Where leads come from" subtitle="First-touch source · paid, organic, offline & referral">
            <div className="h-[210px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={CHANNELS} dataKey="leads" nameKey="name" innerRadius={58} outerRadius={90} paddingAngle={2}>
                    {CHANNELS.map((_, i) => (
                      <Cell key={i} fill={SOURCE_COLORS[i]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value, name) => [`${value} leads`, name]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Legend swatches must match the slice colours exactly, so they
                read from the same array by inline style - see the file note. */}
            <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
              {CHANNELS.map((c, i) => (
                <span key={c.name} className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full" style={{ background: SOURCE_COLORS[i] }} />
                  {c.name} ({c.leads})
                </span>
              ))}
            </div>
          </ChartCard>

          <ChartCard title="Revenue by source" subtitle="Booked-job revenue traced back to lead source">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={CHANNELS} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} horizontal={false} />
                  <XAxis type="number" tickFormatter={money} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value) => formatCurrency(Number(value))} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                    {CHANNELS.map((_, i) => (
                      <Cell key={i} fill={SOURCE_COLORS[i]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </div>

        {/* Channel performance table */}
        <Card>
          <div>
            <ReportHeading level={2} scale="lg">Channel performance</ReportHeading>
            <p className="text-muted-foreground mb-3 text-[12px]">
              Performing vs underperforming · CPBJ vs benchmark + ROAS vs 4.0× breakeven + seasonal trend
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Booked</TableHead>
                <TableHead>Revenue</TableHead>
                <TableHead>CPBJ</TableHead>
                {director && <TableHead>ROAS</TableHead>}
                {director && <TableHead>Booking</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CHANNELS.map((c) => (
                <TableRow key={c.name}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td>{c.spend ? money(c.spend) : money(0)}</Td>
                  <Td>{c.leads}</Td>
                  <Td>{c.booked}</Td>
                  <Td>{money(c.revenue)}</Td>
                  <Td className="font-semibold">{c.spend ? money(Math.round(c.spend / c.booked)) : '-'}</Td>
                  {director && <Td>{c.spend ? `${(c.revenue / c.spend).toFixed(1)}×` : '∞'}</Td>}
                  {director && <Td>{Math.round((c.booked / c.leads) * 100)}%</Td>}
                  <Td>
                    <Badge variant={STATUS_PILL[c.status].variant} size="pill">{STATUS_PILL[c.status].label}</Badge>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground mt-3 text-[11px]">
            Referral & Organic have no ad spend, so CPBJ is shown as - (revenue contribution only).
          </p>
        </Card>

        {/* Director-only blocks */}
        {director && (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ChartCard title="Pipeline revenue projection" subtitle="Weighted: Σ(open estimate × stage win-probability)">
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={PIPELINE}>
                      <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                      <XAxis dataKey="stage" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={money} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} width={88} />
                      <Tooltip formatter={(value) => formatCurrency(Number(value))} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                      <Bar dataKey="raw" name="Raw open" fill={C.charcoal} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="weighted" name="Weighted" fill={chartPalette[0]} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>

              <ChartCard title="Conversion funnel" subtitle="Lead → booked → ran → sold">
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={FUNNEL}>
                      <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                      <XAxis dataKey="stage" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} width={36} />
                      <Tooltip cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {FUNNEL.map((_, i) => (
                          <Cell key={i} fill={chartPalette[i % chartPalette.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <div>
                  <ReportHeading level={2} scale="lg">Product / service profitability</ReportHeading>
                  <p className="text-muted-foreground mb-3 text-[12px]">
                    Where you make & lose money · gross margin by service line
                  </p>
                </div>
                <Table>
                  <TableBody>
                    {PROFIT.map((p) => {
                      // Margin band = data meaning, not decoration. Same three
                      // design-system accessors as before.
                      const col = p.margin >= 60 ? C.success : p.margin >= 50 ? C.warning : C.danger;
                      return (
                        <TableRow key={p.line}>
                          <Td className="font-medium">{p.line}</Td>
                          <Td className="text-muted-foreground">{money(p.revenue)}</Td>
                          <Td className="font-semibold" style={{ color: col }}>{p.margin}%</Td>
                          <Td className="w-[130px]">
                            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                              <div className="h-full rounded-full" style={{ width: `${p.margin}%`, background: col }} />
                            </div>
                          </Td>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>

              <Card>
                <div>
                  <ReportHeading level={2} scale="lg">Organic & reputation</ReportHeading>
                  <p className="text-muted-foreground mb-3 text-[12px]">
                    Google Business Profile + reviews - the earned channel
                  </p>
                </div>
                <Table>
                  <TableBody>
                    {ORGANIC.map((o) => (
                      <TableRow key={o[0]}>
                        <Td>{o[0]}</Td>
                        <Td className="text-right font-bold">{o[1]}</Td>
                        <Td className="text-status-green-emphasis text-right font-medium">{o[2]}</Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          </>
        )}

        <p className={cn('text-muted-foreground flex items-center gap-1.5 pt-1 text-[11px]')}>
          {director ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          Scaffold with mock data - wire to /api/marketing (revenue-by-source + CPBJ via Customer.ad_source).
        </p>
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  DollarSign,
  Target,
  TrendingUp,
  PhoneMissed,
  Users,
  Megaphone,
} from 'lucide-react';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import { SelectField } from '@/components/form/SelectField';
import { useOrganization } from '@/lib/api/organization';
import { Heading } from '@/components/ui/heading';

/**
 * Marketing Analytics page — v1 scaffold (mock data).
 *
 * Built from the locked PRD/research in `servwave crm/solvave-marketing-research/`.
 * Hero metric is Cost Per Booked Job (CPBJ) by channel — the number no competitor
 * can compute without the CRM's Lead→Estimate→Job→Invoice join (source lives on
 * `Customer.ad_source`, per commit #96). Wire to a real `/api/marketing` endpoint later.
 *
 * This is a SALES surface: it is shown to prospects to demonstrate what the platform
 * reports once their own data is in it. Two consequences for the mock data below.
 *
 * 1. Channels mirror what an electronic-security / door-installation contractor
 *    actually records - Northwind Services' live `ad_source` values are Google, Website -
 *    Submission, Referral, return-customer buckets, Account and SUB Company. Angi and
 *    paid social were removed: they are residential home-services channels and a
 *    commercial access-control buyer reads them as generic template data.
 * 2. Figures are scaled to a ~$6M/yr contractor and cross-checked against published
 *    benchmarks, not invented. Door/window CPL runs $90-$250 and cost per SOLD job
 *    $450-$1,500 (LocaliQ / QuantiMedia 2025); locksmith-style emergency LSA leads are
 *    far cheaper ($25-$45) and close at 50-70%; integrators in the $5-30M band spend
 *    $7k-$18k/mo on marketing. The split below reproduces that barbell - cheap
 *    high-closing service calls beside expensive low-closing commercial projects.
 */

// ─── Semantic palette — all values read from design-system tokens ────────────
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
  /** What this channel actually is for a door / security contractor. */
  note: string;
  spend: number;
  leads: number;
  booked: number;
  revenue: number;
  status: Status;
}

interface ServiceLine {
  line: string;
  revenue: number;
  margin: number;
}

interface Period {
  /** Human label for the window, e.g. "Aug 1-6, 2026". */
  window: string;
  channels: Channel[];
  /** Missed inbound calls in the window - drives the recovered-revenue KPI. */
  missedCalls: number;
  funnel: { stage: string; count: number }[];
  profit: ServiceLine[];
  organic: [string, string, string][];
  /** Period-over-period deltas — copy only, shown under the KPI values. */
  deltas: { cpbj: string; booking: string; revenue: string; leads: string };
}

/**
 * Selectable windows, in menu order. A literal-key union (rather than an index
 * signature) keeps `PERIODS[dateRange]` provably total, so no lookup needs a
 * `?? fallback` that TypeScript would still widen to `Period | undefined`.
 */
const DATE_RANGES = ['This month', 'Last 30 days', 'This quarter', 'Year to date'] as const;
type DateRange = (typeof DATE_RANGES)[number];

/**
 * Per-timeframe datasets. Every channel row is internally consistent: the six
 * `spend`/`leads`/`booked`/`revenue` columns sum to the period totals, so KPIs and
 * charts are derived rather than hardcoded and cannot drift out of agreement.
 *
 * Scale target: ~$500k attributed revenue/mo ($6.0M/yr) on ~4.5% of revenue in
 * marketing spend. Only Google LSA and Google Ads carry spend, so the headline
 * Cost/Booked Job is a PAID-only figure (see `paidCpbj`) - blending in free referral,
 * repeat and trade work would report ~$145 and overstate efficiency, which is exactly
 * the number a sharp prospect pulls apart. $363 against the published $450-$1,500 band
 * is credible and still a win.
 */
const PERIODS: Record<DateRange, Period> = {
  'This month': {
    window: 'Aug 1-6, 2026',
    channels: [
      { name: 'Google LSA',        note: 'Emergency service, lockouts',        spend: 1500, leads: 21, booked:  9, revenue:  11200, status: 'good' },
      { name: 'Google Ads',        note: 'Commercial door & access control',   spend: 3100, leads: 15, booked:  4, revenue:  29500, status: 'watch' },
      { name: 'Website & Organic', note: 'GBP + website form submissions',     spend:    0, leads: 17, booked:  6, revenue:  19800, status: 'good' },
      { name: 'Referral Partners', note: 'GCs, property managers, locksmiths', spend:    0, leads: 11, booked:  6, revenue:  24000, status: 'good' },
      { name: 'Repeat & Accounts', note: 'Returning customers, service plans', spend:    0, leads:  9, booked:  4, revenue:  12500, status: 'good' },
      { name: 'Trade Accounts',    note: 'Sub-contract work for other trades', spend:    0, leads:  3, booked:  2, revenue:   7000, status: 'good' },
    ],
    missedCalls: 6,
    funnel: [
      { stage: 'Leads', count: 76 },
      { stage: 'Quoted', count: 54 },
      { stage: 'Won', count: 31 },
      { stage: 'Completed', count: 24 },
    ],
    profit: [
      { line: 'Commercial Door Install / Replacement', revenue: 35000, margin: 39 },
      { line: 'Access Control & Intercom',             revenue: 23000, margin: 47 },
      { line: 'Commercial Door Repair & Service',      revenue: 19000, margin: 62 },
      { line: 'Camera & Surveillance',                 revenue: 13000, margin: 44 },
      { line: 'Gates & Garage Doors',                  revenue:  8500, margin: 41 },
      { line: 'Residential Service & Lockout',         revenue:  5500, margin: 66 },
    ],
    organic: [
      ['Google Business calls', '38', '▲ 6%'],
      ['Direction requests', '21', '▲ 3%'],
      ['Website clicks (GBP)', '54', '▲ 11%'],
      ['Average rating', '4.8 ★', '—'],
      ['New reviews', '5', '▲ 1'],
      ['Review response rate', '94%', '▲ 2 pts'],
    ],
    deltas: {
      cpbj: '▼ 3% vs same days last month',
      booking: '▲ 2 pts · 31 of 76 leads',
      revenue: '▲ 9% vs same days last month',
      leads: '▲ 7% vs same days last month',
    },
  },

  'Last 30 days': {
    window: 'Jul 8 - Aug 6, 2026',
    channels: [
      { name: 'Google LSA',        note: 'Emergency service, lockouts',        spend:  7300, leads: 98, booked: 41, revenue:  51000, status: 'good' },
      { name: 'Google Ads',        note: 'Commercial door & access control',   spend: 15200, leads: 71, booked: 21, revenue: 152000, status: 'watch' },
      { name: 'Website & Organic', note: 'GBP + website form submissions',     spend:     0, leads: 84, booked: 30, revenue:  96000, status: 'good' },
      { name: 'Referral Partners', note: 'GCs, property managers, locksmiths', spend:     0, leads: 52, booked: 30, revenue: 118000, status: 'good' },
      { name: 'Repeat & Accounts', note: 'Returning customers, service plans', spend:     0, leads: 44, booked: 24, revenue:  59000, status: 'good' },
      { name: 'Trade Accounts',    note: 'Sub-contract work for other trades', spend:     0, leads: 23, booked: 10, revenue:  24000, status: 'good' },
    ],
    missedCalls: 27,
    funnel: [
      { stage: 'Leads', count: 372 },
      { stage: 'Quoted', count: 268 },
      { stage: 'Won', count: 156 },
      { stage: 'Completed', count: 131 },
    ],
    profit: [
      { line: 'Commercial Door Install / Replacement', revenue: 168000, margin: 39 },
      { line: 'Access Control & Intercom',             revenue: 112000, margin: 47 },
      { line: 'Commercial Door Repair & Service',      revenue:  89000, margin: 62 },
      { line: 'Camera & Surveillance',                 revenue:  64000, margin: 44 },
      { line: 'Gates & Garage Doors',                  revenue:  41000, margin: 41 },
      { line: 'Residential Service & Lockout',         revenue:  26000, margin: 66 },
    ],
    organic: [
      ['Google Business calls', '186', '▲ 9%'],
      ['Direction requests', '104', '▲ 4%'],
      ['Website clicks (GBP)', '271', '▲ 15%'],
      ['Average rating', '4.8 ★', '+0.1'],
      ['New reviews', '24', '▲ 6'],
      ['Review response rate', '92%', '—'],
    ],
    deltas: {
      cpbj: '▼ 8% vs prior 30 days',
      booking: '▲ 3 pts · 156 of 372 leads',
      revenue: '▲ 14% attributed revenue',
      leads: '▲ 12% vs prior period',
    },
  },

  'This quarter': {
    window: 'Jul 1 - Aug 6, 2026 (Q3)',
    channels: [
      { name: 'Google LSA',        note: 'Emergency service, lockouts',        spend:  9000, leads: 121, booked: 51, revenue:  63500, status: 'good' },
      { name: 'Google Ads',        note: 'Commercial door & access control',   spend: 18800, leads:  88, booked: 26, revenue: 187000, status: 'watch' },
      { name: 'Website & Organic', note: 'GBP + website form submissions',     spend:     0, leads: 103, booked: 37, revenue: 118000, status: 'good' },
      { name: 'Referral Partners', note: 'GCs, property managers, locksmiths', spend:     0, leads:  64, booked: 37, revenue: 145000, status: 'good' },
      { name: 'Repeat & Accounts', note: 'Returning customers, service plans', spend:     0, leads:  54, booked: 29, revenue:  72500, status: 'good' },
      { name: 'Trade Accounts',    note: 'Sub-contract work for other trades', spend:     0, leads:  28, booked: 11, revenue:  26000, status: 'good' },
    ],
    missedCalls: 33,
    funnel: [
      { stage: 'Leads', count: 458 },
      { stage: 'Quoted', count: 331 },
      { stage: 'Won', count: 191 },
      { stage: 'Completed', count: 162 },
    ],
    profit: [
      { line: 'Commercial Door Install / Replacement', revenue: 206000, margin: 40 },
      { line: 'Access Control & Intercom',             revenue: 137000, margin: 48 },
      { line: 'Commercial Door Repair & Service',      revenue: 109000, margin: 61 },
      { line: 'Camera & Surveillance',                 revenue:  78000, margin: 45 },
      { line: 'Gates & Garage Doors',                  revenue:  50000, margin: 42 },
      { line: 'Residential Service & Lockout',         revenue:  32000, margin: 65 },
    ],
    organic: [
      ['Google Business calls', '229', '▲ 11%'],
      ['Direction requests', '128', '▲ 6%'],
      ['Website clicks (GBP)', '334', '▲ 17%'],
      ['Average rating', '4.8 ★', '+0.1'],
      ['New reviews', '29', '▲ 8'],
      ['Review response rate', '93%', '▲ 1 pt'],
    ],
    deltas: {
      cpbj: '▼ 6% vs Q2',
      booking: '▲ 4 pts · 191 of 458 leads',
      revenue: '▲ 18% vs Q2',
      leads: '▲ 15% vs Q2',
    },
  },

  'Year to date': {
    window: 'Jan 1 - Aug 6, 2026',
    channels: [
      { name: 'Google LSA',        note: 'Emergency service, lockouts',        spend:  51000, leads: 689, booked: 287, revenue:  356000, status: 'good' },
      { name: 'Google Ads',        note: 'Commercial door & access control',   spend: 107000, leads: 498, booked: 148, revenue: 1043000, status: 'watch' },
      { name: 'Website & Organic', note: 'GBP + website form submissions',     spend:      0, leads: 592, booked: 212, revenue:  664000, status: 'good' },
      { name: 'Referral Partners', note: 'GCs, property managers, locksmiths', spend:      0, leads: 366, booked: 209, revenue:  812000, status: 'good' },
      { name: 'Repeat & Accounts', note: 'Returning customers, service plans', spend:      0, leads: 306, booked: 165, revenue:  401000, status: 'good' },
      { name: 'Trade Accounts',    note: 'Sub-contract work for other trades', spend:      0, leads: 163, booked:  67, revenue:  134000, status: 'good' },
    ],
    missedCalls: 188,
    funnel: [
      { stage: 'Leads', count: 2614 },
      { stage: 'Quoted', count: 1885 },
      { stage: 'Won', count: 1088 },
      { stage: 'Completed', count: 934 },
    ],
    profit: [
      { line: 'Commercial Door Install / Replacement', revenue: 1142000, margin: 38 },
      { line: 'Access Control & Intercom',             revenue:  758000, margin: 46 },
      { line: 'Commercial Door Repair & Service',      revenue:  613000, margin: 60 },
      { line: 'Camera & Surveillance',                 revenue:  437000, margin: 43 },
      { line: 'Gates & Garage Doors',                  revenue:  281000, margin: 40 },
      { line: 'Residential Service & Lockout',         revenue:  179000, margin: 64 },
    ],
    organic: [
      ['Google Business calls', '1,284', '▲ 22%'],
      ['Direction requests', '703', '▲ 14%'],
      ['Website clicks (GBP)', '1,916', '▲ 31%'],
      ['Average rating', '4.8 ★', '+0.3'],
      ['New reviews', '161', '▲ 47'],
      ['Review response rate', '90%', '▲ 6 pts'],
    ],
    deltas: {
      cpbj: '▼ 11% vs 2025',
      booking: '▲ 5 pts · 1,088 of 2,614 leads',
      revenue: '▲ 26% vs same period 2025',
      leads: '▲ 19% vs same period 2025',
    },
  },
};

/**
 * Published cost-per-SOLD-job band for door / window contractors (LocaliQ and
 * QuantiMedia, 2025). Shown beside the paid CPBJ so the number is anchored to an
 * outside reference rather than a benchmark we invented.
 */
const CPBJ_BENCHMARK = { low: 450, high: 1500 };

/**
 * Expected gross-margin band per service line, because margin is structurally
 * different by work type - judging them all on one scale is actively misleading.
 * For garage / commercial door contractors, service runs 65-72% while new install
 * runs 28-38% (Projul 2026 construction margin benchmarks; BizBite commercial-door
 * operator data). A single ">=60% is good" rule paints a 39% install margin red
 * even though it beats the top of its own band - i.e. it tells an owner their
 * largest and healthiest revenue line is failing.
 *
 * Keyed by line name so the bands live in one place rather than repeating across
 * all four periods.
 */
const MARGIN_BANDS: Record<string, [number, number]> = {
  'Commercial Door Install / Replacement': [28, 38],
  'Access Control & Intercom': [30, 40],
  'Commercial Door Repair & Service': [65, 72],
  'Camera & Surveillance': [30, 40],
  'Gates & Garage Doors': [28, 38],
  'Residential Service & Lockout': [65, 72],
};
/** Upper bound of the margin track, so every bullet row shares one scale. */
const MARGIN_SCALE_MAX = 80;

/**
 * Trailing 12 months of PAID cost per booked job. The page's hero metric only
 * carried a single period-over-period delta, which cannot answer the first question
 * an owner asks - "is this getting better, and since when". Like the pipeline
 * snapshot, a 12-month trend is inherently longer than any selectable window, so it
 * does not move with the date filter.
 *
 * The final point is August month-to-date and equals the "This month" KPI exactly
 * ($354), so switching the filter to This month and reading the last point agree -
 * a cross-check a demo viewer can actually perform.
 */
const CPBJ_TREND = [
  { month: 'Sep', cpbj: 521 },
  { month: 'Oct', cpbj: 498 },
  { month: 'Nov', cpbj: 476 },
  { month: 'Dec', cpbj: 465 },
  { month: 'Jan', cpbj: 405 },
  { month: 'Feb', cpbj: 392 },
  { month: 'Mar', cpbj: 379 },
  { month: 'Apr', cpbj: 367 },
  { month: 'May', cpbj: 356 },
  { month: 'Jun', cpbj: 345 },
  { month: 'Jul', cpbj: 336 },
  { month: 'Aug', cpbj: 354 },
];

// ─── Pipeline & forecast — POINT-IN-TIME, not a period aggregate ─────────────
/**
 * Open pipeline is a snapshot of what is live right now, so it deliberately does NOT
 * move with the date filter above: "what is still open" is the same fact whether you
 * are looking at 30 days or the year. Mixing a period aggregate and a snapshot under
 * one control is how a dashboard ends up lying, so this block is labelled "as of
 * today" and left out of the filter.
 *
 * Revenue is credited to the month the LEAD arrived, not the month the job closed - an
 * April lead that finishes in May belongs to April's campaign, because that campaign
 * bought it. That is the attribution the CRM can do and a standalone ad platform
 * cannot: it needs the Lead→Estimate→Job→Invoice join.
 */
const COHORTS = [
  { month: 'Mar', closed: 486000, open:  14000 },
  { month: 'Apr', closed: 512000, open:  42000 },
  { month: 'May', closed: 498000, open:  81000 },
  { month: 'Jun', closed: 521000, open: 142000 },
  { month: 'Jul', closed: 404000, open: 231000 },
  // The `open` column is the SAME money the FORECAST table weights out, sliced by
  // cohort month instead of by channel, so the two must total identically
  // ($892,920). Aug carries the remainder - a demo viewer who adds the bars and
  // compares them to the forecast total has to find them equal.
  { month: 'Aug', closed:  96000, open: 382920 },
];

interface ForecastRow {
  channel: string;
  /** Open estimate value attributable to this channel, as of today. */
  open: number;
  /** Trailing-12-month win rate for the channel, applied as the forecast weight. */
  closeRate: number;
  /** Typical lead→close lag, so an owner knows WHEN to expect the money. */
  lag: string;
}

const FORECAST: ForecastRow[] = [
  { channel: 'Google Ads',        open: 684000, closeRate: 0.31, lag: '45-60 days' },
  { channel: 'Referral Partners', open: 428000, closeRate: 0.57, lag: '20-30 days' },
  { channel: 'Website & Organic', open: 361000, closeRate: 0.38, lag: '30-45 days' },
  { channel: 'Repeat & Accounts', open: 214000, closeRate: 0.61, lag: '15-25 days' },
  { channel: 'Trade Accounts',    open: 176000, closeRate: 0.44, lag: '30-60 days' },
  { channel: 'Google LSA',        open: 148000, closeRate: 0.62, lag: '7-14 days' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Full comma-grouped money everywhere (no k/M abbreviations), org-aware.
const money = (n: number) => formatCurrencyWhole(n);
const STATUS_PILL: Record<Status, { cls: string; label: string }> = {
  good: { cls: 'bg-success/10 text-success', label: '🟢 Performing' },
  watch: { cls: 'bg-warning/10 text-warning', label: '🟡 Watch' },
  bad: { cls: 'bg-danger/10 text-danger', label: '🔴 Underperform' },
};

const card = 'bg-surface-light rounded-card border border-border shadow-card';

/**
 * Where a service line's margin sits against its OWN expected band. Only `below`
 * is a problem, so it is the only state that earns a warning color - "above" and
 * "in band" both mean the line is performing as it should for that kind of work.
 */
function bandVerdict(line: string, margin: number) {
  const band = MARGIN_BANDS[line];
  if (!band) return { label: '', tone: C.muted, band: null };
  const [low, high] = band;
  const range = `${low}-${high}%`;
  if (margin > high) return { label: `▲ above ${range}`, tone: C.success, band };
  if (margin < low) return { label: `▼ below ${range}`, tone: C.warning, band };
  return { label: `● in ${range}`, tone: C.success, band };
}

// ─── KPI card ────────────────────────────────────────────────────────────────
function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  sub: string;
  tone: string;
}) {
  return (
    <div className="px-5 py-4 border-r border-border last:border-r-0">
      <div className="flex items-center gap-2 text-[12px] font-medium text-text-secondary">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: tone }} />
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="mt-2 text-[26px] font-bold tracking-tight text-text-primary">{value}</div>
      <div className="mt-1 text-[12px] font-medium" style={{ color: tone }}>
        {sub}
      </div>
    </div>
  );
}

/** Section card header — text-[15px] has no matching Heading scale key, so h3 is raw. */
function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
      <p className="text-[12px] text-text-secondary mb-3">{subtitle}</p>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function MarketingAnalyticsPage() {
  const [dateRange, setDateRange] = useState<DateRange>('Last 30 days');
  const { data: org } = useOrganization();

  // Subtitle only - the figures below stay mock. The org name and month come from
  // the signed-in org / today's date so the screen reads as theirs when it is
  // presented, instead of naming a sample company on a frozen month. Falls back
  // to the generic sample name while the org query is in flight.
  const orgName = org?.name ?? 'Your company';

  const period = PERIODS[dateRange];
  const channels = period.channels;

  /**
   * Lead mix for the donut. `chartPalette` has 5 slots and there are 6 channels, so
   * cycling it (`i % length`) handed slot 1's green to BOTH Google LSA and Trade
   * Accounts - two different channels rendering as the same color, which is
   * indistinguishable to a reader. Rather than invent a 6th hue, the smallest
   * channel folds into "Other"; the table below still breaks out all six.
   */
  const leadMix = (() => {
    const sorted = [...channels].sort((a, b) => b.leads - a.leads);
    const head = sorted.slice(0, chartPalette.length - 1);
    const tail = sorted.slice(chartPalette.length - 1);
    const rest = tail.reduce((n, c) => n + c.leads, 0);
    return rest > 0
      ? [...head, { name: `Other (${tail.map((c) => c.name).join(', ')})`, leads: rest }]
      : head;
  })();
  const mixColors = leadMix.map((_, i) => chartPalette[i]);

  const totals = channels.reduce(
    (a, c) => ({
      leads: a.leads + c.leads,
      booked: a.booked + c.booked,
      revenue: a.revenue + c.revenue,
      spend: a.spend + c.spend,
    }),
    { leads: 0, booked: 0, revenue: 0, spend: 0 }
  );

  // PAID-only cost per booked job: spend divided by the jobs that spend actually
  // bought. Referral, repeat, organic and trade work carry no spend, so folding them
  // in would flatter the number and invite a credibility challenge in a demo.
  const paid = channels.filter((c) => c.spend > 0);
  const paidBooked = paid.reduce((n, c) => n + c.booked, 0);
  const paidCpbj = Math.round(totals.spend / paidBooked);
  const vsBenchmark = Math.round((1 - paidCpbj / CPBJ_BENCHMARK.low) * 100);

  const bookingRate = Math.round((totals.booked / totals.leads) * 100);
  const avgJob = Math.round(totals.revenue / totals.booked);
  // Recoverable revenue sitting in unanswered calls: missed × job value × booking rate.
  const missedRisk = Math.round(period.missedCalls * avgJob * (bookingRate / 100));
  const spendPctRevenue = ((totals.spend / totals.revenue) * 100).toFixed(1);

  const forecastTotal = FORECAST.reduce((n, f) => n + f.open * f.closeRate, 0);
  const openTotal = FORECAST.reduce((n, f) => n + f.open, 0);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Heading level={1} className="flex items-center gap-2"><Megaphone className="h-5 w-5 shrink-0 text-primary" />Marketing Analytics</Heading>
          <p className="text-[13px] text-text-secondary">
            {/* The window the figures actually cover, so the period is legible without
                mentally resolving the filter label. */}
            {orgName} · Owner view · {period.window}
          </p>
        </div>
        {/* SelectField's base variant carries `w-full`, so in a flex row it stretches
            across the header. A filter is a small control - pin the width and stop it
            growing (tailwind-merge lets the later w-* win over the base). */}
        <SelectField
          aria-label="Date range"
          value={dateRange}
          onValueChange={(v) => setDateRange(v as DateRange)}
          className="text-[13px] h-9 w-[150px] shrink-0"
          options={DATE_RANGES.map((r) => ({ value: r, label: r }))}
        />
      </div>

      {/* 5 hero KPI cards */}
      <div className={`grid grid-cols-5 ${card} overflow-hidden`}>
        <Kpi
          icon={DollarSign}
          label="Cost / Booked Job (paid)"
          value={money(paidCpbj)}
          sub={`${period.deltas.cpbj} · ${vsBenchmark}% under the ${money(CPBJ_BENCHMARK.low)} industry floor`}
          tone={C.success}
        />
        <Kpi icon={Target} label="Booking Rate" value={`${bookingRate}%`} sub={period.deltas.booking} tone={C.success} />
        <Kpi icon={TrendingUp} label="Attributed Revenue" value={money(totals.revenue)} sub={period.deltas.revenue} tone={C.info} />
        <Kpi
          icon={PhoneMissed}
          label="Missed-Call $ at Risk"
          value={money(missedRisk)}
          sub={`${period.missedCalls} missed × ${money(avgJob)} × ${bookingRate}%`}
          tone={C.warning}
        />
        <Kpi icon={Users} label="Lead Volume" value={totals.leads.toLocaleString()} sub={period.deltas.leads} tone={C.success} />
      </div>

      {/* Source + revenue charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Where leads come from"
          subtitle="First-touch source · paid, organic, referral & trade"
        >
          <div className="h-[210px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={leadMix} dataKey="leads" nameKey="name" innerRadius={58} outerRadius={90} paddingAngle={2}>
                  {leadMix.map((_, i) => (
                    <Cell key={i} fill={mixColors[i]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value, name) => [`${value} leads`, name]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-text-secondary mt-2">
            {leadMix.map((c, i) => (
              <span key={c.name} className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: mixColors[i] }} />
                {c.name.replace(/ \(.*\)$/, '')} ({c.leads})
              </span>
            ))}
          </div>
        </ChartCard>

        <ChartCard
          title="Revenue by source"
          subtitle="Booked-job revenue traced back to lead source"
        >
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={channels} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} horizontal={false} />
                <XAxis type="number" tickFormatter={money} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={128} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                {/* ONE series across categories, so one color. Six hues here encoded
                    nothing the bar length does not already say, and burned the only
                    free channel on duplicate information. */}
                <Bar dataKey="revenue" radius={[0, 4, 4, 0]} fill={chartPalette[0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      {/* Channel performance table */}
      <div className={`${card} p-5`}>
        <CardHeader
          title="Channel performance"
          subtitle={`Performing vs underperforming · CPBJ vs the ${money(CPBJ_BENCHMARK.low)}-${money(CPBJ_BENCHMARK.high)} industry band + ROAS vs 4.0× breakeven`}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" aria-label="Channel performance">
            <thead>
              <tr className="text-text-secondary text-[11px] uppercase tracking-wide">
                <th className="text-left font-semibold py-2 pr-3 border-b border-border">Channel</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Spend</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Leads</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Booked</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Revenue</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Avg job</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">CPBJ</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">ROAS</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Booking</th>
                <th className="text-left font-semibold py-2 px-3 border-b border-border">Status</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.name} className="text-text-primary">
                  <td className="py-2.5 pr-3 border-b border-border-soft">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-[11px] text-text-secondary">{c.note}</div>
                  </td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{c.spend ? money(c.spend) : money(0)}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{c.leads}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{c.booked}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{money(c.revenue)}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{money(Math.round(c.revenue / c.booked))}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft font-semibold">{c.spend ? money(Math.round(c.spend / c.booked)) : '—'}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{c.spend ? `${(c.revenue / c.spend).toFixed(1)}×` : '∞'}</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">{Math.round((c.booked / c.leads) * 100)}%</td>
                  <td className="py-2.5 px-3 border-b border-border-soft">
                    <span className={`inline-flex items-center text-[11px] font-semibold px-2.5 py-1 rounded-full ${STATUS_PILL[c.status].cls}`}>
                      {STATUS_PILL[c.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-text-secondary mt-3">
          Referral, repeat, organic and trade work carry no ad spend, so CPBJ shows — and ROAS ∞
          (revenue contribution only). Total spend {money(totals.spend)} = {spendPctRevenue}% of
          attributed revenue; the paid-only CPBJ above is {money(paidCpbj)} across {paidBooked} jobs
          bought by {paid.map((c) => c.name).join(' + ')}.
        </p>
      </div>

      {/* ── Pipeline & forecast (point-in-time snapshot) ───────────────────── */}
      <div className={`${card} p-5`}>
        <CardHeader
          title="Pipeline & forecast by lead cohort"
          subtitle="Revenue credited to the month the LEAD arrived, not the month the job closed · snapshot as of today, not affected by the date filter"
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={COHORTS} margin={{ top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={money} tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} width={92} />
                  <Tooltip formatter={(value) => formatCurrency(Number(value))} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="closed" stackId="c" name="Closed & invoiced" fill={C.charcoal} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="open" stackId="c" name="Still open (weighted)" fill={chartPalette[0]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-text-secondary mt-2">
              A lead that arrived in April and finished in May still counts toward April&apos;s
              campaign — it bought the job. Recent cohorts are mostly open pipeline; older ones have
              resolved.
            </p>
          </div>

          <div>
            <div className="flex items-baseline gap-5 mb-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-text-secondary font-semibold">Open pipeline</div>
                <div className="text-[22px] font-bold text-text-primary">{money(openTotal)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-text-secondary font-semibold">Weighted forecast</div>
                <div className="text-[22px] font-bold" style={{ color: C.info }}>{money(Math.round(forecastTotal))}</div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Pipeline forecast by channel">
                <thead>
                  <tr className="text-text-secondary text-[11px] uppercase tracking-wide">
                    <th className="text-left font-semibold py-2 pr-3 border-b border-border">Channel</th>
                    <th className="text-right font-semibold py-2 px-3 border-b border-border">Open</th>
                    <th className="text-right font-semibold py-2 px-3 border-b border-border">Close %</th>
                    <th className="text-right font-semibold py-2 px-3 border-b border-border">Forecast</th>
                    <th className="text-right font-semibold py-2 pl-3 border-b border-border">Expected in</th>
                  </tr>
                </thead>
                <tbody>
                  {FORECAST.map((f) => (
                    <tr key={f.channel} className="text-text-primary">
                      <td className="py-2.5 pr-3 border-b border-border-soft font-medium">{f.channel}</td>
                      <td className="py-2.5 px-3 border-b border-border-soft text-right">{money(f.open)}</td>
                      <td className="py-2.5 px-3 border-b border-border-soft text-right">{Math.round(f.closeRate * 100)}%</td>
                      <td className="py-2.5 px-3 border-b border-border-soft text-right font-semibold" style={{ color: C.info }}>
                        {money(Math.round(f.open * f.closeRate))}
                      </td>
                      <td className="py-2.5 pl-3 border-b border-border-soft text-right text-text-secondary">{f.lag}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-text-secondary mt-3">
              Forecast = open estimate value × the channel&apos;s trailing-12-month win rate. Referral
              and LSA convert fastest, so their pipeline lands soonest; Google Ads carries the most
              open value but at a 31% win rate and a 45-60 day lag.
            </p>
          </div>
        </div>
      </div>

      {/* Cost-per-booked-job trend — the hero metric's trajectory. Fixed 12 months,
          so it does not move with the date filter (same reasoning as the pipeline). */}
      <ChartCard
        title="Cost per booked job — trailing 12 months"
        subtitle={`Paid channels only · against the ${money(CPBJ_BENCHMARK.low)} industry floor · trailing 12 months, not affected by the date filter`}
      >
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={CPBJ_TREND} margin={{ top: 8, right: 16 }}>
              <CartesianGrid stroke={token('--border-color')} vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: C.muted }} axisLine={false} tickLine={false} />
              <YAxis
                tickFormatter={money}
                tick={{ fontSize: 11, fill: C.muted }}
                axisLine={false}
                tickLine={false}
                width={64}
                domain={[0, 600]}
              />
              <Tooltip formatter={(v) => [formatCurrency(Number(v)), 'Cost / booked job']} cursor={{ stroke: token('--border-color') }} />
              {/* The outside reference, labelled - a bare line would read as a grid rule. */}
              <ReferenceLine
                y={CPBJ_BENCHMARK.low}
                stroke={C.warning}
                strokeWidth={2}
                label={{ value: `${money(CPBJ_BENCHMARK.low)} industry floor`, position: 'insideTopRight', fontSize: 11, fill: C.warning }}
              />
              {/* Single series, so no legend - the title names it. */}
              <Line
                type="monotone"
                dataKey="cpbj"
                stroke={chartPalette[0]}
                strokeWidth={2}
                dot={{ r: 3, fill: chartPalette[0], strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-text-secondary mt-2">
          Down from {money(CPBJ_TREND[0]!.cpbj)} to {money(CPBJ_TREND[CPBJ_TREND.length - 1]!.cpbj)} - below the
          industry floor every month since January. August ticks up because the month is
          only part-run.
        </p>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className={`${card} p-5`}>
          <CardHeader
            title="Conversion funnel"
            subtitle="Lead → quoted → won → completed · the drop between stages is the number to work on"
          />
          {/* One quantity shrinking, so ONE color - four categorical hues implied four
              unrelated things. The stage-to-stage conversion is the actual insight, so
              it is labelled between the bars rather than left to be inferred. */}
          <div className="space-y-1">
            {period.funnel.map((f, i) => {
              const prev = i > 0 ? period.funnel[i - 1]! : null;
              const pct = prev ? Math.round((f.count / prev.count) * 100) : null;
              const width = Math.round((f.count / period.funnel[0]!.count) * 100);
              return (
                <div key={f.stage}>
                  {pct !== null && (
                    <div className="text-[11px] text-text-secondary pl-[92px] py-0.5">
                      ↓ {pct}% {f.stage.toLowerCase()}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="w-[80px] shrink-0 text-[12px] text-text-secondary">{f.stage}</span>
                    <div className="flex-1 h-6 flex items-center">
                      <div
                        className="h-full rounded-r"
                        style={{ width: `${width}%`, background: chartPalette[0] }}
                      />
                      <span className="ml-2 text-[13px] font-semibold text-text-primary">
                        {f.count.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {(() => {
            // Name the worst stage-to-stage loss outright; an owner should not have to
            // compare four percentages to find where the money leaks.
            let worst = { stage: '', lost: 0, pct: 0 };
            period.funnel.forEach((f, i) => {
              if (i === 0) return;
              const prev = period.funnel[i - 1]!;
              const lost = prev.count - f.count;
              if (lost > worst.lost) {
                worst = { stage: `${prev.stage} → ${f.stage}`, lost, pct: Math.round((lost / prev.count) * 100) };
              }
            });
            return (
              <p className="text-[11px] text-text-secondary mt-3">
                Biggest drop: <b>{worst.stage}</b> — {worst.lost.toLocaleString()} lost ({worst.pct}%).
              </p>
            );
          })()}
        </div>

        <div className={`${card} p-5`}>
          <CardHeader
            title="Service line profitability"
            subtitle="Gross margin vs the expected band for that KIND of work — install and service are not comparable"
          />
          <table className="w-full text-[13px]" aria-label="Service line profitability">
            <tbody>
              {period.profit.map((p) => {
                const v = bandVerdict(p.line, p.margin);
                return (
                  <tr key={p.line}>
                    <td className="py-2 pr-3 font-medium text-text-primary">{p.line}</td>
                    <td className="py-2 px-2 text-text-secondary text-right whitespace-nowrap">{money(p.revenue)}</td>
                    <td className="py-2 px-2 font-semibold text-right" style={{ color: v.tone }}>
                      {p.margin}%
                    </td>
                    <td className="py-2 pl-2 w-[120px]">
                      {/* Bullet row: the shaded span is the expected band for this kind of
                          work, the tick is where this line actually sits. Reading "is the
                          tick past the band" is the whole judgement. */}
                      <div className="relative h-3">
                        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-border-soft" />
                        {v.band && (
                          <div
                            className="absolute top-1/2 -translate-y-1/2 h-1 rounded bg-border"
                            style={{
                              left: `${(v.band[0] / MARGIN_SCALE_MAX) * 100}%`,
                              width: `${((v.band[1] - v.band[0]) / MARGIN_SCALE_MAX) * 100}%`,
                            }}
                          />
                        )}
                        <div
                          className="absolute top-0 h-3 w-[3px] rounded"
                          style={{ left: `${(p.margin / MARGIN_SCALE_MAX) * 100}%`, background: v.tone }}
                        />
                      </div>
                    </td>
                    <td className="py-2 pl-3 text-[11px] text-right whitespace-nowrap" style={{ color: v.tone }}>
                      {v.label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-text-secondary mt-3">
            Bands are industry norms per work type — install 28-38%, service 65-72%. A 39%
            install margin beats its band; a 62% service margin is under its own. Grey span
            is the band, the tick is this line.
          </p>
        </div>
      </div>

      <div className={`${card} p-5`}>
        <CardHeader
          title="Organic & reputation"
          subtitle="Google Business Profile + reviews — the earned channel"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8">
          {period.organic.map((o) => (
            <div key={o[0]} className="flex items-baseline justify-between py-2 border-b border-border-soft">
              <span className="text-[13px] text-text-primary">{o[0]}</span>
              <span className="flex items-baseline gap-2">
                <span className="text-[13px] font-bold text-text-primary">{o[1]}</span>
                <span className="text-[12px] font-medium text-success">{o[2]}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-text-secondary pt-1">
        Sample figures shown for preview. Marketing attribution connects to your live lead sources
        and job revenue once campaign tracking is enabled for your account.
      </p>
    </div>
  );
}

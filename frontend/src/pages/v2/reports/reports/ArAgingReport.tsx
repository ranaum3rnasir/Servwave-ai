import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { AlertTriangle, ChevronRight, Gauge, Hourglass, ShieldCheck } from 'lucide-react';

import { ChartCard } from '@/components/charts';
import { chartLabelStyle } from '@/components/charts/chartTheme';
import { token } from '@/design-system/tokens';
import { Collapse } from '@/components/ui/collapse';
import { exportCsvFile } from '@/lib/csv';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import { useArAging } from '@/lib/reports/ar-aging-data';
import {
  ACTION, BUCKET_COLOR, BUCKET_ORDER, aggregate, applyDateRange, applyFilter, arAgingCsv,
  bucketFor, bucketTotals, invoiceDate,
  type Account, type Bucket, type DateField, type Filter, type FlatInvoice,
} from '@/lib/reports/arAging.data';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { ReportToolbar } from '../components/shared';
import { DateRangeControl } from '../components/dateRangeControl';
import { preferV2Path } from '../../uiV2';

/**
 * F4 - AR Aging & Collections.
 *
 * The whole aging model is imported from `arAging.data`: the bucket order, the
 * bucket colour ramp, `bucketFor`, `aggregate`, `applyFilter`,
 * `applyDateRange`, the escalation `ACTION` cadence and the CSV shape. The
 * date presets are copied because they are private to the legacy page.
 *
 * BUCKET_COLOUR IS A SEVERITY RAMP AND IT IS UNTOUCHED. It worsens as an
 * invoice ages, and the same array colours the aging chart, the mini per-section
 * charts and every bucket pill - so the pills keep reading it through an inline
 * `background` rather than moving to a kit Badge variant, which would break the
 * pill/bar correspondence. Everything from `<ResponsiveContainer>` down is
 * carried over verbatim.
 *
 * `Collapse` stays the legacy `components/ui/collapse` - the kit ships no
 * accordion or disclosure primitive at all (ledger row).
 *
 * Two shape differences: the per-account expand chevron is a kit Button (the
 * raw-tag ratchet is at its floor), and the invoice table's `<tfoot>` totals
 * row is a `ReportTableTotals` strip beneath the table, because the kit's
 * DataTable has no footer slot.
 */

const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n: number) => `${Math.round(n)}%`;
const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

type Preset = 'all' | 'today' | 'yesterday' | '7d' | 'lastWeek' | 'month' | 'lastMonth' | '30d' | 'year' | 'lastYear' | 'custom';

const PRESET_LABEL: Record<Preset, string> = {
  all: 'All time', today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', lastWeek: 'Last week',
  month: 'This month', lastMonth: 'Last month', '30d': 'Last 30 days', year: 'This year', lastYear: 'Last year', custom: 'Custom',
};

const DATE_FIELDS: { key: DateField; label: string }[] = [
  { key: 'issued', label: 'Invoice date' },
  { key: 'due', label: 'Due date' },
];

function presetRange(p: Preset, now: Date, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  if (p === 'custom') {
    return {
      from: customFrom ? new Date(customFrom + 'T00:00:00') : null,
      to: customTo ? new Date(customTo + 'T23:59:59.999') : null,
    };
  }
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const weekStart = new Date(start); weekStart.setDate(start.getDate() - start.getDay()); // Sunday
  switch (p) {
    case 'today': return { from: start, to: end };
    case 'yesterday': { const y = new Date(start); y.setDate(start.getDate() - 1); const ye = new Date(y); ye.setHours(23, 59, 59, 999); return { from: y, to: ye }; }
    case '7d': { const f = new Date(start); f.setDate(start.getDate() - 6); return { from: f, to: end }; }
    case 'lastWeek': { const f = new Date(weekStart); f.setDate(weekStart.getDate() - 7); const t = new Date(weekStart); t.setDate(weekStart.getDate() - 1); t.setHours(23, 59, 59, 999); return { from: f, to: t }; }
    case 'month': { const f = new Date(now.getFullYear(), now.getMonth(), 1); return { from: f, to: end }; }
    case 'lastMonth': return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999) };
    case '30d': { const f = new Date(start); f.setDate(start.getDate() - 29); return { from: f, to: end }; }
    case 'year': return { from: new Date(now.getFullYear(), 0, 1), to: end };
    case 'lastYear': return { from: new Date(now.getFullYear() - 1, 0, 1), to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999) };
    case 'all': default: return { from: null, to: null };
  }
}

/** The severity-ramp pill. Its fill is the bucket colour, never a kit variant. */
function BucketPill({ bucket }: { bucket: Bucket }) {
  return (
    <span
      className="text-on-fill inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: BUCKET_COLOR[bucket] }}
    >
      {bucket}
    </span>
  );
}

function MiniAgingChart({ data }: { data: { bucket: Bucket; value: number; color: string }[] }) {
  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" />
        <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: token('--text-secondary') }} interval={0} />
        <YAxis tickFormatter={money0} tick={{ fontSize: 9, fill: token('--text-secondary') }} width={64} />
        <Tooltip formatter={(v: number) => money0(v)} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((b) => <Cell key={b.bucket} fill={BUCKET_COLOR[b.bucket]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function WorklistSection({
  title, subtitle, accounts, expandedId, onToggle,
}: {
  title: string; subtitle: string; accounts: Account[];
  expandedId: string | null; onToggle: (id: string) => void;
}) {
  const sectionTotals = bucketTotals(accounts);
  const sorted = [...accounts].sort((a, b) => aggregate(b.invoices).balance - aggregate(a.invoices).balance);
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <ReportHeading level={2} scale="lg">{title}</ReportHeading>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
        <div className="w-44 shrink-0"><MiniAgingChart data={sectionTotals} /></div>
      </div>
      {sorted.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">No customers match this filter.</p>
      ) : (
        <div className="mt-3 divide-y">
          {sorted.map((a) => {
            const agg = aggregate(a.invoices);
            const open = expandedId === a.id;
            return (
              <div key={a.id}>
                <div className="flex items-center gap-3 py-2.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onToggle(a.id)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} invoices for ${a.customer}`}
                  >
                    <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <Link to={preferV2Path(`/customers/${a.id}`)} className="text-brand truncate font-medium hover:underline">
                      {a.customer}
                    </Link>
                    <div className="text-muted-foreground truncate text-xs">
                      {a.type} · {a.invoices.length} invoice{a.invoices.length > 1 ? 's' : ''}
                    </div>
                  </div>
                  <BucketPill bucket={agg.bucket} />
                  <span className="text-muted-foreground w-14 text-right tabular-nums">{agg.daysLate}d</span>
                  <span className="w-24 text-right font-medium tabular-nums">{`$${Math.round(agg.balance).toLocaleString('en-US')}`}</span>
                  <span className="text-muted-foreground hidden w-28 text-right text-xs sm:inline">{ACTION[agg.bucket]}</span>
                </div>
                <Collapse open={open} className="mb-2 ml-9">
                  <div className="bg-muted rounded-lg border">
                    {a.invoices.map((inv) => {
                      const b = bucketFor(inv.daysLate);
                      return (
                        <div key={inv.number} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="text-muted-foreground w-20 font-mono text-xs">{inv.number}</span>
                          <span className="text-muted-foreground min-w-0 flex-1 truncate">{inv.location ?? '-'}</span>
                          <BucketPill bucket={b} />
                          <span className="text-muted-foreground w-14 text-right tabular-nums">{inv.daysLate}d</span>
                          <span className="w-24 text-right tabular-nums">{`$${Math.round(inv.balance).toLocaleString('en-US')}`}</span>
                        </div>
                      );
                    })}
                  </div>
                </Collapse>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function ArAgingReport() {
  const report = findReport('unpaid-invoices')!;
  const isDemo = useIsDemoOrg();
  const { accounts: ACCOUNTS, now: NOW, dso, isLoading: arLoading, isError: arError } = useArAging(isDemo);
  const [type, setType] = useState<'all' | 'Residential' | 'Commercial'>('all');
  const [filter, setFilter] = useState<Filter | null>(null); // null = Total Unpaid (all buckets)
  const [sortByDaysLate, setSortByDaysLate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('all');
  const [field, setField] = useState<DateField>('issued');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(() => presetRange(preset, NOW, customFrom, customTo), [preset, customFrom, customTo, NOW]);

  // date range -> customer type -> bucket filter -> re-aggregate. ACCOUNTS is
  // in the deps so the report recomputes when the live query resolves from []
  // to data.
  const dateScoped = useMemo(() => applyDateRange(ACCOUNTS, field, range.from, range.to, NOW), [ACCOUNTS, field, range, NOW]);
  const visible = useMemo<Account[]>(() => {
    const byType = dateScoped.filter((a) => type === 'all' || a.type === type);
    return applyFilter(byType, filter);
  }, [dateScoped, type, filter]);

  const invoiceRows = useMemo<FlatInvoice[]>(() => {
    const flat = visible.flatMap((a) => a.invoices.map((i) => ({
      key: `${a.id}-${i.number}`, customer: a.customer, type: a.type, location: i.location ?? '-',
      number: i.number, bucket: bucketFor(i.daysLate), daysLate: i.daysLate, balance: i.balance,
      date: invoiceDate(i, field, NOW),
    })));
    return sortByDaysLate
      ? flat.sort((x, y) => y.daysLate - x.daysLate)
      : flat.sort((x, y) => y.balance - x.balance);
  }, [visible, sortByDaysLate, field, NOW]);
  const invoiceTotal = invoiceRows.reduce((s, r) => s + r.balance, 0);

  const overall = useMemo(() => bucketTotals(visible), [visible]);
  // KPIs reflect the date-scoped, type-scoped set (no bucket filter) so they
  // stay meaningful as filter targets.
  const scoped = useMemo(() => dateScoped.filter((a) => type === 'all' || a.type === type), [dateScoped, type]);
  const scopedTotals = useMemo(() => bucketTotals(scoped), [scoped]);
  const scopedTotal = scopedTotals.reduce((s, b) => s + b.value, 0);
  const over90 = scopedTotals.filter((b) => ['91-120', '121+'].includes(b.bucket)).reduce((s, b) => s + b.value, 0);
  const current = scopedTotals.find((b) => b.bucket === 'current')?.value ?? 0;
  const currentPct = scopedTotal ? (current / scopedTotal) * 100 : 0;

  const filterActive = (buckets: Bucket[]) =>
    !!filter && filter.buckets.length === buckets.length && buckets.every((b) => filter.buckets.includes(b));
  const setBucketFilter = (buckets: Bucket[] | null) => {
    setSortByDaysLate(false);
    setExpandedId(null);
    setFilter(buckets ? { buckets } : null);
  };

  const fieldLabel = DATE_FIELDS.find((f) => f.key === field)?.label ?? 'Invoice date';
  function exportCsv() {
    const { header, rows } = arAgingCsv(invoiceRows, fieldLabel);
    exportCsvFile('unpaid-invoices.csv', header, rows);
  }

  const columns: ReportColumn<FlatInvoice>[] = [
    {
      id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (r) => r.customer,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.customer}</div>
          <div className="text-muted-foreground truncate text-xs">{r.type}</div>
        </div>
      ),
      footer: <span>Total</span>,
    },
    { id: 'location', header: 'Location', width: 130, min: 100, sortValue: (r) => r.location, cell: (r) => <span className="text-muted-foreground truncate">{r.location}</span> },
    { id: 'number', header: 'Invoice', width: 100, min: 90, sortValue: (r) => r.number, cell: (r) => <span className="text-muted-foreground font-mono text-xs">{r.number}</span> },
    { id: 'date', header: fieldLabel, width: 110, min: 95, sortValue: (r) => r.date.getTime(), cell: (r) => <span className="text-muted-foreground tabular-nums">{shortDate(r.date)}</span> },
    { id: 'bucket', header: 'Bucket', width: 110, min: 95, sortValue: (r) => BUCKET_ORDER.indexOf(r.bucket), cell: (r) => <BucketPill bucket={r.bucket} /> },
    { id: 'daysLate', header: 'Days late', width: 100, min: 90, align: 'right', sortValue: (r) => r.daysLate, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.daysLate}</span> },
    {
      id: 'balance', header: 'Balance', width: 120, min: 105, align: 'right', sortValue: (r) => r.balance,
      cell: (r) => <span className="font-medium tabular-nums">{money0(r.balance)}</span>,
      footer: <span className="tabular-nums">{money0(invoiceTotal)}</span>,
    },
    { id: 'action', header: 'Next action', width: 140, min: 120, sortValue: (r) => ACTION[r.bucket], cell: (r) => <span className="text-muted-foreground">{ACTION[r.bucket]}</span> },
  ];

  return (
    <ReportShell
      report={report}
      actions={
        <>
          <DateRangeControl
            presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
            preset={preset}
            onPreset={(k) => setPreset(k as Preset)}
            from={range.from}
            to={range.to}
            fields={DATE_FIELDS}
            field={field}
            onField={(k) => setField(k as DateField)}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
          />
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger aria-label="Customer type" size="sm" className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All customers</SelectItem>
              <SelectItem value="Residential">Residential</SelectItem>
              <SelectItem value="Commercial">Commercial</SelectItem>
            </SelectContent>
          </Select>
          <ReportToolbar variant="compact" onExport={exportCsv} />
        </>
      }
    >
      <ReportKpis
        items={[
          {
            icon: Hourglass, label: 'Total Unpaid', value: money0(scopedTotal), tone: 'neutral',
            active: !filter && !sortByDaysLate, activeLabel: 'All', onClick: () => setBucketFilter(null),
          },
          {
            icon: ShieldCheck, label: 'Current', value: pct(currentPct),
            tone: currentPct >= 80 ? 'success' : 'warning', emphasize: true,
            active: filterActive(['current']), onClick: () => setBucketFilter(['current']),
          },
          {
            icon: AlertTriangle, label: '90+ Days', value: money0(over90),
            tone: 'danger', emphasize: true,
            active: filterActive(['91-120', '121+']), onClick: () => setBucketFilter(['91-120', '121+']),
          },
          {
            icon: Gauge, label: 'DSO (days)',
            value: arLoading ? '-' : dso === null ? '-' : String(dso),
            tone: dso !== null && dso <= 36 ? 'success' : 'warning',
            active: sortByDaysLate, activeLabel: 'Sorted',
            onClick: () => { setSortByDaysLate((v) => !v); },
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <ChartCard title="Unpaid by age" subtitle="Healthy = 80%+ current, under 3% over 90d" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={overall} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: token('--text-secondary') }} interval={0} />
              <YAxis tickFormatter={money0} tick={{ fontSize: 11, fill: token('--text-secondary') }} width={96} />
              <Tooltip formatter={(v: number) => money0(v)} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                <LabelList dataKey="value" position="top" formatter={(v: number) => (v ? money0(v) : '')} style={chartLabelStyle} />
                {overall.map((b) => <Cell key={b.bucket} fill={BUCKET_COLOR[b.bucket]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="space-y-4 lg:col-span-3">
          <WorklistSection
            title="Account clients" subtitle="Commercial accounts - expand for per-invoice aging"
            accounts={visible.filter((a) => a.type === 'Commercial')}
            expandedId={expandedId} onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
          />
          <WorklistSection
            title="Individual clients" subtitle="Residential - expand for per-invoice aging"
            accounts={visible.filter((a) => a.type === 'Residential')}
            expandedId={expandedId} onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
          />
        </div>
      </div>

      <div>
        <div className="mb-3 px-1">
          <ReportHeading level={2} scale="lg">All invoices</ReportHeading>
          <p className="text-muted-foreground text-xs">
            Every open invoice across customers - sortable, matches the active filter
          </p>
        </div>
        <ReportTable
          rows={invoiceRows}
          getRowKey={(r) => r.key}
          empty={<EmptyState title="No invoices match this filter." />}
          columns={columns}
        />
        <ReportTableTotals columns={columns} className="mt-2" />
      </div>

      <p className="text-muted-foreground text-xs">
        {isDemo && 'Sample data shown so the layout is reviewable without a backend. '}
        Commercial = multi-invoice accounts, Residential = individual clients. Click a KPI to filter, a row to
        expand its invoices, or a name to open the customer. Escalation cadence: email @20d, call @30d, call +
        letter @45d, final @60d.
      </p>
    </ReportShell>
  );
}

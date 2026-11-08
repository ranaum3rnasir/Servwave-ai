import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Banknote, Check, ChevronDown, CreditCard, DollarSign, FileText, HandCoins,
  Percent, Repeat, Search, Wallet, X,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import { formatCurrency } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import {
  PAYMENT_CATEGORIES, PAYMENT_METHODS, PAYMENT_STATUSES, TECHNICIANS, usePaymentsReport,
  type PaymentCategory, type PaymentStatus, type PaymentTxn,
} from '@/lib/reports/payments-report-data';
import { usePaymentFeesReport } from '@/lib/reports/payment-fees-data';
import {
  DATE_PRESETS, categoryBreakdown, computeKpis, countable, filterNoCategory, filterPayments,
  filteredTotals, priorRange, resolveRange, weeklyTrend, type DatePreset,
} from '@/lib/reports/payments-report-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard } from '@/ui-kit/components/data/statCard';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Input } from '@/ui-kit/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Td } from '../components/td';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { Delta, ReportPager, ReportToolbar, Sparkline } from '../components/shared';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * F5 - Payments collected & method mix.
 *
 * `payments-report-logic` does every derivation and all of it is imported:
 * `resolveRange`/`priorRange` (the period and its prior-period twin, which is
 * what the delta pills compare against), `filterNoCategory` vs `filterPayments`
 * (the two-stage filter that keeps the category KPIs honest while they act as
 * filters), `computeKpis`, `categoryBreakdown`, `weeklyTrend`,
 * `filteredTotals`, and `countable`.
 *
 * `countable` is load-bearing and easy to lose: a deposit-credit row is listed
 * but never summed (#498), so the per-category payment COUNT has to come from
 * the same predicate the money total does. It is called here exactly as before.
 *
 * TIPS ARE REAL DATA, NOT DEMO DRESSING (SRVW-55, SRVW-193/194). Payments carry
 * `tip_amount` in the schema and `usePaymentsReport` maps it for a live org too,
 * so the Tip column, the Total tips card and the CSV's Tip column are
 * unconditional - the same three surfaces the legacy report shows. This file was
 * ported from the pre-SRVW-55 report and kept its `isDemo` gate; that gate is
 * gone, because hiding a real org's own tips is a defect, not a safeguard.
 *
 * CHARTS UNTOUCHED. `CAT_COLOR` maps the four payment categories onto the calm
 * categorical palette, and that same array colours the category bars, the
 * trend lines, the breakdown-table swatches, the row swatch in the transaction
 * table and each row's sparkline. Substituting a kit token in any one of them
 * would break the correspondence, so all five read the array. The revenue bars
 * keep their own semantic fill: red when the category is down on the prior
 * period, green otherwise.
 *
 * Shape differences: the multi-column "Filter results" panel is now the kit's
 * `Popover` (it was a hand-rolled panel plus a document `mousedown` listener),
 * the processing-fee tiles are kit `StatCard`s, and the transaction table's
 * `<tfoot>` is a `ReportTableTotals` strip.
 */

const money = (n: number) => formatCurrency(n);
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// Per-category colors - the calm categorical palette (no rainbow / off-brand hex).
const CAT_COLOR: Record<PaymentCategory, string> = {
  Invoice: chartPalette[1]!, // ocean
  Deposit: chartPalette[2]!, // indigo
  Account: chartPalette[0]!, // green
  Recurring: chartPalette[3]!, // amber
};

const CAT_ICON: Record<PaymentCategory, typeof FileText> = {
  Invoice: FileText,
  Deposit: HandCoins,
  Account: Wallet,
  Recurring: Repeat,
};

const STATUS_VARIANT: Record<PaymentStatus, NonNullable<BadgeProps['variant']>> = {
  Succeeded: 'softGreen',
  Pending: 'softAmber',
  Failed: 'softRed',
  Refunded: 'softNeutral',
};

interface FilterCol {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/** The multi-column "Filter results" picker, on the kit's Popover. */
function FilterResults({ columns }: { columns: FilterCol[] }) {
  const total = columns.reduce((a, c) => a + c.selected.length, 0);
  const toggle = (c: FilterCol, v: string) =>
    c.onChange(c.selected.includes(v) ? c.selected.filter((x) => x !== v) : [...c.selected, v]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="min-w-[240px] flex-1 justify-between">
          <span className="truncate">
            {total === 0 ? 'Filter results' : `${total} filter${total === 1 ? '' : 's'} applied`}
          </span>
          <ChevronDown className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-h-[60vh] w-[620px] max-w-[calc(100vw-2rem)] grid-cols-2 gap-x-6 gap-y-1 overflow-auto sm:grid-cols-4">
        {columns.map((c) => (
          <div key={c.label} className="min-w-0">
            <div className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">{c.label}</div>
            <div className="space-y-0.5">
              {c.options.map((o) => {
                const on = c.selected.includes(o);
                return (
                  <Button
                    key={o}
                    type="button"
                    variant={on ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={on}
                    onClick={() => toggle(c, o)}
                    className="w-full justify-between gap-2"
                  >
                    <span className="truncate">{o}</span>
                    {on && <Check className="shrink-0" />}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export default function PaymentsReport() {
  // The same report is reachable from the Main tab ("Payments") and the Finance
  // tab ("Payments Collected & Method Mix") - both point at the `payments` slug.
  // Title the page after whichever card the user came through.
  const { slug } = useParams<{ slug: string }>();
  const report = findReport(slug) ?? findReport('payments')!;
  // Demo orgs keep the seeded mock; real orgs read live DB payments, tips
  // included. The aggregation logic below is identical for both.
  const isDemo = useIsDemoOrg();
  const { rows: ALL } = usePaymentsReport(isDemo);

  const [search, setSearch] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [techs, setTechs] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [preset, setPreset] = useState<DatePreset>('3m');
  // Lazy initialisers: the clock is read once, when the state is created, which
  // is exactly what an eagerly evaluated initial value did - but without reading
  // it during every render.
  const [customFrom, setCustomFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filters or page size change
  useEffect(() => setPage(0), [search, methods, techs, categories, statuses, preset, customFrom, customTo, pageSize]);

  const range = useMemo(() => resolveRange(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const filters = useMemo(
    () => ({ search, methods, technicians: techs, categories, statuses, range }),
    [search, methods, techs, categories, statuses, range],
  );

  // Date+method+tech+status+search filtered (excludes category) - drives KPIs
  // and the dashboard.
  const baseRows = useMemo(() => filterNoCategory(ALL, filters), [ALL, filters]);
  // Prior-period equivalent (for the delta pills).
  const priorRows = useMemo(() => {
    const pr = priorRange(range);
    if (!pr) return null;
    return filterNoCategory(ALL, { ...filters, range: pr });
  }, [ALL, filters, range]);

  // Fully filtered (adds category) - drives the transaction table.
  const tableRows = useMemo(() => filterPayments(ALL, filters), [ALL, filters]);

  const kpis = useMemo(() => computeKpis(baseRows), [baseRows]);
  const priorKpis = useMemo(() => (priorRows ? computeKpis(priorRows) : null), [priorRows]);
  const breakdown = useMemo(() => categoryBreakdown(ALL, baseRows, priorRows), [ALL, baseRows, priorRows]);
  const trend = useMemo(() => weeklyTrend(ALL, 8), [ALL]);
  const totals = useMemo(() => filteredTotals(tableRows), [tableRows]);

  // Payment processing fees (Gross/Stripe/ServWave/Net), backend-aggregated over
  // the SAME period this page already has selected, so it needs no period
  // control of its own.
  const feeRange = useMemo(
    () => ({
      from: isFinite(range.from) ? new Date(range.from).toISOString().slice(0, 10) : undefined,
      to: isFinite(range.to) ? new Date(range.to).toISOString().slice(0, 10) : undefined,
    }),
    [range],
  );
  // isLoading drives the tile's own skeleton rather than a bare "$0.00" flash
  // that would misleadingly read as "this org has no processing fees".
  const { data: feesData, isLoading: feesLoading } = usePaymentFeesReport(feeRange);
  const serviceFeeCount = feesData?.serviceFeeCount ?? 0;
  const tipCount = feesData?.tipCount ?? 0;

  const toggleCategory = (c: PaymentCategory) =>
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const hasFilters =
    !!search || methods.length || techs.length || categories.length || statuses.length || preset !== 'all';
  const clearFilters = () => {
    setSearch(''); setMethods([]); setTechs([]); setCategories([]); setStatuses([]); setPreset('all');
  };

  function exportCsv() {
    exportCsvFile(
      'payments-report.csv',
      ['ID', 'Date', 'Amount', 'Tip', 'Status', 'Type', 'Category', 'Client', 'Email', 'Card', 'Technician', 'Transaction', 'Confirmation'],
      tableRows.map((r) => [
        r.id, new Date(r.date).toISOString().slice(0, 10), r.amount, r.tip,
        r.status, r.method, r.category, r.client, r.email, r.card, r.technician, r.txnKind, r.confirmation,
      ]),
    );
  }

  const pageCount = Math.max(1, Math.ceil(tableRows.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * pageSize;
  const pageRows = tableRows.slice(start, start + pageSize);

  // KPI cards: Revenue + Collected + the four categories.
  const catCard = (c: PaymentCategory) => {
    return {
      icon: CAT_ICON[c],
      label: c,
      value: money(kpis.byCategory[c]),
      tone: 'neutral' as const,
      active: categories.includes(c),
      onClick: () => toggleCategory(c),
    };
  };

  const columns: ReportColumn<PaymentTxn>[] = [
    { id: 'id', header: 'ID', width: 90, min: 80, sortValue: (r) => r.id, cell: (r) => <span className="text-brand font-medium">{r.id}</span> },
    // A deposit-credit row is listed but never summed (#498), so it is muted and
    // labelled - otherwise its amount looks like it is missing from the total.
    {
      id: 'amount', header: 'Amount', width: 110, min: 95, align: 'right', sortValue: (r) => r.amount,
      cell: (r) => (r.isDepositCredit
        ? <span className="text-muted-foreground tabular-nums" title="Deposit already collected, applied here as credit - not counted again">{money(r.amount)} <span className="text-xs">credit</span></span>
        : <span className="font-medium tabular-nums">{money(r.amount)}</span>),
      footer: <span className="tabular-nums">{money(totals.amount)}</span>,
    },
    { id: 'date', header: 'Date', width: 130, min: 115, sortValue: (r) => r.date, cell: (r) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate(r.date)}</span> },
    { id: 'status', header: 'Status', width: 110, min: 100, sortValue: (r) => r.status, cell: (r) => <Badge variant={STATUS_VARIANT[r.status]} size="pill">{r.status}</Badge> },
    { id: 'method', header: 'Type', width: 150, min: 120, sortValue: (r) => r.method, cell: (r) => <span>{r.method}</span> },
    {
      id: 'category', header: 'Category', width: 110, min: 95, sortValue: (r) => r.category,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ background: CAT_COLOR[r.category] }} />
          {r.category}
        </span>
      ),
    },
    {
      id: 'client', header: 'Client', width: 190, min: 150, sortValue: (r) => r.client,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{r.client}</div>
          <div className="text-muted-foreground truncate text-xs">{r.email}</div>
        </div>
      ),
    },
    // Tips ride on real payments (`tip_amount`), so every org sees the column;
    // an untipped row reads as a dash rather than a $0.00 that looks collected.
    {
      id: 'tip', header: 'Tip', width: 90, min: 75, align: 'right',
      sortValue: (r) => r.tip,
      cell: (r) => <span className="text-muted-foreground tabular-nums">{r.tip ? money(r.tip) : '-'}</span>,
      footer: <span className="tabular-nums">{money(totals.tips)}</span>,
    },
    { id: 'card', header: 'Card', width: 110, min: 90, sortValue: (r) => r.card, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.card || '-'}</span> },
    { id: 'technician', header: 'Technician', width: 140, min: 120, sortValue: (r) => r.technician, cell: (r) => <span>{r.technician}</span> },
    { id: 'txn', header: 'Transaction', width: 120, min: 100, sortValue: (r) => r.txnKind, cell: (r) => <span className="text-muted-foreground">{r.txnKind}</span> },
    { id: 'collected', header: 'Collected by', width: 140, min: 120, sortValue: (r) => r.technician, cell: (r) => <span className="text-brand">{r.technician}</span> },
  ];

  return (
    <ReportShell
      report={report}
      subtitle={
        isDemo
          ? 'Sample data - every payment received, by category and method.'
          : 'Every payment received, by category and method.'
      }
      actions={<ReportToolbar variant="compact" onExport={exportCsv} />}
    >
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Total Revenue', value: money(kpis.revenue), tone: 'primary', emphasize: true },
          { icon: Banknote, label: 'Total Collected', value: money(kpis.collected), tone: 'success', emphasize: true },
          catCard('Invoice'),
          catCard('Deposit'),
          catCard('Account'),
          catCard('Recurring'),
        ]}
      />

      {/* Two-pane: dashboard (left) + transaction list (right). The right track
          uses minmax(0,...) so the wide table scrolls INSIDE its card instead of
          stretching the whole page off-screen. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(340px,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-4">
          <ChartCard title="Revenue by category" subtitle="Collected this period · bar color = trend vs last period">
            <ResponsiveContainer width="100%" height={Math.max(160, breakdown.length * 46)}>
              <BarChart data={breakdown} layout="vertical" margin={{ left: 8, right: 96, top: 4, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke={token('--border-color')} />
                <XAxis type="number" tickFormatter={money} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                <YAxis type="category" dataKey="category" width={72} tick={{ fontSize: 12, fill: token('--text-primary') }} />
                <Tooltip formatter={(v: number) => money(v)} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                <Bar
                  dataKey="revenue" radius={[0, 6, 6, 0]} barSize={20} isAnimationActive={false}
                  label={{ position: 'right', formatter: (v: number) => money(v), fontSize: 11, fill: token('--text-secondary') }}
                >
                  {breakdown.map((b) => (
                    <Cell key={b.category} fill={b.delta != null && b.delta < 0 ? token('--danger') : token('--success')} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Weekly trend" subtitle="Last 8 weeks of collected revenue per category">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
                <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                <YAxis tickFormatter={money} tick={{ fontSize: 11, fill: token('--text-secondary') }} width={84} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {PAYMENT_CATEGORIES.map((c) => (
                  <Line key={c} type="monotone" dataKey={c} stroke={CAT_COLOR[c]} strokeWidth={2} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Two tiles, one card - what the customer paid ON TOP of the invoice
              face value, never entering invoice totals (D1/D10). This block used
              to break the payment down into Gross / Stripe fee / ServWave
              platform fee / Net; it no longer does - what the processor and the
              platform each take is ours to reconcile, not the org's to read.
              The fee is card-only by construction; a tip is not, so only the fee
              tile says "card". */}
          {/* The counts ride in the subtitle rather than under each tile: the
              kit's StatCard deliberately ships no sub-line slot. */}
          <ChartCard
            title="Collected on top of the invoice"
            subtitle={
              `${serviceFeeCount} card payment${serviceFeeCount === 1 ? '' : 's'} charged the 3.5% fee`
              + ` · ${tipCount} payment${tipCount === 1 ? '' : 's'} tipped`
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatCard
                label="Card service fee"
                value={money(feesData?.serviceFees ?? 0)}
                loading={feesLoading}
              />
              <StatCard
                label="Customer tips"
                value={money(feesData?.tips ?? 0)}
                loading={feesLoading}
              />
            </div>
          </ChartCard>

          <Card>
            <ReportHeading level={2} scale="lg" className="mb-3">Category breakdown</ReportHeading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">% total</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead className="text-right">8-wk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakdown.map((b) => (
                  <TableRow key={b.category}>
                    <Td>
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2.5 rounded-sm" style={{ background: CAT_COLOR[b.category] }} />
                        {b.category}
                      </span>
                    </Td>
                    <Td className="text-right font-medium tabular-nums">{money(b.revenue)}</Td>
                    <Td className="text-muted-foreground text-right tabular-nums">{b.pct.toFixed(0)}%</Td>
                    <Td className="text-right"><Delta value={b.delta} /></Td>
                    <Td>
                      <div className="flex justify-end">
                        <Sparkline data={b.trend.length ? b.trend : [0, 0]} color={CAT_COLOR[b.category]} />
                      </div>
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>

        <div className="min-w-0 space-y-3">
          {/* Date filter sits top-left where it is always visible; totals right. */}
          <div className="flex flex-wrap items-start gap-3">
            <DateRangeControl
              presets={DATE_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
              preset={preset}
              onPreset={(k) => setPreset(k as DatePreset)}
              from={isFinite(range.from) ? new Date(range.from) : null}
              to={isFinite(range.to) ? new Date(range.to) : null}
              fields={[{ key: 'date', label: 'Payment date' }]}
              field="date"
              onField={() => {}}
              customFrom={customFrom}
              customTo={customTo}
              onCustomFrom={setCustomFrom}
              onCustomTo={setCustomTo}
            />
            <div className="ml-auto flex items-center gap-3">
              <StatCard label="Total amount" value={money(totals.amount)} />
              <StatCard label="Total tips" value={money(totals.tips)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterResults
              columns={[
                { label: 'Payment Type', options: PAYMENT_METHODS, selected: methods, onChange: setMethods },
                { label: 'Technician', options: TECHNICIANS, selected: techs, onChange: setTechs },
                { label: 'Category', options: PAYMENT_CATEGORIES, selected: categories, onChange: setCategories },
                { label: 'Status', options: PAYMENT_STATUSES, selected: statuses, onChange: setStatuses },
              ]}
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search payments"
              placeholder="Search id, client, email"
              startIcon={<Search className="size-4" />}
              className="w-56"
            />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X />
                Clear
              </Button>
            )}
          </div>

          <Card>
            <div className="mb-3 flex items-center justify-between gap-3">
              <ReportHeading level={2} scale="lg">Payments</ReportHeading>
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <span>Rows</span>
                <SelectField
                  value={String(pageSize)}
                  onValueChange={(v) => setPageSize(Number(v))}
                  aria-label="Rows per page"
                  size="sm"
                  className="w-[80px]"
                  options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
            </div>

            <ReportTable<PaymentTxn>
              rows={pageRows}
              getRowKey={(r) => r.id}
              empty={<EmptyState title="No payments match these filters." />}
              columns={columns}
              initialPageSize={pageSize}
            />
            <ReportTableTotals columns={columns} className="mt-2" />

            <ReportPager
              variant="compact"
              page={clampedPage}
              pageCount={pageCount}
              pageSize={pageSize}
              totalItems={tableRows.length}
              onPageChange={setPage}
              emptyLabel="No payments"
            />
          </Card>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {isDemo && 'Sample data shown so the layout is reviewable without a backend. '}
        The left dashboard, KPI cards and totals all follow the date range + filters; the
        weekly-trend chart is a fixed 8-week context window.
      </p>
    </ReportShell>
  );
}

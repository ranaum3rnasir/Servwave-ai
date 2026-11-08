// ───────────────────────────────────────────────────────────────────────────
// Payments report (F5) — Workiz/ServiceTitan-style.
// Left: payments dashboard by category (bars + weekly trend + breakdown).
// Right: the full transaction list with a multi-column filter, date range,
// search and CSV export. Deterministic MOCK data; wire to
// GET /api/reports/payments later. See md_files/specs/payments/.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  DollarSign, Banknote, FileText, HandCoins, Gift, Wallet, Repeat,
  Search, X, ChevronDown, Check,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, LineChart, Line, Legend,
} from 'recharts';
import { KpiStrip, KpiTile } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import { formatCurrency } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { ReportToolbar, ReportPager } from './_shared';
import { Delta, Sparkline } from '@/components/reports/ReportIndicators';
import { DateRangeControl } from './DateRangeControl';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import {
  usePaymentsReport, PAYMENT_METHODS, PAYMENT_CATEGORIES, PAYMENT_STATUSES, TECHNICIANS,
  type PaymentCategory, type PaymentStatus, type PaymentTxn,
} from '@/lib/reports/payments-report-data';
import { usePaymentFeesReport } from '@/lib/reports/payment-fees-data';
import {
  DATE_PRESETS, resolveRange, priorRange, filterNoCategory, filterPayments,
  computeKpis, categoryBreakdown, weeklyTrend, filteredTotals, countable, type DatePreset,
} from '@/lib/reports/payments-report-logic';

const money = (n: number) => formatCurrency(n);
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// Per-category colors — the calm categorical palette (no rainbow / off-brand hex).
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

const STATUS_STYLE: Record<PaymentStatus, string> = {
  Succeeded: 'bg-success/10 text-success',
  Pending: 'bg-warning/10 text-warning',
  Failed: 'bg-danger/10 text-danger',
  Refunded: 'bg-background-light text-text-secondary',
};

// ── Multi-column "Filter results" dropdown (Workiz-style) ─────────────────────
interface FilterCol {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}
function FilterResults({ columns }: { columns: FilterCol[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const total = columns.reduce((a, c) => a + c.selected.length, 0);
  const toggle = (c: FilterCol, v: string) =>
    c.onChange(c.selected.includes(v) ? c.selected.filter((x) => x !== v) : [...c.selected, v]);

  return (
    <div ref={ref} className="relative flex-1 min-w-[240px]">
      {/* raw: outline/neutral sets no idle text colour and nothing in this tree
          supplies text-text-secondary; converting would silently darken the idle
          label to near-black (the documented outline/neutral trap). Left raw. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface-light px-3 text-left text-sm text-text-secondary shadow-sm hover:bg-background-light focus:outline-none focus:ring-2 focus:ring-primary/20"
      >
        <span className="truncate">
          {total === 0 ? 'Filter results' : `${total} filter${total === 1 ? '' : 's'} applied`}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 grid max-h-[60vh] w-[620px] max-w-[calc(100vw-2rem)] grid-cols-2 gap-x-6 gap-y-1 overflow-auto rounded-lg border border-border bg-surface-light p-4 shadow-lg sm:grid-cols-4">
          {columns.map((c) => (
            <div key={c.label} className="min-w-0">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">{c.label}</div>
              <div className="space-y-0.5">
                {c.options.map((o) => {
                  const on = c.selected.includes(o);
                  return (
                    // raw: dropdown-item / checklist row, not Button-shaped
                    <button
                      key={o}
                      type="button"
                      onClick={() => toggle(c, o)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-background-light ${on ? 'bg-primary-subtle font-medium text-text-primary' : 'text-text-primary'}`}
                    >
                      <span className="truncate">{o}</span>
                      {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PaymentsReport() {
  // Same report is reachable from the Main tab ("Payments") and the Finance tab
  // ("Payments Collected & Method Mix") - both point at the `payments` slug.
  // Title the page after whichever card the user came through.
  const { slug } = useParams<{ slug: string }>();
  const report = findReport(slug) ?? findReport('payments')!;
  // Demo orgs keep the seeded mock; real orgs read live DB payments. The
  // aggregation logic below is identical.
  const isDemo = useIsDemoOrg();
  const { rows: ALL, now: NOW } = usePaymentsReport(isDemo);

  const [search, setSearch] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [techs, setTechs] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [preset, setPreset] = useState<DatePreset>('3m');
  const [customFrom, setCustomFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10));

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [search, methods, techs, categories, statuses, preset, customFrom, customTo, pageSize]);

  const range = useMemo(
    () => resolveRange(preset, customFrom, customTo, NOW.getTime()),
    [preset, customFrom, customTo, NOW],
  );
  const filters = useMemo(
    () => ({ search, methods, technicians: techs, categories, statuses, range }),
    [search, methods, techs, categories, statuses, range],
  );

  // Date+method+tech+status+search filtered (excludes category) — drives KPIs & dashboard.
  const baseRows = useMemo(() => filterNoCategory(ALL, filters), [ALL, filters]);
  // Prior-period equivalent (for Δ pills).
  const priorRows = useMemo(() => {
    const pr = priorRange(range);
    if (!pr) return null;
    return filterNoCategory(ALL, { ...filters, range: pr });
  }, [ALL, filters, range]);

  // Fully filtered (adds category) — drives the transaction table.
  const tableRows = useMemo(() => filterPayments(ALL, filters), [ALL, filters]);

  const kpis = useMemo(() => computeKpis(baseRows), [baseRows]);
  const priorKpis = useMemo(() => (priorRows ? computeKpis(priorRows) : null), [priorRows]);
  const breakdown = useMemo(
    () => categoryBreakdown(ALL, baseRows, priorRows, NOW.getTime()),
    [ALL, baseRows, priorRows, NOW],
  );
  const trend = useMemo(() => weeklyTrend(ALL, 8, NOW.getTime()), [ALL, NOW]);
  const totals = useMemo(() => filteredTotals(tableRows), [tableRows]);

  // Task 4.1 — payment processing fees summary (Gross/Stripe/ServWave/Net),
  // backend-aggregated (GET /api/reports/payment-fees) over the SAME period
  // this page already has selected, so it needs no period control of its own.
  const feeRange = useMemo(
    () => ({
      from: isFinite(range.from) ? new Date(range.from).toISOString().slice(0, 10) : undefined,
      to: isFinite(range.to) ? new Date(range.to).toISOString().slice(0, 10) : undefined,
    }),
    [range],
  );
  // isLoading drives KpiTile's own skeleton (rather than a bare "$0.00" flash
  // that would misleadingly read as "this org has no processing fees").
  const { data: feesData, isLoading: feesLoading } = usePaymentFeesReport(feeRange);
  const serviceFeeCount = feesData?.serviceFeeCount ?? 0;
  const tipCount = feesData?.tipCount ?? 0;

  const delta = (cur: number, prev: number | undefined): number | null =>
    prev == null || prev <= 0 ? null : ((cur - prev) / prev) * 100;
  const deltaText = (cur: number, prev: number | undefined): string | undefined => {
    const d = delta(cur, prev);
    if (d == null || Math.abs(d) < 0.5) return undefined;
    return `${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(0)}% vs prior`;
  };

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
    // countable(): the count sits under the category's money value, so it counts the same rows
    // that value sums - a deposit-credit application is excluded from both (#498).
    const n = countable(baseRows).filter((r) => r.status === 'Succeeded' && r.category === c).length;
    const dt = deltaText(kpis.byCategory[c], priorKpis?.byCategory[c]);
    return {
      icon: CAT_ICON[c],
      label: c,
      value: money(kpis.byCategory[c]),
      sub: dt ? `${n} payments · ${dt}` : `${n} payments`,
      tone: 'neutral' as const,
      active: categories.includes(c),
      onClick: () => toggleCategory(c),
    };
  };

  return (
    <ReportShell
      report={report}
      subtitle={
        isDemo
          ? 'Sample data — every payment received, by category and method.'
          : 'Every payment received, by category and method.'
      }
      actions={<ReportToolbar variant="compact" onExport={exportCsv} />}
    >
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Total Revenue', value: money(kpis.revenue), sub: deltaText(kpis.revenue, priorKpis?.revenue) ?? 'succeeded + pending', tone: 'primary', emphasize: true },
          { icon: Banknote, label: 'Total Collected', value: money(kpis.collected), sub: deltaText(kpis.collected, priorKpis?.collected) ?? `${baseRows.filter((r) => r.status === 'Succeeded').length} succeeded`, tone: 'success', emphasize: true },
          catCard('Invoice'),
          catCard('Deposit'),
          catCard('Account'),
          catCard('Recurring'),
        ]}
      />

      {/* Two-pane: dashboard (left) + transaction list (right).
          The right track uses minmax(0,…) so the wide table scrolls INSIDE its
          card instead of stretching the whole page off-screen. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(340px,2fr)_minmax(0,3fr)]">
        {/* ── LEFT: payments dashboard ─────────────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <ChartCard title="Revenue by category" subtitle="Collected this period · bar color = trend vs last period">
            <ResponsiveContainer width="100%" height={Math.max(160, breakdown.length * 46)}>
              <BarChart data={breakdown} layout="vertical" margin={{ left: 8, right: 96, top: 4, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke={token('--border-color')} />
                <XAxis type="number" tickFormatter={money} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
                <YAxis type="category" dataKey="category" width={72} tick={{ fontSize: 12, fill: token('--text-primary') }} />
                <Tooltip formatter={(v: number) => money(v)} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
                <Bar dataKey="revenue" radius={[0, 6, 6, 0]} barSize={20} isAnimationActive={false}
                     label={{ position: 'right', formatter: (v: number) => money(v), fontSize: 11, fill: token('--text-secondary') }}>
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

          {/* Slice 6/7 - fee + tip collected on top of the invoice, never entering invoice
              totals (D1/D10; see payment-fees-report.ts for the doctrine). Each tile owns its
              count (D-A6): the fee and tip populations overlap but neither contains the other.
              The fee is card-only by construction; a tip is not, so only the fee tile says
              "card". */}
          <ChartCard title="Collected on top of the invoice">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <KpiTile
                icon={HandCoins}
                label="Card service fee"
                value={money(feesData?.serviceFees ?? 0)}
                sub={`${serviceFeeCount} card payment${serviceFeeCount === 1 ? '' : 's'} · 3.5% collected from the customer`}
                tone="neutral"
                emphasize
                loading={feesLoading}
              />
              <KpiTile
                icon={Gift}
                label="Customer tips"
                value={money(feesData?.tips ?? 0)}
                sub={`${tipCount} payment${tipCount === 1 ? '' : 's'} tipped`}
                tone="neutral"
                emphasize
                loading={feesLoading}
              />
            </div>
          </ChartCard>

          <div className="rounded-xl border border-border bg-surface-light p-5 shadow-card">
            <Heading level={2} className="mb-3">Category breakdown</Heading>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                  <th className="pb-2 font-medium">Category</th>
                  <th className="pb-2 text-right font-medium">Revenue</th>
                  <th className="pb-2 text-right font-medium">% total</th>
                  <th className="pb-2 text-right font-medium">Δ</th>
                  <th className="pb-2 text-right font-medium">8-wk</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b) => (
                  <tr key={b.category} className="border-b border-border/60 last:border-0">
                    <td className="py-2">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CAT_COLOR[b.category] }} />
                        {b.category}
                      </span>
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(b.revenue)}</td>
                    <td className="py-2 text-right tabular-nums text-text-secondary">{b.pct.toFixed(0)}%</td>
                    <td className="py-2 text-right"><Delta value={b.delta} /></td>
                    <td className="py-2"><div className="flex justify-end"><Sparkline data={b.trend.length ? b.trend : [0, 0]} color={CAT_COLOR[b.category]} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── RIGHT: transaction list ──────────────────────────────────── */}
        <div className="min-w-0 space-y-3">
          {/* Date filter sits top-left where it's always visible; totals on the right. */}
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
              <div className="rounded-xl border border-border bg-surface-light px-4 py-2.5 shadow-card">
                <div className="text-xs text-text-secondary">Total amount</div>
                <div className="text-lg font-bold tabular-nums text-text-primary">{money(totals.amount)}</div>
              </div>
              <div className="rounded-xl border border-border bg-surface-light px-4 py-2.5 shadow-card">
                <div className="text-xs text-text-secondary">Total tips</div>
                <div className="text-lg font-bold tabular-nums text-text-primary">{money(totals.tips)}</div>
              </div>
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
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search id, client, email"
                className="h-10 w-56 rounded-lg border border-border bg-surface-light pl-8 pr-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {hasFilters && (
              // ghost/subtle, size="3xs" - idle text-text-secondary and hover
              // text-text-primary are an exact colour match; the rung adds an
              // hover:bg-background-light the plain raw icon+label control
              // didn't have, and shrinks the raw's unset (no padding, no
              // height) footprint to the 3xs rung's fixed h-6/px-2 - the
              // closest available match, disclosed.
              <Button variant="ghost" tone="subtle" size="3xs" onClick={clearFilters} className="gap-1">
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface-light p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between gap-3">
              <Heading level={2}>Payments</Heading>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <span>Rows</span>
                <SelectField
                  aria-label="Rows per page"
                  className="h-8"
                  value={String(pageSize)}
                  onValueChange={(v) => setPageSize(Number(v))}
                  options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
            </div>

            <ResizableTable<PaymentTxn>
              rows={pageRows}
              getRowKey={(r) => r.id}
              empty={<EmptyState title="No payments match these filters." />}
              columns={[
                { id: 'id', header: 'ID', width: 90, min: 80, sortValue: (r) => r.id, cell: (r) => <span className="font-medium text-primary">{r.id}</span> },
                // A deposit-credit row is listed but never summed (#498), so it is muted and
                // labelled - otherwise its amount looks like it is missing from the footer total.
                { id: 'amount', header: 'Amount', width: 110, min: 95, align: 'right', sortValue: (r) => r.amount, cell: (r) => (r.isDepositCredit
                  ? <span className="tabular-nums text-text-secondary" title="Deposit already collected, applied here as credit - not counted again">{money(r.amount)} <span className="text-xs">credit</span></span>
                  : <span className="font-medium tabular-nums">{money(r.amount)}</span>), footer: <span className="tabular-nums">{money(totals.amount)}</span> },
                { id: 'date', header: 'Date', width: 130, min: 115, sortValue: (r) => r.date, cell: (r) => <span className="whitespace-nowrap text-text-secondary">{fmtDate(r.date)}</span> },
                { id: 'status', header: 'Status', width: 110, min: 100, sortValue: (r) => r.status, cell: (r) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{r.status}</span> },
                { id: 'method', header: 'Type', width: 150, min: 120, sortValue: (r) => r.method, cell: (r) => <span className="text-text-primary">{r.method}</span> },
                { id: 'category', header: 'Category', width: 110, min: 95, sortValue: (r) => r.category, cell: (r) => <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: CAT_COLOR[r.category] }} />{r.category}</span> },
                { id: 'client', header: 'Client', width: 190, min: 150, sortValue: (r) => r.client, cell: (r) => <div className="min-w-0"><div className="truncate font-medium text-text-primary">{r.client}</div><div className="truncate text-xs text-text-secondary">{r.email}</div></div> },
                { id: 'tip', header: 'Tip', width: 90, min: 75, align: 'right', sortValue: (r) => r.tip, cell: (r) => <span className="tabular-nums text-text-secondary">{r.tip ? money(r.tip) : '—'}</span>, footer: <span className="tabular-nums">{money(totals.tips)}</span> },
                { id: 'card', header: 'Card', width: 110, min: 90, sortValue: (r) => r.card, cell: (r) => <span className="tabular-nums text-text-secondary">{r.card || '—'}</span> },
                { id: 'technician', header: 'Technician', width: 140, min: 120, sortValue: (r) => r.technician, cell: (r) => <span className="text-text-primary">{r.technician}</span> },
                { id: 'txn', header: 'Transaction', width: 120, min: 100, sortValue: (r) => r.txnKind, cell: (r) => <span className="text-text-secondary">{r.txnKind}</span> },
                { id: 'collected', header: 'Collected by', width: 140, min: 120, sortValue: (r) => r.technician, cell: (r) => <span className="text-primary">{r.technician}</span> },
              ]}
            />

            <ReportPager
              variant="compact"
              page={clampedPage}
              pageCount={pageCount}
              pageSize={pageSize}
              totalItems={tableRows.length}
              onPageChange={setPage}
              emptyLabel="No payments"
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-text-secondary">
        {isDemo && 'Sample data shown so the layout is reviewable without a backend. '}
        The left dashboard, KPI cards and totals all follow the date range + filters; the
        weekly-trend chart is a fixed 8-week context window.
      </p>
    </ReportShell>
  );
}

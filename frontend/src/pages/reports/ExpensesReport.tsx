// ───────────────────────────────────────────────────────────────────────────
// Expenses Report — expense-led financial report (mock-first).
//
// Profit strip (revenue/expenses/net/margin) + Workiz-style expense report:
// KPI tiles, 12-month spend-by-category chart, and a filterable transaction
// table with inline receipt/description/status edits (local-only for now).
//
// Wire to GET /api/reports/expenses later; expenses-logic.ts mirrors to the
// backend service. The top-right time filter drives the WHOLE page — profit
// strip, KPI tiles, drill-downs, and the table all recompute for the selected
// window (the 12-month spend-by-category trend stays a rolling 12-month view).
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { DollarSign, Wallet, TrendingUp, Percent, CalendarClock, Receipt, Search, Download, Paperclip, Check, X, ChevronRight } from 'lucide-react';
import { KpiTile } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/form/SelectField';
import { formatCurrencyWhole } from '@/lib/utils';
import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system/tokens';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { MultiSelectFilter, FacetFilter } from './_shared';
import { Delta } from '@/components/reports/ReportIndicators';
import type { FacetGroup } from '@/lib/reports/types';
import { DateRangeControl } from './DateRangeControl';
import { buildExpenses, buildMonthlyRevenue } from '@/lib/reports/expenses-data';
import { periodExpenseKpis, periodProfitSummary, withinRange, previousPeriod, EXPENSE_CATEGORIES, spendByCategoryByMonth, spendByCategoryForCardholder, filterExpenses, EXPENSE_STATUSES, EXPENSE_ATTRIBUTES, BUSINESS_UNITS, CARDHOLDERS, USERS, type ExpenseFilters, type ExpenseRow } from '@/lib/reports/expenses-logic';
import { exportCsvFile } from '@/lib/csv';

const NOW = new Date(2026, 5, 6, 12, 0, 0);
// Org-aware whole-dollar currency (honors organization currency setting). (#126)
const usd = (n: number) => formatCurrencyWhole(n);

type Preset = 'month' | 'lastMonth' | '7d' | 'year' | 'all' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  month: 'This month', lastMonth: 'Last month', '7d': 'Last 7 days', year: 'This year', all: 'All time', custom: 'Custom',
};
function presetRange(p: Preset, now: Date, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  if (p === 'custom') {
    const from = customFrom ? new Date(customFrom + 'T00:00:00') : null;
    const to = customTo ? new Date(customTo + 'T23:59:59.999') : null;
    return { from, to };
  }
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  switch (p) {
    case 'month': start.setDate(1); return { from: start, to: end };
    case 'lastMonth': return {
      from: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
    };
    case '7d': start.setDate(now.getDate() - 6); return { from: start, to: end };
    case 'year': return { from: new Date(now.getFullYear(), 0, 1), to: end };
    case 'all': default: return { from: null, to: null };
  }
}

// Categorical expense categories → calm brand palette (cycled, deterministic by order).
const palAt = (i: number) => chartPalette[i % chartPalette.length] ?? token('--text-secondary');
const CATEGORY_COLORS: Record<string, string> = {
  Hardware: palAt(0), Materials: palAt(1), Gas: palAt(2), Parking: palAt(3),
  Software: palAt(4), Tools: palAt(0), Meals: palAt(1), General: palAt(2),
};
const CARDHOLDER_PALETTE = chartPalette;
// Positive/negative money signals for the net/margin/revenue drill bars.
const COLOR_POSITIVE = chartPalette[0] ?? token('--success');
const COLOR_NEGATIVE = token('--danger');
const COLOR_NEUTRAL = chartPalette[1] ?? token('--primary');
const COLOR_ACCENT = chartPalette[2] ?? token('--ai');

export interface DrillBar {
  label: string;
  value: number;
  color?: string;
}

// Inline KPI drill-down: a horizontal bar chart that opens BELOW the KPI tiles
// when one is pressed (replaces the old floating popover).
function DrillChart({
  title, subtitle, data, money, onClose,
}: { title: string; subtitle?: string; data: DrillBar[]; money: boolean; onClose: () => void }) {
  const fmt = (v: number) => (money ? usd(v) : String(Math.round(v)));
  const axisFmt = (v: number) => (money ? usd(v) : String(Math.round(v)));

  return (
    <ChartCard title={title} subtitle={subtitle} action={
      // raw: small close-X affordance, not Button-shaped
      <button onClick={onClose} className="shrink-0 rounded p-1 text-text-secondary hover:bg-background-light" aria-label="Close">
        <X className="h-4 w-4" />
      </button>
    }>
      {data.length === 0 ? (
        <p className="text-sm text-text-secondary">No data to show.</p>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(140, data.length * 38)}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 96, top: 4, bottom: 4 }}>
            <XAxis type="number" tickFormatter={axisFmt} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="label" width={96} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={18} isAnimationActive={false} label={{ position: 'right', formatter: fmt, fontSize: 11, fill: token('--text-secondary') }}>
              {data.map((d, i) => <Cell key={i} fill={d.color ?? palAt(0)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// Row drill-down: ALL of one cardholder's spend by category, as a horizontal
// bar chart. Shown inline when a transaction row is expanded.
function CardholderBreakdown({ cardholder, rows }: { cardholder: string; rows: ExpenseRow[] }) {
  const data = useMemo(() => spendByCategoryForCardholder(rows, cardholder), [rows, cardholder]);
  const total = data.reduce((s, d) => s + d.amount, 0);
  const count = useMemo(() => rows.filter((r) => r.cardholder === cardholder).length, [rows, cardholder]);
  const axisFmt = (v: number) => usd(v);

  return (
    <ChartCard
      title={`All of ${cardholder}'s spend by category`}
      action={<span className="shrink-0 text-xs text-text-secondary">{count} transactions · {usd(total)} total</span>}
    >
      {data.length === 0 ? (
        <p className="text-sm text-text-secondary">No spend on record for {cardholder}.</p>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36)}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 96, top: 4, bottom: 4 }}>
            <XAxis type="number" tickFormatter={axisFmt} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="category" width={88} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v: number) => usd(v)} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            <Bar dataKey="amount" radius={[0, 6, 6, 0]} barSize={18} isAnimationActive={false} label={{ position: 'right', formatter: (v: number) => usd(v), fontSize: 11, fill: token('--text-secondary') }}>
              {data.map((d) => <Cell key={d.category} fill={CATEGORY_COLORS[d.category] ?? token('--text-secondary')} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

export default function ExpensesReport() {
  const report = findReport('expenses')!;
  const [rows] = useState(() => buildExpenses());
  const monthlyRevenue = useMemo(() => buildMonthlyRevenue(NOW), []);

  // ── Time filter (top-right) — drives the WHOLE page: the profit strip, KPI
  // tiles, drill-downs, and the transaction table all recompute for this window.
  const [preset, setPreset] = useState<Preset>('month');
  const expDefaultFrom = useMemo(() => { const d = new Date(NOW); d.setDate(NOW.getDate() - 30); return d; }, []);
  const [customFrom, setCustomFrom] = useState(expDefaultFrom.toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(NOW.toISOString().slice(0, 10));
  const range = useMemo(() => presetRange(preset, NOW, customFrom, customTo), [preset, customFrom, customTo]);
  const presetLabel = PRESET_LABEL[preset];

  // Rows in the selected window, and in the prior equal-length window (for deltas / drill-downs).
  const periodRows = useMemo(() => rows.filter((r) => withinRange(r.date, range.from, range.to)), [rows, range]);
  const prevRange = useMemo(() => previousPeriod(range.from, range.to), [range]);
  const prevPeriodRows = useMemo(
    () => (prevRange.from && prevRange.to ? rows.filter((r) => withinRange(r.date, prevRange.from, prevRange.to)) : []),
    [rows, prevRange],
  );

  const profit = useMemo(() => periodProfitSummary(rows, monthlyRevenue, range.from, range.to), [rows, monthlyRevenue, range]);
  const kpis = useMemo(() => periodExpenseKpis(rows, range.from, range.to), [rows, range]);
  const spend = useMemo(() => spendByCategoryByMonth(rows, NOW, 12), [rows]);

  // ── KPI card breakdown popovers ──────────────────────────────────────────
  const [openCard, setOpenCard] = useState<string | null>(null);
  const toggleCard = (k: string) => setOpenCard((c) => (c === k ? null : k));
  const closeCard = () => setOpenCard(null);

  const mkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const y = NOW.getFullYear();
  const m = NOW.getMonth();
  // Sum a row set by a chosen key, returned as a descending [name, amount] list.
  const groupBy = (rs: typeof rows, key: 'category' | 'cardholder'): [string, number][] => {
    const map: Record<string, number> = {};
    for (const r of rs) map[r[key]] = (map[r[key]] ?? 0) + r.amount;
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  };
  const recentRevenue = [5, 4, 3, 2, 1, 0].map((i) => {
    const d = new Date(y, m - i, 1);
    return { label: d.toLocaleDateString('en-US', { month: 'short' }), value: monthlyRevenue[mkey(d)] ?? 0 };
  });

  // The chart the active KPI tile opens below the strip (replaces the popover).
  const drill = useMemo((): { title: string; subtitle?: string; data: DrillBar[]; money: boolean } | null => {
    if (!openCard) return null;
    const byCat = (rs: typeof rows): DrillBar[] => groupBy(rs, 'category').map(([c, a]) => ({ label: c, value: a, color: CATEGORY_COLORS[c] }));
    const byHolder = (rs: typeof rows): DrillBar[] => groupBy(rs, 'cardholder').map(([c, a], i) => ({ label: c, value: a, color: CARDHOLDER_PALETTE[i % CARDHOLDER_PALETTE.length] ?? COLOR_NEUTRAL }));
    switch (openCard) {
      case 'revenue': return { title: 'Revenue — recent months', data: recentRevenue.map((r) => ({ label: r.label, value: r.value, color: COLOR_POSITIVE })), money: true };
      case 'expenses': return { title: `Expenses by category — ${presetLabel.toLowerCase()}`, subtitle: `${usd(profit.expenses)} total`, data: byCat(periodRows), money: true };
      case 'net': return { title: `Net profit — ${presetLabel.toLowerCase()}`, data: [{ label: 'Revenue', value: profit.revenue, color: COLOR_POSITIVE }, { label: 'Expenses', value: profit.expenses, color: COLOR_NEGATIVE }, { label: 'Net profit', value: profit.net, color: COLOR_ACCENT }], money: true };
      case 'margin': return { title: 'Margin — net vs revenue', subtitle: `${profit.margin.toFixed(0)}% margin`, data: [{ label: 'Revenue', value: profit.revenue, color: COLOR_NEUTRAL }, { label: 'Net profit', value: profit.net, color: COLOR_POSITIVE }], money: true };
      case 'thisMonth': return { title: `${presetLabel} — by cardholder`, subtitle: `${usd(kpis.total)} total`, data: byHolder(periodRows), money: true };
      case 'lastMonth': return { title: 'Previous period — by cardholder', subtitle: `${usd(kpis.prevTotal)} total`, data: byHolder(prevPeriodRows), money: true };
      case 'receipts': return { title: `Receipts — ${presetLabel.toLowerCase()}`, subtitle: `${kpis.receiptsAttached}/${kpis.receiptsTotal} attached`, data: [{ label: 'Attached', value: kpis.receiptsAttached, color: COLOR_POSITIVE }, { label: 'Missing', value: kpis.receiptsTotal - kpis.receiptsAttached, color: token('--warning') }], money: false };
      default: return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCard, recentRevenue, periodRows, prevPeriodRows, profit, kpis, presetLabel]);

  const [search, setSearch] = useState('');
  const [cats, setCats] = useState<string[]>([]);
  const [merchants, setMerchants] = useState<string[]>([]);
  const [cardholders, setCardholders] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [units, setUnits] = useState<string[]>([]);
  const [withAttrs, setWithAttrs] = useState<string[]>([]);
  const [withoutAttrs, setWithoutAttrs] = useState<string[]>([]);

  // Distinct merchants present in the data, for the facet picker's Merchant column.
  const merchantOptions = useMemo(() => [...new Set(rows.map((r) => r.merchant))].sort(), [rows]);

  // Workiz-style faceted filter — its columns share state with the dropdowns below.
  const facetGroups: FacetGroup[] = [
    { key: 'category', label: 'Category', options: [...EXPENSE_CATEGORIES], selected: cats },
    { key: 'merchant', label: 'Merchant', options: merchantOptions, selected: merchants },
    { key: 'user', label: 'User', options: [...USERS], selected: users },
    { key: 'card', label: 'Card', options: [...CARDHOLDERS], selected: cardholders },
    { key: 'unit', label: 'Business unit', options: [...BUSINESS_UNITS], selected: units },
    { key: 'with', label: 'With', options: [...EXPENSE_ATTRIBUTES], selected: withAttrs },
    { key: 'without', label: 'Without', options: [...EXPENSE_ATTRIBUTES], selected: withoutAttrs },
  ];
  const toggleIn = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  const facetSetters: Record<string, (v: string) => void> = {
    category: toggleIn(setCats), merchant: toggleIn(setMerchants), user: toggleIn(setUsers),
    card: toggleIn(setCardholders), unit: toggleIn(setUnits),
    with: toggleIn(setWithAttrs), without: toggleIn(setWithoutAttrs),
  };
  const onFacetToggle = (groupKey: string, value: string) => facetSetters[groupKey]?.(value);
  const onFacetClear = () => {
    setCats([]); setMerchants([]); setUsers([]); setCardholders([]); setUnits([]);
    setWithAttrs([]); setWithoutAttrs([]);
  };

  const filters: ExpenseFilters = useMemo(
    () => ({ from: range.from, to: range.to, categories: cats, merchants, cardholders, users, statuses, businessUnits: units, withAttrs, withoutAttrs, search }),
    [range, cats, merchants, cardholders, users, statuses, units, withAttrs, withoutAttrs, search],
  );
  const filtered = useMemo(() => filterExpenses(rows, filters), [rows, filters]);

  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  // Inline local-only edits keyed by row id (reset on refresh).
  const [edits, setEdits] = useState<Record<string, { description?: string; hasReceipt?: boolean; status?: 'Pending' | 'Settled' }>>({});
  // Which transaction row is expanded into its cardholder drill-down chart.
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const toggleRow = (id: string) => setExpandedRow((cur) => (cur === id ? null : id));

  // Re-page when the filtered set changes.
  useEffect(() => { setPage(0); }, [filtered, pageSize]);

  const view = filtered.map((r) => ({ ...r, ...edits[r.id] }));
  const pageRows = view.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(view.length / pageSize));
  // Per-column footer total (Amount column) across the full filtered set.
  const totalAmount = view.reduce((s, r) => s + r.amount, 0);
  // The currently-expanded row, for the inline cardholder drill-down below the table.
  const expandedRowData = pageRows.find((r) => r.id === expandedRow) ?? null;

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });

  function patch(id: string, p: { description?: string; hasReceipt?: boolean; status?: 'Pending' | 'Settled' }) {
    setEdits((e) => ({ ...e, [id]: { ...e[id], ...p } }));
  }

  function exportCsv() {
    exportCsvFile(
      'expenses-report.csv',
      ['Date', 'Merchant', 'Category', 'Amount', 'Cardholder', 'User', 'Business Unit', 'Job #', 'Description', 'Receipt', 'Status'],
      view.map((r) => [
        fmtDate(r.date), r.merchant, r.category, r.amount.toFixed(2), r.cardholder, r.loggedBy,
        r.businessUnit, r.jobNumber ?? '', r.description, r.hasReceipt ? 'Yes' : 'No', r.status,
      ]),
    );
  }

  return (
    <ReportShell
      report={report}
      subtitle="Card spend, categories, and net profit"
      actions={
        <DateRangeControl
          presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
          preset={preset}
          onPreset={(k) => setPreset(k as Preset)}
          from={range.from}
          to={range.to}
          fields={[{ key: 'date', label: 'Transaction date' }]}
          field="date"
          onField={() => {}}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
      }
    >
      {/* Profit strip — press a tile to open its chart below */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile icon={DollarSign} label="Revenue" tone="success" emphasize active={openCard === 'revenue'} onClick={() => toggleCard('revenue')} value={<span className="flex items-baseline gap-2">{usd(profit.revenue)}<Delta value={profit.revenueDeltaPct} /></span>} />
        <KpiTile icon={Wallet} label="Expenses" tone="danger" emphasize active={openCard === 'expenses'} onClick={() => toggleCard('expenses')} value={<span className="flex items-baseline gap-2">{usd(profit.expenses)}<Delta value={profit.expensesDeltaPct} flipColor /></span>} />
        <KpiTile icon={TrendingUp} label="Net Profit" tone="success" emphasize active={openCard === 'net'} onClick={() => toggleCard('net')} value={<span className="flex items-baseline gap-2">{usd(profit.net)}<Delta value={profit.netDeltaPct} /></span>} />
        <KpiTile icon={Percent} label="Margin" tone="primary" emphasize active={openCard === 'margin'} onClick={() => toggleCard('margin')} value={<span className="flex items-baseline gap-2">{`${profit.margin.toFixed(0)}%`}<Delta value={profit.marginDeltaPp} suffix="pp" /></span>} />
      </div>

      {/* Expense KPI tiles — press a tile to open its chart below */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile icon={Wallet} label={presetLabel} active={openCard === 'thisMonth'} onClick={() => toggleCard('thisMonth')} value={<span className="flex items-baseline gap-2">{usd(kpis.total)}<Delta value={kpis.deltaPct} flipColor /></span>} />
        <KpiTile icon={CalendarClock} label="Previous period" active={openCard === 'lastMonth'} onClick={() => toggleCard('lastMonth')} value={usd(kpis.prevTotal)} />
        <KpiTile icon={Receipt} label="Receipts attached" active={openCard === 'receipts'} onClick={() => toggleCard('receipts')} value={`${kpis.receiptsPct.toFixed(0)}%`} sub={`${kpis.receiptsAttached}/${kpis.receiptsTotal} ${presetLabel.toLowerCase()}`} />
      </div>

      {/* KPI drill-down — the pressed tile's chart, inline below the strip */}
      {drill && (
        <DrillChart title={drill.title} subtitle={drill.subtitle} data={drill.data} money={drill.money} onClose={closeCard} />
      )}

      {/* Spend by category — last 12 months */}
      <ChartCard title="Spend by category" subtitle="Last 12 months">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={spend} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={token('--border-color')} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v: number) => usd(v)} width={96} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v: number) => usd(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {EXPENSE_CATEGORIES.map((c) => (
              <Bar key={c} dataKey={c} stackId="spend" fill={CATEGORY_COLORS[c]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Workiz-style faceted filter — pick across Category / Merchant / User / Card / With / Without */}
      <FacetFilter groups={facetGroups} onToggle={onFacetToggle} onClear={onFacetClear} placeholder="Filter results" />

      {/* Controls — table-only facets/search; the time window is set by the top-right filter */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter label="Category" options={[...EXPENSE_CATEGORIES]} selected={cats} onChange={setCats} />
        <MultiSelectFilter label="Cardholder" options={[...CARDHOLDERS]} selected={cardholders} onChange={setCardholders} />
        <MultiSelectFilter label="Status" options={[...EXPENSE_STATUSES]} selected={statuses} onChange={setStatuses} />
        <MultiSelectFilter label="Business unit" options={[...BUSINESS_UNITS]} selected={units} onChange={setUnits} />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchant, job, description…"
            className="h-9 w-64 rounded-lg border border-border bg-surface-light pl-8 pr-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {/* Table toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">{view.length} expenses</p>
        <div className="flex items-center gap-2">
          <SelectField
            aria-label="Rows per page"
            className="h-9"
            value={String(pageSize)}
            onValueChange={(v) => setPageSize(Number(v))}
            options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
          />
          {/* outline/neutral size="sm" matches the raw's border colour, surface
              background, hover background and height/padding exactly. Two disclosed
              deltas: outline/neutral sets no idle text colour (relies on the inherited
              default text colour, same as the raw did implicitly), and the base
              font-semibold replaces the raw's font-medium. */}
          <Button variant="outline" tone="neutral" size="sm" onClick={exportCsv} className="gap-1.5">
            <Download className="h-4 w-4" /> Export
          </Button>
        </div>
      </div>

      {/* Transaction table — shared resizable grid (drag column edges to resize, click headers to sort) */}
      <ResizableTable
        rows={pageRows}
        getRowKey={(r) => r.id}
        empty={<EmptyState title="No expenses match these filters." />}
        onRowClick={(r) => toggleRow(r.id)}
        rowClassName={(r) => (expandedRow === r.id ? 'bg-background-light/60' : '')}
        columns={[
          {
            id: 'date',
            header: 'Date',
            width: 180,
            min: 165,
            sortValue: (r) => r.date.getTime(),
            cell: (r) => (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-secondary">
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expandedRow === r.id ? 'rotate-90 text-primary' : 'text-text-secondary'}`} />
                {fmtDate(r.date)}
              </span>
            ),
          },
          { id: 'merchant', header: 'Merchant', width: 170, min: 140, sortValue: (r) => r.merchant, cell: (r) => <span className="font-medium text-text-primary">{r.merchant}</span> },
          { id: 'category', header: 'Category', width: 130, min: 110, sortValue: (r) => r.category, cell: (r) => <span>{r.category}</span> },
          {
            id: 'amount',
            header: 'Amount',
            width: 120,
            min: 105,
            align: 'right',
            sortValue: (r) => r.amount,
            cell: (r) => <span className="tabular-nums">{usd(r.amount)}</span>,
            footer: <span className="tabular-nums">{usd(totalAmount)}</span>,
          },
          { id: 'cardholder', header: 'Cardholder', width: 150, min: 130, sortValue: (r) => r.cardholder, cell: (r) => <span>{r.cardholder}</span> },
          { id: 'user', header: 'User', width: 150, min: 130, sortValue: (r) => r.loggedBy, cell: (r) => <span className="text-text-secondary">{r.loggedBy}</span> },
          { id: 'businessUnit', header: 'Business Unit', width: 150, min: 130, sortValue: (r) => r.businessUnit, cell: (r) => <span>{r.businessUnit}</span> },
          {
            id: 'jobNumber',
            header: 'Job #',
            width: 110,
            min: 90,
            sortValue: (r) => r.jobNumber,
            cell: (r) => (r.jobNumber ? <span className="text-primary">{r.jobNumber}</span> : <span className="text-text-secondary">—</span>),
          },
          {
            id: 'description',
            header: 'Description',
            width: 200,
            min: 160,
            cell: (r) => (
              <input
                value={r.description}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => patch(r.id, { description: e.target.value })}
                placeholder="Add description"
                className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm hover:border-border focus:border-primary focus:outline-none"
              />
            ),
          },
          {
            id: 'receipt',
            header: 'Receipt',
            width: 140,
            min: 120,
            sortValue: (r) => (r.hasReceipt ? 1 : 0),
            // raw: two-state toggle pill - no success tone is minted on Button
            // (only brand/neutral/subtle/danger/ai/business), not Button-shaped
            cell: (r) => (
              <button
                onClick={(e) => { e.stopPropagation(); patch(r.id, { hasReceipt: !r.hasReceipt }); }}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${r.hasReceipt ? 'bg-success/10 text-success' : 'border border-border text-text-secondary hover:bg-background-light'}`}
              >
                {r.hasReceipt ? <Check className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />}
                {r.hasReceipt ? 'Attached' : 'Add receipt'}
              </button>
            ),
          },
          {
            id: 'status',
            header: 'Status',
            width: 120,
            min: 110,
            sortValue: (r) => r.status,
            // raw: two-state toggle pill - no success/warning tone is minted on
            // Button (only brand/neutral/subtle/danger/ai/business), not
            // Button-shaped
            cell: (r) => (
              <button
                onClick={(e) => { e.stopPropagation(); patch(r.id, { status: r.status === 'Settled' ? 'Pending' : 'Settled' }); }}
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status === 'Settled' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}
              >
                {r.status}
              </button>
            ),
          },
        ]}
      />

      {/* Row drill-down — the expanded transaction's cardholder breakdown, inline below the table */}
      {expandedRowData && (
        <CardholderBreakdown cardholder={expandedRowData.cardholder} rows={rows} />
      )}

      {/* Pager */}
      <div className="flex items-center justify-between text-sm text-text-secondary">
        <span>
          Showing {view.length === 0 ? 0 : page * pageSize + 1}–{Math.min((page + 1) * pageSize, view.length)} of {view.length}
        </span>
        <div className="flex items-center gap-2">
          {/* outline/neutral, size="sm" - closest available rung to the raw's
              tight px-2.5/py-1 pager control (sm's h-9/px-3 is the nearest
              without forcing text-xs, since the 3xs rung would also shrink the
              inherited text-sm). outline/neutral's bg-surface-light fill and
              Button's base font-semibold are both additions the transparent,
              normal-weight raw didn't have - disclosed, not fought. Idle text
              isn't set explicitly here or by outline/neutral, but the ambient
              pager wrapper (text-sm text-text-secondary two lines up) supplies
              it safely - not the risky muted-text trap. Button's own
              disabled:opacity-50 replaces the raw's disabled:opacity-40. */}
          <Button variant="outline" tone="neutral" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</Button>
          <span>Page {page + 1} / {totalPages}</span>
          <Button variant="outline" tone="neutral" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>
    </ReportShell>
  );
}

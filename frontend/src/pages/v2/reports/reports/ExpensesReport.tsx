import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  CalendarClock, Check, ChevronRight, DollarSign, Download, Paperclip, Percent,
  Receipt, Search, TrendingUp, Wallet, X,
} from 'lucide-react';

import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system/tokens';
import { formatCurrencyWhole } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { buildExpenses, buildMonthlyRevenue } from '@/lib/reports/expenses-data';
import {
  BUSINESS_UNITS, CARDHOLDERS, EXPENSE_ATTRIBUTES, EXPENSE_CATEGORIES, EXPENSE_STATUSES, USERS,
  filterExpenses, periodExpenseKpis, periodProfitSummary, previousPeriod,
  spendByCategoryByMonth, spendByCategoryForCardholder, withinRange,
  type ExpenseFilters, type ExpenseRow,
} from '@/lib/reports/expenses-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard } from '@/ui-kit/components/data/statCard';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';
import { Delta, FacetFilter, MultiSelectFilter, ReportPager, type FacetGroup } from '../components/shared';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * Expenses - card spend, categories and net profit.
 *
 * `expenses-logic` owns every derivation and all of it is imported:
 * `periodProfitSummary`, `periodExpenseKpis`, `previousPeriod` (the prior
 * equal-length window the deltas compare against), `withinRange`,
 * `spendByCategoryByMonth`, `spendByCategoryForCardholder`, `filterExpenses`
 * and the six option vocabularies. `expenses-data` builds the deterministic
 * fixture. Nothing is recomputed here.
 *
 * ONE TIME FILTER DRIVES THE WHOLE PAGE - the profit strip, the KPI tiles, the
 * drill-downs and the table all recompute for the selected window; only the
 * spend-by-category chart stays a rolling twelve months. That is the report's
 * defining behaviour and it is unchanged.
 *
 * TWO DELTA DIRECTIONS ARE INVERTED ON PURPOSE and are preserved: expenses
 * rising is bad and "this period" spend rising is bad, so both pass
 * `flipColor`. Revenue, net and margin read the normal way.
 *
 * CHARTS UNTOUCHED. `CATEGORY_COLORS` gives a category one colour across the
 * stacked 12-month chart, the KPI drill-down and the cardholder breakdown, and
 * the four `COLOR_*` constants are the positive/negative money signals in the
 * net and margin drills. All of it is carried over.
 *
 * Shape differences: the inline description edit is a kit `Input`, the receipt
 * and status toggles are kit Buttons carrying `aria-pressed` (they were raw
 * two-state pills), the expanded-row tint is gone - the kit's DataTable has no
 * per-row className, and the rotating chevron already says which row is open -
 * and the amount total moves to a `ReportTableTotals` strip.
 */

const NOW = new Date(2026, 5, 6, 12, 0, 0);
// Org-aware whole-dollar currency (honors the organization currency setting).
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

// Categorical expense categories -> calm brand palette (cycled, deterministic by order).
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

/** The chart a pressed KPI tile opens below the strip. */
function DrillChart({
  title, subtitle, data, money, onClose,
}: { title: string; subtitle?: string; data: DrillBar[]; money: boolean; onClose: () => void }) {
  const fmt = (v: number) => (money ? usd(v) : String(Math.round(v)));
  const axisFmt = (v: number) => (money ? usd(v) : String(Math.round(v)));

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      action={
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      }
    >
      {data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No data to show.</p>
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

/** All of one cardholder's spend by category, shown when a row is expanded. */
function CardholderBreakdown({ cardholder, rows }: { cardholder: string; rows: ExpenseRow[] }) {
  const data = useMemo(() => spendByCategoryForCardholder(rows, cardholder), [rows, cardholder]);
  const total = data.reduce((s, d) => s + d.amount, 0);
  const count = useMemo(() => rows.filter((r) => r.cardholder === cardholder).length, [rows, cardholder]);
  const axisFmt = (v: number) => usd(v);

  return (
    <ChartCard
      title={`All of ${cardholder}'s spend by category`}
      action={<span className="text-muted-foreground shrink-0 text-xs">{count} transactions · {usd(total)} total</span>}
    >
      {data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No spend on record for {cardholder}.</p>
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

  // Time filter (top-right) - drives the WHOLE page.
  const [preset, setPreset] = useState<Preset>('month');
  const expDefaultFrom = useMemo(() => { const d = new Date(NOW); d.setDate(NOW.getDate() - 30); return d; }, []);
  const [customFrom, setCustomFrom] = useState(expDefaultFrom.toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(NOW.toISOString().slice(0, 10));
  const range = useMemo(() => presetRange(preset, NOW, customFrom, customTo), [preset, customFrom, customTo]);
  const presetLabel = PRESET_LABEL[preset];

  // Rows in the selected window, and in the prior equal-length window.
  const periodRows = useMemo(() => rows.filter((r) => withinRange(r.date, range.from, range.to)), [rows, range]);
  const prevRange = useMemo(() => previousPeriod(range.from, range.to), [range]);
  const prevPeriodRows = useMemo(
    () => (prevRange.from && prevRange.to ? rows.filter((r) => withinRange(r.date, prevRange.from, prevRange.to)) : []),
    [rows, prevRange],
  );

  const profit = useMemo(() => periodProfitSummary(rows, monthlyRevenue, range.from, range.to), [rows, monthlyRevenue, range]);
  const kpis = useMemo(() => periodExpenseKpis(rows, range.from, range.to), [rows, range]);
  const spend = useMemo(() => spendByCategoryByMonth(rows, NOW, 12), [rows]);

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

  const drill = useMemo((): { title: string; subtitle?: string; data: DrillBar[]; money: boolean } | null => {
    if (!openCard) return null;
    const byCat = (rs: typeof rows): DrillBar[] => groupBy(rs, 'category').map(([c, a]) => ({ label: c, value: a, color: CATEGORY_COLORS[c] }));
    const byHolder = (rs: typeof rows): DrillBar[] => groupBy(rs, 'cardholder').map(([c, a], i) => ({ label: c, value: a, color: CARDHOLDER_PALETTE[i % CARDHOLDER_PALETTE.length] ?? COLOR_NEUTRAL }));
    switch (openCard) {
      case 'revenue': return { title: 'Revenue - recent months', data: recentRevenue.map((r) => ({ label: r.label, value: r.value, color: COLOR_POSITIVE })), money: true };
      case 'expenses': return { title: `Expenses by category - ${presetLabel.toLowerCase()}`, subtitle: `${usd(profit.expenses)} total`, data: byCat(periodRows), money: true };
      case 'net': return { title: `Net profit - ${presetLabel.toLowerCase()}`, data: [{ label: 'Revenue', value: profit.revenue, color: COLOR_POSITIVE }, { label: 'Expenses', value: profit.expenses, color: COLOR_NEGATIVE }, { label: 'Net profit', value: profit.net, color: COLOR_ACCENT }], money: true };
      case 'margin': return { title: 'Margin - net vs revenue', subtitle: `${profit.margin.toFixed(0)}% margin`, data: [{ label: 'Revenue', value: profit.revenue, color: COLOR_NEUTRAL }, { label: 'Net profit', value: profit.net, color: COLOR_POSITIVE }], money: true };
      case 'thisMonth': return { title: `${presetLabel} - by cardholder`, subtitle: `${usd(kpis.total)} total`, data: byHolder(periodRows), money: true };
      case 'lastMonth': return { title: 'Previous period - by cardholder', subtitle: `${usd(kpis.prevTotal)} total`, data: byHolder(prevPeriodRows), money: true };
      case 'receipts': return { title: `Receipts - ${presetLabel.toLowerCase()}`, subtitle: `${kpis.receiptsAttached}/${kpis.receiptsTotal} attached`, data: [{ label: 'Attached', value: kpis.receiptsAttached, color: COLOR_POSITIVE }, { label: 'Missing', value: kpis.receiptsTotal - kpis.receiptsAttached, color: token('--warning') }], money: false };
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

  // Distinct merchants present in the data, for the facet picker's column.
  const merchantOptions = useMemo(() => [...new Set(rows.map((r) => r.merchant))].sort(), [rows]);

  // The faceted filter's columns share state with the dropdowns below.
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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: reset to the first page whenever the filtered set or page size changes
  useEffect(() => { setPage(0); }, [filtered, pageSize]);

  const view = filtered.map((r) => ({ ...r, ...edits[r.id] }));
  const pageRows = view.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(view.length / pageSize));
  // Per-column total (Amount) across the full filtered set.
  const totalAmount = view.reduce((s, r) => s + r.amount, 0);
  // The currently-expanded row, for the inline cardholder drill-down.
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

  type ViewRow = (typeof view)[number];

  const columns: ReportColumn<ViewRow>[] = [
    {
      id: 'date', header: 'Date', width: 180, min: 165, sortValue: (r) => r.date.getTime(),
      cell: (r) => (
        <span className="text-muted-foreground inline-flex items-center gap-1.5 whitespace-nowrap">
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expandedRow === r.id && 'text-brand rotate-90')} />
          {fmtDate(r.date)}
        </span>
      ),
    },
    { id: 'merchant', header: 'Merchant', width: 170, min: 140, sortValue: (r) => r.merchant, cell: (r) => <span className="font-medium">{r.merchant}</span> },
    { id: 'category', header: 'Category', width: 130, min: 110, sortValue: (r) => r.category, cell: (r) => <span>{r.category}</span> },
    {
      id: 'amount', header: 'Amount', width: 120, min: 105, align: 'right', sortValue: (r) => r.amount,
      cell: (r) => <span className="tabular-nums">{usd(r.amount)}</span>,
      footer: <span className="tabular-nums">{usd(totalAmount)}</span>,
    },
    { id: 'cardholder', header: 'Cardholder', width: 150, min: 130, sortValue: (r) => r.cardholder, cell: (r) => <span>{r.cardholder}</span> },
    { id: 'user', header: 'User', width: 150, min: 130, sortValue: (r) => r.loggedBy, cell: (r) => <span className="text-muted-foreground">{r.loggedBy}</span> },
    { id: 'businessUnit', header: 'Business Unit', width: 150, min: 130, sortValue: (r) => r.businessUnit, cell: (r) => <span>{r.businessUnit}</span> },
    {
      id: 'jobNumber', header: 'Job #', width: 110, min: 90, sortValue: (r) => r.jobNumber,
      cell: (r) => (r.jobNumber ? <span className="text-brand">{r.jobNumber}</span> : <span className="text-muted-foreground">-</span>),
    },
    {
      id: 'description', header: 'Description', width: 200, min: 160,
      // The cell is an editable Input, so this orders by the text a row
      // currently holds. Sorting is user-initiated and rows are keyed by id, so
      // a reorder mid-edit moves the field without losing what is typed in it.
      sortValue: (r) => r.description,
      cell: (r) => (
        <Input
          value={r.description}
          aria-label={`Description for ${r.merchant}`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => patch(r.id, { description: e.target.value })}
          placeholder="Add description"
          className="h-8"
        />
      ),
    },
    {
      id: 'receipt', header: 'Receipt', width: 140, min: 120, sortValue: (r) => (r.hasReceipt ? 1 : 0),
      cell: (r) => (
        <Button
          type="button"
          size="sm"
          aria-pressed={r.hasReceipt}
          variant={r.hasReceipt ? 'secondary' : 'outline'}
          onClick={(e) => { e.stopPropagation(); patch(r.id, { hasReceipt: !r.hasReceipt }); }}
        >
          {r.hasReceipt ? <Check /> : <Paperclip />}
          {r.hasReceipt ? 'Attached' : 'Add receipt'}
        </Button>
      ),
    },
    {
      id: 'status', header: 'Status', width: 120, min: 110, sortValue: (r) => r.status,
      cell: (r) => (
        <Button
          type="button"
          size="sm"
          aria-pressed={r.status === 'Settled'}
          variant={r.status === 'Settled' ? 'secondary' : 'outline'}
          onClick={(e) => { e.stopPropagation(); patch(r.id, { status: r.status === 'Settled' ? 'Pending' : 'Settled' }); }}
        >
          {r.status}
        </Button>
      ),
    },
  ];

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
      {/* Profit strip - press a tile to open its chart below. Delta keeps its
          own colour, including the two inverted directions. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Revenue" active={openCard === 'revenue'} onClick={() => toggleCard('revenue')} value={usd(profit.revenue)} />
        <StatCard label="Expenses" active={openCard === 'expenses'} onClick={() => toggleCard('expenses')} value={usd(profit.expenses)} />
        <StatCard label="Net Profit" active={openCard === 'net'} onClick={() => toggleCard('net')} value={usd(profit.net)} />
        <StatCard label="Margin" active={openCard === 'margin'} onClick={() => toggleCard('margin')} value={`${profit.margin.toFixed(0)}%`} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={presetLabel} active={openCard === 'thisMonth'} onClick={() => toggleCard('thisMonth')} value={usd(kpis.total)} />
        <StatCard label="Previous period" active={openCard === 'lastMonth'} onClick={() => toggleCard('lastMonth')} value={usd(kpis.prevTotal)} />
        <StatCard
          label="Receipts attached"
          active={openCard === 'receipts'}
          onClick={() => toggleCard('receipts')}
          value={`${kpis.receiptsPct.toFixed(0)}%`}
        />
      </div>

      {drill && (
        <DrillChart title={drill.title} subtitle={drill.subtitle} data={drill.data} money={drill.money} onClose={closeCard} />
      )}

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

      <FacetFilter groups={facetGroups} onToggle={onFacetToggle} onClear={onFacetClear} placeholder="Filter results" />

      {/* Table-only facets and search; the time window is the top-right filter. */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter label="Category" options={[...EXPENSE_CATEGORIES]} selected={cats} onChange={setCats} />
        <MultiSelectFilter label="Cardholder" options={[...CARDHOLDERS]} selected={cardholders} onChange={setCardholders} />
        <MultiSelectFilter label="Status" options={[...EXPENSE_STATUSES]} selected={statuses} onChange={setStatuses} />
        <MultiSelectFilter label="Business unit" options={[...BUSINESS_UNITS]} selected={units} onChange={setUnits} />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search expenses"
          placeholder="Search merchant, job, description..."
          startIcon={<Search className="size-4" />}
          className="h-9 w-64"
        />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">{view.length} expenses</p>
        <div className="flex items-center gap-2">
          <SelectField
            value={String(pageSize)}
            onValueChange={(v) => setPageSize(Number(v))}
            aria-label="Rows per page"
            size="sm"
            className="w-[80px]"
            options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))}
          />
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download />
            Export
          </Button>
        </div>
      </div>

      <ReportTable
        rows={pageRows}
        getRowKey={(r) => r.id}
        empty={<EmptyState title="No expenses match these filters." />}
        onRowClick={(r) => toggleRow(r.id)}
        columns={columns}
        initialPageSize={pageSize}
      />
      <ReportTableTotals columns={columns} />

      {expandedRowData && <CardholderBreakdown cardholder={expandedRowData.cardholder} rows={rows} />}

      <ReportPager
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
        totalItems={view.length}
        onPageChange={setPage}
      />
    </ReportShell>
  );
}

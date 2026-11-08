import { useMemo, useRef, useState } from 'react';
import {
  BadgeCheck, CalendarRange, Calculator, Check, ChevronDown, CircleDollarSign, Coins,
  DollarSign, Download, Hourglass, Mail, Pencil, Printer, RotateCcw, Search, Send,
  SlidersHorizontal,
} from 'lucide-react';

import { formatCurrency, formatCurrencyWhole, formatPhone } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { hashStr, mulberry32 } from '@/lib/reports/random';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Td } from '../components/td';
import { DatePicker } from '../../_shared/datePicker';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ReportTable, ReportTableTotals, type ReportColumn } from '../components/reportTable';

/**
 * Commissions (mock-first preview) - mirrors the legacy commission screen
 * (Standard / Tech / External report types, Settlement + By-Time + date-range
 * filters, Total Profits / Total by type / Report History) and the v1 spec
 * model (md_files/specs/commissions/BUILD_SPEC_v1.md).
 *
 * THE MONEY MODEL IS THE REPORT AND IT IS CARRIED OVER EXACTLY:
 *   net profit  = job total - parts - labor - sales tax - card fees, floored at 0
 *   commission  = net profit x the tech's rate ("Tech Share")
 *   an ADJUSTED job uses its adjusted amount and nothing else
 *   a CALLBACK earns zero
 *   tips are 100% on top, never part of the commission base
 *   settled == state 'Paid'
 * `netProfitOf`, `commissionOf` and `isSettled` are the only places any of that
 * is decided, exactly as before, and the CSV export reads through the same
 * three functions so an export can never disagree with the screen.
 *
 * Shape differences, all from the kit: the date-range picker and the Fields
 * menu are a kit `Popover` and `DropdownMenu` (both were hand-rolled panels
 * with their own document listeners), the five action buttons and the two
 * segmented toggles are kit Buttons, the three summary tables are the kit's
 * `Table` inside a `Card` (SectionCard has no kit equivalent and its only job
 * here was a titled box), and both tables' `<tfoot>` totals become a
 * `ReportTableTotals` strip.
 */

const money0 = (n: number) => formatCurrencyWhole(n);
const money2 = (n: number) => formatCurrency(n);
const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (d: Date) =>
  `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

type CommState = 'Projected' | 'Earned' | 'Paid';
type JobStatus = 'Scheduled' | 'In Progress' | 'Completed' | 'Closed';
type PaymentType = 'cash' | 'credit' | 'billing' | 'check';

interface Tech {
  id: string;
  name: string;
  role: string;
  structure: string;
  rate: number;
  external?: boolean;
}

interface CommissionJob {
  id: string;
  jobNumber: number;
  invoiceNumber: string;
  tech: Tech;
  customer: string;
  address: string;
  phone: string;
  jobType: string;
  createdDate: Date;
  scheduledDate: Date;
  doneDate: Date;
  jobStatus: JobStatus;
  paymentType: PaymentType;
  jobTotal: number;
  parts: number;
  labor: number;
  salesTax: number;
  paymentFees: number;
  tip: number;
  isCallback: boolean;
  state: CommState;
  adjusted?: { from: number; to: number; reason: string; by: string };
}

const TECHS: Tech[] = [
  { id: 't1', name: 'Adam Elkarrat', role: 'Service Tech', structure: 'Base + Commission', rate: 8 },
  { id: 't2', name: 'Amiran Bekauri', role: 'Install Tech', structure: 'Payroll + Commission', rate: 10 },
  { id: 't3', name: 'Emanuel Dahan', role: 'Comfort Advisor', structure: 'Commission Only', rate: 12 },
  { id: 't4', name: 'Priya', role: 'Service Tech', structure: 'Base + Commission', rate: 7 },
  { id: 't5', name: 'Itay', role: 'Install Tech', structure: 'Payroll + Commission', rate: 9 },
  { id: 't6', name: 'Liran - Dor', role: 'Install Tech', structure: 'Payroll + Commission', rate: 9 },
  { id: 't7', name: 'Nethanel', role: 'Service Tech', structure: 'Base + Commission', rate: 8 },
  { id: 't8', name: 'Ohad', role: 'Service Tech', structure: 'Base + Commission', rate: 10 },
  { id: 't9', name: 'Omer', role: 'Install Tech', structure: 'Payroll + Commission', rate: 10 },
  { id: 't10', name: 'Oved Adani', role: 'Comfort Advisor', structure: 'Commission Only', rate: 12 },
  { id: 'x1', name: 'Efrain & Zhao', role: 'External Company', structure: 'Subcontractor', rate: 60, external: true },
  { id: 'x2', name: 'Ofek Sub', role: 'External Company', structure: 'Subcontractor', rate: 55, external: true },
  { id: 'x3', name: 'Ofir Sub', role: 'External Company', structure: 'Subcontractor', rate: 50, external: true },
];

const CUSTOMERS = ['R. Whitfield', 'Cedar Park HOA', 'M. Delgado', 'Summit Dental', 'J. Okafor', 'Brightway Cafe', 'L. Hammond', 'Northgate Apts', 'P. Vasquez', 'E. Lindqvist', 'Harbor Freight #214', 'K. Nakamura', 'Willow Creek Inn', 'T. Boudreaux', 'A. Petrova'];
const STREETS = ['Prince St', 'Teaneck Rd', 'Monmouth St', 'Maple Ave', 'Oak St', 'Broadway', 'Bergen Blvd', 'Main St', 'Park Ave', 'Hudson St'];
const ZIPS = ['10012', '07660', '07302', '10001', '07024', '11201'];
const JOB_TYPES = ['Intercom System', 'Commercial Door Repair', 'Residential Door Repair', 'AC Replacement', 'Furnace Repair', 'Water Heater', 'Diagnostic', 'Panel Upgrade'];
const JOB_STATUSES: JobStatus[] = ['Scheduled', 'In Progress', 'Completed', 'Closed'];
const PAYMENT_TYPES: PaymentType[] = ['cash', 'credit', 'billing', 'check'];

const netProfitOf = (j: CommissionJob) => Math.max(0, j.jobTotal - j.parts - j.labor - j.salesTax - j.paymentFees);
const commissionOf = (j: CommissionJob) => {
  if (j.adjusted) return j.adjusted.to;
  if (j.isCallback) return 0;
  return Math.round(netProfitOf(j) * (j.tech.rate / 100) * 100) / 100;
};
const isSettled = (j: CommissionJob) => j.state === 'Paid';

function buildJobs(): CommissionJob[] {
  const rng = mulberry32(hashStr('alpha-commissions-preview-v3'));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const now = new Date();
  const jobs: CommissionJob[] = [];
  const N = 60;

  for (let i = 0; i < N; i++) {
    const tech = pick(TECHS);
    const jobTotal = Math.round((300 + rng() * 5700) / 5) * 5;
    const parts = Math.round(jobTotal * (0.12 + rng() * 0.3));
    const labor = Math.round(jobTotal * (0.1 + rng() * 0.16));
    const salesTax = Math.round(jobTotal * 0.0825);
    const paymentType = pick<PaymentType>(['credit', 'credit', 'credit', 'cash', 'billing', 'check']);
    const paymentFees = paymentType === 'credit' ? Math.round(jobTotal * 0.029) : 0;
    const tip = rng() > 0.78 ? pick([10, 15, 20, 25, 40, 50, 60]) : 0;
    const isCallback = rng() > 0.92;
    const r = rng();
    const state: CommState = isCallback ? 'Projected' : r > 0.62 ? 'Paid' : r > 0.32 ? 'Earned' : 'Projected';
    const jobStatus: JobStatus = state === 'Paid' ? 'Closed' : pick(JOB_STATUSES);
    const createdDaysAgo = 1 + Math.floor(rng() * 40);
    const createdDate = new Date(now.getTime() - createdDaysAgo * 86400000 - Math.floor(rng() * 8) * 3600000);
    const scheduledDate = new Date(createdDate.getTime() + Math.floor(rng() * 5) * 86400000);
    const doneDate = new Date(scheduledDate.getTime() + Math.floor(rng() * 3) * 86400000 + Math.floor(rng() * 8) * 3600000);

    jobs.push({
      id: `cj-${i}`,
      jobNumber: 698494 - i,
      invoiceNumber: `INV-${20480 - i}`,
      tech,
      customer: pick(CUSTOMERS),
      address: `${100 + Math.floor(rng() * 8900)} ${pick(STREETS)} , ${pick(ZIPS)}`,
      phone: `(201) ${200 + Math.floor(rng() * 799)}-${(1000 + Math.floor(rng() * 8999)).toString()}`,
      jobType: pick(JOB_TYPES),
      createdDate,
      scheduledDate,
      doneDate,
      jobStatus,
      paymentType,
      jobTotal,
      parts,
      labor,
      salesTax,
      paymentFees,
      tip,
      isCallback,
      state,
    });
  }

  const a = jobs[3]!;
  a.adjusted = { from: commissionOf(a), to: commissionOf(a) + 75, reason: 'Promised incentive - tough attic install', by: 'Admin' };
  const b = jobs[9]!;
  b.adjusted = { from: commissionOf(b), to: Math.round(commissionOf(b) * 0.5), reason: 'Quality reduction - rework needed', by: 'Admin' };
  return jobs;
}

const JOBS = buildJobs();

// Synthetic report-only taxonomy (Title Case) - not the backend JobStatus enum,
// so this stays a local map rather than routing through the status registry's
// `job` domain. Its four intents are the kit's soft badge variants.
const JOB_STATUS_VARIANT: Record<JobStatus, NonNullable<BadgeProps['variant']>> = {
  Scheduled: 'softAmber',
  'In Progress': 'softAmber',
  Completed: 'softGreen',
  Closed: 'softNeutral',
};

function ReportStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={JOB_STATUS_VARIANT[status]} size="pill">{status}</Badge>;
}

function SettlementBadge({ settled }: { settled: boolean }) {
  return <Badge variant={settled ? 'softGreen' : 'softAmber'} size="pill">{settled ? 'Settled' : 'Unsettled'}</Badge>;
}

function FilterSelect({
  value, onChange, options, className = 'w-[180px]', label = 'Filter',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /**
   * Was `width?: number` rendered as `style={{ width }}`. `SelectField` has no
   * `style` prop, and every call site passed a literal, so the width is now a
   * static utility class - same pixels, and one Tailwind can actually see.
   */
  className?: string;
  label?: string;
}) {
  return (
    <SelectField
      value={value}
      onValueChange={onChange}
      aria-label={label}
      size="sm"
      className={className}
      options={options}
    />
  );
}

type Range = { from: Date | null; to: Date | null; label: string };
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

function presetRange(label: string): Range {
  const now = new Date();
  const today = startOfDay(now);
  const dow = today.getDay(); // 0 Sun
  switch (label) {
    case 'All time': return { from: null, to: null, label };
    case 'Today': return { from: today, to: endOfDay(now), label };
    case 'Yesterday': return { from: addDays(today, -1), to: endOfDay(addDays(today, -1)), label };
    case 'This week (Sun-Today)': return { from: addDays(today, -dow), to: endOfDay(now), label };
    case 'This week (Mon-Today)': return { from: addDays(today, dow === 0 ? -6 : 1 - dow), to: endOfDay(now), label };
    case 'Last 7 days': return { from: addDays(today, -6), to: endOfDay(now), label };
    case 'Last 14 days': return { from: addDays(today, -13), to: endOfDay(now), label };
    case 'This month': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now), label };
    case 'Last 30 days': return { from: addDays(today, -29), to: endOfDay(now), label };
    case 'Last month': return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)), label };
    case 'Year to date': return { from: new Date(now.getFullYear(), 0, 1), to: endOfDay(now), label };
    case 'This year': return { from: new Date(now.getFullYear(), 0, 1), to: endOfDay(new Date(now.getFullYear(), 11, 31)), label };
    case 'Last year': return { from: new Date(now.getFullYear() - 1, 0, 1), to: endOfDay(new Date(now.getFullYear() - 1, 11, 31)), label };
    default: return { from: null, to: null, label: 'All time' };
  }
}

const RANGE_PRESETS = ['All time', 'Today', 'Yesterday', 'This week (Sun-Today)', 'This week (Mon-Today)', 'Last 7 days', 'Last 14 days', 'This month', 'Last 30 days', 'Last month', 'Year to date', 'This year', 'Last year'];

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function DateRangePicker({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(range.label === 'Custom range');
  const [customFrom, setCustomFrom] = useState(range.from ? toInputDate(range.from) : '');
  const [customTo, setCustomTo] = useState(range.to ? toInputDate(range.to) : '');

  const summary = range.from && range.to ? `${fmtDate(range.from)} - ${fmtDate(range.to)}` : 'All time';
  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    const from = startOfDay(new Date(`${customFrom}T00:00:00`));
    const to = endOfDay(new Date(`${customTo}T00:00:00`));
    if (from.getTime() > to.getTime()) return;
    onChange({ from, to, label: 'Custom range' });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <CalendarRange />
          <span className="tabular-nums">{summary}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-96 w-72 p-1">
        <div className="px-2.5 py-1.5 text-xs font-semibold">{range.label}</div>
        <div className="my-1 border-t" />
        {RANGE_PRESETS.map((p) => (
          <Button
            key={p}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={range.label === p}
            onClick={() => { onChange(presetRange(p)); setShowCustom(false); setOpen(false); }}
            className="w-full justify-between"
          >
            {p}{range.label === p && <Check />}
          </Button>
        ))}
        <div className="my-1 border-t" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showCustom}
          onClick={() => setShowCustom((s) => !s)}
          className="w-full justify-between"
        >
          Custom range...{range.label === 'Custom range' && <Check />}
        </Button>
        {showCustom && (
          <div className="space-y-2 px-2.5 py-2">
            <div className="space-y-1">
              <Label htmlFor="commissions-range-from" className="text-muted-foreground text-xs">From</Label>
              <DatePicker id="commissions-range-from" value={customFrom} max={customTo || undefined} onChange={setCustomFrom} inputClassName="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="commissions-range-to" className="text-muted-foreground text-xs">To</Label>
              <DatePicker id="commissions-range-to" value={customTo} min={customFrom || undefined} onChange={setCustomTo} inputClassName="h-9" />
            </div>
            <Button type="button" onClick={applyCustom} disabled={!customFrom || !customTo} className="w-full">
              Apply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FieldsMenu({ all, hidden, onToggle }: { all: { id: string; label: string }[]; hidden: Set<string>; onToggle: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <SlidersHorizontal />
          Fields
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {all.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onSelect={(e) => { e.preventDefault(); onToggle(c.id); }}
            className="justify-between"
          >
            {c.label}{!hidden.has(c.id) && <Check />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionBtn({ icon: Icon, label, onClick }: { icon: typeof Download; label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      <Icon />
      {label}
    </Button>
  );
}

function downloadCsv(filename: string, rows: CommissionJob[]) {
  exportCsvFile(
    filename,
    ['Job ID', 'Invoice', 'Tech', 'Created', 'Closed', 'Job Type', 'Address', 'Phone', 'Total', 'Billing', 'Check', 'Tech Share', 'Tip', 'Company Parts', 'Net Profit', 'Tech Profit', 'Settlement'],
    rows.map((j) => [
      `J${j.jobNumber}`, j.invoiceNumber, j.tech.name, fmtDateTime(j.createdDate), fmtDateTime(j.doneDate),
      j.jobType, j.address, j.phone, j.jobTotal,
      j.paymentType === 'billing' ? j.jobTotal : 0,
      j.paymentType === 'check' ? j.jobTotal : 0,
      `${j.tech.rate}%`, j.tip, j.parts, netProfitOf(j), commissionOf(j),
      isSettled(j) ? 'Settled' : 'Unsettled',
    ]),
  );
}

const REPORT_TYPES = ['Standard Report', 'Tech Report', 'External Company'] as const;
type ReportType = (typeof REPORT_TYPES)[number];
type ByTime = 'Created' | 'Scheduled' | 'Closed';
type Settlement = 'All' | 'Settled' | 'Unsettled';

const COLUMN_LABELS: { id: string; label: string }[] = [
  { id: 'job', label: 'Job Id' }, { id: 'tech', label: 'Tech' }, { id: 'created', label: 'Created' }, { id: 'closed', label: 'Closed' },
  { id: 'jobType', label: 'Job Type' }, { id: 'address', label: 'Address' }, { id: 'phone', label: 'Phone' }, { id: 'total', label: 'Total' },
  { id: 'billing', label: 'Billing' }, { id: 'check', label: 'Check' }, { id: 'share', label: 'Tech Share' }, { id: 'tip', label: 'Tip Amount' },
  { id: 'parts', label: 'Company Parts' }, { id: 'net', label: 'Net Profit' }, { id: 'profit', label: 'Tech Profit' }, { id: 'settlement', label: 'Settlement' },
];

export default function CommissionsReport() {
  const report = findReport('commissions')!;
  const [reportType, setReportType] = useState<ReportType>('Tech Report');
  const [techId, setTechId] = useState<string>('all');
  const [jobType, setJobType] = useState<string>('all');
  const [settlement, setSettlement] = useState<Settlement>('All');
  const [byTime, setByTime] = useState<ByTime>('Closed');
  const [range, setRange] = useState<Range>(() => presetRange('All time'));
  const [query, setQuery] = useState('');
  const [showN, setShowN] = useState<number>(50);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [tipsOnly, setTipsOnly] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string) => { setNotice(msg); window.setTimeout(() => setNotice(null), 2600); };
  const scrollToTable = () => window.setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  const onKpiSettlement = (s: Settlement) => { setSettlement((cur) => (cur === s ? 'All' : s)); setTipsOnly(false); scrollToTable(); };
  const onKpiTips = () => { setTipsOnly((v) => !v); scrollToTable(); };
  const onKpiClear = () => { setSettlement('All'); setTipsOnly(false); scrollToTable(); };
  const timeKey = (j: CommissionJob) => (byTime === 'Created' ? j.createdDate : byTime === 'Scheduled' ? j.scheduledDate : j.doneDate);
  const roster = reportType === 'External Company' ? TECHS.filter((t) => t.external) : TECHS.filter((t) => !t.external);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = JOBS.filter((j) => (reportType === 'External Company' ? j.tech.external : !j.tech.external));
    if (techId !== 'all') rows = rows.filter((j) => j.tech.id === techId);
    if (jobType !== 'all') rows = rows.filter((j) => j.jobType === jobType);
    if (settlement !== 'All') rows = rows.filter((j) => (settlement === 'Settled' ? isSettled(j) : !isSettled(j)));
    if (tipsOnly) rows = rows.filter((j) => j.tip > 0);
    if (range.from && range.to) rows = rows.filter((j) => { const t = timeKey(j).getTime(); return t >= range.from!.getTime() && t <= range.to!.getTime(); });
    if (q) rows = rows.filter((j) => [`j${j.jobNumber}`, j.invoiceNumber, j.customer, j.address, j.phone, j.tech.name, j.jobType].some((f) => f.toLowerCase().includes(q)));
    return [...rows].sort((a, b) => timeKey(b).getTime() - timeKey(a).getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportType, techId, jobType, settlement, tipsOnly, byTime, range, query, showN]);

  const rows = matched.slice(0, showN);

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <ActionBtn icon={Download} label="Export" onClick={() => downloadCsv(`commissions-${reportType.toLowerCase().replace(/ /g, '-')}.csv`, matched)} />
      <ActionBtn icon={Mail} label="Export By Mail" onClick={() => flash('Report queued - emailed to admin@servwave (mock).')} />
      <FieldsMenu all={COLUMN_LABELS} hidden={hidden} onToggle={(id) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; })} />
      <ActionBtn icon={Send} label="Send Bulk" onClick={() => flash(`Statements sent to ${roster.length} technicians (mock).`)} />
      <ActionBtn icon={Printer} label="Print" onClick={() => window.print()} />
    </div>
  );

  return (
    <ReportShell report={report} subtitle="Job-level net-profit commission · tips on top · callbacks off · Settled / Unsettled" actions={actions}>
      {notice && (
        <div className="bg-status-green-subtle text-status-green-emphasis rounded-lg border px-4 py-2 text-sm font-medium">
          {notice}
        </div>
      )}

      <div role="radiogroup" aria-label="Report type" className="flex flex-wrap gap-2">
        {REPORT_TYPES.map((rt) => (
          <Button
            key={rt}
            type="button"
            role="radio"
            aria-checked={reportType === rt}
            variant={reportType === rt ? 'default' : 'outline'}
            size="sm"
            onClick={() => { setReportType(rt); setTechId('all'); }}
          >
            {rt}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect value={techId} onChange={setTechId} className="w-[210px]" label={reportType === 'External Company' ? 'Company' : 'Technician'} options={[{ value: 'all', label: reportType === 'External Company' ? 'All Companies' : 'Select Technician' }, ...roster.map((t) => ({ value: t.id, label: t.name }))]} />
        <FilterSelect value={jobType} onChange={setJobType} className="w-[180px]" label="Job type" options={[{ value: 'all', label: 'Job Type' }, ...JOB_TYPES.map((t) => ({ value: t, label: t }))]} />
        <FilterSelect value={settlement} onChange={(v) => setSettlement(v as Settlement)} className="w-[150px]" label="Settlement" options={[{ value: 'All', label: 'Settlement' }, { value: 'Settled', label: 'Settled Jobs' }, { value: 'Unsettled', label: 'Un-Settled Jobs' }]} />
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <span className="mr-1">By Time:</span>
          <div role="radiogroup" aria-label="By time" className="flex items-center gap-1">
            {(['Created', 'Scheduled', 'Closed'] as ByTime[]).map((t) => (
              <Button
                key={t}
                type="button"
                role="radio"
                aria-checked={byTime === t}
                variant={byTime === t ? 'default' : 'outline'}
                size="sm"
                onClick={() => setByTime(t)}
              >
                {t}
              </Button>
            ))}
          </div>
        </div>
        <DateRangePicker range={range} onChange={setRange} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
          Show
          <FilterSelect value={String(showN)} onChange={(v) => setShowN(Number(v))} className="w-[86px]" label="Rows per page" options={[{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: '999', label: 'All' }]} />
          entries
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commissions"
          placeholder="search"
          startIcon={<Search className="size-4" />}
          className="ml-auto h-9 w-56"
        />
      </div>

      {reportType === 'Tech Report' ? (
        <TechReportView rows={rows} all={matched} hidden={hidden} settlement={settlement} tipsOnly={tipsOnly} onSettlement={onKpiSettlement} onTips={onKpiTips} onClear={onKpiClear} tableRef={tableRef} />
      ) : (
        <StandardView rows={rows} all={matched} byTime={byTime} hidden={hidden} external={reportType === 'External Company'} tipsOnly={tipsOnly} onTips={onKpiTips} tableRef={tableRef} />
      )}

      <p className="text-muted-foreground text-sm">
        Showing {matched.length === 0 ? 0 : 1} to {rows.length} of {matched.length} entries
      </p>
    </ReportShell>
  );
}

function TechReportView({ rows, all, hidden, settlement, tipsOnly, onSettlement, onTips, onClear, tableRef }: { rows: CommissionJob[]; all: CommissionJob[]; hidden: Set<string>; settlement: Settlement; tipsOnly: boolean; onSettlement: (s: Settlement) => void; onTips: () => void; onClear: () => void; tableRef: React.RefObject<HTMLDivElement | null> }) {
  const t = all.reduce(
    (acc, j) => ({ total: acc.total + j.jobTotal, billing: acc.billing + (j.paymentType === 'billing' ? j.jobTotal : 0), check: acc.check + (j.paymentType === 'check' ? j.jobTotal : 0), tip: acc.tip + j.tip, parts: acc.parts + j.parts, net: acc.net + netProfitOf(j), profit: acc.profit + commissionOf(j) }),
    { total: 0, billing: 0, check: 0, tip: 0, parts: 0, net: 0, profit: 0 },
  );

  const allColumns: ReportColumn<CommissionJob>[] = [
    { id: 'job', header: 'Job Id', width: 96, grow: 0, sortValue: (j) => j.jobNumber, cell: (j) => <span className="text-brand font-medium tabular-nums">{j.jobNumber}</span>, footer: <span>Totals: {all.length}</span> },
    { id: 'tech', header: 'Tech', width: 120, grow: 1, sortValue: (j) => j.tech.name, cell: (j) => j.tech.name },
    { id: 'created', header: 'Created', width: 150, sortValue: (j) => j.createdDate.getTime(), cell: (j) => <span className="text-muted-foreground tabular-nums">{fmtDateTime(j.createdDate)}</span> },
    { id: 'closed', header: 'Closed', width: 150, sortValue: (j) => j.doneDate.getTime(), cell: (j) => <span className="text-muted-foreground tabular-nums">{fmtDateTime(j.doneDate)}</span> },
    { id: 'jobType', header: 'Job Type', width: 150, grow: 1, sortValue: (j) => j.jobType, cell: (j) => j.jobType },
    { id: 'address', header: 'Address', width: 200, grow: 1, sortValue: (j) => j.address, cell: (j) => <span className="text-muted-foreground">{j.address}</span> },
    { id: 'phone', header: 'Phone', width: 140, grow: 0, sortValue: (j) => j.phone, cell: (j) => <span className="text-muted-foreground tabular-nums">{formatPhone(j.phone)}</span> },
    { id: 'total', header: 'Total', width: 100, align: 'right', sortValue: (j) => j.jobTotal, cell: (j) => <span className="tabular-nums">{money0(j.jobTotal)}</span>, footer: <span className="tabular-nums">{money0(t.total)}</span> },
    { id: 'billing', header: 'Billing', width: 90, align: 'right', grow: 0, sortValue: (j) => (j.paymentType === 'billing' ? j.jobTotal : 0), cell: (j) => <span className="text-muted-foreground tabular-nums">{j.paymentType === 'billing' ? money0(j.jobTotal) : '0'}</span>, footer: <span className="tabular-nums">{money0(t.billing)}</span> },
    { id: 'check', header: 'Check', width: 90, align: 'right', grow: 0, sortValue: (j) => (j.paymentType === 'check' ? j.jobTotal : 0), cell: (j) => <span className="text-muted-foreground tabular-nums">{j.paymentType === 'check' ? money0(j.jobTotal) : '0'}</span>, footer: <span className="tabular-nums">{money0(t.check)}</span> },
    { id: 'share', header: 'Tech Share', width: 100, align: 'right', grow: 0, sortValue: (j) => j.tech.rate, cell: (j) => <span className="text-muted-foreground tabular-nums">{j.tech.rate}%</span> },
    { id: 'tip', header: 'Tip Amount', width: 100, align: 'right', grow: 0, sortValue: (j) => j.tip, cell: (j) => (j.tip ? <span className="text-status-green-emphasis tabular-nums">{money0(j.tip)}</span> : <span className="text-muted-foreground">0</span>), footer: <span className="text-status-green-emphasis tabular-nums">{money0(t.tip)}</span> },
    { id: 'parts', header: 'Company Parts', width: 120, align: 'right', grow: 0, sortValue: (j) => j.parts, cell: (j) => <span className="text-muted-foreground tabular-nums">{money0(j.parts)}</span>, footer: <span className="tabular-nums">{money0(t.parts)}</span> },
    { id: 'net', header: 'Net Profit', width: 100, align: 'right', sortValue: (j) => netProfitOf(j), cell: (j) => <span className="tabular-nums">{money0(netProfitOf(j))}</span>, footer: <span className="tabular-nums">{money0(t.net)}</span> },
    {
      id: 'profit', header: 'Tech Profit', width: 110, align: 'right', sortValue: (j) => commissionOf(j),
      cell: (j) => (
        <span className={cn('font-medium tabular-nums', j.isCallback ? 'text-status-red-emphasis' : 'text-brand')}>
          {j.isCallback ? '0' : money2(commissionOf(j))}
          {j.adjusted && <Pencil className="text-status-amber-emphasis ml-1 inline size-3" />}
        </span>
      ),
      footer: <span className="text-brand tabular-nums">{money2(t.profit)}</span>,
    },
    { id: 'settlement', header: 'Settlement', width: 110, grow: 0, sortValue: (j) => (isSettled(j) ? 1 : 0), cell: (j) => <SettlementBadge settled={isSettled(j)} /> },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.id));

  const settledComm = all.filter(isSettled).reduce((s, j) => s + commissionOf(j), 0);
  const unsettledComm = all.filter((j) => !isSettled(j)).reduce((s, j) => s + commissionOf(j), 0);

  return (
    <div className="space-y-5">
      <ReportKpis
        items={[
          { icon: Hourglass, label: 'Unsettled (owed)', value: money2(unsettledComm), tone: 'warning', emphasize: true, active: settlement === 'Unsettled', onClick: () => onSettlement('Unsettled') },
          { icon: CircleDollarSign, label: 'Settled (paid)', value: money2(settledComm), tone: 'success', emphasize: true, active: settlement === 'Settled', onClick: () => onSettlement('Settled') },
          { icon: Calculator, label: 'Full Tech Profit', value: money2(t.profit), tone: 'primary', emphasize: true, onClick: onClear },
          { icon: Coins, label: 'Tips', value: money2(t.tip), tone: 'success', emphasize: true, active: tipsOnly, onClick: onTips },
        ]}
      />

      <div ref={tableRef}>
        <ReportTable columns={columns} rows={rows} getRowKey={(j) => j.id} empty={<EmptyState title="No data available in table" />} />
        <ReportTableTotals columns={columns} className="mt-2" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <ReportHeading level={2} scale="lg" className="mb-2">Total Profits</ReportHeading>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Profit For</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <Td>Tech profit</Td>
                <Td className="text-brand text-right tabular-nums">{money2(t.profit)}</Td>
              </TableRow>
              <TableRow>
                <Td>Tips (pass-through)</Td>
                <Td className="text-status-green-emphasis text-right tabular-nums">{money2(t.tip)}</Td>
              </TableRow>
              <TableRow>
                <Td>Company net (after tech profit)</Td>
                <Td className="text-right tabular-nums">{money2(Math.max(0, t.net - t.profit))}</Td>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <Card>
          <ReportHeading level={2} scale="lg" className="mb-2">Total by type</ReportHeading>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Jobs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byTypeRows(all).map((r) => (
                <TableRow key={r.type}>
                  <Td className="capitalize">{r.type}</Td>
                  <Td className="text-right tabular-nums">{r.total ? money0(r.total) : '0'}</Td>
                  <Td className="text-muted-foreground text-right tabular-nums">{r.jobs}</Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <ReportHeading level={2} scale="lg" className="mb-2">Report History</ReportHeading>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sent</TableHead>
              <TableHead>Sent To</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <Td colSpan={6} padding="none">
                <EmptyState title="No Records Found" />
              </Td>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function byTypeRows(jobs: CommissionJob[]) {
  const out: { type: string; total: number; jobs: number }[] = [];
  for (const pt of PAYMENT_TYPES) {
    const internal = jobs.filter((j) => !j.tech.external && j.paymentType === pt);
    out.push({ type: pt, total: internal.reduce((s, j) => s + j.jobTotal, 0), jobs: internal.length });
  }
  for (const pt of PAYMENT_TYPES) {
    const ext = jobs.filter((j) => j.tech.external && j.paymentType === pt);
    out.push({ type: `${pt} by external`, total: ext.reduce((s, j) => s + j.jobTotal, 0), jobs: ext.length });
  }
  return out;
}

function StandardView({ rows, all, byTime, hidden, external, tipsOnly, onTips, tableRef }: { rows: CommissionJob[]; all: CommissionJob[]; byTime: ByTime; hidden: Set<string>; external: boolean; tipsOnly: boolean; onTips: () => void; tableRef: React.RefObject<HTMLDivElement | null> }) {
  const t = all.reduce((acc, j) => ({ net: acc.net + netProfitOf(j), profit: acc.profit + commissionOf(j), tip: acc.tip + j.tip, total: acc.total + j.jobTotal, parts: acc.parts + j.parts }), { net: 0, profit: 0, tip: 0, total: 0, parts: 0 });
  // The active By-Time column stays emphasised so the reader can see which date
  // the range filter is actually applied to.
  const dim = (active: boolean) => (active ? 'font-medium' : 'text-muted-foreground');

  const allColumns: ReportColumn<CommissionJob>[] = [
    { id: 'job', header: 'Job Id', width: 96, grow: 0, sortValue: (j) => j.jobNumber, cell: (j) => <span className="text-brand font-medium tabular-nums">{j.jobNumber}</span>, footer: <span>Totals: {all.length}</span> },
    { id: 'invoice', header: 'Invoice #', width: 110, grow: 0, sortValue: (j) => j.invoiceNumber, cell: (j) => <span className="text-muted-foreground tabular-nums">{j.invoiceNumber}</span> },
    { id: 'tech', header: 'Tech', width: 120, grow: 1, sortValue: (j) => j.tech.name, cell: (j) => j.tech.name },
    { id: 'customer', header: 'Customer', width: 130, grow: 1, sortValue: (j) => j.customer, cell: (j) => j.customer },
    { id: 'address', header: 'Address', width: 190, grow: 1, sortValue: (j) => j.address, cell: (j) => <span className="text-muted-foreground">{j.address}</span> },
    { id: 'phone', header: 'Phone', width: 140, grow: 0, sortValue: (j) => j.phone, cell: (j) => <span className="text-muted-foreground tabular-nums">{formatPhone(j.phone)}</span> },
    { id: 'created', header: 'Created', width: 120, sortValue: (j) => j.createdDate.getTime(), cell: (j) => <span className={cn('tabular-nums', dim(byTime === 'Created'))}>{fmtDate(j.createdDate)}</span> },
    { id: 'scheduled', header: 'Scheduled', width: 120, sortValue: (j) => j.scheduledDate.getTime(), cell: (j) => <span className={cn('tabular-nums', dim(byTime === 'Scheduled'))}>{fmtDate(j.scheduledDate)}</span> },
    { id: 'done', header: 'Closed', width: 120, sortValue: (j) => j.doneDate.getTime(), cell: (j) => <span className={cn('tabular-nums', dim(byTime === 'Closed'))}>{fmtDate(j.doneDate)}</span> },
    {
      id: 'status', header: 'Status', width: 116, grow: 0, sortValue: (j) => j.jobStatus,
      cell: (j) => (j.isCallback
        ? <Badge variant="softRed" size="pill"><RotateCcw className="size-3" /> Callback</Badge>
        : <ReportStatusBadge status={j.jobStatus} />),
    },
    { id: 'total', header: 'Total', width: 100, align: 'right', sortValue: (j) => j.jobTotal, cell: (j) => <span className="tabular-nums">{money0(j.jobTotal)}</span>, footer: <span className="tabular-nums">{money0(t.total)}</span> },
    { id: 'net', header: 'Net Profit', width: 104, align: 'right', sortValue: (j) => netProfitOf(j), cell: (j) => <span className="tabular-nums">{money0(netProfitOf(j))}</span>, footer: <span className="tabular-nums">{money0(t.net)}</span> },
    { id: 'share', header: 'Tech Share', width: 96, align: 'right', grow: 0, sortValue: (j) => j.tech.rate, cell: (j) => <span className="text-muted-foreground tabular-nums">{j.tech.rate}%</span> },
    {
      id: 'profit', header: external ? 'Company Payout' : 'Tech Profit', width: 120, align: 'right', sortValue: (j) => commissionOf(j),
      cell: (j) => (
        <span className={cn('font-medium tabular-nums', j.isCallback ? 'text-status-red-emphasis' : 'text-brand')}>
          {j.isCallback ? '0' : money2(commissionOf(j))}
          {j.adjusted && <Pencil className="text-status-amber-emphasis ml-1 inline size-3" />}
        </span>
      ),
      footer: <span className="text-brand tabular-nums">{money2(t.profit)}</span>,
    },
    { id: 'tip', header: 'Tip', width: 84, align: 'right', grow: 0, sortValue: (j) => j.tip, cell: (j) => (j.tip ? <span className="text-status-green-emphasis tabular-nums">+{money2(j.tip)}</span> : <span className="text-muted-foreground">-</span>), footer: <span className="text-status-green-emphasis tabular-nums">{money2(t.tip)}</span> },
    { id: 'settlement', header: 'Settlement', width: 110, grow: 0, sortValue: (j) => (isSettled(j) ? 1 : 0), cell: (j) => <SettlementBadge settled={isSettled(j)} /> },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.id));

  return (
    <div className="space-y-3">
      <ReportKpis
        items={[
          { icon: DollarSign, label: 'Net Profit', value: money0(t.net), tone: 'neutral' },
          { icon: Calculator, label: external ? 'Company Payout' : 'Tech Profit', value: money2(t.profit), tone: 'primary', emphasize: true },
          { icon: Coins, label: 'Tips', value: money2(t.tip), tone: 'success', emphasize: true, active: tipsOnly, onClick: onTips },
          { icon: BadgeCheck, label: 'Jobs', value: all.length, tone: 'neutral' },
        ]}
      />
      <div ref={tableRef}>
        <ReportTable columns={columns} rows={rows} getRowKey={(j) => j.id} empty={<EmptyState title="No data available in table" />} />
        <ReportTableTotals columns={columns} className="mt-2" />
      </div>
    </div>
  );
}

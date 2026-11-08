import { useMemo, useRef, useState, useEffect } from 'react';
import {
  DollarSign,
  CircleDollarSign,
  BadgeCheck,
  Hourglass,
  Coins,
  Download,
  RotateCcw,
  Pencil,
  Calculator,
  Mail,
  Printer,
  SlidersHorizontal,
  Send,
  Check,
  ChevronDown,
  Search,
  CalendarRange,
} from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable, type ResizableColumn } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/form/SelectField';
import { DatePicker } from '@/components/form/DatePicker';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { ReportShell } from './ReportShell';
import { formatCurrency, formatCurrencyWhole, formatPhone } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { hashStr, mulberry32 } from '@/lib/reports/random';
import { exportCsvFile } from '@/lib/csv';
import { STATUS_INTENT_CLASSES } from '@/design-system/status-registry';

/**
 * Commissions (mock-first preview) — mirrors the legacy commission screen
 * (Standard / Tech / External report types, Settlement + By-Time + date-range
 * filters, Total Profits / Total by type / Report History) and the v1 spec
 * model (md_files/specs/commissions/BUILD_SPEC_v1.md):
 *   net profit = job total − parts − labor − sales tax − card fees
 *   commission ("Tech Profit") = net profit × the tech's % ("Tech Share")
 *   tips 100% on top · callback = off · settled = Paid
 * All data is deterministic mock data; wire to /api/commissions later.
 */

// ── formatting ────────────────────────────────────────────────────────────────
// Org-aware currency (honors organization currency setting). (#126)
const money0 = (n: number) => formatCurrencyWhole(n);
const money2 = (n: number) => formatCurrency(n);
const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (d: Date) =>
  `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

// ── model ─────────────────────────────────────────────────────────────────────
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
  a.adjusted = { from: commissionOf(a), to: commissionOf(a) + 75, reason: 'Promised incentive — tough attic install', by: 'Admin' };
  const b = jobs[9]!;
  b.adjusted = { from: commissionOf(b), to: Math.round(commissionOf(b) * 0.5), reason: 'Quality reduction — rework needed', by: 'Admin' };
  return jobs;
}

const JOBS = buildJobs();

// ── badges ────────────────────────────────────────────────────────────────────
// Synthetic report-only taxonomy (Title Case) - not the real backend JobStatus enum, so
// this stays a local map rather than routing through the `job` status-registry domain.
function ReportStatusBadge({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, string> = {
    Scheduled: STATUS_INTENT_CLASSES.warning,
    'In Progress': STATUS_INTENT_CLASSES.warning,
    Completed: STATUS_INTENT_CLASSES.success,
    Closed: STATUS_INTENT_CLASSES.neutral,
  };
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${map[status]}`}>{status}</span>;
}

// ── tiny select ───────────────────────────────────────────────────────────────
function Select({ value, onChange, options, width = 180, label = 'Filter' }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; width?: number; label?: string }) {
  return (
    <div style={{ width }}>
      <SelectField aria-label={label} value={value} onValueChange={onChange} className="h-9 w-full" options={options} />
    </div>
  );
}

// ── date-range preset picker ──────────────────────────────────────────────────
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const summary = range.from && range.to ? `${fmtDate(range.from)} – ${fmtDate(range.to)}` : 'All time';
  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    const from = startOfDay(new Date(`${customFrom}T00:00:00`));
    const to = endOfDay(new Date(`${customTo}T00:00:00`));
    if (from.getTime() > to.getTime()) return;
    onChange({ from, to, label: 'Custom range' });
    setOpen(false);
  };
  return (
    <div className="relative" ref={ref}>
      {/* outline/neutral matches the raw's border colour, surface background and hover
          background exactly. Three disclosed deltas: outline/neutral sets no idle text
          colour (relies on the inherited default text colour, same as the raw did
          implicitly), the base font-semibold replaces the raw's font-medium, and the
          shadow is dropped (no shadow slot on this cell). */}
      <Button type="button" variant="outline" tone="neutral" size="sm" onClick={() => setOpen((o) => !o)} className="gap-1.5">
        <CalendarRange className="h-4 w-4 text-text-secondary" />
        <span className="tabular-nums">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 text-text-secondary" />
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 max-h-96 w-72 overflow-auto rounded-lg border border-border bg-surface-light p-1 shadow-lg">
          <div className="px-2.5 py-1.5 text-xs font-semibold text-text-primary">{range.label}</div>
          <div className="my-1 border-t border-border" />
          {/* raw: dropdown-menu-item row (listbox option), not Button-shaped */}
          {RANGE_PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => { onChange(presetRange(p)); setShowCustom(false); setOpen(false); }} className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-background-light ${range.label === p ? 'font-medium text-primary' : 'text-text-primary'}`}>
              {p}{range.label === p && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          {/* raw: dropdown-menu-item row (listbox option), not Button-shaped */}
          <button type="button" onClick={() => setShowCustom((s) => !s)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-background-light ${range.label === 'Custom range' ? 'font-medium text-primary' : 'text-text-primary'}`}>
            Custom range…{range.label === 'Custom range' && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>
          {showCustom && (
            <div className="space-y-2 px-2.5 py-2">
              <label className="block text-xs font-medium text-text-secondary">
                From
                <DatePicker value={customFrom} max={customTo || undefined} onChange={setCustomFrom} className="mt-1" inputClassName="text-sm" />
              </label>
              <label className="block text-xs font-medium text-text-secondary">
                To
                <DatePicker value={customTo} min={customFrom || undefined} onChange={setCustomTo} className="mt-1" inputClassName="text-sm" />
              </label>
              {/* raw: solid CTA filled with bg-text-primary (near-black) - no minted
                  solid tone reproduces this fill; left raw rather than force a colour
                  swap onto a mismatched cell (see CampaignRoiReport.tsx "Add" for the
                  same recipe/reasoning). */}
              <button type="button" onClick={applyCustom} disabled={!customFrom || !customTo} className="w-full rounded-md bg-text-primary px-3 py-1.5 text-sm font-medium text-on-fill transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Fields menu ───────────────────────────────────────────────────────────────
function FieldsMenu({ all, hidden, onToggle }: { all: { id: string; label: string }[]; hidden: Set<string>; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      {/* raw: outline/neutral sets no idle text colour and nothing in this tree
          supplies text-text-secondary; converting would silently darken the idle
          label to near-black (the documented outline/neutral trap). Left raw. */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-light px-3 py-1.5 text-sm font-medium text-text-secondary shadow-sm hover:text-text-primary">
        <SlidersHorizontal className="h-4 w-4" /> Fields <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-80 w-56 overflow-auto rounded-lg border border-border bg-surface-light p-1 shadow-lg">
          {/* raw: dropdown-menu-item row (listbox option), not Button-shaped */}
          {all.map((c) => (
            <button key={c.id} type="button" onClick={() => onToggle(c.id)} className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs text-text-primary hover:bg-background-light">
              {c.label}{!hidden.has(c.id) && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// raw: outline/neutral sets no idle text colour and nothing in this tree supplies
// text-text-secondary; converting would silently darken the idle label to near-black
// (the documented outline/neutral trap - same reasoning as FieldsMenu's trigger
// above). Left raw.
function ActionBtn({ icon: Icon, label, onClick }: { icon: typeof Download; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-light px-3 py-1.5 text-sm font-medium text-text-secondary shadow-sm hover:text-text-primary">
      <Icon className="h-4 w-4" /> {label}
    </button>
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

// ── report types & filters ────────────────────────────────────────────────────
const REPORT_TYPES = ['Standard Report', 'Tech Report', 'External Company'] as const;
type ReportType = (typeof REPORT_TYPES)[number];
type ByTime = 'Created' | 'Scheduled' | 'Closed';
type Settlement = 'All' | 'Settled' | 'Unsettled';

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
      <ActionBtn icon={Mail} label="Export By Mail" onClick={() => flash('Report queued — emailed to admin@servwave (mock).')} />
      <FieldsMenu all={COLUMN_LABELS} hidden={hidden} onToggle={(id) => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
      <ActionBtn icon={Send} label="Send Bulk" onClick={() => flash(`Statements sent to ${roster.length} technicians (mock).`)} />
      <ActionBtn icon={Printer} label="Print" onClick={() => window.print()} />
    </div>
  );

  return (
    <ReportShell report={report} subtitle="Job-level net-profit commission · tips on top · callbacks off · Settled / Unsettled" actions={actions}>
      {notice && <div className="rounded-lg border border-success-border bg-success-surface px-4 py-2 text-sm font-medium text-success-text">{notice}</div>}

      {/* report-type tabs. raw: segmented toggle control, not Button-shaped */}
      <div className="flex flex-wrap gap-2">
        {REPORT_TYPES.map((rt) => (
          <button key={rt} type="button" onClick={() => { setReportType(rt); setTechId('all'); }} className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition ${reportType === rt ? 'bg-text-primary text-on-fill' : 'border border-border bg-surface-light text-text-secondary hover:text-text-primary'}`}>
            {rt}
          </button>
        ))}
      </div>

      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={techId} onChange={setTechId} width={210} label={reportType === 'External Company' ? 'Company' : 'Technician'} options={[{ value: 'all', label: reportType === 'External Company' ? 'All Companies' : 'Select Technician' }, ...roster.map((t) => ({ value: t.id, label: t.name }))]} />
        <Select value={jobType} onChange={setJobType} width={180} label="Job type" options={[{ value: 'all', label: 'Job Type' }, ...JOB_TYPES.map((t) => ({ value: t, label: t }))]} />
        <Select value={settlement} onChange={(v) => setSettlement(v as Settlement)} width={150} label="Settlement" options={[{ value: 'All', label: 'Settlement' }, { value: 'Settled', label: 'Settled Jobs' }, { value: 'Unsettled', label: 'Un-Settled Jobs' }]} />
        <div className="flex items-center gap-1 text-xs text-text-secondary">
          <span className="mr-1">By Time:</span>
          {/* raw: segmented toggle control, not Button-shaped */}
          {(['Created', 'Scheduled', 'Closed'] as ByTime[]).map((t) => (
            <button key={t} type="button" onClick={() => setByTime(t)} className={`rounded-md px-2.5 py-1 font-medium transition ${byTime === t ? 'bg-text-primary text-on-fill' : 'border border-border bg-surface-light text-text-secondary hover:text-text-primary'}`}>{t}</button>
          ))}
        </div>
        <DateRangePicker range={range} onChange={setRange} />
      </div>

      {/* table chrome: show entries + search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-text-secondary">
          Show
          <Select value={String(showN)} onChange={(v) => setShowN(Number(v))} width={76} label="Rows per page" options={[{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: '999', label: 'All' }]} />
          entries
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search" className="w-56 rounded-lg border border-border bg-surface-light py-1.5 pl-8 pr-3 text-sm text-text-primary shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
      </div>

      {reportType === 'Tech Report' ? (
        <TechReportView rows={rows} all={matched} hidden={hidden} settlement={settlement} tipsOnly={tipsOnly} onSettlement={onKpiSettlement} onTips={onKpiTips} onClear={onKpiClear} tableRef={tableRef} />
      ) : (
        <StandardView rows={rows} all={matched} byTime={byTime} hidden={hidden} external={reportType === 'External Company'} tipsOnly={tipsOnly} onTips={onKpiTips} tableRef={tableRef} />
      )}

      <p className="text-sm text-text-secondary">
        Showing {matched.length === 0 ? 0 : 1} to {rows.length} of {matched.length} entries
      </p>
    </ReportShell>
  );
}

// ── column catalog for Fields toggle ──────────────────────────────────────────
const COLUMN_LABELS: { id: string; label: string }[] = [
  { id: 'job', label: 'Job Id' }, { id: 'tech', label: 'Tech' }, { id: 'created', label: 'Created' }, { id: 'closed', label: 'Closed' },
  { id: 'jobType', label: 'Job Type' }, { id: 'address', label: 'Address' }, { id: 'phone', label: 'Phone' }, { id: 'total', label: 'Total' },
  { id: 'billing', label: 'Billing' }, { id: 'check', label: 'Check' }, { id: 'share', label: 'Tech Share' }, { id: 'tip', label: 'Tip Amount' },
  { id: 'parts', label: 'Company Parts' }, { id: 'net', label: 'Net Profit' }, { id: 'profit', label: 'Tech Profit' }, { id: 'settlement', label: 'Settlement' },
];

// ── Tech Report: legacy column set + Total Profits / Total by type / History ───
function TechReportView({ rows, all, hidden, settlement, tipsOnly, onSettlement, onTips, onClear, tableRef }: { rows: CommissionJob[]; all: CommissionJob[]; hidden: Set<string>; settlement: Settlement; tipsOnly: boolean; onSettlement: (s: Settlement) => void; onTips: () => void; onClear: () => void; tableRef: React.RefObject<HTMLDivElement | null> }) {
  const t = all.reduce(
    (acc, j) => ({ total: acc.total + j.jobTotal, billing: acc.billing + (j.paymentType === 'billing' ? j.jobTotal : 0), check: acc.check + (j.paymentType === 'check' ? j.jobTotal : 0), tip: acc.tip + j.tip, parts: acc.parts + j.parts, net: acc.net + netProfitOf(j), profit: acc.profit + commissionOf(j) }),
    { total: 0, billing: 0, check: 0, tip: 0, parts: 0, net: 0, profit: 0 },
  );

  const allColumns: ResizableColumn<CommissionJob>[] = [
    { id: 'job', header: 'Job Id', width: 96, grow: 0, sortValue: (j) => j.jobNumber, cell: (j) => <span className="font-medium tabular-nums text-primary underline-offset-2 hover:underline">{j.jobNumber}</span>, footer: <span className="font-semibold">Totals:{all.length}</span> },
    { id: 'tech', header: 'Tech', width: 120, grow: 1, sortValue: (j) => j.tech.name, cell: (j) => j.tech.name },
    { id: 'created', header: 'Created', width: 150, sortValue: (j) => j.createdDate.getTime(), cell: (j) => <span className="tabular-nums text-text-secondary">{fmtDateTime(j.createdDate)}</span> },
    { id: 'closed', header: 'Closed', width: 150, sortValue: (j) => j.doneDate.getTime(), cell: (j) => <span className="tabular-nums text-text-secondary">{fmtDateTime(j.doneDate)}</span> },
    { id: 'jobType', header: 'Job Type', width: 150, grow: 1, sortValue: (j) => j.jobType, cell: (j) => j.jobType },
    { id: 'address', header: 'Address', width: 200, grow: 1, sortValue: (j) => j.address, cell: (j) => <span className="text-text-secondary">{j.address}</span> },
    { id: 'phone', header: 'Phone', width: 140, grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{formatPhone(j.phone)}</span> },
    { id: 'total', header: 'Total', width: 100, align: 'right', sortValue: (j) => j.jobTotal, cell: (j) => <span className="tabular-nums">{money0(j.jobTotal)}</span>, footer: <span className="tabular-nums">{money0(t.total)}</span> },
    { id: 'billing', header: 'Billing', width: 90, align: 'right', grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{j.paymentType === 'billing' ? money0(j.jobTotal) : '0'}</span>, footer: <span className="tabular-nums">{money0(t.billing)}</span> },
    { id: 'check', header: 'Check', width: 90, align: 'right', grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{j.paymentType === 'check' ? money0(j.jobTotal) : '0'}</span>, footer: <span className="tabular-nums">{money0(t.check)}</span> },
    { id: 'share', header: 'Tech Share', width: 100, align: 'right', grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{j.tech.rate}%</span> },
    { id: 'tip', header: 'Tip Amount', width: 100, align: 'right', grow: 0, sortValue: (j) => j.tip, cell: (j) => (j.tip ? <span className="tabular-nums text-success-text">{money0(j.tip)}</span> : <span className="text-text-secondary">0</span>), footer: <span className="tabular-nums text-success-text">{money0(t.tip)}</span> },
    { id: 'parts', header: 'Company Parts', width: 120, align: 'right', grow: 0, sortValue: (j) => j.parts, cell: (j) => <span className="tabular-nums text-text-secondary">{money0(j.parts)}</span>, footer: <span className="tabular-nums">{money0(t.parts)}</span> },
    { id: 'net', header: 'Net Profit', width: 100, align: 'right', sortValue: (j) => netProfitOf(j), cell: (j) => <span className="tabular-nums">{money0(netProfitOf(j))}</span>, footer: <span className="tabular-nums">{money0(t.net)}</span> },
    { id: 'profit', header: 'Tech Profit', width: 110, align: 'right', sortValue: (j) => commissionOf(j), cell: (j) => <span className={`tabular-nums font-medium ${j.isCallback ? 'text-danger-text' : 'text-primary'}`}>{j.isCallback ? '0' : money2(commissionOf(j))}{j.adjusted && <Pencil className="ml-1 inline h-3 w-3 text-warning-text" />}</span>, footer: <span className="tabular-nums text-primary">{money2(t.profit)}</span> },
    { id: 'settlement', header: 'Settlement', width: 110, grow: 0, sortValue: (j) => (isSettled(j) ? 1 : 0), cell: (j) => (isSettled(j) ? <span className="inline-block rounded-full bg-success-surface px-2 py-0.5 text-xs font-medium text-success-text">Settled</span> : <span className="inline-block rounded-full bg-warning-surface px-2 py-0.5 text-xs font-medium text-warning-text">Unsettled</span>) },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.id));

  const settledComm = all.filter(isSettled).reduce((s, j) => s + commissionOf(j), 0);
  const unsettledComm = all.filter((j) => !isSettled(j)).reduce((s, j) => s + commissionOf(j), 0);

  return (
    <div className="space-y-5">
      <KpiStrip
        items={[
          { icon: Hourglass, label: 'Unsettled (owed)', value: money2(unsettledComm), sub: 'not yet paid', tone: 'warning', emphasize: true, active: settlement === 'Unsettled', onClick: () => onSettlement('Unsettled') },
          { icon: CircleDollarSign, label: 'Settled (paid)', value: money2(settledComm), sub: 'paid out', tone: 'success', emphasize: true, active: settlement === 'Settled', onClick: () => onSettlement('Settled') },
          { icon: Calculator, label: 'Full Tech Profit', value: money2(t.profit), sub: 'settled + unsettled', tone: 'primary', emphasize: true, onClick: onClear },
          { icon: Coins, label: 'Tips', value: money2(t.tip), sub: '100% on top', tone: 'success', emphasize: true, active: tipsOnly, onClick: onTips },
        ]}
      />

      <div ref={tableRef}>
        <ResizableTable columns={columns} rows={rows} getRowKey={(j) => j.id} empty={<EmptyState title="No data available in table" />} />
      </div>

      {/* summary sections */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Total Profits">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-text-secondary"><th className="py-2 font-medium">Profit For</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
            <tbody>
              <tr className="border-b border-border last:border-0"><td className="py-2">Tech profit</td><td className="py-2 text-right tabular-nums text-primary">{money2(t.profit)}</td></tr>
              <tr className="border-b border-border last:border-0"><td className="py-2">Tips (pass-through)</td><td className="py-2 text-right tabular-nums text-success-text">{money2(t.tip)}</td></tr>
              <tr><td className="py-2">Company net (after tech profit)</td><td className="py-2 text-right tabular-nums">{money2(Math.max(0, t.net - t.profit))}</td></tr>
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Total by type">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-text-secondary"><th className="py-2 font-medium">Type</th><th className="py-2 text-right font-medium">Total</th><th className="py-2 text-right font-medium">Jobs</th></tr></thead>
            <tbody>
              {byTypeRows(all).map((r) => (
                <tr key={r.type} className="border-b border-border last:border-0">
                  <td className="py-2 capitalize">{r.type}</td>
                  <td className="py-2 text-right tabular-nums">{r.total ? money0(r.total) : '0'}</td>
                  <td className="py-2 text-right tabular-nums text-text-secondary">{r.jobs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      <SectionCard title="Report History">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-text-secondary"><th className="py-2 font-medium">Sent</th><th className="py-2 font-medium">Sent To</th><th className="py-2 font-medium">Email</th><th className="py-2 font-medium">Description</th><th className="py-2 font-medium">Notes</th><th className="py-2 font-medium">Actions</th></tr></thead>
          <tbody><tr><td colSpan={6} className="py-8 text-center text-text-secondary">No Records Found</td></tr></tbody>
        </table>
      </SectionCard>
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

// ── Standard / External: broad table ──────────────────────────────────────────
function StandardView({ rows, all, byTime, hidden, external, tipsOnly, onTips, tableRef }: { rows: CommissionJob[]; all: CommissionJob[]; byTime: ByTime; hidden: Set<string>; external: boolean; tipsOnly: boolean; onTips: () => void; tableRef: React.RefObject<HTMLDivElement | null> }) {
  const t = all.reduce((acc, j) => ({ net: acc.net + netProfitOf(j), profit: acc.profit + commissionOf(j), tip: acc.tip + j.tip, total: acc.total + j.jobTotal, parts: acc.parts + j.parts }), { net: 0, profit: 0, tip: 0, total: 0, parts: 0 });
  const dim = (active: boolean) => (active ? 'text-text-primary font-medium' : 'text-text-secondary');

  const allColumns: ResizableColumn<CommissionJob>[] = [
    { id: 'job', header: 'Job Id', width: 96, grow: 0, sortValue: (j) => j.jobNumber, cell: (j) => <span className="font-medium tabular-nums text-primary">{j.jobNumber}</span>, footer: <span className="font-semibold">Totals:{all.length}</span> },
    { id: 'invoice', header: 'Invoice #', width: 110, grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{j.invoiceNumber}</span> },
    { id: 'tech', header: 'Tech', width: 120, grow: 1, sortValue: (j) => j.tech.name, cell: (j) => j.tech.name },
    { id: 'customer', header: 'Customer', width: 130, grow: 1, sortValue: (j) => j.customer, cell: (j) => j.customer },
    { id: 'address', header: 'Address', width: 190, grow: 1, sortValue: (j) => j.address, cell: (j) => <span className="text-text-secondary">{j.address}</span> },
    { id: 'phone', header: 'Phone', width: 140, grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{formatPhone(j.phone)}</span> },
    { id: 'created', header: 'Created', width: 120, sortValue: (j) => j.createdDate.getTime(), cell: (j) => <span className={`tabular-nums ${dim(byTime === 'Created')}`}>{fmtDate(j.createdDate)}</span> },
    { id: 'scheduled', header: 'Scheduled', width: 120, sortValue: (j) => j.scheduledDate.getTime(), cell: (j) => <span className={`tabular-nums ${dim(byTime === 'Scheduled')}`}>{fmtDate(j.scheduledDate)}</span> },
    { id: 'done', header: 'Closed', width: 120, sortValue: (j) => j.doneDate.getTime(), cell: (j) => <span className={`tabular-nums ${dim(byTime === 'Closed')}`}>{fmtDate(j.doneDate)}</span> },
    { id: 'status', header: 'Status', width: 116, grow: 0, sortValue: (j) => j.jobStatus, cell: (j) => (j.isCallback ? <span className="inline-flex items-center gap-1 rounded-full bg-danger-surface px-2 py-0.5 text-xs font-medium text-danger-text"><RotateCcw className="h-3 w-3" /> Callback</span> : <ReportStatusBadge status={j.jobStatus} />) },
    { id: 'total', header: 'Total', width: 100, align: 'right', sortValue: (j) => j.jobTotal, cell: (j) => <span className="tabular-nums">{money0(j.jobTotal)}</span>, footer: <span className="tabular-nums">{money0(t.total)}</span> },
    { id: 'net', header: 'Net Profit', width: 104, align: 'right', sortValue: (j) => netProfitOf(j), cell: (j) => <span className="tabular-nums">{money0(netProfitOf(j))}</span>, footer: <span className="tabular-nums">{money0(t.net)}</span> },
    { id: 'share', header: 'Tech Share', width: 96, align: 'right', grow: 0, cell: (j) => <span className="tabular-nums text-text-secondary">{j.tech.rate}%</span> },
    { id: 'profit', header: external ? 'Company Payout' : 'Tech Profit', width: 120, align: 'right', sortValue: (j) => commissionOf(j), cell: (j) => <span className={`tabular-nums font-medium ${j.isCallback ? 'text-danger-text' : 'text-primary'}`}>{j.isCallback ? '0' : money2(commissionOf(j))}{j.adjusted && <Pencil className="ml-1 inline h-3 w-3 text-warning-text" />}</span>, footer: <span className="tabular-nums text-primary">{money2(t.profit)}</span> },
    { id: 'tip', header: 'Tip', width: 84, align: 'right', grow: 0, sortValue: (j) => j.tip, cell: (j) => (j.tip ? <span className="tabular-nums text-success-text">+{money2(j.tip)}</span> : <span className="text-text-secondary">—</span>), footer: <span className="tabular-nums text-success-text">{money2(t.tip)}</span> },
    { id: 'settlement', header: 'Settlement', width: 110, grow: 0, sortValue: (j) => (isSettled(j) ? 1 : 0), cell: (j) => (isSettled(j) ? <span className="inline-block rounded-full bg-success-surface px-2 py-0.5 text-xs font-medium text-success-text">Settled</span> : <span className="inline-block rounded-full bg-warning-surface px-2 py-0.5 text-xs font-medium text-warning-text">Unsettled</span>) },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.id));

  return (
    <div className="space-y-3">
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Net Profit', value: money0(t.net), tone: 'neutral' },
          { icon: Calculator, label: external ? 'Company Payout' : 'Tech Profit', value: money2(t.profit), tone: 'primary', emphasize: true },
          { icon: Coins, label: 'Tips', value: money2(t.tip), tone: 'success', emphasize: true, active: tipsOnly, onClick: onTips },
          { icon: BadgeCheck, label: 'Jobs', value: all.length, sub: `${all.filter(isSettled).length} settled`, tone: 'neutral' },
        ]}
      />
      <div ref={tableRef}>
        <ResizableTable columns={columns} rows={rows} getRowKey={(j) => j.id} empty={<EmptyState title="No data available in table" />} />
      </div>
    </div>
  );
}

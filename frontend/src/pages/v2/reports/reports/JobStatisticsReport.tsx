import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { ChartCard } from '@/components/charts';
import { chartPalette, token } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { hashStr, mulberry32 } from '@/lib/reports/random';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportTable } from '../components/reportTable';
import { DateRangeControl } from '../components/dateRangeControl';
import { TabPanel, TabStrip } from '../../_shared/tabs';

/**
 * Job Statistics - the tabbed analytics dashboard for jobs.
 *
 * Nine tabs over one deterministic 700-job fixture, all scoped by a single
 * date-range control. Every number and every rule is carried over verbatim:
 *
 *   CALL-BACK DETECTION is the subtle one. A job is a call-back if its type is
 *   'CALL BACK', OR it is a repeat for the SAME CLIENT within 30 days of that
 *   client's previous COMPLETED job - which is why the builder sorts each
 *   client's jobs by date and walks them tracking `lastCompleted`. The reason
 *   string ('CALL BACK type' vs 'Repeat under 30d') is what the history table
 *   shows, so both branches matter.
 *
 *   THE THREE QUALITY TABS USE A FIXED 12-MONTH WINDOW, deliberately, not the
 *   page's date scope - the comment on `twelveMoSrc` explains why: a per-job-type
 *   comparison needs enough data to name a best performer. Their sort direction
 *   also carries meaning: call-back rate ascending (lower is better),
 *   first-time-fix descending, average completion ascending.
 *
 *   THE "BEST" BADGE TRACKS THE ACTUAL BEST TECH, not the first rendered row,
 *   because the table can be re-sorted by the reader. `bestCbTech` and friends
 *   are computed off the ordered arrays before any table sees them.
 *
 * CHARTS UNTOUCHED. Jobs vs Canceled stays primary vs danger, Sales vs Profit
 * stays primary vs success, the call-back trend line stays danger (higher is
 * worse), and each quality bar keeps its own direction colour. The pie pair
 * assigns a colour per NAME across both pies from `chartPalette`, so a source
 * is the same colour in "by count" and "by sales" - that shared `color(name)`
 * lookup is the whole point and is carried over as-is.
 *
 * Shape differences: the tab strip and the day/week/month segmented control are
 * the shared `TabStrip` and kit Buttons, and two table affordances are lost to
 * the kit's DataTable - see the ledger for the sticky-header/flat variant and
 * the selected-row tint.
 */

const STATUSES = ['Submitted', 'In progress', 'Done', 'Canceled'] as const;
type Status = (typeof STATUSES)[number];
// weighted draw so most jobs are Done/Submitted
const STATUS_WEIGHTED: Status[] = ['Done', 'Done', 'Done', 'Submitted', 'Submitted', 'In progress', 'Canceled'];

const SOURCES = ['Account', 'Returning customer', 'Google', 'LVD', 'LVD return customer', 'Referral', 'Village - Returned Customer', 'Website -Submission'];
const JOB_TYPES = ['Alarm System', 'Burglar Alarm', 'Access Control', 'Buzzer System', 'Business Lockout', 'Bullet Proof', 'AV + NETWORK', 'Gate', 'Garage', 'CALL BACK', 'Troubleshoot', 'Commercial', 'Residential'];
const TECHS = ['Adam Elkarrat', 'Emanuel Dahan', 'Nadia', 'Ohad', 'Rami', 'Robert Bresnick', 'Sagiv Peker', 'Oved Adani'];
const DISPATCHERS = ['Dispatch', 'Emanuel Dahan', 'Nadia', 'Ohad', 'Rami', 'Shani Adani'];
const AREAS = ['Brooklyn', 'Queens', 'Bronx', 'Manhattan', 'Jersey City', 'Newark', 'Boston'];

// Calm categorical palette (cycled) - replaces the prior rainbow set.
const PALETTE = chartPalette;

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

const FIRST = ['Aiden', 'Jenny', 'Diogo', 'Brett', 'Jasmine', 'Marcus', 'Sofia', 'Devon', 'Priya', 'Tyler', 'Aisha', 'Omar', 'Tina', 'Leo', 'Dana', 'Robin', 'Casey', 'Alex', 'Sam', 'Jordan'];
const LAST = ['Mills', 'Park', 'Silva', 'Owens', 'Lee', 'Bell', 'Reyes', 'Clark', 'Nair', 'Brooks', 'Khan', 'Said', 'Marsh', 'Cole', 'Shah', 'Ng', 'Ortiz', 'Diaz', 'Pope', 'Klein'];
const makeClientName = (id: number) => `${FIRST[id % FIRST.length]} ${LAST[(id * 7) % LAST.length]}`;

interface Job {
  id: number;
  clientId: number;
  clientName: string;
  callbackReason: string;
  status: Status;
  source: string;
  jobType: string;
  tech: string;
  dispatcher: string;
  area: string;
  gross: number; // realized on Done only
  profit: number;
  laborCost: number;
  techExpenses: number;
  completionHours: number; // Done only
  singleVisit: boolean;
  isCallback: boolean;
  jobDate: Date;
  completedAt: Date | null;
}

function buildJobs(): Job[] {
  const rng = mulberry32(hashStr('alpha-job-statistics'));
  const now = new Date();
  const jobs: Job[] = [];
  const N = 700;
  for (let i = 0; i < N; i++) {
    const status = pick(rng, STATUS_WEIGHTED);
    const clientId = 1 + Math.floor(rng() * 110);
    const jobDate = new Date(now);
    jobDate.setDate(now.getDate() - Math.floor(rng() * 365));
    jobDate.setHours(8 + Math.floor(rng() * 9), Math.floor(rng() * 60), 0, 0);
    const done = status === 'Done';
    const completedAt = done ? new Date(jobDate.getTime() + Math.floor(rng() * 3) * 86400000) : null;

    const subtotal = Math.round((150 + rng() * 4200) / 5) * 5;
    const gross = done ? subtotal : 0;
    const laborCost = done ? Math.round(subtotal * (0.1 + rng() * 0.15)) : 0;
    const techExpenses = done ? Math.round(subtotal * rng() * 0.05) : 0;
    const itemCost = done ? Math.round(subtotal * (0.12 + rng() * 0.13)) : 0;
    const profit = done ? Math.max(0, gross - laborCost - techExpenses - itemCost) : 0;

    jobs.push({
      id: 698500 - i,
      clientId,
      clientName: makeClientName(clientId),
      callbackReason: '',
      status,
      source: pick(rng, SOURCES),
      jobType: pick(rng, JOB_TYPES),
      tech: pick(rng, TECHS),
      dispatcher: pick(rng, DISPATCHERS),
      area: pick(rng, AREAS),
      gross,
      profit,
      laborCost,
      techExpenses,
      completionHours: done ? Math.round((0.5 + rng() * 6) * 10) / 10 : 0,
      singleVisit: rng() > 0.25,
      isCallback: false, // computed below
      jobDate,
      completedAt,
    });
  }

  // Call-back detection: jobType === 'CALL BACK', OR same client within 30 days
  // of that client's previously COMPLETED job.
  const DAY = 86400000;
  const byClient = new Map<number, Job[]>();
  for (const j of jobs) {
    const arr = byClient.get(j.clientId) ?? [];
    arr.push(j);
    byClient.set(j.clientId, arr);
  }
  for (const arr of byClient.values()) {
    arr.sort((a, b) => a.jobDate.getTime() - b.jobDate.getTime());
    let lastCompleted: number | null = null;
    for (const j of arr) {
      if (j.jobType === 'CALL BACK') { j.isCallback = true; j.callbackReason = 'CALL BACK type'; }
      else if (lastCompleted != null && j.jobDate.getTime() - lastCompleted > 0 && j.jobDate.getTime() - lastCompleted <= 30 * DAY) { j.isCallback = true; j.callbackReason = 'Repeat under 30d'; }
      if (j.status === 'Done') lastCompleted = (j.completedAt ?? j.jobDate).getTime();
    }
  }
  return jobs;
}

const JOBS = buildJobs();

const money2 = (n: number) => formatCurrencyWhole(n);
const money0 = (n: number) => formatCurrencyWhole(n);
const pct1 = (n: number) => `${(n * 100).toFixed(n === 0 ? 0 : 1)}%`;
const fmtDate2 = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Call-back rate per month over the last 12 months (independent of the top date
// scope, so it always shows the long-term trend). Optionally filtered to a tech.
function callbackTrend(allJobs: Job[], now: Date, techFilter: string | null, typeFilter: string) {
  const out: { month: string; rate: number; all: number; callbacks: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const js = allJobs.filter((j) => (!techFilter || j.tech === techFilter) && (typeFilter === 'all' || j.jobType === typeFilter) && j.jobDate.getFullYear() === dt.getFullYear() && j.jobDate.getMonth() === dt.getMonth());
    const all = js.length;
    const callbacks = js.filter((j) => j.isCallback).length;
    out.push({ month: dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), rate: all ? Math.round((callbacks / all) * 1000) / 10 : 0, all, callbacks });
  }
  return out;
}

interface Agg {
  key: string;
  all: number;
  done: number;
  open: number;
  canceled: number;
  canceledPct: number;
  gross: number;
  profit: number;
  labor: number;
  techExp: number;
  avgSale: number;
  avgProfit: number;
}

function aggregate(key: string, js: Job[]): Agg {
  const all = js.length;
  const done = js.filter((j) => j.status === 'Done').length;
  const canceled = js.filter((j) => j.status === 'Canceled').length;
  const open = all - done - canceled;
  const gross = js.reduce((s, j) => s + j.gross, 0);
  const profit = js.reduce((s, j) => s + j.profit, 0);
  const labor = js.reduce((s, j) => s + j.laborCost, 0);
  const techExp = js.reduce((s, j) => s + j.techExpenses, 0);
  return {
    key, all, done, open, canceled,
    canceledPct: all ? canceled / all : 0,
    gross, profit, labor, techExp,
    avgSale: done ? gross / done : 0,
    avgProfit: done ? profit / done : 0,
  };
}

function groupBy(js: Job[], keyFn: (j: Job) => string): Agg[] {
  const m = new Map<string, Job[]>();
  for (const j of js) {
    const k = keyFn(j);
    const arr = m.get(k) ?? [];
    arr.push(j);
    m.set(k, arr);
  }
  return Array.from(m, ([k, arr]) => aggregate(k, arr)).sort((a, b) => b.gross - a.gross);
}

type StatColKey = keyof Omit<Agg, 'key'> | 'key';
interface Col {
  key: StatColKey;
  label: string;
  money?: boolean;
  pct?: boolean;
  align?: 'left' | 'right';
  width: number;
  min: number;
}

function StatsTable({ rows, groupLabel, costCols }: { rows: Agg[]; groupLabel: string; costCols?: boolean }) {
  const cols: Col[] = [
    { key: 'key', label: groupLabel, align: 'left', width: 200, min: 160 },
    { key: 'all', label: 'All Jobs', align: 'right', width: 110, min: 95 },
    { key: 'done', label: 'Done Jobs', align: 'right', width: 110, min: 95 },
    { key: 'open', label: 'Open Jobs', align: 'right', width: 110, min: 95 },
    { key: 'canceled', label: 'Canceled Jobs', align: 'right', width: 130, min: 110 },
    { key: 'canceledPct', label: 'Canceled %', pct: true, align: 'right', width: 120, min: 105 },
    { key: 'gross', label: 'Gross Amount', money: true, align: 'right', width: 140, min: 120 },
    { key: 'profit', label: 'Profit', money: true, align: 'right', width: 120, min: 105 },
    ...(costCols
      ? ([
          { key: 'labor', label: 'Labor Cost', money: true, align: 'right', width: 130, min: 110 },
          { key: 'techExp', label: 'Tech Expenses', money: true, align: 'right', width: 140, min: 120 },
        ] as Col[])
      : []),
    { key: 'avgSale', label: 'Average Sale', money: true, align: 'right', width: 140, min: 120 },
    { key: 'avgProfit', label: 'Average Profit', money: true, align: 'right', width: 140, min: 120 },
  ];

  const cell = (c: Col, r: Agg) => {
    const v = r[c.key];
    if (c.key === 'key') return <span className="font-medium">{r.key}</span>;
    if (c.pct) return <span className="tabular-nums">{pct1(v as number)}</span>;
    if (c.money) return <span className="tabular-nums">{money2(v as number)}</span>;
    return <span className="tabular-nums">{String(v)}</span>;
  };

  return (
    <ReportTable<Agg>
      rows={rows}
      getRowKey={(r) => r.key}
      empty={<EmptyState title="No jobs in this range." />}
      columns={cols.map((c) => ({
        id: c.key,
        header: c.label,
        cell: (r) => cell(c, r),
        sortValue: (r) => r[c.key],
        width: c.width,
        min: c.min,
        align: c.align,
      }))}
    />
  );
}

function PiePair({ leftTitle, left, rightTitle, right }: { leftTitle: string; left: { name: string; value: number }[]; rightTitle: string; right: { name: string; value: number }[] }) {
  // One colour per NAME across BOTH pies, so a source reads the same in "by
  // count" and "by sales". Do not localise this to a single pie.
  const names = Array.from(new Set([...left, ...right].map((d) => d.name)));
  const color = (n: string) => PALETTE[names.indexOf(n) % PALETTE.length];
  const pie = (title: string, data: { name: string; value: number }[]) => (
    <ChartCard>
      <ReportHeading level={3} className="mb-2 text-center">{title}</ReportHeading>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie data={data.filter((d) => d.value > 0)} dataKey="value" nameKey="name" outerRadius={100} label={false} isAnimationActive={false}>
            {data.filter((d) => d.value > 0).map((d) => (
              <Cell key={d.name} fill={color(d.name)} />
            ))}
          </Pie>
          <Tooltip formatter={(v: number) => v.toLocaleString('en-US')} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {pie(leftTitle, left)}
      {pie(rightTitle, right)}
    </div>
  );
}

interface TechQuality { tech: string; all: number; done: number; callbacks: number; callbackPct: number; ftf: number; ftfPct: number; avgHours: number }

function techQuality(js: Job[]): TechQuality[] {
  const m = new Map<string, Job[]>();
  for (const j of js) {
    const arr = m.get(j.tech) ?? [];
    arr.push(j);
    m.set(j.tech, arr);
  }
  return Array.from(m, ([tech, arr]) => {
    const all = arr.length;
    const doneJobs = arr.filter((j) => j.status === 'Done');
    const done = doneJobs.length;
    const callbacks = arr.filter((j) => j.isCallback).length;
    const ftf = doneJobs.filter((j) => j.singleVisit && !j.isCallback).length;
    const avgHours = done ? doneJobs.reduce((s, j) => s + j.completionHours, 0) / done : 0;
    return { tech, all, done, callbacks, callbackPct: all ? callbacks / all : 0, ftf, ftfPct: done ? ftf / done : 0, avgHours };
  });
}

function QualityBar({ data, color, fmt }: { data: { name: string; value: number }[]; color: string; fmt: (v: number) => string }) {
  return (
    <ChartCard>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="vertical" margin={{ left: 24, right: 48 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} tickFormatter={fmt} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v: number) => fmt(v)} />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={18} fill={color} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

type Gran = 'day' | 'week' | 'month';

function overviewBuckets(js: Job[], gran: Gran) {
  const m = new Map<string, { label: string; t: number; Jobs: number; Canceled: number; Sales: number; Profit: number }>();
  for (const j of js) {
    const d = j.jobDate;
    let t: number;
    let label: string;
    if (gran === 'day') {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      t = day.getTime();
      label = day.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    } else if (gran === 'week') {
      const wd = (d.getDay() + 6) % 7;
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
      t = start.getTime();
      label = start.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
    } else {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      t = start.getTime();
      label = start.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
    const cur = m.get(label) ?? { label, t, Jobs: 0, Canceled: 0, Sales: 0, Profit: 0 };
    if (j.status === 'Canceled') cur.Canceled += 1;
    else cur.Jobs += 1;
    cur.Sales += j.gross;
    cur.Profit += j.profit;
    m.set(label, cur);
  }
  return Array.from(m.values()).sort((a, b) => a.t - b.t);
}

type Preset = 'week' | '7d' | 'month' | 'lastMonth' | 'year' | 'all' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  week: 'This week (Mon-Today)', '7d': 'Last 7 days', month: 'This month', lastMonth: 'Last month', year: 'This year', all: 'All time', custom: 'Custom',
};

function presetRange(p: Preset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  if (p === 'custom') {
    const from = customFrom ? new Date(customFrom + 'T00:00:00') : null;
    const to = customTo ? new Date(customTo + 'T23:59:59.999') : null;
    return { from, to };
  }
  const now = new Date();
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  switch (p) {
    case 'week': { const day = (now.getDay() + 6) % 7; start.setDate(now.getDate() - day); return { from: start, to: end }; }
    case '7d': start.setDate(now.getDate() - 6); return { from: start, to: end };
    case 'month': start.setDate(1); return { from: start, to: end };
    case 'lastMonth': return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999) };
    case 'year': return { from: new Date(now.getFullYear(), 0, 1), to: end };
    default: return { from: null, to: null };
  }
}

type DateField = 'jobDate' | 'completedAt';
const DATE_FIELD_LABEL: Record<DateField, string> = { jobDate: 'Job date', completedAt: 'Completed' };

const TABS = ['Jobs overview', 'Sources', 'By Job Type', 'Tech Performance', 'Call Back Rate', 'First-Time Fix', 'Avg Completion Time', 'Area Performance', 'Dispatcher Performance'] as const;
type Tab = (typeof TABS)[number];

/** The job-type narrowing control the three quality tabs share. */
function JobTypeFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={id} className="text-muted-foreground text-sm font-medium">Job type:</Label>
      <SelectField
        value={value}
        onValueChange={onChange}
        id={id}
        aria-label="Job type"
        size="sm"
        className="w-[200px]"
        options={[
          { value: 'all', label: 'All job types' },
          ...JOB_TYPES.map((t) => ({ value: t, label: t })),
        ]}
      />
    </div>
  );
}

export default function JobStatisticsReport() {
  const report = findReport('job-statistics')!;
  const [tab, setTab] = useState<Tab>('Jobs overview');
  const [preset, setPreset] = useState<Preset>('month');
  const [dateField, setDateField] = useState<DateField>('jobDate');
  const [gran, setGran] = useState<Gran>('day');

  const now = new Date();
  const defaultFrom = new Date(now); defaultFrom.setDate(now.getDate() - 30);
  const [customFrom, setCustomFrom] = useState(defaultFrom.toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(now.toISOString().slice(0, 10));

  const range = useMemo(() => presetRange(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const filtered = useMemo(() => {
    return JOBS.filter((j) => {
      const d = j[dateField];
      if (range.from && (!d || d < range.from)) return false;
      if (range.to && (!d || d > range.to)) return false;
      return true;
    });
  }, [range, dateField]);

  const kpis = useMemo(() => {
    const by = (s: Status) => filtered.filter((j) => j.status === s).length;
    return {
      done: by('Done'),
      submitted: by('Submitted'),
      inProgress: by('In progress'),
      canceled: by('Canceled'),
      sales: filtered.reduce((s, j) => s + j.gross, 0),
      profit: filtered.reduce((s, j) => s + j.profit, 0),
    };
  }, [filtered]);

  const buckets = useMemo(() => overviewBuckets(filtered, gran), [filtered, gran]);
  // Quality tabs (Call Back / First-Time Fix / Avg Completion) compute per-tech
  // over the last 12 months, optionally narrowed to one job type so the
  // job-type comparison has enough data to name a best performer.
  const [selTech, setSelTech] = useState<string | null>(null);
  const [cbType, setCbType] = useState<string>('all');
  const [ftfType, setFtfType] = useState<string>('all');
  const [actType, setActType] = useState<string>('all');

  const twelveMoSrc = (type: string) => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    return JOBS.filter((j) => j.jobDate >= cutoff && (type === 'all' || j.jobType === type));
  };

  // Call Back: lower is better -> best first (ascending rate).
  const cbRows = useMemo(() => techQuality(twelveMoSrc(cbType)).filter((t) => t.all > 0).sort((a, b) => a.callbackPct - b.callbackPct), [cbType]);
  // First-Time Fix: higher is better -> best first (descending rate).
  const ftfRows = useMemo(() => techQuality(twelveMoSrc(ftfType)).filter((t) => t.done > 0).sort((a, b) => b.ftfPct - a.ftfPct), [ftfType]);
  // Avg Completion: lower is better -> fastest first.
  const actRows = useMemo(() => techQuality(twelveMoSrc(actType)).filter((t) => t.done > 0).sort((a, b) => a.avgHours - b.avgHours), [actType]);

  // Top performers (the badge tracks the actual best tech, not the rendered
  // row order, since the table can re-sort the rows).
  const bestCbTech = cbRows[0]?.tech;
  const bestFtfTech = ftfRows[0]?.tech;
  const bestActTech = actRows[0]?.tech;

  const cbTrend = useMemo(() => callbackTrend(JOBS, new Date(), selTech, cbType), [selTech, cbType]);
  const cbHistory = useMemo(() => {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    return JOBS.filter((j) => j.isCallback && j.jobDate >= cutoff && (!selTech || j.tech === selTech) && (cbType === 'all' || j.jobType === cbType)).sort((a, b) => b.jobDate.getTime() - a.jobDate.getTime());
  }, [selTech, cbType]);

  const segBtn = (g: Gran, label: string) => (
    <Button
      type="button"
      role="radio"
      aria-checked={gran === g}
      variant={gran === g ? 'default' : 'ghost'}
      size="sm"
      onClick={() => setGran(g)}
    >
      {label}
    </Button>
  );

  return (
    <ReportShell
      report={report}
      actions={
        <DateRangeControl
          presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
          preset={preset}
          onPreset={(k) => setPreset(k as Preset)}
          from={range.from}
          to={range.to}
          fields={(Object.keys(DATE_FIELD_LABEL) as DateField[]).map((k) => ({ key: k, label: DATE_FIELD_LABEL[k] }))}
          field={dateField}
          onField={(k) => setDateField(k as DateField)}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
      }
    >
      <TabStrip
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        tabs={TABS.map((t) => ({ value: t, label: t }))}
      />

      <TabPanel value="Jobs overview" activeValue={tab}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
          <div className="space-y-4">
            <Card>
              <div className="mb-3 flex items-center justify-end">
                <div role="radiogroup" aria-label="Granularity" className="flex items-center gap-1">
                  {segBtn('day', 'Day')}
                  {segBtn('week', 'Week')}
                  {segBtn('month', 'Month')}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={buckets} margin={{ left: 4, right: 8, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Jobs" fill={token('--primary')} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Canceled" fill={token('--danger')} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
            <ChartCard>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={buckets} margin={{ left: 4, right: 8, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v: number) => money0(v)} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={84} />
                  <Tooltip formatter={(v: number) => money0(v)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Sales" fill={token('--primary')} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Profit" fill={token('--success')} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
          {/* KPI rail */}
          <Card>
            {[
              { n: kpis.done, l: 'Jobs Done' },
              { n: kpis.submitted, l: 'Jobs Submitted' },
              { n: kpis.inProgress, l: 'Jobs In Progress' },
              { n: kpis.canceled, l: 'Jobs Canceled' },
            ].map((k) => (
              <div key={k.l} className="flex items-baseline gap-3 py-4">
                <span className="text-3xl font-bold tabular-nums">{k.n}</span>
                <span className="text-muted-foreground text-sm">{k.l}</span>
              </div>
            ))}
            <div className="py-4">
              <div className="text-3xl font-bold tabular-nums">{money2(kpis.sales)}</div>
              <div className="text-muted-foreground text-sm">Total Sales</div>
            </div>
            <div className="py-4">
              <div className="text-status-green-emphasis text-3xl font-bold tabular-nums">{money2(kpis.profit)}</div>
              <div className="text-muted-foreground text-sm">Total Profit</div>
            </div>
          </Card>
        </div>
      </TabPanel>

      <TabPanel value="Sources" activeValue={tab}>
        <div className="space-y-4">
          <PiePair
            leftTitle="By Job Count"
            left={groupBy(filtered, (j) => j.source).map((g) => ({ name: g.key, value: g.all }))}
            rightTitle="By Sales Amount"
            right={groupBy(filtered, (j) => j.source).map((g) => ({ name: g.key, value: g.gross }))}
          />
          <StatsTable rows={groupBy(filtered, (j) => j.source)} groupLabel="Job Source" />
        </div>
      </TabPanel>

      <TabPanel value="By Job Type" activeValue={tab}>
        <StatsTable rows={groupBy(filtered, (j) => j.jobType)} groupLabel="Job Type" />
      </TabPanel>

      <TabPanel value="Tech Performance" activeValue={tab}>
        <StatsTable rows={groupBy(filtered, (j) => j.tech)} groupLabel="Tech" costCols />
      </TabPanel>

      <TabPanel value="Call Back Rate" activeValue={tab}>
        <div className="space-y-4">
          <JobTypeFilter id="jobstats-cb-type" value={cbType} onChange={setCbType} />
          {cbRows.length > 0 && (
            <div className="bg-status-green-subtle text-status-green-emphasis rounded-lg border px-4 py-3 text-sm">
              <span className="font-semibold">🏆 Lowest call-back rate{cbType !== 'all' ? ` on ${cbType}` : ''}: {cbRows[0]!.tech}</span>
              <span> - {pct1(cbRows[0]!.callbackPct)} ({cbRows[0]!.callbacks}/{cbRows[0]!.all} jobs)</span>
            </div>
          )}

          {/* 12-month trend - are we getting better or worse? */}
          <Card>
            <ReportHeading level={3} className="mb-1">
              Call-back rate trend - last 12 months {selTech ? <span className="text-brand">· {selTech}</span> : <span className="text-muted-foreground">· all techs</span>}{cbType !== 'all' && <span className="text-muted-foreground"> · {cbType}</span>}
            </ReportHeading>
            <p className="text-muted-foreground mb-3 text-xs">Lower is better. (Always shows 12 months, regardless of the date filter above.)</p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={cbTrend} margin={{ left: 4, right: 12, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} width={40} domain={[0, 'auto']} />
                <Tooltip formatter={(v: number, _n, p) => [`${v}%`, `${(p?.payload?.callbacks ?? 0)}/${(p?.payload?.all ?? 0)} jobs`]} />
                <Line type="monotone" dataKey="rate" stroke={token('--danger')} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <QualityBar data={cbRows.map((t) => ({ name: t.tech, value: Math.round(t.callbackPct * 1000) / 10 }))} color={token('--danger')} fmt={(v) => `${v}%`} />

          {/* Click a row to drill into that tech. */}
          <ReportTable
            rows={cbRows}
            getRowKey={(t) => t.tech}
            empty={<EmptyState title="No call-back data for this period." />}
            onRowClick={(t) => setSelTech(selTech === t.tech ? null : t.tech)}
            columns={[
              {
                id: 'tech', header: 'Tech', width: 220, min: 170, sortValue: (t) => t.tech,
                cell: (t) => (
                  <span className="font-medium">
                    {t.tech}
                    {bestCbTech === t.tech && <Badge variant="softGreen" size="sm" className="ml-2">Best</Badge>}
                  </span>
                ),
              },
              { id: 'all', header: 'All Jobs', align: 'right', width: 110, min: 95, sortValue: (t) => t.all, cell: (t) => <span className="tabular-nums">{t.all}</span> },
              { id: 'callbacks', header: 'Call Backs', align: 'right', width: 120, min: 105, sortValue: (t) => t.callbacks, cell: (t) => <span className="tabular-nums">{t.callbacks}</span> },
              { id: 'callbackPct', header: 'Call Back Rate', align: 'right', width: 140, min: 120, sortValue: (t) => t.callbackPct, cell: (t) => <span className="text-status-red-emphasis font-semibold tabular-nums">{pct1(t.callbackPct)}</span> },
            ]}
          />

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <ReportHeading level={3}>
                Call-back jobs · last 12 months {selTech ? <span className="text-brand">- {selTech}</span> : ''}{' '}
                <span className="text-muted-foreground font-normal">({cbHistory.length})</span>
              </ReportHeading>
              {selTech && (
                <Button type="button" variant="link" size="sm" onClick={() => setSelTech(null)}>
                  Show all techs
                </Button>
              )}
            </div>
            <ReportTable
              rows={cbHistory}
              getRowKey={(j) => String(j.id)}
              empty={<EmptyState title="No call-backs in this period." />}
              columns={[
                { id: 'id', header: 'Job ID', width: 110, min: 95, sortValue: (j) => j.id, cell: (j) => <span className="text-status-blue-emphasis font-medium tabular-nums">{j.id}</span> },
                { id: 'date', header: 'Date', width: 150, min: 130, sortValue: (j) => j.jobDate.getTime(), cell: (j) => <span className="text-muted-foreground whitespace-nowrap">{fmtDate2(j.jobDate)}</span> },
                { id: 'client', header: 'Client', width: 170, min: 140, sortValue: (j) => j.clientName, cell: (j) => <span>{j.clientName}</span> },
                { id: 'tech', header: 'Tech', width: 160, min: 130, sortValue: (j) => j.tech, cell: (j) => <span>{j.tech}</span> },
                { id: 'jobType', header: 'Job Type', width: 160, min: 130, sortValue: (j) => j.jobType, cell: (j) => <span>{j.jobType}</span> },
                { id: 'status', header: 'Status', width: 120, min: 105, sortValue: (j) => j.status, cell: (j) => <span className="text-muted-foreground">{j.status}</span> },
                {
                  id: 'reason', header: 'Reason', width: 150, min: 130, sortValue: (j) => j.callbackReason,
                  cell: (j) => (
                    <Badge variant={j.callbackReason === 'CALL BACK type' ? 'softRed' : 'softAmber'} size="pill">
                      {j.callbackReason}
                    </Badge>
                  ),
                },
              ]}
            />
          </div>

          <p className="text-muted-foreground text-xs">
            Call-back = job type &quot;CALL BACK&quot;, or a repeat for the same client within 30 days of a completed job.
            Lower is better. Click a tech row to drill into that tech&apos;s trend and history.
          </p>
        </div>
      </TabPanel>

      <TabPanel value="First-Time Fix" activeValue={tab}>
        <div className="space-y-4">
          <JobTypeFilter id="jobstats-ftf-type" value={ftfType} onChange={setFtfType} />
          {ftfRows.length > 0 ? (
            <div className="bg-status-green-subtle text-status-green-emphasis rounded-lg border px-4 py-3 text-sm">
              <span className="font-semibold">🏆 Best first-time-fix{ftfType !== 'all' ? ` on ${ftfType}` : ''}: {ftfRows[0]!.tech}</span>
              <span> - {pct1(ftfRows[0]!.ftfPct)} ({ftfRows[0]!.ftf}/{ftfRows[0]!.done} done jobs)</span>
            </div>
          ) : (
            <div className="bg-muted text-muted-foreground rounded-lg border px-4 py-3 text-sm">
              No completed jobs{ftfType !== 'all' ? ` for "${ftfType}"` : ''} in the last 12 months.
            </div>
          )}

          {ftfRows.length > 0 && (
            <>
              <QualityBar data={ftfRows.map((t) => ({ name: t.tech, value: Math.round(t.ftfPct * 1000) / 10 }))} color={token('--success')} fmt={(v) => `${v}%`} />
              <ReportTable
                rows={ftfRows}
                getRowKey={(t) => t.tech}
                empty={<EmptyState title="No completed jobs in this period." />}
                columns={[
                  {
                    id: 'tech', header: 'Tech', width: 220, min: 170, sortValue: (t) => t.tech,
                    cell: (t) => (
                      <span className="font-medium">
                        {t.tech}
                        {bestFtfTech === t.tech && <Badge variant="softGreen" size="sm" className="ml-2">Best</Badge>}
                      </span>
                    ),
                  },
                  { id: 'done', header: 'Done Jobs', align: 'right', width: 120, min: 105, sortValue: (t) => t.done, cell: (t) => <span className="tabular-nums">{t.done}</span> },
                  { id: 'ftf', header: 'First-Time Fixes', align: 'right', width: 150, min: 130, sortValue: (t) => t.ftf, cell: (t) => <span className="tabular-nums">{t.ftf}</span> },
                  { id: 'ftfPct', header: 'First-Time Fix Rate', align: 'right', width: 170, min: 140, sortValue: (t) => t.ftfPct, cell: (t) => <span className="text-status-green-emphasis font-semibold tabular-nums">{pct1(t.ftfPct)}</span> },
                ]}
              />
            </>
          )}
          <p className="text-muted-foreground text-xs">
            First-time fix = job completed on the first visit (single visit, not a call-back), over the last 12 months.
            Higher is better - the top of the list is your best performer.
          </p>
        </div>
      </TabPanel>

      <TabPanel value="Avg Completion Time" activeValue={tab}>
        <div className="space-y-4">
          <JobTypeFilter id="jobstats-act-type" value={actType} onChange={setActType} />

          {actRows.length > 0 ? (
            <div className="bg-status-green-subtle text-status-green-emphasis rounded-lg border px-4 py-3 text-sm">
              <span className="font-semibold">🏆 Fastest{actType !== 'all' ? ` on ${actType}` : ''}: {actRows[0]!.tech}</span>
              <span> - {actRows[0]!.avgHours.toFixed(1)}h avg over {actRows[0]!.done} done job{actRows[0]!.done !== 1 ? 's' : ''}</span>
            </div>
          ) : (
            <div className="bg-muted text-muted-foreground rounded-lg border px-4 py-3 text-sm">
              No completed jobs{actType !== 'all' ? ` for "${actType}"` : ''} in this period.
            </div>
          )}

          {actRows.length > 0 && (
            <>
              <QualityBar data={actRows.map((t) => ({ name: t.tech, value: Math.round(t.avgHours * 10) / 10 }))} color={token('--primary')} fmt={(v) => `${v}h`} />
              <ReportTable
                rows={actRows}
                getRowKey={(t) => t.tech}
                empty={<EmptyState title="No completed jobs in this period." />}
                columns={[
                  {
                    id: 'tech', header: 'Tech', width: 240, min: 180, sortValue: (t) => t.tech,
                    cell: (t) => (
                      <span className="font-medium">
                        {t.tech}
                        {bestActTech === t.tech && <Badge variant="softGreen" size="sm" className="ml-2">Fastest</Badge>}
                      </span>
                    ),
                  },
                  { id: 'done', header: 'Done Jobs', align: 'right', width: 130, min: 110, sortValue: (t) => t.done, cell: (t) => <span className="tabular-nums">{t.done}</span> },
                  { id: 'avgHours', header: 'Avg Completion (hrs)', align: 'right', width: 180, min: 150, sortValue: (t) => t.avgHours, cell: (t) => <span className="font-semibold tabular-nums">{t.avgHours.toFixed(1)}</span> },
                ]}
              />
            </>
          )}
          <p className="text-muted-foreground text-xs">
            Average hours from start to done over the last 12 months, for completed jobs{actType !== 'all' ? ` of type "${actType}"` : ''}.
            Lower is faster - the top of the list is your best performer. (This tab uses a 12-month window so per-job-type
            comparisons have enough data.)
          </p>
        </div>
      </TabPanel>

      <TabPanel value="Area Performance" activeValue={tab}>
        <StatsTable rows={groupBy(filtered, (j) => j.area)} groupLabel="Area" />
      </TabPanel>

      <TabPanel value="Dispatcher Performance" activeValue={tab}>
        <div className="space-y-4">
          <PiePair
            leftTitle="By Sales Amount"
            left={groupBy(filtered, (j) => j.dispatcher).map((g) => ({ name: g.key, value: g.gross }))}
            rightTitle="By Jobs Done"
            right={groupBy(filtered, (j) => j.dispatcher).map((g) => ({ name: g.key, value: g.done }))}
          />
          <StatsTable rows={groupBy(filtered, (j) => j.dispatcher)} groupLabel="Dispatcher" />
        </div>
      </TabPanel>

      <p className="text-muted-foreground text-xs">
        Sample data shown so the layout is reviewable without a backend. Once connected, this wires to{' '}
        <code className="bg-muted rounded px-1">GET /api/jobs</code> with the same date scope and groupings.
      </p>
    </ReportShell>
  );
}

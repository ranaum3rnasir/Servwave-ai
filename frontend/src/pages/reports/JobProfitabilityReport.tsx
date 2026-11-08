// ───────────────────────────────────────────────────────────────────────────
// F1 — Job Profitability / Job Costing (Wave 1, highest-value Finance report)
// Per-job gross margin after materials, equipment, POs, labor pay, labor burden,
// commissions and misc. Margin-heat table + revenue-vs-GM% scatter.
//
// Deterministic MOCK data so it renders without a backend. Wire to
// GET /api/reports/job-profitability later (replace JOBS); the view stays.
// ───────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';
import { DollarSign, Wallet, PiggyBank, Percent, Boxes, Wrench } from 'lucide-react';
import { KpiStrip, type KpiTone } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard } from '@/components/charts';
import { token } from '@/design-system';
import { formatCurrencyWhole } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { ReportToolbar } from './_shared';

type BU = 'HVAC' | 'Plumbing' | 'Electrical';
type Status = 'completed' | 'in-progress';

interface Job {
  id: string;
  customer: string;
  jobType: string;
  bu: BU;
  status: Status;
  revenue: number;
  materials: number;
  equipment: number;
  pos: number; // purchase orders
  laborPay: number;
  laborBurden: number; // overhead per tech-hour
  commissions: number;
  misc: number;
}

const money0 = (n: number) => formatCurrencyWhole(n);
const pct = (n: number) => `${Math.round(n)}%`;

// GM% color band — simplified vs catalog benchmarks (HVAC install 35–45, service 50–65).
// Semantic data signal: healthy = success, watch = warning, thin = danger.
function band(gmPct: number): { tone: KpiTone; chip: string; hex: string } {
  if (gmPct >= 50) return { tone: 'success', chip: 'bg-success/10 text-success', hex: token('--success') };
  if (gmPct >= 35) return { tone: 'warning', chip: 'bg-warning/10 text-warning', hex: token('--warning') };
  return { tone: 'danger', chip: 'bg-danger/10 text-danger', hex: token('--danger') };
}

const JOBS: Job[] = [
  { id: 'J10002', customer: 'Carter, Dee', jobType: 'AC Replacement', bu: 'HVAC', status: 'completed', revenue: 12800, materials: 3900, equipment: 2600, pos: 400, laborPay: 1400, laborBurden: 700, commissions: 640, misc: 160 },
  { id: 'J10005', customer: 'Nguyen, Bao', jobType: 'Furnace Install', bu: 'HVAC', status: 'completed', revenue: 9600, materials: 3200, equipment: 2100, pos: 250, laborPay: 1200, laborBurden: 600, commissions: 480, misc: 120 },
  { id: 'J10008', customer: 'Webb, Ian', jobType: 'Panel Upgrade', bu: 'Electrical', status: 'completed', revenue: 5400, materials: 900, equipment: 300, pos: 120, laborPay: 700, laborBurden: 350, commissions: 270, misc: 90 },
  { id: 'J10011', customer: 'Hayes, Victor', jobType: 'Water Heater', bu: 'Plumbing', status: 'completed', revenue: 3200, materials: 1100, equipment: 200, pos: 80, laborPay: 520, laborBurden: 260, commissions: 160, misc: 60 },
  { id: 'J10013', customer: 'Flores, Ana', jobType: 'Drain Service', bu: 'Plumbing', status: 'completed', revenue: 1450, materials: 220, equipment: 0, pos: 0, laborPay: 320, laborBurden: 160, commissions: 70, misc: 40 },
  { id: 'J10015', customer: 'Shaw, Greg', jobType: 'AC Repair', bu: 'HVAC', status: 'completed', revenue: 980, materials: 240, equipment: 0, pos: 0, laborPay: 360, laborBurden: 180, commissions: 0, misc: 30 },
  { id: 'J10017', customer: 'Vega, Lia', jobType: 'Rewire', bu: 'Electrical', status: 'completed', revenue: 7200, materials: 1500, equipment: 400, pos: 300, laborPay: 1600, laborBurden: 800, commissions: 360, misc: 140 },
  { id: 'J10018', customer: 'Bauer, Cole', jobType: 'Repipe', bu: 'Plumbing', status: 'in-progress', revenue: 8800, materials: 3600, equipment: 600, pos: 500, laborPay: 1900, laborBurden: 950, commissions: 0, misc: 200 },
  { id: 'J10021', customer: 'Diaz, Mara', jobType: 'AC Replacement', bu: 'HVAC', status: 'completed', revenue: 11200, materials: 4800, equipment: 2400, pos: 600, laborPay: 1500, laborBurden: 750, commissions: 560, misc: 180 },
  { id: 'J10024', customer: 'Pope, Neil', jobType: 'Lighting Retrofit', bu: 'Electrical', status: 'in-progress', revenue: 4100, materials: 700, equipment: 200, pos: 100, laborPay: 900, laborBurden: 450, commissions: 0, misc: 80 },
];

function cost(j: Job) {
  return j.materials + j.equipment + j.pos + j.laborPay + j.laborBurden + j.commissions + j.misc;
}

type Row = Job & { totalCost: number; gm: number; gmPct: number };

const JOB_TYPES = Array.from(new Set(JOBS.map((j) => j.jobType)));

export default function JobProfitabilityReport() {
  const report = findReport('job-profitability')!;
  const [bu, setBu] = useState<BU | 'all'>('all');
  const [jobType, setJobType] = useState<string>('all');
  const [status, setStatus] = useState<Status | 'all'>('all');

  const rows = useMemo(
    () =>
      JOBS.filter((j) => bu === 'all' || j.bu === bu)
        .filter((j) => jobType === 'all' || j.jobType === jobType)
        .filter((j) => status === 'all' || j.status === status)
        .map((j) => {
          const totalCost = cost(j);
          const gm = j.revenue - totalCost;
          return { ...j, totalCost, gm, gmPct: j.revenue ? (gm / j.revenue) * 100 : 0 };
        })
        .sort((a, b) => a.gmPct - b.gmPct),
    [bu, jobType, status],
  );

  const t = useMemo(() => {
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
    const materials = rows.reduce((s, r) => s + r.materials + r.equipment + r.pos, 0);
    const labor = rows.reduce((s, r) => s + r.laborPay + r.laborBurden, 0);
    const gm = revenue - totalCost;
    return {
      revenue, totalCost, gm,
      gmPct: revenue ? (gm / revenue) * 100 : 0,
      matPct: revenue ? (materials / revenue) * 100 : 0,
      laborPct: revenue ? (labor / revenue) * 100 : 0,
    };
  }, [rows]);

  function exportCsv() {
    exportCsvFile(
      'job-profitability.csv',
      ['Job', 'Customer', 'Type', 'BU', 'Status', 'Revenue', 'Cost', 'Gross Margin', 'GM %'],
      rows.map((r) => [r.id, r.customer, r.jobType, r.bu, r.status, r.revenue, r.totalCost, r.gm, `${Math.round(r.gmPct)}%`]),
    );
  }

  const scatterData = rows.map((r) => ({ x: r.revenue, y: Math.round(r.gmPct), z: r.totalCost, name: r.id, hex: band(r.gmPct).hex }));

  return (
    <ReportShell
      report={report}
      actions={<ReportToolbar variant="compact" onExport={exportCsv} />}
    >
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <SelectField
          aria-label="Business unit"
          value={bu}
          onValueChange={(v) => setBu(v as BU | 'all')}
          className="h-9"
          options={[
            { value: 'all', label: 'All business units' },
            { value: 'HVAC', label: 'HVAC' },
            { value: 'Plumbing', label: 'Plumbing' },
            { value: 'Electrical', label: 'Electrical' },
          ]}
        />
        <SelectField
          aria-label="Job type"
          value={jobType}
          onValueChange={setJobType}
          className="h-9"
          options={[
            { value: 'all', label: 'All job types' },
            ...JOB_TYPES.map((jt) => ({ value: jt, label: jt })),
          ]}
        />
        <SelectField
          aria-label="Status"
          value={status}
          onValueChange={(v) => setStatus(v as Status | 'all')}
          className="h-9"
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'completed', label: 'Completed' },
            { value: 'in-progress', label: 'In progress' },
          ]}
        />
        <span className="ml-auto rounded-md bg-background-light px-2 py-1 text-xs text-text-secondary">
          Sample data · cost = materials + equipment + POs + labor + burden + commission
        </span>
      </div>

      {/* KPIs */}
      <KpiStrip
        items={[
          { icon: DollarSign, label: 'Revenue', value: money0(t.revenue), tone: 'neutral' },
          { icon: Wallet, label: 'Total Cost', value: money0(t.totalCost), tone: 'danger' },
          { icon: PiggyBank, label: 'Gross Margin', value: money0(t.gm), tone: 'success', emphasize: true },
          { icon: Percent, label: 'GM %', value: pct(t.gmPct), tone: band(t.gmPct).tone, emphasize: true },
          { icon: Boxes, label: 'Material %', value: pct(t.matPct), tone: 'warning' },
          { icon: Wrench, label: 'Labor %', value: pct(t.laborPct), tone: 'warning' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Margin-heat table */}
        <ChartCard
          className="lg:col-span-3"
          title="Job margin heat"
          subtitle="Lowest margin first — money losers surface at the top"
        >
          <ResizableTable<Row>
            rows={rows}
            getRowKey={(r) => r.id}
            empty={<EmptyState title="No jobs match these filters." />}
            columns={[
              {
                id: 'job',
                header: 'Job',
                width: 170,
                min: 150,
                sortValue: (r) => r.id,
                cell: (r) => (
                  <div className="min-w-0">
                    <div className="font-medium text-text-primary">{r.id}</div>
                    <div className="truncate text-xs text-text-secondary">{r.customer}{r.status === 'in-progress' ? ' · in progress' : ''}</div>
                  </div>
                ),
                footer: <span>Total · {rows.length} job{rows.length === 1 ? '' : 's'}</span>,
              },
              {
                id: 'jobType',
                header: 'Type',
                width: 150,
                min: 130,
                sortValue: (r) => r.jobType,
                cell: (r) => <span className="truncate text-text-secondary">{r.jobType}</span>,
              },
              {
                id: 'revenue',
                header: 'Revenue',
                width: 110,
                min: 100,
                align: 'right',
                sortValue: (r) => r.revenue,
                cell: (r) => <span className="tabular-nums">{money0(r.revenue)}</span>,
                footer: <span className="tabular-nums">{money0(t.revenue)}</span>,
              },
              {
                id: 'cost',
                header: 'Cost',
                width: 110,
                min: 100,
                align: 'right',
                sortValue: (r) => r.totalCost,
                cell: (r) => <span className="tabular-nums text-text-secondary">{money0(r.totalCost)}</span>,
                footer: <span className="tabular-nums">{money0(t.totalCost)}</span>,
              },
              {
                id: 'gm',
                header: 'GM',
                width: 110,
                min: 100,
                align: 'right',
                sortValue: (r) => r.gm,
                cell: (r) => <span className="tabular-nums font-medium">{money0(r.gm)}</span>,
                footer: <span className="tabular-nums">{money0(t.gm)}</span>,
              },
              {
                id: 'gmPct',
                header: 'GM %',
                width: 110,
                min: 100,
                align: 'right',
                sortValue: (r) => r.gmPct,
                cell: (r) => {
                  const b = band(r.gmPct);
                  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${b.chip}`}>{pct(r.gmPct)}</span>;
                },
                footer: (() => {
                  const b = band(t.gmPct);
                  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${b.chip}`}>{pct(t.gmPct)}</span>;
                })(),
              },
            ]}
          />
        </ChartCard>

        {/* Revenue vs GM% scatter */}
        <ChartCard
          className="lg:col-span-2"
          title="Revenue vs margin %"
          subtitle="Bottom-right = big jobs with thin margins (watch list)"
        >
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid stroke={token('--border-color')} strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name="Revenue" tickFormatter={(v) => money0(v)} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
              <YAxis type="number" dataKey="y" name="GM %" unit="%" tick={{ fontSize: 11, fill: token('--text-secondary') }} domain={[0, 80]} />
              <ZAxis type="number" dataKey="z" range={[120, 420]} />
              <ReferenceLine y={45} stroke={token('--text-soft')} strokeDasharray="4 4" label={{ value: '45% target', fontSize: 10, fill: token('--text-secondary'), position: 'insideTopRight' }} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                formatter={(val: number, key: string) => (key === 'Revenue' ? money0(val) : `${val}%`)}
              />
              <Scatter data={scatterData} stroke={token('--surface-light')} strokeWidth={1.5} fillOpacity={0.9}>
                {scatterData.map((d) => <Cell key={d.name} fill={d.hex} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <p className="text-xs text-text-secondary">
        Sample data shown so the layout is reviewable without a backend. GM% bands: ≥50% green, 35–49% amber, &lt;35% red
        (catalog benchmark: HVAC install 35–45%, service 50–65%, electrical 65–67%). Per-job waterfall is planned next.
      </p>
    </ReportShell>
  );
}

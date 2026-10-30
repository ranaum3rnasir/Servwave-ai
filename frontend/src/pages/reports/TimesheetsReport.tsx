import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
} from 'recharts';
import { Clock, Timer, AlarmClock, Activity } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { SelectField } from '@/components/form/SelectField';
import { ChartCard } from '@/components/charts';
import { token } from '@/design-system';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { EmployeePayrollCard } from '@/components/timeclock/EmployeePayrollCard';
import { useAppAbility } from '@/contexts/AbilityContext';
import { usePunches, useOtReviews, useUpsertOtReview } from '@/lib/api/timeclock';
import { formatPlace } from '@/lib/timeclock/place';
import { buildSessions, isLate, type Session } from '@/lib/timeclock/aggregate';
import { buildDays, buildPayroll, type WeekRow } from '@/lib/timeclock/payroll';
import type { ReviewState } from '@/lib/timeclock/types';
import { useOrganization } from '@/lib/api/organization';

const fmtHM = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

const TABS = ['Hours', 'Attendance'] as const;
type Tab = (typeof TABS)[number];

const hrs = (min: number) => min / 60;
const fmtHrs = (min: number) => `${hrs(min).toFixed(1)}h`;
const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

type EmpRow = {
  userId: string;
  userName: string;
  totalMin: number;
  otMin: number;
  days: number;
  lateCount: number;
  closedSessions: number;
  rank: number;
};

export default function TimesheetsReport() {
  const report = findReport('timesheets');
  // Whoever holds "See everyone's timesheets" sees the whole company; everyone else only their own punches.
  // The server enforces the same rule regardless of what we ask for.
  const ability = useAppAbility();
  const scope = ability.can('see_all', 'Timeclock') ? 'org' : 'me';
  // ISO-week period_keys must be bucketed in the ORG timezone (not the viewer's
  // browser zone) so every admin agrees with the backend on boundary punches.
  const { data: org } = useOrganization();
  const timeZone = org?.timezone || 'America/New_York';

  const { data: punches = [] } = usePunches({ scope });
  const { data: otReviewRows = [] } = useOtReviews({ scope });
  const upsertOtReview = useUpsertOtReview();

  // Map the API's per-week reviews → `Record<reviewKey, ReviewState>` keyed
  // `${user_id}:${period_key}` (matching WeekRow.reviewKey), state lowercased.
  const otReviews = useMemo<Record<string, ReviewState>>(() => {
    const m: Record<string, ReviewState> = {};
    for (const r of otReviewRows) {
      m[`${r.user_id}:${r.period_key}`] = r.state === 'APPROVED' ? 'approved' : 'rejected';
    }
    return m;
  }, [otReviewRows]);

  const approveOt = (week: WeekRow) =>
    void upsertOtReview.mutateAsync({ user_id: week.userId, period_key: week.periodKey, state: 'APPROVED' });
  const rejectOt = (week: WeekRow) =>
    void upsertOtReview.mutateAsync({ user_id: week.userId, period_key: week.periodKey, state: 'REJECTED' });

  const [tab, setTab] = useState<Tab>('Hours');
  const [selectedEmp, setSelectedEmp] = useState<string>('all');

  const sessions = useMemo(() => buildSessions(punches), [punches]);
  const days = useMemo(() => buildDays(sessions, timeZone), [sessions, timeZone]);
  const payroll = useMemo(() => buildPayroll(days, otReviews, timeZone), [days, otReviews, timeZone]);

  const periodLabel = useMemo(() => {
    if (days.length === 0) return 'This period';
    const lo = days[0]!.dateTs;
    const hi = days[days.length - 1]!.dateTs;
    const f = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${f(lo)} – ${f(hi)}`;
  }, [days]);

  const employees = useMemo<EmpRow[]>(() => {
    const byUser = new Map<string, Session[]>();
    for (const s of sessions) {
      const arr = byUser.get(s.userId) ?? [];
      arr.push(s);
      byUser.set(s.userId, arr);
    }
    const rows: EmpRow[] = [];
    for (const [userId, list] of byUser) {
      const first = list[0];
      if (!first) continue;
      const totalMin = list.reduce((a, s) => a + s.minutes, 0);
      const days = new Set(list.map((s) => new Date(s.inTs).toDateString())).size;
      const lateCount = list.filter((s) => isLate(s.inTs)).length;
      rows.push({
        userId,
        userName: first.userName,
        totalMin,
        otMin: Math.max(0, totalMin - 40 * 60),
        days,
        lateCount,
        closedSessions: list.filter((s) => s.outTs !== null).length,
        rank: 0,
      });
    }
    return rows.sort((a, b) => b.totalMin - a.totalMin).map((r, i) => ({ ...r, rank: i + 1 }));
  }, [sessions]);

  const totalMin = employees.reduce((a, r) => a + r.totalMin, 0);
  const otMin = employees.reduce((a, r) => a + r.otMin, 0);
  const onTimeCount = sessions.filter((s) => !isLate(s.inTs)).length;
  const onTimePct = sessions.length ? Math.round((onTimeCount / sessions.length) * 100) : 0;
  const activeNow = sessions.filter((s) => s.outTs === null).length;

  const logRows = useMemo(() => [...punches].sort((a, b) => b.ts - a.ts), [punches]);

  const selectedPayroll = selectedEmp === 'all' ? undefined : payroll.find((p) => p.userId === selectedEmp);
  const selectedDays = selectedEmp === 'all' ? [] : days.filter((d) => d.userId === selectedEmp);

  if (!report) return null;

  return (
    <ReportShell report={report}>
      <KpiStrip
        items={[
          { icon: Clock, label: 'Total hours', value: fmtHrs(totalMin), tone: 'success', emphasize: true },
          { icon: Timer, label: 'Overtime hours', value: fmtHrs(otMin), tone: 'warning' },
          { icon: AlarmClock, label: 'On-time %', value: `${onTimePct}%`, tone: 'primary' },
          { icon: Activity, label: 'Active now', value: activeNow, tone: 'neutral' },
        ]}
      />

      {/* Employee filter — pick a person to open their payroll card directly */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-secondary">Showing</span>
        <SelectField
          aria-label="Team member"
          value={selectedEmp}
          onValueChange={(v) => {
            setSelectedEmp(v);
            setTab('Hours');
          }}
          options={[
            { value: 'all', label: 'All team members' },
            ...payroll.map((p) => ({ value: p.userId, label: p.userName })),
          ]}
        />
        <span className="text-sm text-text-secondary">· {periodLabel}</span>
      </div>

      {selectedEmp !== 'all' && selectedPayroll ? (
        <EmployeePayrollCard
          payroll={selectedPayroll}
          days={selectedDays}
          otReviews={otReviews}
          onApproveOt={approveOt}
          onRejectOt={rejectOt}
          onBack={() => setSelectedEmp('all')}
          periodLabel={periodLabel}
          timeZone={timeZone}
        />
      ) : (
        <>
      <div className="flex flex-wrap gap-1 border-b border-border">
        {/* raw: underline tab-navigation control, not Button-shaped */}
        {TABS.map((t) => (
          // Segmented tab-underline control, not Button-shaped - left raw.
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Hours' && (
        <div className="space-y-4">
          <ChartCard title="Hours by employee">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={employees} layout="vertical" margin={{ left: 8, right: 48 }}>
                <XAxis type="number" tickFormatter={(v: number) => `${(v / 60).toFixed(0)}h`} tick={{ fontSize: 11, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="userName" width={96} tick={{ fontSize: 12, fill: token('--text-secondary') }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => fmtHrs(v)} />
                <Bar dataKey="totalMin" radius={[0, 6, 6, 0]} barSize={20} isAnimationActive={false}>
                  {employees.map((r) => (
                    <Cell key={r.userId} fill={r.otMin > 0 ? token('--warning') : token('--success')} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div>
            <Heading level={2} className="mb-2">Payroll Summary <span className="font-normal text-text-secondary">· tap a row to open the employee</span></Heading>
            <ResizableTable
              rows={payroll}
              getRowKey={(r) => r.userId}
              onRowClick={(r) => setSelectedEmp(r.userId)}
              empty={<EmptyState title="No timesheet data." />}
              columns={[
                { id: 'name', header: 'Team member', width: 180, min: 140, cell: (r) => <span className="font-medium text-text-primary">{r.userName}</span>, sortValue: (r) => r.userName, footer: <span className="font-semibold">Totals</span> },
                { id: 'reg', header: 'Regular', width: 100, min: 90, align: 'right', cell: (r) => <span className="tabular-nums">{fmtHM(r.regMin)}</span>, sortValue: (r) => r.regMin, footer: <span className="tabular-nums font-semibold">{fmtHM(payroll.reduce((a, p) => a + p.regMin, 0))}</span> },
                { id: 'ot1', header: 'OT1', width: 90, min: 80, align: 'right', cell: (r) => <span className="tabular-nums">{r.ot1Min ? fmtHM(r.ot1Min) : '-'}</span>, sortValue: (r) => r.ot1Min, footer: <span className="tabular-nums font-semibold">{fmtHM(payroll.reduce((a, p) => a + p.ot1Min, 0))}</span> },
                { id: 'ot2', header: 'OT2', width: 90, min: 80, align: 'right', cell: (r) => <span className="tabular-nums">{r.ot2Min ? fmtHM(r.ot2Min) : '-'}</span>, sortValue: (r) => r.ot2Min, footer: <span className="tabular-nums font-semibold">{fmtHM(payroll.reduce((a, p) => a + p.ot2Min, 0))}</span> },
                { id: 'otApproved', header: 'Approved OT', width: 120, min: 100, align: 'right', cell: (r) => <span className="tabular-nums text-success">{r.otApprovedMin ? fmtHM(r.otApprovedMin) : '-'}</span>, sortValue: (r) => r.otApprovedMin, footer: <span className="tabular-nums font-semibold text-success">{fmtHM(payroll.reduce((a, p) => a + p.otApprovedMin, 0))}</span> },
                { id: 'otPending', header: 'Pending OT', width: 120, min: 100, align: 'right', cell: (r) => <span className="tabular-nums text-warning">{r.otPendingMin ? fmtHM(r.otPendingMin) : '-'}</span>, sortValue: (r) => r.otPendingMin, footer: <span className="tabular-nums font-semibold text-warning">{fmtHM(payroll.reduce((a, p) => a + p.otPendingMin, 0))}</span> },
                { id: 'timeoff', header: 'Time off', width: 90, min: 80, align: 'right', cell: () => <span className="text-text-secondary">-</span> },
                { id: 'total', header: 'Total', width: 100, min: 90, align: 'right', cell: (r) => <span className="tabular-nums font-medium">{fmtHM(r.totalMin)}</span>, sortValue: (r) => r.totalMin, footer: <span className="tabular-nums font-semibold">{fmtHM(payroll.reduce((a, p) => a + p.totalMin, 0))}</span> },
              ]}
            />
          </div>
        </div>
      )}

      {tab === 'Attendance' && (
        <ResizableTable
          rows={employees}
          getRowKey={(r) => r.userId}
          empty={<EmptyState title="No attendance data." />}
          columns={[
            { id: 'name', header: 'Employee', width: 180, min: 140, cell: (r) => <span className="font-medium text-text-primary">{r.userName}</span>, sortValue: (r) => r.userName },
            { id: 'days', header: 'Days worked', width: 120, min: 100, align: 'right', cell: (r) => <span className="tabular-nums">{r.days}</span>, sortValue: (r) => r.days },
            { id: 'late', header: 'Late arrivals', width: 120, min: 100, align: 'right', cell: (r) => <span className={`tabular-nums ${r.lateCount > 0 ? 'text-danger' : ''}`}>{r.lateCount}</span>, sortValue: (r) => r.lateCount },
            { id: 'ontime', header: 'On-time %', width: 110, min: 90, align: 'right', cell: (r) => <span className="tabular-nums">{r.days === 0 ? '-' : `${Math.round((Math.max(0, r.days - r.lateCount) / Math.max(1, r.days)) * 100)}%`}</span>, sortValue: (r) => r.days - r.lateCount },
          ]}
        />
      )}

      <div className="space-y-2">
        <Heading level={2}>Punch log</Heading>
        <ResizableTable
          rows={logRows}
          getRowKey={(p) => p.id}
          empty={<EmptyState title="No punches recorded." />}
          columns={[
            { id: 'emp', header: 'Employee', width: 160, min: 130, cell: (p) => <span className="font-medium text-text-primary">{p.userName}</span>, sortValue: (p) => p.userName },
            { id: 'when', header: 'When', width: 150, min: 120, cell: (p) => <span className="tabular-nums text-text-secondary">{fmtDate(p.ts)} {fmtClock(p.ts)}</span>, sortValue: (p) => p.ts },
            { id: 'type', header: 'Type', width: 80, min: 70, cell: (p) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.type === 'IN' ? 'bg-success/10 text-success' : 'bg-background-light text-text-secondary'}`}>{p.type}</span>, sortValue: (p) => p.type },
            { id: 'where', header: 'Where', width: 200, min: 160, cell: (p) => <span className="tabular-nums text-text-secondary">{formatPlace(p.lat, p.lng)}</span>, sortValue: (p) => p.lat },
          ]}
        />
      </div>
        </>
      )}
    </ReportShell>
  );
}

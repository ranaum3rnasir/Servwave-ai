import { useEffect, useMemo, useState } from 'react';
import {
  Activity as ActivityIcon, CheckCircle2, ChevronRight, Clock, CornerUpLeft,
  DollarSign, Target, Users, Zap,
} from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { findReport } from '@/lib/reports/report-catalog';
import { useActivityReport } from '@/lib/reports/activity-data';
import {
  BAND_TEXT, EMPTY_FILTERS, SLA_MINUTES, bandFill, companyRows, deriveScope, filterUsers,
  findDivision, fmtDuration, leaderboard, pctDelta, reconcileFilters, responseBand, rollUp,
  slaBand,
  type Division, type Filters, type MetricKey, type PersonMetricKey, type UserActivity,
} from '@/lib/reports/activity-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Td } from '../components/td';
import { cn } from '@/ui-kit/lib/utils';

import { ReportShell } from '../components/reportShell';
import { ReportHeading } from '../components/heading';
import { ReportKpis } from '../components/kpi';
import { ActivityFilterBar } from '../components/activityFilterBar';
import { MetricDetailPanel } from '../components/metricDetailPanel';
import { PersonMetricPanel } from '../components/personMetricPanel';

/**
 * Activity - the deep-dive performance surface. One engine, three zoom levels
 * (Company -> Division -> Individual), money-first with response time and SLA
 * alongside.
 *
 * Spec: md_files/specs/activity/2026-06-07-activity-deep-dive-design.md
 *
 * FOUR THINGS ARE LOAD-BEARING and are carried over unchanged:
 *
 *   1. THE SCOPE IS DERIVED FROM THE FILTERS, never held separately.
 *      `deriveScope` reads the reconciled filter set, so picking a person (or a
 *      single division) jumps straight to that page, and drilling into a row is
 *      implemented by SETTING A FILTER - `openDivision`/`openUser`/`openCompany`
 *      all go through `setAndReconcile`. Drill-down and the filter bar are one
 *      state, which is why they can never disagree.
 *   2. EVERY filter write goes through `reconcileFilters`, so a contradictory
 *      selection (a person outside the selected division) is repaired instead of
 *      rendering zeros.
 *   3. THE REAL-ORG PATH IS NARROWER ON PURPOSE. `useActivityReport(isDemo)`
 *      gives demo orgs the Company/Division/Individual sample and real orgs a
 *      flat per-actor rollup of the TimelineEvent log - there is no division
 *      field to group by, so for a real org the division breadcrumb, the
 *      division table, the money and SLA KPIs and the sample-data pill are all
 *      hidden. `showDivisions` is that switch and it is `isDemo`.
 *   4. The open metric breakdown CLOSES on any scope change, so a panel can
 *      never describe a scope you have already left.
 *
 * COLOUR IS DATA HERE. `bandFill(responseBand(...))` colours the response
 * figures and the 7-day bars, `BAND_TEXT` colours the SLA pill and the timeline
 * gap notes, and the "when active" heatmap keeps its `--success-strong` alpha
 * ramp. All of it stays inline rather than moving to kit variants, for the same
 * reason chart fills do.
 *
 * `SpeedDelta` keeps its inversion: response time falling is FASTER, so a
 * negative delta reads green.
 */

/** Speed delta - lower is better, so a drop reads as "faster". */
function SpeedDelta({ cur, prev }: { cur: number; prev: number }) {
  const d = pctDelta(cur, prev);
  if (d === null || Math.abs(d) < 0.5) return <span className="text-muted-foreground text-xs">-</span>;
  const faster = d < 0;
  return (
    <span className={cn('text-xs font-medium', faster ? 'text-status-green-emphasis' : 'text-status-red-emphasis')}>
      {faster ? '↑' : '↓'} {Math.abs(d).toFixed(0)}% {faster ? 'faster' : 'slower'}
    </span>
  );
}

function SlaPill({ pct }: { pct: number }) {
  const band = slaBand(pct);
  return <span className={cn('font-semibold tabular-nums', BAND_TEXT[band])}>{pct}%</span>;
}

export default function ActivityReport() {
  const report = findReport('activity')!;
  const isDemo = useIsDemoOrg();
  // demo -> Company/Division/Individual sample; real -> flat per-actor rollup of
  // the TimelineEvent log (NO division - there is no division field to group by).
  const { users: USERS, divisions: DIVISIONS } = useActivityReport(isDemo);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Holds a MetricKey (company/division) or PersonMetricKey (individual); reset
  // on scope change.
  const [activeMetric, setActiveMetric] = useState<string | null>(null);

  // Always work from a reconciled filter set so contradictory facets can't show zeros.
  const effectiveFilters = useMemo(() => reconcileFilters(filters, USERS), [filters, USERS]);
  const users = useMemo(() => filterUsers(USERS, effectiveFilters), [USERS, effectiveFilters]);

  // The scope (Company / Division / Individual) is DERIVED from the filter
  // selection, so picking a person (or a single division) jumps to its page.
  const scope = useMemo(() => deriveScope(effectiveFilters, USERS), [USERS, effectiveFilters]);
  const { level } = scope;
  const division = findDivision(DIVISIONS, scope.divisionId);
  const user = useMemo(() => USERS.find((u) => u.id === scope.userId), [USERS, scope.userId]);

  // Close any open metric breakdown when the scope changes (drill or filter).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: the open breakdown belongs to the previous scope, so it has to close when the scope changes
    setActiveMetric(null);
  }, [scope.level, scope.divisionId, scope.userId]);

  const setAndReconcile = (next: Filters) => setFilters(reconcileFilters(next, USERS));

  /** Press a KPI card -> open its breakdown; press the active one again -> close. */
  const toggleMetric = (key: string | null) =>
    setActiveMetric((cur) => (key === null || cur === key ? null : key));

  // Drill-down and the filter bar are the SAME state: clicking a row sets the filter.
  const openDivision = (id: string) => setAndReconcile({ ...filters, divisionIds: [id], userIds: [] });
  const openUser = (u: UserActivity) =>
    setAndReconcile({ ...filters, divisionIds: [u.divisionId], userIds: [u.id] });
  const openCompany = () => setAndReconcile({ ...filters, divisionIds: [], userIds: [] });

  // The active crumb is a pressed Button rather than a disabled one: disabled
  // would grey out "you are here", which is the opposite of what it means.
  const crumb = (label: string, onClick: (() => void) | null, activeNode: boolean) => (
    <Button
      type="button"
      size="sm"
      aria-current={activeNode ? 'page' : undefined}
      variant={activeNode ? 'default' : onClick ? 'outline' : 'ghost'}
      onClick={onClick ?? undefined}
      disabled={!onClick && !activeNode}
    >
      {label}
    </Button>
  );

  // Division grouping is demo-only (no division field on real data) - for real
  // orgs the breadcrumb collapses to Company > Person and the pill is hidden.
  const scopeSwitcher = (
    <div className="flex items-center gap-1.5">
      {isDemo && <Badge variant="softAmber" size="pill">Sample data</Badge>}
      {crumb('🏢 Company', level === 'company' ? null : openCompany, level === 'company')}
      {isDemo && division && <ChevronRight className="text-muted-foreground size-3.5" />}
      {isDemo && division && crumb(`${division.icon} ${division.name}`, level === 'division' ? null : () => openDivision(division.id), level === 'division')}
      {user && <ChevronRight className="text-muted-foreground size-3.5" />}
      {user && crumb(`👤 ${user.name}`, null, level === 'individual')}
    </div>
  );

  return (
    <ReportShell
      report={report}
      subtitle={`Who did what - and how fast. SLA target: respond within ${SLA_MINUTES} min.`}
      actions={scopeSwitcher}
    >
      <div className="space-y-4">
        <ActivityFilterBar
          filters={effectiveFilters}
          onChange={setAndReconcile}
          divisions={DIVISIONS}
          users={USERS}
        />
        {level === 'company' && (
          <CompanyView divisions={DIVISIONS} users={users} activeMetric={activeMetric} onMetric={toggleMetric} onOpenDivision={openDivision} showDivisions={isDemo} />
        )}
        {level === 'division' && division && (
          <DivisionView divisions={DIVISIONS} divisionId={division.id} users={users} activeMetric={activeMetric} onMetric={toggleMetric} onOpenUser={openUser} />
        )}
        {level === 'individual' && user && (
          <IndividualView divisions={DIVISIONS} user={user} activeMetric={activeMetric} onMetric={toggleMetric} />
        )}
      </div>
    </ReportShell>
  );
}

function CompanyView({
  divisions: DIVISIONS,
  users,
  activeMetric,
  onMetric,
  onOpenDivision,
  showDivisions,
}: {
  divisions: Division[];
  users: UserActivity[];
  activeMetric: string | null;
  onMetric: (key: string | null) => void;
  onOpenDivision: (id: string) => void;
  showDivisions: boolean;
}) {
  const rows = companyRows(DIVISIONS, users);
  const all = rollUp(users, users);
  const press = (key: MetricKey) => ({ onClick: () => onMetric(key), active: activeMetric === key, activeLabel: 'Detail' });
  const totalActions = users.reduce((a, u) => a + u.actions, 0);

  return (
    <>
      <ReportKpis
        items={
          showDivisions
            ? [
                { icon: DollarSign, label: 'Revenue touched', value: formatCurrency(all.revenueTouched), tone: 'success', emphasize: true, ...press('revenue') },
                { icon: CheckCircle2, label: 'Conversions', value: all.conversions, tone: 'primary', ...press('conversions') },
                { icon: Zap, label: 'Avg response', value: fmtDuration(all.avgResponseSec), tone: 'neutral', ...press('response') },
                { icon: Target, label: 'SLA met', value: `${all.slaMetPct}%`, tone: 'warning', ...press('sla') },
                { icon: Users, label: 'Active people', value: `${all.activePeople}`, tone: 'neutral', ...press('people') },
              ]
            : [
                // Real orgs: only metrics the TimelineEvent log supports (no
                // money/SLA, no division).
                { icon: ActivityIcon, label: 'Total actions', value: totalActions, tone: 'primary', emphasize: true },
                { icon: Users, label: 'Active people', value: `${all.activePeople}`, tone: 'neutral' },
              ]
        }
      />

      {showDivisions && activeMetric && (
        <MetricDetailPanel
          metric={activeMetric as MetricKey}
          level="company"
          users={users}
          divisions={DIVISIONS}
          onClose={() => onMetric(null)}
        />
      )}

      {showDivisions ? (
        <Card>
          <ReportHeading level={2} scale="lg">Divisions - ranked by revenue touched</ReportHeading>
          <p className="text-muted-foreground mb-4 text-xs">
            Click a division to open its team. Support divisions (no revenue) are measured on speed only.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Division</TableHead>
                <TableHead className="text-right">$ Touched</TableHead>
                <TableHead className="text-right">Conv. rate</TableHead>
                <TableHead className="text-right">Avg response</TableHead>
                <TableHead className="text-right">SLA met</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.division.id} onClick={() => onOpenDivision(r.division.id)} className="cursor-pointer">
                  <Td className="font-medium">{r.division.icon} {r.division.name}</Td>
                  <Td className="text-right tabular-nums">{r.division.revenueBearing ? formatCurrency(r.revenueTouched) : <span className="text-muted-foreground">-</span>}</Td>
                  <Td className="text-right tabular-nums">{r.division.revenueBearing ? `${r.convRatePct}%` : <span className="text-muted-foreground">-</span>}</Td>
                  {/* The response figure is coloured by its band - a data reading. */}
                  <Td className="text-right tabular-nums" style={{ color: bandFill(responseBand(r.avgResponseSec)) }}>{fmtDuration(r.avgResponseSec)}</Td>
                  <Td className="text-right"><SlaPill pct={r.slaMetPct} /></Td>
                  <Td className="text-muted-foreground text-right tabular-nums">{r.activePeople}</Td>
                  <Td className="text-muted-foreground text-right"><ChevronRight className="ml-auto size-4" /></Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        // Real orgs: a flat people leaderboard (NO division column) ranked by actions.
        <Card>
          <ReportHeading level={2} scale="lg">People - ranked by actions logged</ReportHeading>
          <p className="text-muted-foreground mb-4 text-xs">Activity from the timeline log, this period.</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Person</TableHead>
                <TableHead className="text-right">Actions</TableHead>
                <TableHead className="text-right">Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <Td colSpan={4} padding="none"><EmptyState title="No activity logged yet." /></Td>
                </TableRow>
              ) : (
                users.map((u, i) => (
                  <TableRow key={u.id}>
                    <Td className="text-muted-foreground tabular-nums">{i + 1}</Td>
                    <Td>
                      <div className="font-medium">{u.name}</div>
                      <div className="text-muted-foreground text-xs">{u.role}</div>
                    </Td>
                    <Td className="text-right tabular-nums">{u.actions}</Td>
                    <Td className="text-muted-foreground text-right tabular-nums">{u.firstActionAt}-{u.lastActionAt}</Td>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}

function DivisionView({
  divisions: DIVISIONS,
  divisionId,
  users,
  activeMetric,
  onMetric,
  onOpenUser,
}: {
  divisions: Division[];
  divisionId: string;
  users: UserActivity[];
  activeMetric: string | null;
  onMetric: (key: string | null) => void;
  onOpenUser: (u: UserActivity) => void;
}) {
  const division = findDivision(DIVISIONS, divisionId)!;
  const members = leaderboard(users, divisionId);
  const r = rollUp(members, members);
  const revenue = division.revenueBearing;
  const press = (key: MetricKey) => ({ onClick: () => onMetric(key), active: activeMetric === key, activeLabel: 'Detail' });

  return (
    <>
      <ReportKpis
        items={[
          revenue
            ? { icon: DollarSign, label: 'Revenue touched', value: formatCurrency(r.revenueTouched), tone: 'success', emphasize: true, ...press('revenue') }
            : { icon: ActivityIcon, label: 'Throughput', value: members.reduce((a, m) => a + m.actions, 0), tone: 'primary' },
          { icon: CheckCircle2, label: 'Conversions', value: revenue ? r.conversions : '-', tone: 'primary', ...(revenue ? press('conversions') : {}) },
          { icon: Zap, label: 'Avg response', value: fmtDuration(r.avgResponseSec), tone: 'neutral', ...press('response') },
          { icon: Target, label: 'SLA met', value: `${r.slaMetPct}%`, tone: 'warning', ...press('sla') },
          { icon: Users, label: 'Active people', value: `${r.activePeople}`, tone: 'neutral', ...press('people') },
        ]}
      />

      {activeMetric && (
        <MetricDetailPanel
          metric={activeMetric as MetricKey}
          level="division"
          users={users}
          divisions={DIVISIONS}
          divisionId={divisionId}
          onClose={() => onMetric(null)}
        />
      )}

      <Card>
        <ReportHeading level={2} scale="lg">{division.icon} {division.name} - leaderboard</ReportHeading>
        <p className="text-muted-foreground mb-4 text-xs">
          Ranked by revenue touched. Click a person to open their scorecard.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Person</TableHead>
              <TableHead className="text-right">$ Touched</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="text-right">Response</TableHead>
              <TableHead className="text-right">SLA</TableHead>
              <TableHead className="text-right">Actions</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m, i) => (
              <TableRow key={m.id} onClick={() => onOpenUser(m)} className="cursor-pointer">
                <Td className="text-muted-foreground tabular-nums">{i + 1}</Td>
                <Td>
                  <div className="font-medium">{m.name}</div>
                  <div className="text-muted-foreground text-xs">{m.role}</div>
                </Td>
                <Td className="text-right tabular-nums">{revenue ? formatCurrency(m.revenueTouched) : <span className="text-muted-foreground">-</span>}</Td>
                <Td className="text-right tabular-nums">{revenue ? m.conversions : <span className="text-muted-foreground">-</span>}</Td>
                <Td className="text-right tabular-nums" style={{ color: bandFill(responseBand(m.responseSec)) }}>{fmtDuration(m.responseSec)}</Td>
                <Td className="text-right"><SlaPill pct={m.slaMetPct} /></Td>
                <Td className="text-muted-foreground text-right tabular-nums">{m.actions}</Td>
                <Td className="text-muted-foreground text-right"><ChevronRight className="ml-auto size-4" /></Td>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function IndividualView({
  divisions: DIVISIONS,
  user,
  activeMetric,
  onMetric,
}: {
  divisions: Division[];
  user: UserActivity;
  activeMetric: string | null;
  onMetric: (key: string | null) => void;
}) {
  const division = findDivision(DIVISIONS, user.divisionId);
  const revenue = division?.revenueBearing ?? true;
  const maxResp = Math.max(...user.response7d, 1);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const underSla = user.response7d.filter((s) => s <= SLA_MINUTES * 60).length;
  const press = (key: PersonMetricKey) => ({ onClick: () => onMetric(key), active: activeMetric === key, activeLabel: 'Detail' });

  return (
    <>
      <ReportKpis
        items={[
          revenue
            ? { icon: DollarSign, label: '$ Touched', value: formatCurrency(user.revenueTouched), tone: 'success', emphasize: true, ...press('touch') }
            : { icon: ActivityIcon, label: 'Throughput', value: user.actions, tone: 'primary', ...press('actions') },
          { icon: Zap, label: 'Response time', value: fmtDuration(user.responseSec), tone: 'neutral', ...press('response') },
          { icon: CornerUpLeft, label: 'Reaction time', value: fmtDuration(user.reactionSec), tone: 'neutral', ...press('reaction') },
          { icon: Clock, label: 'Active time', value: `${Math.floor(user.activeMinutes / 60)}h ${user.activeMinutes % 60}m`, tone: 'neutral', ...press('active') },
          { icon: ActivityIcon, label: 'Actions', value: user.actions, tone: 'primary', ...press('actions') },
        ]}
      />

      {activeMetric && (
        <PersonMetricPanel user={user} metric={activeMetric as PersonMetricKey} onClose={() => onMetric(null)} />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <ReportHeading level={2} scale="lg" className="mb-1">What {user.name.split(' ')[0]} did</ReportHeading>
          <p className="text-muted-foreground mb-4 text-xs">Actions by type, this period</p>
          <div className="space-y-1.5">
            {user.breakdown.map((b) => (
              <div key={b.label} className="hover:bg-muted flex items-center justify-between rounded-lg px-2 py-1.5">
                <span className="text-sm">{b.icon} {b.label}</span>
                <span className="text-sm font-semibold tabular-nums">
                  {b.count}
                  {b.note && <span className="text-muted-foreground ml-1.5 text-xs font-normal">{b.note}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <ReportHeading level={2} scale="lg">Response time - last 7 days</ReportHeading>
          <p className="text-muted-foreground mb-3 text-xs">
            Bars colored by SLA band ·{' '}
            <span className="text-status-green-emphasis font-medium">
              {Math.round((underSla / user.response7d.length) * 100)}% under {SLA_MINUTES}-min SLA
            </span>
          </p>
          {/* Bar heights and fills are the band reading, so both stay inline. */}
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {user.response7d.map((s, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t"
                  style={{ height: Math.max((s / maxResp) * 100, 4), backgroundColor: bandFill(responseBand(s)) }}
                  title={fmtDuration(s)}
                />
                <span className="text-muted-foreground text-[10px]">{days[i]}</span>
              </div>
            ))}
          </div>

          <ReportHeading level={3} scale="sm" className="mt-5 mb-2">When active</ReportHeading>
          {/* Alpha ramp over --success-strong: intensity IS the value. */}
          <div className="flex gap-1">
            {user.heatmap.map((v, i) => (
              <div key={i} className="h-4 flex-1 rounded-sm" style={{ backgroundColor: `rgb(var(--success-strong) / ${0.15 + v * 0.85})` }} title={`intensity ${Math.round(v * 100)}%`} />
            ))}
          </div>
          <div className="text-muted-foreground mt-1 flex justify-between text-[10px]"><span>8a</span><span>12p</span><span>6p</span></div>
        </Card>
      </div>

      <Card>
        <ReportHeading level={2} scale="lg">Timeline</ReportHeading>
        <p className="text-muted-foreground mb-4 text-xs">Recent activity, annotated with response &amp; reaction gaps</p>
        <div className="space-y-2">
          {user.timeline.map((e, i) => (
            <div key={i} className="flex items-baseline gap-3 border-l-2 pl-3">
              <span className="text-muted-foreground w-16 shrink-0 text-xs tabular-nums">{e.at}</span>
              <span className="text-sm">
                {e.label}
                {e.gapNote && (
                  <span className={cn('ml-2 text-xs', e.gapTone ? BAND_TEXT[e.gapTone] : 'text-muted-foreground')}>
                    · {e.gapNote}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

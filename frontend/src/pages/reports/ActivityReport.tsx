import { useEffect, useMemo, useState } from 'react';
import {
  DollarSign,
  CheckCircle2,
  Zap,
  CornerUpLeft,
  Clock,
  Users,
  Target,
  Activity as ActivityIcon,
  ChevronRight,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { KpiStrip } from '@/components/data/KpiStrip';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useActivityReport } from '@/lib/reports/activity-data';
import { ActivityFilterBar } from './ActivityFilterBar';
import { MetricDetailPanel } from './MetricDetailPanel';
import { PersonMetricPanel } from './PersonMetricPanel';
import {
  type Division,
  type UserActivity,
  type Filters,
  type MetricKey,
  type PersonMetricKey,
  EMPTY_FILTERS,
  filterUsers,
  reconcileFilters,
  deriveScope,
  fmtDuration,
  pctDelta,
  slaBand,
  responseBand,
  bandFill,
  BAND_TEXT,
  SLA_MINUTES,
  rollUp,
  companyRows,
  leaderboard,
  findDivision,
} from '@/lib/reports/activity-logic';

/**
 * Activity — deep-dive performance surface. One engine, three zoom levels
 * (Company → Division → Individual), money-first with response-time + SLA
 * alongside. Mock-first: renders from activity-data via pure activity-logic.
 *
 * Spec: md_files/specs/activity/2026-06-07-activity-deep-dive-design.md
 */

const card = 'rounded-xl border border-border bg-surface-light p-6 shadow-card';

/** Speed delta — lower is better, so a drop reads as "faster". */
function SpeedDelta({ cur, prev }: { cur: number; prev: number }) {
  const d = pctDelta(cur, prev);
  if (d === null || Math.abs(d) < 0.5) return <span className="text-xs text-text-secondary">—</span>;
  const faster = d < 0;
  return (
    <span className={`text-xs font-medium ${faster ? 'text-success-text' : 'text-danger-text'}`}>
      {faster ? '↑' : '↓'} {Math.abs(d).toFixed(0)}% {faster ? 'faster' : 'slower'}
    </span>
  );
}

function SlaPill({ pct }: { pct: number }) {
  const band = slaBand(pct);
  return <span className={`font-semibold tabular-nums ${BAND_TEXT[band]}`}>{pct}%</span>;
}

export default function ActivityReport() {
  const report = findReport('activity')!;
  const isDemo = useIsDemoOrg();
  // demo → Company→Division→Individual sample; real → flat per-actor rollup of the
  // TimelineEvent log (NO division — there is no division field to group by).
  const { users: USERS, divisions: DIVISIONS } = useActivityReport(isDemo);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Holds a MetricKey (company/division) or PersonMetricKey (individual); reset on scope change.
  const [activeMetric, setActiveMetric] = useState<string | null>(null);

  // Always work from a reconciled filter set so contradictory facets can't show zeros.
  const effectiveFilters = useMemo(() => reconcileFilters(filters, USERS), [filters, USERS]);
  const users = useMemo(() => filterUsers(USERS, effectiveFilters), [USERS, effectiveFilters]);

  // The scope (Company / Division / Individual) is DERIVED from the filter selection,
  // so picking a person (or a single division) jumps straight to its page.
  const scope = useMemo(() => deriveScope(effectiveFilters, USERS), [USERS, effectiveFilters]);
  const { level } = scope;
  const division = findDivision(DIVISIONS, scope.divisionId);
  const user = useMemo(() => USERS.find((u) => u.id === scope.userId), [USERS, scope.userId]);

  // Close any open metric breakdown when the scope changes (drill or filter).
  useEffect(() => {
    setActiveMetric(null);
  }, [scope.level, scope.divisionId, scope.userId]);

  const setAndReconcile = (next: Filters) => setFilters(reconcileFilters(next, USERS));

  /** Press a KPI card → open its breakdown; press the active one again → close. */
  const toggleMetric = (key: string | null) =>
    setActiveMetric((cur) => (key === null || cur === key ? null : key));

  // Drill-down and the filter bar are the SAME state: clicking a row sets the filter.
  const openDivision = (id: string) => setAndReconcile({ ...filters, divisionIds: [id], userIds: [] });
  const openUser = (u: UserActivity) =>
    setAndReconcile({ ...filters, divisionIds: [u.divisionId], userIds: [u.id] });
  const openCompany = () => setAndReconcile({ ...filters, divisionIds: [], userIds: [] });

  // ── Scope breadcrumb (also the actions slot) ────────────────────────────────
  // Not Button-shaped: a shared 3-state renderer (active / clickable / inert), and
  // the active state is a `disabled` solid/brand pill with NO faded look - Button's
  // base string bakes in `disabled:opacity-50` with no per-cell override, so
  // converting the active crumb would visibly grey out the current location. Left
  // raw so "you are here" doesn't read as disabled.
  const crumb = (label: string, onClick: (() => void) | null, activeNode: boolean) => (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick ?? undefined}
      className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
        activeNode
          ? 'bg-primary text-on-fill'
          : onClick
            ? 'border border-border bg-surface-light text-text-secondary hover:text-text-primary'
            : 'text-text-secondary'
      }`}
    >
      {label}
    </button>
  );

  // Division grouping is demo-only (no division field on real data) — for real orgs
  // the breadcrumb collapses to Company → Person and the "Sample data" pill is hidden.
  const scopeSwitcher = (
    <div className="flex items-center gap-1.5">
      {isDemo && (
        <span className="rounded-full bg-warning-surface px-2 py-1 text-xs font-medium text-warning-text">Sample data</span>
      )}
      {crumb('🏢 Company', level === 'company' ? null : openCompany, level === 'company')}
      {isDemo && division && <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />}
      {isDemo && division && crumb(`${division.icon} ${division.name}`, level === 'division' ? null : () => openDivision(division.id), level === 'division')}
      {user && <ChevronRight className="h-3.5 w-3.5 text-text-secondary" />}
      {user && crumb(`👤 ${user.name}`, null, level === 'individual')}
    </div>
  );

  return (
    <ReportShell
      report={report}
      subtitle={`Who did what — and how fast. SLA target: respond within ${SLA_MINUTES} min.`}
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

// ── Company view ──────────────────────────────────────────────────────────────
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
      <KpiStrip
        items={
          showDivisions
            ? [
                { icon: DollarSign, label: 'Revenue touched', value: formatCurrency(all.revenueTouched), sub: 'across all divisions', tone: 'success', emphasize: true, ...press('revenue') },
                { icon: CheckCircle2, label: 'Conversions', value: all.conversions, sub: `of ${all.leads} leads · ${all.convRatePct}%`, tone: 'primary', ...press('conversions') },
                { icon: Zap, label: 'Avg response', value: fmtDuration(all.avgResponseSec), tone: 'neutral', ...press('response') },
                { icon: Target, label: 'SLA met', value: `${all.slaMetPct}%`, sub: `target ${90}%`, tone: 'warning', ...press('sla') },
                { icon: Users, label: 'Active people', value: `${all.activePeople}`, sub: `of ${all.totalPeople}`, tone: 'neutral', ...press('people') },
              ]
            : [
                // Real orgs: only metrics the TimelineEvent log supports (no money/SLA, no division).
                { icon: ActivityIcon, label: 'Total actions', value: totalActions, sub: 'logged this period', tone: 'primary', emphasize: true },
                { icon: Users, label: 'Active people', value: `${all.activePeople}`, sub: 'with logged activity', tone: 'neutral' },
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
        <div className={card}>
          <Heading level={2}>Divisions — ranked by revenue touched</Heading>
          <p className="mb-4 text-xs text-text-secondary">Click a division to open its team. Support divisions (no revenue) are measured on speed only.</p>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-background-light text-left text-[11px] uppercase tracking-wide text-text-secondary">
                  <th className="px-3 py-2 font-medium">Division</th>
                  <th className="px-3 py-2 text-right font-medium">$ Touched</th>
                  <th className="px-3 py-2 text-right font-medium">Conv. rate</th>
                  <th className="px-3 py-2 text-right font-medium">Avg response</th>
                  <th className="px-3 py-2 text-right font-medium">SLA met</th>
                  <th className="px-3 py-2 text-right font-medium">People</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.division.id}
                    onClick={() => onOpenDivision(r.division.id)}
                    className="cursor-pointer border-t border-border hover:bg-background-light"
                  >
                    <td className="px-3 py-2.5 font-medium text-text-primary">{r.division.icon} {r.division.name}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.division.revenueBearing ? formatCurrency(r.revenueTouched) : <span className="text-text-secondary">—</span>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.division.revenueBearing ? `${r.convRatePct}%` : <span className="text-text-secondary">—</span>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: bandFill(responseBand(r.avgResponseSec)) }}>{fmtDuration(r.avgResponseSec)}</td>
                    <td className="px-3 py-2.5 text-right"><SlaPill pct={r.slaMetPct} /></td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{r.activePeople}</td>
                    <td className="px-3 py-2.5 text-right text-text-secondary"><ChevronRight className="ml-auto h-4 w-4" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        // Real orgs: a flat people leaderboard (NO division column) ranked by actions.
        <div className={card}>
          <Heading level={2}>People — ranked by actions logged</Heading>
          <p className="mb-4 text-xs text-text-secondary">Activity from the timeline log, this period.</p>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-background-light text-left text-[11px] uppercase tracking-wide text-text-secondary">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                  <th className="px-3 py-2 text-right font-medium">Active</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-text-secondary"><EmptyState title="No activity logged yet." /></td></tr>
                ) : (
                  users.map((u, i) => (
                    <tr key={u.id} className="border-t border-border">
                      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{i + 1}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-text-primary">{u.name}</div>
                        <div className="text-xs text-text-secondary">{u.role}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{u.actions}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{u.firstActionAt}–{u.lastActionAt}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ── Division view ─────────────────────────────────────────────────────────────
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
      <KpiStrip
        items={[
          revenue
            ? { icon: DollarSign, label: 'Revenue touched', value: formatCurrency(r.revenueTouched), sub: `${pctDelta(r.revenueTouched, r.prevRevenueTouched)?.toFixed(0) ?? '0'}% vs last mo`, tone: 'success', emphasize: true, ...press('revenue') }
            : { icon: ActivityIcon, label: 'Throughput', value: members.reduce((a, m) => a + m.actions, 0), sub: 'actions · support division', tone: 'primary' },
          { icon: CheckCircle2, label: 'Conversions', value: revenue ? r.conversions : '—', sub: revenue ? `of ${r.leads} leads` : 'n/a', tone: 'primary', ...(revenue ? press('conversions') : {}) },
          { icon: Zap, label: 'Avg response', value: fmtDuration(r.avgResponseSec), tone: 'neutral', ...press('response') },
          { icon: Target, label: 'SLA met', value: `${r.slaMetPct}%`, sub: `target ${90}%`, tone: 'warning', ...press('sla') },
          { icon: Users, label: 'Active people', value: `${r.activePeople}`, sub: `of ${r.totalPeople}`, tone: 'neutral', ...press('people') },
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

      <div className={card}>
        <Heading level={2}>{division.icon} {division.name} — leaderboard</Heading>
        <p className="mb-4 text-xs text-text-secondary">Ranked by revenue touched. Click a person to open their scorecard.</p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-background-light text-left text-[11px] uppercase tracking-wide text-text-secondary">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Person</th>
                <th className="px-3 py-2 text-right font-medium">$ Touched</th>
                <th className="px-3 py-2 text-right font-medium">Conv.</th>
                <th className="px-3 py-2 text-right font-medium">Response</th>
                <th className="px-3 py-2 text-right font-medium">SLA</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={m.id} onClick={() => onOpenUser(m)} className="cursor-pointer border-t border-border hover:bg-background-light">
                  <td className="px-3 py-2.5 tabular-nums text-text-secondary">{i + 1}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text-primary">{m.name}</div>
                    <div className="text-xs text-text-secondary">{m.role}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{revenue ? formatCurrency(m.revenueTouched) : <span className="text-text-secondary">—</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{revenue ? m.conversions : <span className="text-text-secondary">—</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: bandFill(responseBand(m.responseSec)) }}>{fmtDuration(m.responseSec)}</td>
                  <td className="px-3 py-2.5 text-right"><SlaPill pct={m.slaMetPct} /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{m.actions}</td>
                  <td className="px-3 py-2.5 text-right text-text-secondary"><ChevronRight className="ml-auto h-4 w-4" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Individual view ───────────────────────────────────────────────────────────
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
      <KpiStrip
        items={[
          revenue
            ? { icon: DollarSign, label: '$ Touched', value: formatCurrency(user.revenueTouched), sub: `${user.conversions} jobs converted`, tone: 'success', emphasize: true, ...press('touch') }
            : { icon: ActivityIcon, label: 'Throughput', value: user.actions, sub: 'support role', tone: 'primary', ...press('actions') },
          { icon: Zap, label: 'Response time', value: fmtDuration(user.responseSec), sub: undefined, tone: 'neutral', ...press('response') },
          { icon: CornerUpLeft, label: 'Reaction time', value: fmtDuration(user.reactionSec), tone: 'neutral', ...press('reaction') },
          { icon: Clock, label: 'Active time', value: `${Math.floor(user.activeMinutes / 60)}h ${user.activeMinutes % 60}m`, sub: `${user.firstActionAt}–${user.lastActionAt}`, tone: 'neutral', ...press('active') },
          { icon: ActivityIcon, label: 'Actions', value: user.actions, sub: `SLA met ${user.slaMetPct}%`, tone: 'primary', ...press('actions') },
        ]}
      />

      {activeMetric && (
        <PersonMetricPanel user={user} metric={activeMetric as PersonMetricKey} onClose={() => onMetric(null)} />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* What he did */}
        <div className={card}>
          <Heading level={2} className="mb-1">What {user.name.split(' ')[0]} did</Heading>
          <p className="mb-4 text-xs text-text-secondary">Actions by type, this period</p>
          <div className="space-y-1.5">
            {user.breakdown.map((b) => (
              <div key={b.label} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-background-light">
                <span className="text-sm text-text-primary">{b.icon} {b.label}</span>
                <span className="text-sm font-semibold tabular-nums text-text-primary">
                  {b.count}{b.note && <span className="ml-1.5 text-xs font-normal text-text-secondary">{b.note}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Speed detail */}
        <div className={card}>
          <Heading level={2}>Response time — last 7 days</Heading>
          <p className="mb-3 text-xs text-text-secondary">
            Bars colored by SLA band · <span className="font-medium text-success-text">{Math.round((underSla / user.response7d.length) * 100)}% under {SLA_MINUTES}-min SLA</span>
          </p>
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {user.response7d.map((s, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t"
                  style={{ height: Math.max((s / maxResp) * 100, 4), backgroundColor: bandFill(responseBand(s)) }}
                  title={fmtDuration(s)}
                />
                <span className="text-[10px] text-text-secondary">{days[i]}</span>
              </div>
            ))}
          </div>

          <Heading level={3} scale="xs" className="mb-2 mt-5">When active</Heading>
          <div className="flex gap-1">
            {user.heatmap.map((v, i) => (
              <div key={i} className="h-4 flex-1 rounded-sm" style={{ backgroundColor: `rgb(var(--success-strong) / ${0.15 + v * 0.85})` }} title={`intensity ${Math.round(v * 100)}%`} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-text-secondary"><span>8a</span><span>12p</span><span>6p</span></div>
        </div>
      </div>

      {/* Timeline */}
      <div className={card}>
        <Heading level={2}>Timeline</Heading>
        <p className="mb-4 text-xs text-text-secondary">Recent activity, annotated with response & reaction gaps</p>
        <div className="space-y-2">
          {user.timeline.map((e, i) => (
            <div key={i} className="flex items-baseline gap-3 border-l-2 border-border pl-3">
              <span className="w-16 shrink-0 text-xs tabular-nums text-text-secondary">{e.at}</span>
              <span className="text-sm text-text-primary">
                {e.label}
                {e.gapNote && <span className={`ml-2 text-xs ${e.gapTone ? BAND_TEXT[e.gapTone] : 'text-text-secondary'}`}>· {e.gapNote}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Activity report — pure logic (no React, unit-testable).
 *
 * The page (`ActivityReport.tsx`) renders three zoom levels — Company → Division
 * → Individual — over the in-file sample data in `activity-data.ts`. All roll-ups,
 * formatting, SLA banding and deltas live here so they can be tested and later
 * re-pointed at a real backend aggregation without touching the page.
 *
 * Spec: md_files/specs/activity/2026-06-07-activity-deep-dive-design.md
 */
import { token } from '@/design-system/tokens';

export type ScopeLevel = 'company' | 'division' | 'individual';
export type Band = 'good' | 'warn' | 'bad';

/** Response-time SLA: "respond to a new lead within X minutes". */
export const SLA_MINUTES = 10;
export const SLA_SECONDS = SLA_MINUTES * 60;

/** SLA-met % thresholds → color band. */
export const SLA_GOOD_PCT = 90;
export const SLA_WARN_PCT = 70;

export interface Division {
  id: string;
  name: string;
  icon: string;
  /** Support divisions (e.g. Logistics) carry no revenue — measured on speed only. */
  revenueBearing: boolean;
}

export interface ActionCount {
  label: string;
  icon: string;
  count: number;
  note?: string;
}

export interface ActivityEvent {
  at: string; // display time, e.g. "10:38a"
  label: string; // "Sent to tech by SMS — lead 17686"
  gapNote?: string; // "reacted 47s after assignment"
  gapTone?: Band;
}

export interface UserActivity {
  id: string;
  name: string;
  role: string;
  divisionId: string;
  active: boolean;
  // money-first
  revenueTouched: number;
  prevRevenueTouched: number;
  conversions: number;
  leads: number;
  // speed (seconds)
  responseSec: number;
  prevResponseSec: number;
  reactionSec: number;
  // sla
  slaMetPct: number;
  // volume
  actions: number;
  activeMinutes: number;
  firstActionAt: string;
  lastActionAt: string;
  // detail
  breakdown: ActionCount[];
  response7d: number[]; // seconds per day, last 7
  heatmap: number[]; // 0..1 intensity per working-hour block
  timeline: ActivityEvent[];
}

export interface RollUp {
  revenueTouched: number;
  prevRevenueTouched: number;
  conversions: number;
  leads: number;
  convRatePct: number;
  avgResponseSec: number;
  prevAvgResponseSec: number;
  slaMetPct: number;
  activePeople: number;
  totalPeople: number;
}

export interface CompanyRow extends RollUp {
  division: Division;
}

// ── formatting ────────────────────────────────────────────────────────────────

/** Seconds → "4m 12s" / "21m" / "41s". */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export const pctDelta = (cur: number, prev: number): number | null =>
  prev === 0 ? null : ((cur - prev) / prev) * 100;

/** % met → band (more is better). */
export function slaBand(pct: number): Band {
  if (pct >= SLA_GOOD_PCT) return 'good';
  if (pct >= SLA_WARN_PCT) return 'warn';
  return 'bad';
}

/** Response seconds → band (less is better; warn within 2× SLA, bad beyond). */
export function responseBand(sec: number): Band {
  if (sec <= SLA_SECONDS) return 'good';
  if (sec <= SLA_SECONDS * 2) return 'warn';
  return 'bad';
}

/**
 * Band -> a solid fill colour, for dots and bars. Resolved through the token
 * layer at CALL time rather than stored: a module-scope constant would freeze
 * the value before tokens.css applies, and the hex map this replaced was
 * invisible at every `style={{ color: BAND_HEX[b] }}` call site that consumed
 * it - the exact laundering the .ts/.tsx hex ratchet exists to catch.
 */
const BAND_FILL_TOKEN: Record<Band, string> = {
  good: '--success-strong',
  warn: '--warning-strong',
  bad: '--danger-strong',
};
export const bandFill = (band: Band): string => token(BAND_FILL_TOKEN[band]);

/** Band -> text colour on a light surface. The AA-verified `text` role. */
export const BAND_TEXT: Record<Band, string> = {
  good: 'text-success-text',
  warn: 'text-warning-text',
  bad: 'text-danger-text',
};

// ── roll-ups ────────────────────────────────────────────────────────────────

/** Average that ignores zero/empty members (so idle people don't skew speed). */
function avg(nums: number[]): number {
  const live = nums.filter((n) => n > 0);
  return live.length ? live.reduce((a, b) => a + b, 0) / live.length : 0;
}

export function rollUp(users: UserActivity[], allInScope: UserActivity[]): RollUp {
  const revenueTouched = users.reduce((a, u) => a + u.revenueTouched, 0);
  const prevRevenueTouched = users.reduce((a, u) => a + u.prevRevenueTouched, 0);
  const conversions = users.reduce((a, u) => a + u.conversions, 0);
  const leads = users.reduce((a, u) => a + u.leads, 0);
  return {
    revenueTouched,
    prevRevenueTouched,
    conversions,
    leads,
    convRatePct: leads ? Math.round((conversions / leads) * 100) : 0,
    avgResponseSec: Math.round(avg(users.map((u) => u.responseSec))),
    prevAvgResponseSec: Math.round(avg(users.map((u) => u.prevResponseSec))),
    slaMetPct: Math.round(avg(users.map((u) => u.slaMetPct))),
    activePeople: users.filter((u) => u.active).length,
    totalPeople: allInScope.length,
  };
}

/** One roll-up row per division, ranked by revenue touched (money-first). */
export function companyRows(divisions: Division[], users: UserActivity[]): CompanyRow[] {
  return divisions
    .map((division) => {
      const members = users.filter((u) => u.divisionId === division.id);
      return { division, ...rollUp(members, members) };
    })
    .sort((a, b) => b.revenueTouched - a.revenueTouched);
}

/** Leaderboard for a division (or all users), ranked by revenue touched. */
export function leaderboard(users: UserActivity[], divisionId?: string): UserActivity[] {
  return users
    .filter((u) => (divisionId ? u.divisionId === divisionId : true))
    .slice()
    .sort((a, b) => b.revenueTouched - a.revenueTouched);
}

export const findDivision = (divisions: Division[], id: string | undefined): Division | undefined =>
  divisions.find((d) => d.id === id);

// ── filtering ────────────────────────────────────────────────────────────────

/**
 * Cross-cutting filter applied to the whole report (every level recomputes from
 * the filtered person set). `dateRange` is carried for forward-compat but does
 * not narrow the snapshot mock data yet — the backend aggregation will honor it.
 */
export interface Filters {
  divisionIds: string[];
  userIds: string[];
  roles: string[];
  dateRange: string; // preset label, e.g. "Last 7 days" — UI-only for now
}

export const DEFAULT_DATE_RANGE = 'Last 30 days';

export const EMPTY_FILTERS: Filters = {
  divisionIds: [],
  userIds: [],
  roles: [],
  dateRange: DEFAULT_DATE_RANGE,
};

/** Narrow the person set by division / user / role. Empty arrays = no constraint. */
export function filterUsers(users: UserActivity[], f: Filters): UserActivity[] {
  return users.filter((u) => {
    if (f.divisionIds.length && !f.divisionIds.includes(u.divisionId)) return false;
    if (f.userIds.length && !f.userIds.includes(u.id)) return false;
    if (f.roles.length && !f.roles.includes(u.role)) return false;
    return true;
  });
}

/** Distinct roles present in the data, sorted. */
export const allRoles = (users: UserActivity[]): string[] =>
  Array.from(new Set(users.map((u) => u.role))).sort();

/**
 * Keep the facets internally consistent (cascading filter). Division is the top
 * of the hierarchy; Role must exist within the selected divisions; Person must
 * exist within the selected divisions AND roles. Selections that no longer fit
 * are dropped — this prevents contradictory combos (e.g. Division=Door +
 * Person=Oved, who is in Locksmith) that would otherwise show all zeros.
 */
export function reconcileFilters(f: Filters, users: UserActivity[]): Filters {
  const inDiv = (u: UserActivity) => !f.divisionIds.length || f.divisionIds.includes(u.divisionId);
  const validRoles = new Set(users.filter(inDiv).map((u) => u.role));
  const roles = f.roles.filter((r) => validRoles.has(r));
  const inRole = (u: UserActivity) => !roles.length || roles.includes(u.role);
  const validUserIds = new Set(users.filter((u) => inDiv(u) && inRole(u)).map((u) => u.id));
  const userIds = f.userIds.filter((id) => validUserIds.has(id));
  return { ...f, roles, userIds };
}

/**
 * The zoom level implied by the filter selection — this is what makes selecting a
 * Person (or a single Division) jump straight to its page:
 *   • exactly one person  → that person's scorecard (Individual)
 *   • one division, no person → that division (Division)
 *   • anything else → Company (multi-select narrows, doesn't drill)
 */
export interface Scope {
  level: ScopeLevel;
  divisionId?: string;
  userId?: string;
}

export function deriveScope(f: Filters, users: UserActivity[]): Scope {
  if (f.userIds.length === 1) {
    const u = users.find((x) => x.id === f.userIds[0]);
    if (u) return { level: 'individual', divisionId: u.divisionId, userId: u.id };
  }
  if (f.divisionIds.length === 1 && f.userIds.length === 0) {
    return { level: 'division', divisionId: f.divisionIds[0] };
  }
  return { level: 'company' };
}

/** Count of active (non-default) filter facets — drives the "N" badge + chips. */
export function activeFilterCount(f: Filters): number {
  return (
    f.divisionIds.length +
    f.userIds.length +
    f.roles.length +
    (f.dateRange !== DEFAULT_DATE_RANGE ? 1 : 0)
  );
}

// ── metric drill-down (pressable KPI cards) ──────────────────────────────────

export type MetricKey = 'revenue' | 'conversions' | 'response' | 'sla' | 'people';

export const METRIC_META: Record<MetricKey, { title: string; hint: string }> = {
  revenue: { title: 'Revenue touched', hint: 'Ranked by $ touched, with change vs the previous period' },
  conversions: { title: 'Conversions', hint: 'Conversions and conversion rate per scope' },
  response: { title: 'Avg response', hint: 'Average response time — colored by SLA band' },
  sla: { title: 'SLA met', hint: `Share of responses within the ${SLA_MINUTES}-min SLA target` },
  people: { title: 'Active people', hint: 'Active headcount by scope' },
};

/** A row in a metric drill-down: one division (company level) or one person (division level). */
export interface BreakdownSource {
  id: string;
  label: string;
  sub: string;
  revenueBearing: boolean;
  revenueTouched: number;
  prevRevenueTouched: number;
  conversions: number;
  leads: number;
  convRatePct: number;
  avgResponseSec: number;
  slaMetPct: number;
  activePeople: number;
}

// ── per-person record drill-down (pressable individual KPI cards) ─────────────

/** The pressable cards on the Individual scorecard. */
export type PersonMetricKey = 'touch' | 'response' | 'reaction' | 'active' | 'actions';

/** One record line inside a person-metric panel. */
export interface DetailRow {
  id: string;
  label: string;
  sub?: string;
  value: string;
  value2?: string; // secondary value (e.g. response time on a job row)
  band?: Band; // colored dot
}

export interface DetailSpec {
  title: string;
  hint: string;
  summary: string;
  rows: DetailRow[];
}

/**
 * Deterministic RNG seeded from a string — keeps the synthesized record lists
 * stable across renders (the report's "numbers read the same every render" rule).
 */
function seeded(seedStr: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const JOB_SERVICES = ['Rekey', 'Lockout', 'Install', 'Repair', 'Service call', 'Upgrade', 'Inspection'];

/**
 * Records behind a single Individual KPI card. Aggregates only exist per person
 * in the mock data, so job/active rows are synthesized deterministically from the
 * person's numbers; response/reaction/actions use the real per-person detail.
 */
export function personDetail(user: UserActivity, key: PersonMetricKey): DetailSpec {
  const rand = seeded(user.id + ':' + key);

  switch (key) {
    case 'touch': {
      const n = user.conversions;
      if (n <= 0) {
        return { title: '$ Touched', hint: 'Converted jobs', summary: 'No conversions in range', rows: [] };
      }
      // Distribute revenue across n jobs with deterministic jitter, exact sum.
      const weights = Array.from({ length: n }, () => 0.6 + rand() * 0.9);
      const wsum = weights.reduce((a, b) => a + b, 0);
      const amounts = weights.map((w) => Math.max(50, Math.round((user.revenueTouched * w) / wsum / 50) * 50));
      amounts[0] = (amounts[0] ?? 0) + (user.revenueTouched - amounts.reduce((a, b) => a + b, 0));
      const rows = amounts.map((amt, i) => {
        const respSec = Math.round(40 + rand() * (SLA_SECONDS * 1.8));
        const day = 2 + Math.floor(rand() * 26);
        const svc = JOB_SERVICES[Math.floor(rand() * JOB_SERVICES.length)];
        return {
          id: `job-${i}`,
          label: `J${690000 + Math.floor(rand() * 9000) + i}`,
          sub: `${svc} · Jun ${day}`,
          value: `$${amt.toLocaleString('en-US')}`,
          value2: fmtDuration(respSec),
          band: responseBand(respSec),
        };
      });
      return {
        title: '$ Touched',
        hint: 'Converted jobs · amount and response time',
        summary: `${n} jobs · $${user.revenueTouched.toLocaleString('en-US')} touched`,
        rows,
      };
    }

    case 'response': {
      const under = user.response7d.filter((s) => s <= SLA_SECONDS).length;
      const rows = user.response7d.map((s, i) => ({
        id: `resp-${i}`,
        label: DAY_LABELS[i] ?? `Day ${i + 1}`,
        sub: s <= SLA_SECONDS ? 'within SLA' : 'over SLA',
        value: fmtDuration(s),
        band: responseBand(s),
      }));
      return {
        title: 'Response time',
        hint: 'First response to a new lead, last 7 days',
        summary: `avg ${fmtDuration(user.responseSec)} · ${user.response7d.length ? Math.round((under / user.response7d.length) * 100) : 0}% under ${SLA_MINUTES}-min SLA`,
        rows,
      };
    }

    case 'reaction': {
      const rows = user.timeline
        .filter((e) => e.gapNote)
        .map((e, i) => ({ id: `react-${i}`, label: e.label, sub: e.at, value: e.gapNote!, band: e.gapTone }));
      return {
        title: 'Reaction time',
        hint: 'Time from assignment to first action',
        summary: `avg reaction ${fmtDuration(user.reactionSec)}`,
        rows,
      };
    }

    case 'active': {
      const blocks = user.heatmap.length;
      const rows = user.heatmap.map((v, i) => {
        const hour = blocks > 1 ? Math.round(8 + (i * 10) / (blocks - 1)) : 12;
        const h12 = ((hour + 11) % 12) + 1;
        const ampm = hour < 12 ? 'a' : 'p';
        return {
          id: `act-${i}`,
          label: `${h12}${ampm}`,
          sub: v > 0.66 ? 'peak' : v > 0.33 ? 'steady' : 'quiet',
          value: `${Math.round(v * 100)}%`,
          band: (v > 0.66 ? 'good' : v > 0.33 ? 'warn' : 'bad') as Band,
        };
      });
      const h = Math.floor(user.activeMinutes / 60);
      const m = user.activeMinutes % 60;
      return {
        title: 'Active time',
        hint: 'Working-hour activity intensity',
        summary: `${h}h ${m}m active · ${user.firstActionAt}–${user.lastActionAt}`,
        rows,
      };
    }

    case 'actions': {
      const rows = user.breakdown.map((b) => ({
        id: b.label,
        label: `${b.icon} ${b.label}`,
        sub: b.note,
        value: `${b.count}`,
      }));
      return {
        title: 'Actions',
        hint: 'Everything done this period, by type',
        summary: `${user.actions} actions · SLA met ${user.slaMetPct}%`,
        rows,
      };
    }
  }
}

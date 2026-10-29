// Activity report (catalog: Operations / "Activity") — pure aggregation over the
// TimelineEvent log, no Prisma/Express so it unit-tests with fixtures.
//
// Produces the per-actor `ActivityUser[]` the frontend Activity report renders
// (see frontend/src/pages/reports/activity-logic.ts `UserActivity`). The
// controller normalizes Prisma rows into `ActivityEventRow`s; this service groups
// them by actor (created_by → User), counts actions overall and by event_type,
// and derives the active-time window from first/last event timestamps.
//
// IMPORTANT — NO DIVISION. There is no division field on User or TimelineEvent, so
// real orgs get a single flat actor list (no Company→Division→Individual roll-up).
// The "Division" grouping lives ONLY in the demo mock (activity-data.ts) and must
// never be fabricated here.
//
// Money-first metrics (revenue touched, conversions, SLA %, response/reaction
// times, 7-day response, heatmap) are NOT derivable from the timeline log and are
// returned at honest zeros/empties rather than invented. The frontend renders the
// Company "actions / active people" surface from what is real.

/** One timeline event, normalized from the Prisma row by the controller. */
export interface ActivityEventRow {
  eventType: string;
  createdAt: Date;
  actorId: string | null;
  actorFirstName: string | null;
  actorLastName: string | null;
  actorRole: string | null;
}

/** A single action-type tally inside an actor's breakdown. */
export interface ActivityBreakdownRow {
  label: string; // the raw event_type, e.g. "lead.created"
  count: number;
}

/**
 * One actor's activity rollup. Field names mirror the frontend `UserActivity`
 * shape so the report consumes it directly. Non-derivable metrics are zeroed.
 */
export interface ActivityUser {
  id: string;
  name: string;
  role: string;
  active: boolean;
  // money/speed metrics are not derivable from the timeline log → honest zeros
  revenueTouched: number;
  prevRevenueTouched: number;
  conversions: number;
  leads: number;
  responseSec: number;
  prevResponseSec: number;
  reactionSec: number;
  slaMetPct: number;
  // derivable from the event log
  actions: number;
  activeMinutes: number;
  firstActionAt: string; // display time, e.g. "8:05a"
  lastActionAt: string;
  breakdown: ActivityBreakdownRow[];
}

const MS_PER_MIN = 60_000;

/** Format a Date as a compact local-ish display time, e.g. "8:05a" / "12:41p". */
export function fmtClock(d: Date): string {
  const h24 = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h24 < 12 ? 'a' : 'p';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function actorName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim() || 'Unknown';
}

interface Bucket {
  id: string;
  name: string;
  role: string;
  count: number;
  byType: Map<string, number>;
  first: Date;
  last: Date;
}

/**
 * Group timeline events into per-actor activity rollups. Events with no actor
 * (`actorId === null`, e.g. system/public events) are skipped — there is no
 * person to attribute them to. Actors are sorted by action count descending so
 * the busiest people lead. NO division grouping is produced.
 */
export function buildActivityReport(rows: ActivityEventRow[]): ActivityUser[] {
  const byActor = new Map<string, Bucket>();

  for (const row of rows) {
    if (!row.actorId) continue;
    let b = byActor.get(row.actorId);
    if (!b) {
      b = {
        id: row.actorId,
        name: actorName(row.actorFirstName, row.actorLastName),
        role: row.actorRole ?? 'Unknown',
        count: 0,
        byType: new Map(),
        first: row.createdAt,
        last: row.createdAt,
      };
      byActor.set(row.actorId, b);
    }
    b.count += 1;
    b.byType.set(row.eventType, (b.byType.get(row.eventType) ?? 0) + 1);
    if (row.createdAt < b.first) b.first = row.createdAt;
    if (row.createdAt > b.last) b.last = row.createdAt;
  }

  const users: ActivityUser[] = [...byActor.values()].map((b) => ({
    id: b.id,
    name: b.name,
    role: b.role,
    active: true,
    revenueTouched: 0,
    prevRevenueTouched: 0,
    conversions: 0,
    leads: 0,
    responseSec: 0,
    prevResponseSec: 0,
    reactionSec: 0,
    slaMetPct: 0,
    actions: b.count,
    activeMinutes: Math.max(0, Math.round((b.last.getTime() - b.first.getTime()) / MS_PER_MIN)),
    firstActionAt: fmtClock(b.first),
    lastActionAt: fmtClock(b.last),
    breakdown: [...b.byType.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((x, y) => y.count - x.count),
  }));

  users.sort((a, b) => b.actions - a.actions);
  return users;
}

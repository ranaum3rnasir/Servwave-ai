import { RRule, Weekday, Frequency, type Options } from 'rrule';

export type Cadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
export type IntervalUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type StoredStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
export type VisitStatus = 'SCHEDULED' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED';

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_HORIZON_DAYS = 7;

/** A visit reduced to the two fields the derivations care about. */
export interface VisitLike {
  status: VisitStatus;
  scheduled_date: Date;
}

/**
 * The normalized, always-structured recurrence the engine math runs on. A plan is reduced to one
 * of these via toRule() — the single boundary where legacy VisitCadence is mapped onto structure.
 */
export interface RecurrenceRule {
  unit: IntervalUnit;
  /** Interval ("every N"), >= 1. */
  count: number;
  /** Selected weekdays as 0–6 (0=Sun); only meaningful when unit === 'WEEK'. */
  byweekday: number[];
  /** "Ends on date" terminator (inclusive). null = no date terminator. */
  end_date: Date | null;
  /** "Ends after N visits" terminator. null = no count terminator. */
  occurrence_count: number | null;
}

/**
 * The minimal plan shape the derivations read. Carries BOTH the legacy enum and the optional
 * structured fields — toRule() prefers the structured fields and falls back to the enum, so
 * existing rows (structured fields null) keep working with zero data migration.
 */
export interface PlanLike {
  visit_cadence: Cadence;
  interval_unit?: IntervalUnit | null;
  interval_count?: number | null;
  byweekday?: number[] | null;
  occurrence_count?: number | null;
  start_date: Date;
  end_date: Date | null;
  status: StoredStatus;
}

export interface DerivedPlanFields {
  planned_visit_count: number | null;
  visits_remaining: number | null;
  next_due: Date;
  due_soon: boolean;
  overdue: boolean;
  emphasized: boolean;
  effective_status: StoredStatus;
}

/** Statuses that occupy a visit slot (count against the contract). CANCELLED frees its slot. */
const ACTIONED: readonly VisitStatus[] = ['SCHEDULED', 'COMPLETED', 'SKIPPED'];

// ─── rrule plumbing ──────────────────────────────────────────────────────────

const FREQ: Record<IntervalUnit, Frequency> = {
  DAY: RRule.DAILY,
  WEEK: RRule.WEEKLY,
  MONTH: RRule.MONTHLY,
  YEAR: RRule.YEARLY,
};

/** JS getUTCDay (0=Sun..6=Sat) → rrule Weekday objects (which are MO-indexed internally). */
const RRULE_WEEKDAYS: Weekday[] = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];

/**
 * Build an rrule for occurrence generation. All dates are treated as UTC (rrule's default), which
 * matches the UTC-day model the rest of the app uses. `withTerminators` is dropped for projection
 * (next-due) math — there we want the next grid date regardless of when the contract ends.
 */
function buildRRule(rule: RecurrenceRule, dtstart: Date, withTerminators: boolean): RRule {
  const options: Partial<Options> = {
    freq: FREQ[rule.unit],
    interval: Math.max(1, rule.count),
    dtstart,
  };
  if (rule.unit === 'WEEK' && rule.byweekday.length > 0) {
    options.byweekday = rule.byweekday.map((d) => RRULE_WEEKDAYS[((d % 7) + 7) % 7]);
  }
  if (withTerminators) {
    if (rule.occurrence_count != null) options.count = rule.occurrence_count;
    else if (rule.end_date != null) options.until = rule.end_date;
  }
  return new RRule(options);
}

// ─── rule <-> legacy enum boundary ───────────────────────────────────────────

const LEGACY_RULE: Record<Cadence, { unit: IntervalUnit; count: number }> = {
  WEEKLY: { unit: 'WEEK', count: 1 },
  BIWEEKLY: { unit: 'WEEK', count: 2 },
  MONTHLY: { unit: 'MONTH', count: 1 },
  QUARTERLY: { unit: 'MONTH', count: 3 },
  SEMIANNUAL: { unit: 'MONTH', count: 6 },
  ANNUAL: { unit: 'YEAR', count: 1 },
};

/**
 * Reduce a plan to its structured rule. Structured fields win when interval_unit is set; otherwise
 * the legacy VisitCadence enum is mapped (so pre-feature rows derive correctly). end_date and
 * occurrence_count are the shared terminators in either case.
 */
export function toRule(plan: PlanLike): RecurrenceRule {
  const end_date = plan.end_date ?? null;
  const occurrence_count = plan.occurrence_count ?? null;
  if (plan.interval_unit != null) {
    return {
      unit: plan.interval_unit,
      count: plan.interval_count ?? 1,
      byweekday: plan.byweekday ?? [],
      end_date,
      occurrence_count,
    };
  }
  const legacy = LEGACY_RULE[plan.visit_cadence];
  return { unit: legacy.unit, count: legacy.count, byweekday: [], end_date, occurrence_count };
}

/**
 * Map a structured rule back to the closest legacy VisitCadence, so the kept `visit_cadence`
 * column stays populated and any code reading the old enum keeps working. The structured fields
 * remain the source of truth — this is only a best-fit label.
 */
export function bestFitCadence(rule: RecurrenceRule): Cadence {
  switch (rule.unit) {
    case 'WEEK':
      return rule.count === 2 ? 'BIWEEKLY' : 'WEEKLY';
    case 'MONTH':
      if (rule.count === 3) return 'QUARTERLY';
      if (rule.count === 6) return 'SEMIANNUAL';
      if (rule.count >= 12) return 'ANNUAL';
      return 'MONTHLY';
    case 'YEAR':
      return 'ANNUAL';
    case 'DAY':
      return 'WEEKLY';
  }
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNIT_NOUN: Record<IntervalUnit, string> = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const UNIT_EVERY1: Record<IntervalUnit, string> = { DAY: 'Daily', WEEK: 'Weekly', MONTH: 'Monthly', YEAR: 'Annually' };

/** Human-readable summary, e.g. "Every 2 weeks on Mon, Thu" / "Monthly" / "Every 6 months". */
export function describeRule(rule: RecurrenceRule): string {
  const base = rule.count === 1 ? UNIT_EVERY1[rule.unit] : `Every ${rule.count} ${UNIT_NOUN[rule.unit]}s`;
  if (rule.unit === 'WEEK' && rule.byweekday.length > 0) {
    const days = [...rule.byweekday]
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_ABBR[((d % 7) + 7) % 7])
      .join(', ');
    return `${base} on ${days}`;
  }
  return base;
}

// ─── derivations ─────────────────────────────────────────────────────────────

/** Hard ceiling on generated occurrences, so a far-future end_date + DAY cadence can't materialize
 *  millions of dates per plan on a list call. occurrence_count is independently Zod-capped. */
const PLANNED_CAP = 10000;

/**
 * Inclusive count of planned visits, honoring the three terminators:
 *  - open-ended (no end date, no count) → null (the planned total is unknowable → "ongoing");
 *  - occurrence-count → that count (DTSTART counts as occurrence #1);
 *  - end-date → occurrences on/before the end date;
 *  - both → the earlier (min) of the two.
 * Generation is always bounded (by the count terminator, or by PLANNED_CAP via the iterator) so an
 * absurd end_date never blows up — see RISK review.
 */
export function plannedVisitCount(rule: RecurrenceRule, start: Date): number | null {
  const hasCount = rule.occurrence_count != null;
  const hasEnd = rule.end_date != null;
  if (!hasCount && !hasEnd) return null;
  if (!hasEnd) return rule.occurrence_count as number; // count terminator only
  const end = rule.end_date as Date;
  if (hasCount) {
    // Both terminators: generate exactly the count (bounded by occurrence_count), then keep those
    // on/before the end date. min(count, dateCount) falls out of the filter.
    return buildRRule({ ...rule, end_date: null }, start, true)
      .all()
      .filter((d) => d.getTime() <= end.getTime()).length;
  }
  // End-date terminator only: count occurrences on/before the end, capped for safety.
  let count = 0;
  buildRRule(rule, start, false).between(start, end, true, () => {
    count += 1;
    return count < PLANNED_CAP; // current date already counted; stop once we hit the ceiling
  });
  return count;
}

/** Visits that occupy a slot in the current term: actioned status AND scheduled on/after `start`. */
function termScopedActioned(visits: VisitLike[], start: Date): VisitLike[] {
  return visits.filter(
    (vi) => ACTIONED.includes(vi.status) && vi.scheduled_date.getTime() >= start.getTime(),
  );
}

/**
 * Count of in-term occupied slots. Term-scoped (`scheduled_date >= start`) so a renewal that rolls
 * the window recovers the full count; CANCELLED visits are excluded (their slot is freed).
 */
export function termScopedActionedCount(visits: VisitLike[], start: Date): number {
  return termScopedActioned(visits, start).length;
}

/** planned − in-term actioned, floored at 0. Null when planned is null (open-ended plan). */
export function visitsRemaining(planned: number | null, actionedCount: number): number | null {
  if (planned === null) return null;
  return Math.max(0, planned - actionedCount);
}

/** True when an in-term SCHEDULED (booked, not-yet-actioned) visit exists. */
export function hasBookedVisit(visits: VisitLike[], start: Date): boolean {
  return visits.some(
    (vi) => vi.status === 'SCHEDULED' && vi.scheduled_date.getTime() >= start.getTime(),
  );
}

/**
 * Reality-anchored next-due (NOT a pure counter from the sale date):
 * - if an in-term SCHEDULED visit exists, next_due = the earliest such visit's date;
 * - otherwise next_due = the first rule occurrence strictly after the latest in-term actioned
 *   visit (snapping multi-weekday/odd cadences onto the plan's grid), clamped to start_date;
 * - falling back to start_date when no in-term visit exists.
 */
export function nextDue(opts: { start: Date; rule: RecurrenceRule; visits: VisitLike[] }): Date {
  const { start, rule, visits } = opts;
  const scheduled = visits
    .filter((vi) => vi.status === 'SCHEDULED' && vi.scheduled_date.getTime() >= start.getTime())
    .sort((a, b) => a.scheduled_date.getTime() - b.scheduled_date.getTime());
  if (scheduled.length > 0) return new Date(scheduled[0].scheduled_date.getTime());

  const inTerm = termScopedActioned(visits, start);
  if (inTerm.length === 0) return new Date(start.getTime());

  const latest = inTerm.reduce((a, b) =>
    a.scheduled_date.getTime() >= b.scheduled_date.getTime() ? a : b,
  );
  const projected = buildRRule(rule, start, false).after(latest.scheduled_date, false);
  if (projected === null) return new Date(start.getTime());
  return projected.getTime() >= start.getTime() ? projected : new Date(start.getTime());
}

/** due_soon = next_due <= now + 7d (an overdue date is also due-soon). */
export function isDueSoon(next: Date, now: Date): boolean {
  return next.getTime() <= now.getTime() + DUE_SOON_HORIZON_DAYS * DAY_MS;
}

/** overdue = next_due < now. */
export function isOverdue(next: Date, now: Date): boolean {
  return next.getTime() < now.getTime();
}

/**
 * EXPIRED when the term ended or no visits remain; CANCELLED and DRAFT are sticky; else stored.
 * An open-ended plan (null end) never expires by date, and an unknown remaining (null) never
 * expires by count — it just keeps running.
 */
export function effectiveStatus(
  stored: StoredStatus,
  end: Date | null,
  remaining: number | null,
  now: Date,
): StoredStatus {
  if (stored === 'CANCELLED') return 'CANCELLED';
  if (stored === 'DRAFT') return 'DRAFT';
  const termEnded = end !== null && end.getTime() < now.getTime();
  if (termEnded || remaining === 0) return 'EXPIRED';
  return stored;
}

/**
 * The deep-module interface: derive every read-time field for a plan from its stored visits.
 * Emphasis fires only when the plan is (due_soon || overdue) AND no visit is already booked —
 * so a card stops shouting once dispatch has scheduled its next visit.
 */
export function derivePlanFields(plan: PlanLike, visits: VisitLike[], now: Date): DerivedPlanFields {
  const rule = toRule(plan);
  const planned = plannedVisitCount(rule, plan.start_date);
  const actioned = termScopedActionedCount(visits, plan.start_date);
  const remaining = visitsRemaining(planned, actioned);
  const next = nextDue({ start: plan.start_date, rule, visits });
  const due_soon = isDueSoon(next, now);
  const overdue = isOverdue(next, now);
  const booked = hasBookedVisit(visits, plan.start_date);
  return {
    planned_visit_count: planned,
    visits_remaining: remaining,
    next_due: next,
    due_soon,
    overdue,
    emphasized: (due_soon || overdue) && !booked,
    effective_status: effectiveStatus(plan.status, plan.end_date, remaining, now),
  };
}

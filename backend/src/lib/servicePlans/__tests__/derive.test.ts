import { describe, it, expect } from 'vitest';
import {
  toRule,
  bestFitCadence,
  describeRule,
  plannedVisitCount,
  termScopedActionedCount,
  visitsRemaining,
  hasBookedVisit,
  nextDue,
  isDueSoon,
  isOverdue,
  effectiveStatus,
  derivePlanFields,
  type VisitLike,
  type RecurrenceRule,
  type PlanLike,
} from '../derive';

const D = (s: string) => new Date(s);
const START = D('2026-01-01T00:00:00.000Z'); // a Thursday
const END = D('2026-12-31T00:00:00.000Z');
const NOW = D('2026-03-15T00:00:00.000Z');

const v = (status: VisitLike['status'], date: string): VisitLike => ({
  status,
  scheduled_date: D(date),
});

/** Build a RecurrenceRule with sensible defaults (every 1 month, open-ended). */
const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  unit: 'MONTH',
  count: 1,
  byweekday: [],
  end_date: null,
  occurrence_count: null,
  ...over,
});

/** Build a PlanLike (legacy MONTHLY, fixed 1-yr term) with overridable fields. */
const plan = (over: Partial<PlanLike> = {}): PlanLike => ({
  visit_cadence: 'MONTHLY',
  start_date: START,
  end_date: END,
  status: 'ACTIVE',
  ...over,
});

// ─── toRule: legacy enum → structured rule (back-compat, zero data migration) ──

describe('toRule (legacy enum mapping)', () => {
  it('maps each VisitCadence onto unit + count when no structured fields are set', () => {
    const map = (cadence: PlanLike['visit_cadence']) => {
      const r = toRule(plan({ visit_cadence: cadence }));
      return `${r.unit}/${r.count}`;
    };
    expect(map('WEEKLY')).toBe('WEEK/1');
    expect(map('BIWEEKLY')).toBe('WEEK/2');
    expect(map('MONTHLY')).toBe('MONTH/1');
    expect(map('QUARTERLY')).toBe('MONTH/3');
    expect(map('SEMIANNUAL')).toBe('MONTH/6');
    expect(map('ANNUAL')).toBe('YEAR/1');
  });

  it('carries the plan end_date / occurrence_count terminators onto the legacy rule', () => {
    const r = toRule(plan({ visit_cadence: 'MONTHLY', end_date: END, occurrence_count: 4 }));
    expect(r.end_date?.toISOString()).toBe(END.toISOString());
    expect(r.occurrence_count).toBe(4);
  });

  it('prefers the structured fields when interval_unit is set (enum becomes irrelevant)', () => {
    const r = toRule(
      plan({
        visit_cadence: 'MONTHLY', // legacy label — ignored
        interval_unit: 'WEEK',
        interval_count: 2,
        byweekday: [1, 4],
        occurrence_count: 10,
      }),
    );
    expect(r.unit).toBe('WEEK');
    expect(r.count).toBe(2);
    expect(r.byweekday).toEqual([1, 4]);
    expect(r.occurrence_count).toBe(10);
  });

  it('defaults a structured rule with interval_unit but no count to count 1', () => {
    expect(toRule(plan({ interval_unit: 'DAY' })).count).toBe(1);
  });
});

// ─── bestFitCadence: structured rule → nearest legacy enum (for the kept column) ──

describe('bestFitCadence', () => {
  it('maps a structured rule back to the closest VisitCadence', () => {
    expect(bestFitCadence(rule({ unit: 'WEEK', count: 1 }))).toBe('WEEKLY');
    expect(bestFitCadence(rule({ unit: 'WEEK', count: 2 }))).toBe('BIWEEKLY');
    expect(bestFitCadence(rule({ unit: 'MONTH', count: 1 }))).toBe('MONTHLY');
    expect(bestFitCadence(rule({ unit: 'MONTH', count: 3 }))).toBe('QUARTERLY');
    expect(bestFitCadence(rule({ unit: 'MONTH', count: 6 }))).toBe('SEMIANNUAL');
    expect(bestFitCadence(rule({ unit: 'YEAR', count: 1 }))).toBe('ANNUAL');
  });

  it('falls back to the nearest label for off-grid intervals (DAY, odd month counts)', () => {
    expect(bestFitCadence(rule({ unit: 'DAY', count: 1 }))).toBe('WEEKLY');
    expect(bestFitCadence(rule({ unit: 'WEEK', count: 5 }))).toBe('WEEKLY');
    expect(bestFitCadence(rule({ unit: 'MONTH', count: 2 }))).toBe('MONTHLY');
    expect(bestFitCadence(rule({ unit: 'YEAR', count: 3 }))).toBe('ANNUAL');
  });
});

// ─── describeRule: human-readable summary ────────────────────────────────────

describe('describeRule', () => {
  it('renders simple every-1 cadences with friendly words', () => {
    expect(describeRule(rule({ unit: 'DAY', count: 1 }))).toBe('Daily');
    expect(describeRule(rule({ unit: 'WEEK', count: 1 }))).toBe('Weekly');
    expect(describeRule(rule({ unit: 'MONTH', count: 1 }))).toBe('Monthly');
    expect(describeRule(rule({ unit: 'YEAR', count: 1 }))).toBe('Annually');
  });

  it('renders every-N cadences with the count and pluralized unit', () => {
    expect(describeRule(rule({ unit: 'DAY', count: 3 }))).toBe('Every 3 days');
    expect(describeRule(rule({ unit: 'WEEK', count: 2 }))).toBe('Every 2 weeks');
    expect(describeRule(rule({ unit: 'MONTH', count: 6 }))).toBe('Every 6 months');
    expect(describeRule(rule({ unit: 'YEAR', count: 2 }))).toBe('Every 2 years');
  });

  it('appends selected weekdays for weekly rules (sorted, abbreviated)', () => {
    expect(describeRule(rule({ unit: 'WEEK', count: 1, byweekday: [1] }))).toBe('Weekly on Mon');
    expect(describeRule(rule({ unit: 'WEEK', count: 2, byweekday: [4, 1] }))).toBe('Every 2 weeks on Mon, Thu');
    expect(describeRule(rule({ unit: 'WEEK', count: 1, byweekday: [1, 2, 3, 4, 5] }))).toBe(
      'Weekly on Mon, Tue, Wed, Thu, Fri',
    );
  });

  it('ignores byweekday for non-weekly units', () => {
    expect(describeRule(rule({ unit: 'MONTH', count: 1, byweekday: [1] }))).toBe('Monthly');
  });
});

// ─── plannedVisitCount: three terminators ────────────────────────────────────

describe('plannedVisitCount', () => {
  it('counts cadence slots inclusive of start, within an end-date term', () => {
    expect(plannedVisitCount(rule({ unit: 'MONTH', count: 1, end_date: END }), START)).toBe(12);
    expect(plannedVisitCount(rule({ unit: 'MONTH', count: 3, end_date: END }), START)).toBe(4);
    expect(plannedVisitCount(rule({ unit: 'YEAR', count: 1, end_date: END }), START)).toBe(1);
    expect(plannedVisitCount(rule({ unit: 'WEEK', count: 1, end_date: END }), START)).toBe(53);
  });

  it('returns null for an open-ended rule (no end date, no occurrence count)', () => {
    expect(plannedVisitCount(rule({ unit: 'MONTH', count: 1 }), START)).toBeNull();
  });

  it('counts daily occurrences within an end-date term', () => {
    expect(plannedVisitCount(rule({ unit: 'DAY', count: 1, end_date: D('2026-01-10T00:00:00.000Z') }), START)).toBe(10);
  });

  it('uses the occurrence-count terminator directly when set', () => {
    expect(plannedVisitCount(rule({ unit: 'WEEK', count: 2, occurrence_count: 10 }), START)).toBe(10);
  });

  it('takes the earlier of the two terminators when both are set (min)', () => {
    // 12 monthly slots fit before END, but the count caps it at 5.
    expect(plannedVisitCount(rule({ unit: 'MONTH', count: 1, end_date: END, occurrence_count: 5 }), START)).toBe(5);
    // The count (100) is larger than the 12 date-bounded slots → the date wins.
    expect(plannedVisitCount(rule({ unit: 'MONTH', count: 1, end_date: END, occurrence_count: 100 }), START)).toBe(12);
  });

  it('counts each selected weekday for a weekly multi-weekday rule', () => {
    // Mon+Thu, one calendar month (Jan 1 Thu → Jan 31): Thu 1, Mon 5, Thu 8, Mon 12, Thu 15,
    // Mon 19, Thu 22, Mon 26, Thu 29 = 9 occurrences.
    const r = rule({ unit: 'WEEK', count: 1, byweekday: [1, 4], end_date: D('2026-01-31T00:00:00.000Z') });
    expect(plannedVisitCount(r, START)).toBe(9);
  });

  it('skips short months for a monthly day-31 rule (RFC skip, not clamp)', () => {
    // Every month from Jan 31 2026 → Jan, Mar, May, Jul, Aug, Oct, Dec have a 31st (7 in the year).
    const jan31 = D('2026-01-31T00:00:00.000Z');
    const r = rule({ unit: 'MONTH', count: 1, end_date: D('2026-12-31T00:00:00.000Z') });
    expect(plannedVisitCount(r, jan31)).toBe(7);
  });
});

// ─── nextDue: reality-anchored, now rule-driven ──────────────────────────────

describe('nextDue (reality-anchored)', () => {
  const monthly = rule({ unit: 'MONTH', count: 1, end_date: END });

  it('returns the earliest upcoming SCHEDULED visit date when one is booked', () => {
    const visits = [
      v('COMPLETED', '2026-01-01T00:00:00.000Z'),
      v('SCHEDULED', '2026-05-01T00:00:00.000Z'),
      v('SCHEDULED', '2026-04-10T00:00:00.000Z'),
    ];
    expect(nextDue({ start: START, rule: monthly, visits }).toISOString()).toBe('2026-04-10T00:00:00.000Z');
  });

  it('with no SCHEDULED visit, projects one interval past the latest in-term actioned visit', () => {
    const visits = [
      v('COMPLETED', '2026-01-01T00:00:00.000Z'),
      v('COMPLETED', '2026-02-01T00:00:00.000Z'),
    ];
    expect(nextDue({ start: START, rule: monthly, visits }).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('falls back to start_date when there are no in-term visits', () => {
    expect(nextDue({ start: START, rule: monthly, visits: [] }).toISOString()).toBe(START.toISOString());
  });

  it('clamps to start_date when the latest actioned visit predates the rolled term start', () => {
    const visits = [v('COMPLETED', '2025-12-01T00:00:00.000Z')]; // prior term only
    expect(nextDue({ start: START, rule: monthly, visits }).toISOString()).toBe(START.toISOString());
  });

  it('projects onto the next selected weekday for a weekly multi-weekday rule', () => {
    // Mon+Thu weekly; latest actioned = Mon Jan 5 → next selected weekday is Thu Jan 8.
    const weekly = rule({ unit: 'WEEK', count: 1, byweekday: [1, 4] });
    const visits = [v('COMPLETED', '2026-01-05T00:00:00.000Z')];
    expect(nextDue({ start: START, rule: weekly, visits }).toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });
});

// ─── unchanged helpers (regression coverage) ─────────────────────────────────

describe('termScopedActionedCount', () => {
  it('counts SCHEDULED/COMPLETED/SKIPPED visits on or after start, excluding CANCELLED', () => {
    const visits = [
      v('COMPLETED', '2026-01-01T00:00:00.000Z'),
      v('SKIPPED', '2026-02-01T00:00:00.000Z'),
      v('CANCELLED', '2026-03-01T00:00:00.000Z'),
      v('SCHEDULED', '2026-04-01T00:00:00.000Z'),
    ];
    expect(termScopedActionedCount(visits, START)).toBe(3);
  });

  it('ignores visits scheduled before the (rolled) term start', () => {
    const visits = [
      v('COMPLETED', '2025-12-01T00:00:00.000Z'),
      v('COMPLETED', '2026-01-01T00:00:00.000Z'),
    ];
    expect(termScopedActionedCount(visits, START)).toBe(1);
  });
});

describe('visitsRemaining', () => {
  it('is planned minus term-scoped actioned, floored at 0', () => {
    expect(visitsRemaining(12, 3)).toBe(9);
    expect(visitsRemaining(4, 9)).toBe(0);
  });
  it('is null when planned is null (open-ended rule)', () => {
    expect(visitsRemaining(null, 3)).toBeNull();
  });
});

describe('hasBookedVisit', () => {
  it('is true when an in-term SCHEDULED visit exists', () => {
    expect(hasBookedVisit([v('SCHEDULED', '2026-04-01T00:00:00.000Z')], START)).toBe(true);
  });
  it('is false when only COMPLETED/SKIPPED/CANCELLED visits exist', () => {
    expect(hasBookedVisit([v('COMPLETED', '2026-01-01T00:00:00.000Z')], START)).toBe(false);
  });
  it('ignores SCHEDULED visits before the term start', () => {
    expect(hasBookedVisit([v('SCHEDULED', '2025-12-01T00:00:00.000Z')], START)).toBe(false);
  });
});

describe('isDueSoon / isOverdue', () => {
  it('due_soon is next_due <= now + 7d (includes overdue)', () => {
    expect(isDueSoon(D('2026-03-01T00:00:00.000Z'), NOW)).toBe(true);
    expect(isDueSoon(D('2026-03-20T00:00:00.000Z'), NOW)).toBe(true);
    expect(isDueSoon(D('2026-04-10T00:00:00.000Z'), NOW)).toBe(false);
  });
  it('overdue is next_due < now', () => {
    expect(isOverdue(D('2026-03-01T00:00:00.000Z'), NOW)).toBe(true);
    expect(isOverdue(D('2026-03-20T00:00:00.000Z'), NOW)).toBe(false);
  });
});

describe('effectiveStatus', () => {
  it('reports EXPIRED when the term ended or no visits remain', () => {
    expect(effectiveStatus('ACTIVE', END, 9, D('2027-01-15T00:00:00.000Z'))).toBe('EXPIRED');
    expect(effectiveStatus('ACTIVE', END, 0, NOW)).toBe('EXPIRED');
  });
  it('keeps CANCELLED and DRAFT sticky and otherwise returns the stored status', () => {
    expect(effectiveStatus('CANCELLED', END, 5, NOW)).toBe('CANCELLED');
    expect(effectiveStatus('DRAFT', END, 5, NOW)).toBe('DRAFT');
    expect(effectiveStatus('ACTIVE', END, 9, NOW)).toBe('ACTIVE');
  });
  it('never expires by date on an open-ended plan (null end); EXPIRED only when remaining is 0', () => {
    expect(effectiveStatus('ACTIVE', null, null, D('2030-01-01T00:00:00.000Z'))).toBe('ACTIVE');
    expect(effectiveStatus('ACTIVE', null, 5, NOW)).toBe('ACTIVE');
    expect(effectiveStatus('ACTIVE', null, 0, NOW)).toBe('EXPIRED');
  });
});

// ─── derivePlanFields: aggregate (legacy + structured + open-ended) ──────────

describe('derivePlanFields (aggregate)', () => {
  it('emphasizes an overdue legacy plan with no booked visit', () => {
    const visits = [v('COMPLETED', '2026-01-01T00:00:00.000Z'), v('COMPLETED', '2026-02-01T00:00:00.000Z')];
    const d = derivePlanFields(plan(), visits, NOW);
    expect(d.next_due.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(d.visits_remaining).toBe(10);
    expect(d.overdue).toBe(true);
    expect(d.due_soon).toBe(true);
    expect(d.emphasized).toBe(true);
    expect(d.effective_status).toBe('ACTIVE');
  });

  it('suppresses emphasis once a visit is booked (even if that visit is overdue)', () => {
    const visits = [v('COMPLETED', '2026-01-01T00:00:00.000Z'), v('SCHEDULED', '2026-03-01T00:00:00.000Z')];
    const d = derivePlanFields(plan(), visits, NOW);
    expect(d.next_due.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(d.overdue).toBe(true);
    expect(d.emphasized).toBe(false);
  });

  it('open-ended plan (null end): planned + remaining are null ("ongoing"), still computes next_due', () => {
    const openPlan = plan({ end_date: null });
    const visits = [v('COMPLETED', '2026-01-01T00:00:00.000Z'), v('SCHEDULED', '2026-04-10T00:00:00.000Z')];
    const d = derivePlanFields(openPlan, visits, NOW);
    expect(d.planned_visit_count).toBeNull();
    expect(d.visits_remaining).toBeNull();
    expect(d.next_due.toISOString()).toBe('2026-04-10T00:00:00.000Z');
    expect(d.effective_status).toBe('ACTIVE');
  });

  it('derives a structured rule (every 2 weeks on Mon+Thu, after 6 visits)', () => {
    const structured = plan({
      interval_unit: 'WEEK',
      interval_count: 2,
      byweekday: [1, 4],
      end_date: null,
      occurrence_count: 6,
    });
    const d = derivePlanFields(structured, [], NOW);
    expect(d.planned_visit_count).toBe(6);
    expect(d.visits_remaining).toBe(6);
  });
});

// ─── acceptance scenarios (from the implementation plan) ─────────────────────

describe('acceptance scenarios', () => {
  it('every 4 weeks on Thursday until 2026-12-31 → 14 visits, projecting onto the 4-week grid', () => {
    // START (2026-01-01) is a Thursday → byweekday [4]; 14 Thursdays fall on the 4-week grid in 2026.
    const r = rule({ unit: 'WEEK', count: 4, byweekday: [4], end_date: D('2026-12-31T00:00:00.000Z') });
    expect(plannedVisitCount(r, START)).toBe(14);
    const next = nextDue({ start: START, rule: r, visits: [v('COMPLETED', '2026-01-01T00:00:00.000Z')] });
    expect(next.toISOString()).toBe('2026-01-29T00:00:00.000Z');
  });

  it('every 6 months, forever → ongoing (null planned / remaining)', () => {
    const openPlan = plan({ interval_unit: 'MONTH', interval_count: 6, end_date: null, occurrence_count: null });
    const d = derivePlanFields(openPlan, [], NOW);
    expect(d.planned_visit_count).toBeNull();
    expect(d.visits_remaining).toBeNull();
  });
});

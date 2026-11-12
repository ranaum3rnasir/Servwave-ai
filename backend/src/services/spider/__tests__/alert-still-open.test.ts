/**
 * #3450: the one rule for "is this Spider alert still open" (alertStillOpen), which both the unread-alerts read and the
 * sweep's end step use, at its edges. The stage and the instant it was entered come from the same rule the sweep uses
 * (spiderStageOf), so these are the stays the sweep alerts.
 *
 * - Contacted with no contacted_at counts from the lead's creation and follows Contacted's limit.
 * - Walkthrough Completed follows its own limit; another stage's limit going off leaves it alone.
 * - A limit lengthened to exactly the time in the stage keeps the alert open (the sweep alerts at >=, so this is the same
 *   line); a millisecond short of it is not past.
 * - The rule reads only the settings saved now: switched off then on, or excluded then included, before any sweep ended
 *   it, the alert is open again. (After a sweep has ended it, it stays ended: spider-sweep-db "once is enough".)
 * - No settings row: only the stage visit decides.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({ prisma: {} }));

import { spiderStageOf, type SpiderLeadTimes } from '../config';
import { alertStillOpen, isPastLimit, openAlertRulesOf } from '../sweep';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

/** A New lead created 10 hours ago, with no other stamp. */
const NEW_LEAD: SpiderLeadTimes = {
  status: 'NEW', created_at: hoursAgo(10), contacted_at: null, returned_to_new_at: null, walkthrough_first_booked_at: null,
  last_visit_completed_at: null, first_estimate_sent_at: null, won_at: null, lost_at: null, cancelled_at: null,
};

type Limits = Partial<Record<'NEW' | 'CONTACTED' | 'WALKTHROUGH_COMPLETED', [boolean, number]>>;

/** The rules from a settings row with these limits (in hours; any stage not given is off) and exclusions. */
function rules(limits: Limits, excluded: string[] = []) {
  const off = { enabled: false, value: 1, unit: 'HOUR' };
  const stored: Record<string, unknown> = { NEW: off, CONTACTED: off, WALKTHROUGH_COMPLETED: off };
  for (const [stage, [enabled, value]] of Object.entries(limits)) stored[stage] = { enabled, value, unit: 'HOUR' };
  return openAlertRulesOf({ status_limits: stored as never, excluded_lead_ids: excluded });
}

/** The lead's current stay, and an alert raised for that stay. */
function stayOf(id: string, lead: SpiderLeadTimes) {
  const v = spiderStageOf(lead);
  if (!v) throw new Error('the lead is in no Spider stage');
  const visit = { id, status: v.stage, entered_at: v.enteredAt, lead_status: lead.status, created_at: lead.created_at, owner_id: null };
  return { visit, alerted: { leadId: id, status: v.stage, enteredAt: v.enteredAt.toISOString() } };
}

const open = (id: string, lead: SpiderLeadTimes, r: ReturnType<typeof rules>, now = NOW) => {
  const { visit, alerted } = stayOf(id, lead);
  return alertStillOpen(alerted, visit as never, r, now);
};

describe('alertStillOpen at its edges (#3450)', () => {
  it('Contacted with no contacted_at counts from creation and follows the Contacted limit', () => {
    const lead = { ...NEW_LEAD, status: 'CONTACTED' as const };
    const { visit } = stayOf('c', lead);
    expect(visit.status).toBe('CONTACTED');
    expect(visit.entered_at).toEqual(lead.created_at);
    expect(open('c', lead, rules({ CONTACTED: [true, 9] }))).toBe(true); // 10 h in, 9 h limit
    expect(open('c', lead, rules({ CONTACTED: [true, 11] }))).toBe(false); // lengthened past it
    expect(open('c', lead, rules({ CONTACTED: [false, 9], NEW: [true, 1] }))).toBe(false); // its stage off
  });

  it('Walkthrough Completed follows its own limit, and another stage going off leaves it alone', () => {
    const lead = {
      ...NEW_LEAD, status: 'WALKTHROUGH_COMPLETED' as const, contacted_at: hoursAgo(10), walkthrough_first_booked_at: hoursAgo(10),
      last_visit_completed_at: hoursAgo(5),
    };
    expect(stayOf('w', lead).visit.status).toBe('WALKTHROUGH_COMPLETED');
    expect(open('w', lead, rules({ WALKTHROUGH_COMPLETED: [true, 4] }))).toBe(true); // 5 h in, 4 h limit
    expect(open('w', lead, rules({ WALKTHROUGH_COMPLETED: [true, 6] }))).toBe(false);
    expect(open('w', lead, rules({ WALKTHROUGH_COMPLETED: [false, 4], NEW: [true, 1] }))).toBe(false);
    expect(open('w', lead, rules({ WALKTHROUGH_COMPLETED: [true, 4], NEW: [false, 1] }))).toBe(true);
  });

  it('a limit lengthened to exactly the time in the stage keeps it open; a millisecond short is not past', () => {
    expect(open('n', NEW_LEAD, rules({ NEW: [true, 10] }))).toBe(true); // exactly 10 h in
    expect(open('n', NEW_LEAD, rules({ NEW: [true, 10] }), new Date(NOW.getTime() - 1))).toBe(false);
    expect(isPastLimit(hoursAgo(10), { enabled: true, value: 10, unit: 'HOUR' }, NOW)).toBe(true);
    expect(isPastLimit(hoursAgo(10), { enabled: true, value: 10, unit: 'HOUR' }, new Date(NOW.getTime() - 1))).toBe(false);
  });

  it('reads only the settings saved now: off then on, or excluded then included, before a sweep, and it is open again', () => {
    expect(open('n', NEW_LEAD, rules({ NEW: [false, 2] }))).toBe(false);
    expect(open('n', NEW_LEAD, rules({ NEW: [true, 2] }))).toBe(true);
    expect(open('n', NEW_LEAD, rules({ NEW: [true, 2] }, ['n']))).toBe(false);
    expect(open('n', NEW_LEAD, rules({ NEW: [true, 2] }, ['other']))).toBe(true);
  });

  it('with no settings row only the stage visit decides', () => {
    expect(open('n', NEW_LEAD, null)).toBe(true);
    const { alerted } = stayOf('n', NEW_LEAD);
    expect(alertStillOpen(alerted, undefined, null, NOW)).toBe(false); // the lead is in no stage
  });
});

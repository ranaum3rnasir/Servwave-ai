/**
 * The contractor's Configuration-tab maths (lib/spider/watcher.ts): the stage rules the server's
 * sweep uses, his time-in-stage and overdue maths, and the unit fix.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LEAD_STAGES,
  DEFAULT_ASSIGNMENTS_CONFIG,
  buildWatcherCustomersFromLive,
  isLeadOverdue,
  resolveLeadStageAndElapsedTime,
  spiderStageOf,
  type LeadStageConfig,
  type WatcherLead,
} from '../watcher';

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const lead = (over: Record<string, unknown>) => ({
  status: 'NEW',
  created_at: ago(10 * DAY),
  contacted_at: null,
  walkthrough_first_booked_at: null,
  last_visit_completed_at: null,
  first_estimate_sent_at: null,
  won_at: null,
  lost_at: null,
  cancelled_at: null,
  ...over,
});

describe('spiderStageOf (the server sweep\'s rules)', () => {
  it.each([
    ['new, never contacted', {}, 'NEW', ago(10 * DAY)],
    ['status New with contacted_at', { contacted_at: ago(5 * DAY) }, 'CONTACTED', ago(5 * DAY)],
    ['status Contacted with no contacted_at', { status: 'CONTACTED' }, 'CONTACTED', ago(10 * DAY)],
    ['walkthrough completed', { status: 'WALKTHROUGH_COMPLETED', walkthrough_first_booked_at: ago(4 * DAY), last_visit_completed_at: ago(3 * DAY) }, 'WALKTHROUGH_COMPLETED', ago(3 * DAY)],
  ])('%s', (_name, over, stage, enteredAt) => {
    expect(spiderStageOf(lead(over))).toMatchObject({ stageId: stage, enteredAt });
  });

  it.each([
    ['status Walkthrough Scheduled with no timestamps', { status: 'WALKTHROUGH_SCHEDULED' }],
    ['status Walkthrough Completed with no visit timestamps', { status: 'WALKTHROUGH_COMPLETED', contacted_at: ago(5 * DAY) }],
    ['walkthrough booked, not completed', { status: 'WALKTHROUGH_SCHEDULED', walkthrough_first_booked_at: ago(DAY) }],
    ['estimate sent after a walkthrough', { status: 'ESTIMATED', last_visit_completed_at: ago(3 * DAY), first_estimate_sent_at: ago(DAY) }],
    ['estimate sent, no walkthrough', { status: 'ESTIMATED', contacted_at: ago(5 * DAY), first_estimate_sent_at: ago(DAY) }],
    ['won', { status: 'WON', won_at: ago(DAY) }],
    ['lost', { status: 'LOST', lost_at: ago(DAY) }],
    ['cancelled', { status: 'CONTACTED', cancelled_at: ago(DAY) }],
  ])('%s is in no stage', (_name, over) => {
    expect(spiderStageOf(lead(over))).toBeNull();
  });
});

// SPEC-4 D7: a lead whose last outbound contact was taken away is back in New, and its New stay
// starts at the move back (returned_to_new_at), exactly as the server's sweep reads it.
describe('spiderStageOf — a lead moved back to New (the server sweep\'s rule)', () => {
  it('is in New from the moment it moved back', () => {
    expect(spiderStageOf(lead({ returned_to_new_at: ago(2 * HOUR) }))).toMatchObject({ stageId: 'NEW', enteredAt: ago(2 * HOUR) });
  });

  it('is in New from its creation when it never moved back', () => {
    expect(spiderStageOf(lead({ returned_to_new_at: null }))).toMatchObject({ stageId: 'NEW', enteredAt: ago(10 * DAY) });
  });

  it('is in Contacted from its new contact once contacted again, whatever returned_to_new_at holds', () => {
    expect(spiderStageOf(lead({ status: 'CONTACTED', contacted_at: ago(HOUR), returned_to_new_at: ago(2 * HOUR) })))
      .toMatchObject({ stageId: 'CONTACTED', enteredAt: ago(HOUR) });
  });

  it('the Select Contacts for Alert list counts its time in New from the move back', () => {
    const [customer] = buildWatcherCustomersFromLive(
      [{ id: 'l1', lead_number: 'L00001', customer: { id: 'c1', first_name: 'Pat', last_name: 'Payer' }, ...lead({ returned_to_new_at: ago(2 * HOUR + MIN) }) }],
      [],
    );
    expect(customer!.leads[0]).toMatchObject({ stageId: 'NEW', elapsedValue: 2, elapsedUnit: 'Hour', returned_to_new_at: ago(2 * HOUR + MIN) });
  });
});

describe('his maths', () => {
  it('counts time in stage in the largest whole unit, from the stage start', () => {
    expect(resolveLeadStageAndElapsedTime(lead({ status: 'CONTACTED', contacted_at: ago(5 * HOUR + MIN) }))).toMatchObject({
      stageId: 'CONTACTED', elapsedValue: 5, elapsedUnit: 'Hour',
    });
    expect(resolveLeadStageAndElapsedTime(lead({}))).toMatchObject({ elapsedValue: 10, elapsedUnit: 'Day' });
  });

  it('never counts from before Spider was switched on', () => {
    expect(resolveLeadStageAndElapsedTime(lead({}), ago(2 * HOUR))).toMatchObject({ elapsedValue: 2, elapsedUnit: 'Hour' });
  });

  const stages = (id: string, duration: number, unit: LeadStageConfig['unit']): LeadStageConfig[] =>
    DEFAULT_LEAD_STAGES.map((s) => (s.id === id ? { ...s, duration, unit, enabled: true } : s));

  it('counts a limit in minutes as minutes', () => {
    const fiveMinutesIn = lead({ created_at: ago(5 * MIN + 5_000) }) as unknown as WatcherLead;
    expect(isLeadOverdue(fiveMinutesIn, stages('NEW', 10, 'Minute'), true, null)).toBe(false);
    expect(isLeadOverdue(fiveMinutesIn, stages('NEW', 5, 'Minute'), true, null)).toBe(true);
  });

  it('measures a lead against its own stage row, not the row its status is named after', () => {
    // Status still New, but contacted: the Contacted row's limit applies, never the New row's.
    const contacted = lead({ contacted_at: ago(30 * MIN) }) as unknown as WatcherLead;
    const rows = DEFAULT_LEAD_STAGES.map((s) =>
      s.id === 'NEW' ? { ...s, duration: 1, unit: 'Minute' as const, enabled: true } : s.id === 'CONTACTED' ? { ...s, duration: 2, unit: 'Hour' as const, enabled: true } : s,
    );
    expect(isLeadOverdue(contacted, rows, true, null)).toBe(false);
  });

  it('is never overdue while Spider is off or the stage is off', () => {
    const old = lead({}) as unknown as WatcherLead;
    expect(isLeadOverdue(old, stages('NEW', 1, 'Minute'), false, null)).toBe(false);
    expect(isLeadOverdue(old, DEFAULT_LEAD_STAGES, true, null)).toBe(false);
  });
});

describe('his defaults (D3)', () => {
  it('are all four roles and the owner, and three stages that start off, in minutes', () => {
    expect(DEFAULT_ASSIGNMENTS_CONFIG).toEqual({ adminRoles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'], owner: true, users: [] });
    expect(DEFAULT_LEAD_STAGES.map((s) => [s.id, s.label, s.duration, s.unit])).toEqual([
      ['NEW', 'New → Contacted', undefined, 'Minute'],
      ['CONTACTED', 'Contacted → Walkthrough Scheduled', undefined, 'Minute'],
      ['WALKTHROUGH_COMPLETED', 'Walkthrough Completed → Estimate', undefined, 'Minute'],
    ]);
  });
});

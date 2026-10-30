/**
 * Where Reopen lead puts a closed lead (Roles & Permissions, PRD 5, S05.19): the pure half, run with no database.
 * `permission-lead-reopen-db.test.ts` runs the same rules through the route against real rows.
 */
import { describe, it, expect } from 'vitest';
import type { LeadStatus } from '@prisma/client';

import { reopenLandingStatus, statusBeforeClose } from '../services/lead-reopen.service';
import type { LeadStatusFacts } from '../services/lead-status-options';

// The ledger is newest first, each row `{ from, to }` as text.
const row = (from: string | null, to: string | null) => ({ from, to });

describe('statusBeforeClose', () => {
  it('takes the from-status of the most recent row into the current closed status', () => {
    const ledger = [row('CONTACTED', 'LOST'), row('NEW', 'CONTACTED')];
    expect(statusBeforeClose(ledger, 'LOST')).toBe('CONTACTED');
  });

  it('uses the newest close when the lead was closed and reopened before', () => {
    const ledger = [row('LOST', 'CONTACTED'), row('ESTIMATED', 'LOST'), row('NEW', 'ESTIMATED')];
    // Closed again after a reopen: the newest row into Lost is the one that counts.
    expect(statusBeforeClose([row('NEW', 'LOST'), ...ledger], 'LOST')).toBe('NEW');
  });

  it("reads past a migrated lead's Cancelled-to-Lost row to the row that cancelled it", () => {
    const ledger = [row('CANCELLED', 'LOST'), row('ESTIMATED', 'CANCELLED'), row('NEW', 'ESTIMATED')];
    expect(statusBeforeClose(ledger, 'LOST')).toBe('ESTIMATED');
  });

  it('reads past a Won-to-Lost row to the row into Won', () => {
    const ledger = [row('WON', 'LOST'), row('WALKTHROUGH_COMPLETED', 'WON')];
    expect(statusBeforeClose(ledger, 'LOST')).toBe('WALKTHROUGH_COMPLETED');
  });

  it('finds nothing when the ledger has no row into the closed status, or the chain runs out', () => {
    expect(statusBeforeClose([], 'WON')).toBeNull();
    expect(statusBeforeClose([row('NEW', 'CONTACTED')], 'LOST')).toBeNull();
    expect(statusBeforeClose([row('CANCELLED', 'LOST')], 'LOST')).toBeNull();
    expect(statusBeforeClose([row(null, 'LOST')], 'LOST')).toBeNull();
  });

  it('does not loop on a ledger that points at itself', () => {
    expect(statusBeforeClose([row('LOST', 'LOST')], 'LOST')).toBeNull();
  });
});

describe('reopenLandingStatus', () => {
  const facts = (openVisits: number, finishedVisits: number, estimateSent: boolean): LeadStatusFacts => ({
    current: 'LOST', openVisits, finishedVisits, estimateSent,
  });
  const cases: Array<{ name: string; before: LeadStatus | null; facts: LeadStatusFacts; lands: LeadStatus }> = [
    { name: 'the status before the close, when the data supports it', before: 'CONTACTED', facts: facts(0, 0, false), lands: 'CONTACTED' },
    { name: 'New, when nothing else is on the lead', before: 'NEW', facts: facts(0, 0, false), lands: 'NEW' },
    { name: 'Estimate Sent, when an estimate went out', before: 'ESTIMATED', facts: facts(0, 0, true), lands: 'ESTIMATED' },
    { name: 'Contacted, when Estimate Sent has no sent estimate left and nothing was booked', before: 'ESTIMATED', facts: facts(0, 0, false), lands: 'CONTACTED' },
    { name: 'Contacted, when Walkthrough Scheduled has no open visit and none finished', before: 'WALKTHROUGH_SCHEDULED', facts: facts(0, 0, false), lands: 'CONTACTED' },
    { name: 'Walkthrough Completed, when Walkthrough Scheduled has no open visit but one finished', before: 'WALKTHROUGH_SCHEDULED', facts: facts(0, 1, false), lands: 'WALKTHROUGH_COMPLETED' },
    { name: 'Estimate Sent first, when no entry is found and an estimate went out', before: null, facts: facts(0, 1, true), lands: 'ESTIMATED' },
    { name: 'Walkthrough Scheduled, when no entry is found and a visit is still open', before: null, facts: facts(1, 0, false), lands: 'WALKTHROUGH_SCHEDULED' },
    { name: 'Walkthrough Completed, when no entry is found and a visit finished', before: null, facts: facts(0, 1, false), lands: 'WALKTHROUGH_COMPLETED' },
    { name: 'Contacted, when no entry is found and the lead has nothing else', before: null, facts: facts(0, 0, false), lands: 'CONTACTED' },
    { name: 'the furthest supported status, when New is ruled out by a finished visit', before: 'NEW', facts: facts(0, 1, false), lands: 'WALKTHROUGH_COMPLETED' },
  ];
  it.each(cases)('lands on $name', ({ before, facts: f, lands }) => {
    expect(reopenLandingStatus(before, f)).toBe(lands);
  });

  it('never lands on Won or Lost', () => {
    for (const before of [null, 'NEW', 'ESTIMATED'] as const) {
      expect(['WON', 'LOST']).not.toContain(reopenLandingStatus(before, facts(0, 0, false)));
    }
  });
});

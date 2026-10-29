/**
 * leadStatusOptions: the rules for which lead statuses can be picked by hand and why a locked one
 * is locked (walkthrough lead-statuses PRD 7.1 and 7.2). Pure function, no database.
 *
 * The expected values are written out literally, one row per combination of facts, rather than
 * recomputed from a second copy of the rules: a table that restates the implementation passes
 * whatever the implementation does.
 */
import { describe, it, expect } from 'vitest';
import type { LeadStatus } from '@prisma/client';
import { leadStatusOptions, type LeadStatusFacts } from '../services/lead-status-options';

const ESTIMATE_SENT = "An estimate was already sent to this lead, so it can't go back to this step.";
const PAST_NEW = "This lead already has a walkthrough or an estimate, so it's past New.";
const PAST_CONTACTED = "This lead already has a walkthrough or an estimate, so it's past Contacted.";
const NO_BOOKING = "There's no walkthrough booked on this lead right now.";
const STILL_BOOKED = 'A walkthrough visit is still booked on this lead.';
const NO_DONE = 'No walkthrough on this lead is done yet.';
const NO_ESTIMATE = 'No estimate has been sent to this lead yet.';

type Row = Record<'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED', string | null>;

/**
 * Every combination of open (0, 1, 2), finished (0, 1) and estimate sent (no, yes). Open 2 behaves
 * as open 1 and is covered in its own test. `null` = can be picked, a string = locked with that
 * exact text. Won, Lost and Cancelled are never in the table because they are never locked.
 */
const TABLE: Array<{ open: number; finished: number; estimate: boolean; expect: Row }> = [
  { open: 0, finished: 0, estimate: false, expect: { NEW: null, CONTACTED: null, WALKTHROUGH_SCHEDULED: NO_BOOKING, WALKTHROUGH_COMPLETED: NO_DONE, ESTIMATED: NO_ESTIMATE } },
  { open: 1, finished: 0, estimate: false, expect: { NEW: PAST_NEW, CONTACTED: PAST_CONTACTED, WALKTHROUGH_SCHEDULED: null, WALKTHROUGH_COMPLETED: STILL_BOOKED, ESTIMATED: NO_ESTIMATE } },
  { open: 0, finished: 1, estimate: false, expect: { NEW: PAST_NEW, CONTACTED: PAST_CONTACTED, WALKTHROUGH_SCHEDULED: NO_BOOKING, WALKTHROUGH_COMPLETED: null, ESTIMATED: NO_ESTIMATE } },
  { open: 1, finished: 1, estimate: false, expect: { NEW: PAST_NEW, CONTACTED: PAST_CONTACTED, WALKTHROUGH_SCHEDULED: null, WALKTHROUGH_COMPLETED: STILL_BOOKED, ESTIMATED: NO_ESTIMATE } },
  // An estimate went out: the four earlier steps all say so, and that text wins over their own.
  { open: 0, finished: 0, estimate: true, expect: { NEW: ESTIMATE_SENT, CONTACTED: ESTIMATE_SENT, WALKTHROUGH_SCHEDULED: ESTIMATE_SENT, WALKTHROUGH_COMPLETED: ESTIMATE_SENT, ESTIMATED: null } },
  { open: 1, finished: 0, estimate: true, expect: { NEW: ESTIMATE_SENT, CONTACTED: ESTIMATE_SENT, WALKTHROUGH_SCHEDULED: ESTIMATE_SENT, WALKTHROUGH_COMPLETED: ESTIMATE_SENT, ESTIMATED: null } },
  { open: 0, finished: 1, estimate: true, expect: { NEW: ESTIMATE_SENT, CONTACTED: ESTIMATE_SENT, WALKTHROUGH_SCHEDULED: ESTIMATE_SENT, WALKTHROUGH_COMPLETED: ESTIMATE_SENT, ESTIMATED: null } },
  { open: 1, finished: 1, estimate: true, expect: { NEW: ESTIMATE_SENT, CONTACTED: ESTIMATE_SENT, WALKTHROUGH_SCHEDULED: ESTIMATE_SENT, WALKTHROUGH_COMPLETED: ESTIMATE_SENT, ESTIMATED: null } },
];

// A closed lead follows the same data rules as any other (D10), so the table runs for every
// current status. Each status's OWN row is the one exception, tested separately below.
const CURRENTS: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED'];

function facts(current: LeadStatus, open: number, finished: number, estimate: boolean): LeadStatusFacts {
  return { current, openVisits: open, finishedVisits: finished, estimateSent: estimate };
}

describe('leadStatusOptions', () => {
  it('lists all eight statuses in the PRD section 5 order', () => {
    expect(leadStatusOptions(facts('NEW', 0, 0, false)).map((o) => o.status)).toEqual([
      'NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED',
    ]);
  });

  describe.each(CURRENTS)('on a %s lead', (current) => {
    it.each(TABLE)('open $open, finished $finished, estimate sent $estimate', (row) => {
      const options = leadStatusOptions(facts(current, row.open, row.finished, row.estimate));
      for (const [status, reason] of Object.entries(row.expect)) {
        if (status === current) continue; // the current status is never locked (own test)
        const option = options.find((o) => o.status === status)!;
        expect({ status, available: option.available, reason: option.reason }).toEqual({
          status,
          available: reason === null,
          reason,
        });
      }
    });

    it('never locks Won, Lost or Cancelled', () => {
      for (const row of TABLE) {
        const options = leadStatusOptions(facts(current, row.open, row.finished, row.estimate));
        for (const status of ['WON', 'LOST', 'CANCELLED']) {
          expect(options.find((o) => o.status === status)).toEqual({ status, available: true, reason: null });
        }
      }
    });
  });

  it('reports the current status as available, even when its own rule would lock it', () => {
    // A Walkthrough Scheduled lead with nothing booked contradicts its own status, but it is the
    // selected item in the menu, not a locked one.
    expect(leadStatusOptions(facts('WALKTHROUGH_SCHEDULED', 0, 0, false))[2]).toEqual({
      status: 'WALKTHROUGH_SCHEDULED', available: true, reason: null,
    });
    // Same for an Estimate Sent lead whose estimates have all been archived.
    expect(leadStatusOptions(facts('ESTIMATED', 0, 0, false))[4]).toEqual({
      status: 'ESTIMATED', available: true, reason: null,
    });
    // And for New on a lead that has an estimate out.
    expect(leadStatusOptions(facts('NEW', 0, 0, true))[0]).toEqual({ status: 'NEW', available: true, reason: null });
  });

  it('puts the estimate text before the status\'s own reason (PRD 7.2 order)', () => {
    // Walkthrough Completed with an estimate out AND nothing finished: the estimate text, not
    // "No walkthrough on this lead is done yet."
    const wc = leadStatusOptions(facts('CONTACTED', 0, 0, true))[3];
    expect(wc.reason).toBe(ESTIMATE_SENT);
    // Walkthrough Completed with a visit still booked AND an estimate out: still the estimate text.
    expect(leadStatusOptions(facts('CONTACTED', 1, 0, true))[3].reason).toBe(ESTIMATE_SENT);
  });

  it('puts "still booked" before "none done" on Walkthrough Completed', () => {
    // Open visit and no finished one: both rules apply, the first listed in 7.2 is shown.
    expect(leadStatusOptions(facts('CONTACTED', 1, 0, false))[3].reason).toBe(STILL_BOOKED);
  });

  it('treats two open visits the same as one', () => {
    const two = leadStatusOptions(facts('CONTACTED', 2, 0, false));
    const one = leadStatusOptions(facts('CONTACTED', 1, 0, false));
    expect(two).toEqual(one);
  });

  it('lets Won be picked on a New lead with no estimate (D9)', () => {
    expect(leadStatusOptions(facts('NEW', 0, 0, false))[5]).toEqual({ status: 'WON', available: true, reason: null });
  });

  it('gives a closed lead with an estimate the estimate text on the earlier steps (D10)', () => {
    // A Won lead with an approved estimate: Estimate Sent can be picked, Contacted cannot.
    const options = leadStatusOptions(facts('WON', 0, 0, true));
    expect(options[4]).toEqual({ status: 'ESTIMATED', available: true, reason: null });
    expect(options[1]).toEqual({ status: 'CONTACTED', available: false, reason: ESTIMATE_SENT });
  });
});

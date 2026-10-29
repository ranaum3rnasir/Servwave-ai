/**
 * walkthroughDrivenStatus: the one rule that decides a lead's walkthrough-driven status from
 * what its visits look like right now (walkthrough lead-statuses PRD 6.1, decisions D2-D6).
 *
 * A table over every status x open visits (0/1/2) x finished visits (0/1), plus the named cases
 * from PRD 12.1 spelled out on their own so a failure reads as a sentence.
 */
import { describe, it, expect } from 'vitest';
import type { LeadStatus } from '@prisma/client';
import { walkthroughDrivenStatus } from '../services/lead-stage.service';

const ALL: LeadStatus[] = [
  'NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED',
];
const EARLY: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED'];
const NEVER_MOVED: LeadStatus[] = ['ESTIMATED', 'WON', 'LOST', 'CANCELLED'];

/** The rule, restated independently of the implementation for the early statuses. */
function expected(current: LeadStatus, open: number, finished: number): LeadStatus {
  if (NEVER_MOVED.includes(current)) return current;
  if (open > 0) return 'WALKTHROUGH_SCHEDULED';
  if (finished > 0) return 'WALKTHROUGH_COMPLETED';
  if (current === 'WALKTHROUGH_SCHEDULED' || current === 'WALKTHROUGH_COMPLETED') return 'CONTACTED';
  return current;
}

describe('walkthroughDrivenStatus - the named cases', () => {
  it('New with one open visit becomes Walkthrough Scheduled', () => {
    expect(walkthroughDrivenStatus('NEW', 1, 0)).toBe('WALKTHROUGH_SCHEDULED');
  });
  it('Contacted with no visits at all stays Contacted', () => {
    expect(walkthroughDrivenStatus('CONTACTED', 0, 0)).toBe('CONTACTED');
  });
  it('New with no visits at all stays New', () => {
    expect(walkthroughDrivenStatus('NEW', 0, 0)).toBe('NEW');
  });
  it('Walkthrough Scheduled with one open and one finished visit stays Walkthrough Scheduled', () => {
    expect(walkthroughDrivenStatus('WALKTHROUGH_SCHEDULED', 1, 1)).toBe('WALKTHROUGH_SCHEDULED');
  });
  it('Walkthrough Scheduled with nothing open and one finished becomes Walkthrough Completed', () => {
    expect(walkthroughDrivenStatus('WALKTHROUGH_SCHEDULED', 0, 1)).toBe('WALKTHROUGH_COMPLETED');
  });
  it('Walkthrough Scheduled with nothing open and nothing finished goes back to Contacted', () => {
    expect(walkthroughDrivenStatus('WALKTHROUGH_SCHEDULED', 0, 0)).toBe('CONTACTED');
  });
  it('Walkthrough Completed with nothing open and nothing finished goes back to Contacted', () => {
    expect(walkthroughDrivenStatus('WALKTHROUGH_COMPLETED', 0, 0)).toBe('CONTACTED');
  });
  it('Walkthrough Completed with an open visit goes back to Walkthrough Scheduled', () => {
    expect(walkthroughDrivenStatus('WALKTHROUGH_COMPLETED', 1, 0)).toBe('WALKTHROUGH_SCHEDULED');
    expect(walkthroughDrivenStatus('WALKTHROUGH_COMPLETED', 1, 1)).toBe('WALKTHROUGH_SCHEDULED');
  });
  it('Contacted with an open visit becomes Walkthrough Scheduled', () => {
    expect(walkthroughDrivenStatus('CONTACTED', 1, 0)).toBe('WALKTHROUGH_SCHEDULED');
  });
  it('Contacted with only a finished visit becomes Walkthrough Completed', () => {
    expect(walkthroughDrivenStatus('CONTACTED', 0, 1)).toBe('WALKTHROUGH_COMPLETED');
  });
});

describe('walkthroughDrivenStatus - Estimate Sent, Won, Lost and Cancelled are never moved by a visit', () => {
  for (const status of NEVER_MOVED) {
    for (const open of [0, 1, 2]) {
      for (const finished of [0, 1]) {
        it(`${status} with ${open} open and ${finished} finished stays ${status}`, () => {
          expect(walkthroughDrivenStatus(status, open, finished)).toBe(status);
        });
      }
    }
  }
});

describe('walkthroughDrivenStatus - full table', () => {
  for (const status of ALL) {
    for (const open of [0, 1, 2]) {
      for (const finished of [0, 1]) {
        it(`${status} / open ${open} / finished ${finished} -> ${expected(status, open, finished)}`, () => {
          expect(walkthroughDrivenStatus(status, open, finished)).toBe(expected(status, open, finished));
        });
      }
    }
  }

  it('only ever lands on one of the four early statuses for an early status', () => {
    for (const status of EARLY) {
      for (const open of [0, 1, 2]) {
        for (const finished of [0, 1]) {
          expect(EARLY).toContain(walkthroughDrivenStatus(status, open, finished));
        }
      }
    }
  });
});

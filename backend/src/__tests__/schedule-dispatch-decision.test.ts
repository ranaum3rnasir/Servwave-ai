/**
 * The ONE decision both booking doors (POST /jobs/:id/assign and POST /jobs/:id/visits) consult
 * before announcing a schedule to the customer. Scheduling-notifications PRD, "Job is scheduled
 * fires on the date": the event fires the first time a job gains a scheduled start, crew or no
 * crew, from whichever door booked it, and never again for that job. Later moves are "Job is
 * rescheduled"; later crew changes are "Technician is assigned" (dispatched elsewhere).
 *
 * Every row here is a pure fact-in / answer-out case, so each door's mapping onto the facts is
 * the only thing left for a route test to prove.
 */
import { describe, it, expect } from 'vitest';

import { decideScheduleDispatch, type ScheduleWriteFacts } from '../lib/schedule-dispatch';

const START = new Date('2026-09-14T09:00:00.000Z');
const LATER = new Date('2026-09-16T13:00:00.000Z');
const STAMPED = new Date('2026-09-01T00:00:00.000Z');

function facts(over: Partial<ScheduleWriteFacts> = {}): ScheduleWriteFacts {
  return {
    startBefore: null,
    startAfter: null,
    additionalTrip: false,
    scheduledDispatchedAt: null,
    crewCount: 0,
    ...over,
  };
}

describe('decideScheduleDispatch', () => {
  it('a crew-only write on a scheduled job announces nothing (the crew event is not this decision)', () => {
    const decision = decideScheduleDispatch(
      facts({ startBefore: START, startAfter: START, scheduledDispatchedAt: STAMPED, crewCount: 2 }),
    );
    expect(decision).toEqual({ event: null, stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - the first scheduled start', () => {
  it('an unscheduled job given a date and NO crew is announced as scheduled, and the guard is stamped', () => {
    const decision = decideScheduleDispatch(facts({ startBefore: null, startAfter: START, additionalTrip: true, crewCount: 0 }));
    expect(decision).toEqual({ event: 'JOB_SCHEDULED', stampScheduledDispatched: true });
  });
});

describe('decideScheduleDispatch - the guard', () => {
  it('an unscheduled job re-booked after its announcement already happened is not announced twice', () => {
    const decision = decideScheduleDispatch(
      facts({ startBefore: null, startAfter: START, additionalTrip: true, scheduledDispatchedAt: STAMPED, crewCount: 1 }),
    );
    expect(decision).toEqual({ event: null, stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - a move', () => {
  it('moving the trip of an announced job is a reschedule, whoever is on it', () => {
    const decision = decideScheduleDispatch(
      facts({ startBefore: START, startAfter: LATER, additionalTrip: false, scheduledDispatchedAt: STAMPED, crewCount: 0 }),
    );
    expect(decision).toEqual({ event: 'JOB_RESCHEDULED', stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - a move the customer never heard the start of', () => {
  it('moving a job whose announcement never happened stays silent rather than saying "rescheduled" first', () => {
    const decision = decideScheduleDispatch(
      facts({ startBefore: START, startAfter: LATER, additionalTrip: false, scheduledDispatchedAt: null, crewCount: 1 }),
    );
    expect(decision).toEqual({ event: null, stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - an additional trip', () => {
  it('booking a further visit beside one the job already holds announces nothing: the job is already on the calendar', () => {
    const decision = decideScheduleDispatch(
      facts({ startBefore: START, startAfter: LATER, additionalTrip: true, scheduledDispatchedAt: STAMPED, crewCount: 2 }),
    );
    expect(decision).toEqual({ event: null, stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - a restated window', () => {
  it('restating the start at the same minute (seconds differ, or only the end changed) moves nothing and announces nothing', () => {
    const decision = decideScheduleDispatch(
      facts({
        startBefore: new Date('2026-09-14T09:00:17.000Z'),
        startAfter: new Date('2026-09-14T09:00:00.000Z'),
        additionalTrip: false,
        scheduledDispatchedAt: STAMPED,
        crewCount: 1,
      }),
    );
    expect(decision).toEqual({ event: null, stampScheduledDispatched: false });
  });
});

describe('decideScheduleDispatch - the crew is never a condition', () => {
  // The old /assign rule required a crew in the same save. This pins the PRD's "whether the crew
  // is known at fire time is not a condition"; the route suites prove it against the old door.
  it.each([0, 1, 3])('a first scheduled start with %i crew is announced exactly the same way', (crewCount) => {
    const decision = decideScheduleDispatch(facts({ startBefore: null, startAfter: START, additionalTrip: true, crewCount }));
    expect(decision).toEqual({ event: 'JOB_SCHEDULED', stampScheduledDispatched: true });
  });
});

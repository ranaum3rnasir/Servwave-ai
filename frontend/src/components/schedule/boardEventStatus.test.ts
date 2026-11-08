/**
 * MV-BOARD-10. jobToEvents fans a job into one card per visit, but every card shares
 * `raw: job` - so colouring a card off `raw.status` gives each trip the job's roll-up
 * instead of its own state.
 *
 * On staging that painted J00235's COMPLETED Friday trip in the in-flight treatment,
 * byte-identical to its own SCHEDULED sibling the following week; and the uglier
 * inverse, J00264's merely-SCHEDULED future trip on a completed job, painted faded
 * grey and read as finished.
 */
import { describe, it, expect } from 'vitest';

import { boardEventStatus, isCompletedEvent, IN_FLIGHT_STATUSES } from './scheduleModel';
import { jobToEvents } from './eventAdapters';

const NY = 'America/New_York';

/** A live job carrying one finished trip and one still to come - J00235's shape. */
const LIVE_JOB_MIXED_TRIPS = {
  id: 'job-1',
  job_number: 'J00235',
  status: 'IN_PROGRESS',
  visits: [
    { id: 'v1', visit_seq: 1, status: 'COMPLETED', scheduled_at: '2026-08-21T13:00:00.000Z' },
    { id: 'v4', visit_seq: 4, status: 'SCHEDULED', scheduled_at: '2026-08-28T13:00:00.000Z' },
  ],
};

/** A finished job whose remaining trip has not happened yet - J00264's shape. */
const COMPLETED_JOB_FUTURE_TRIP = {
  id: 'job-2',
  job_number: 'J00264',
  status: 'COMPLETED',
  visits: [
    { id: 'v9', visit_seq: 1, status: 'SCHEDULED', scheduled_at: '2026-09-10T13:00:00.000Z' },
  ],
};

describe('boardEventStatus', () => {
  it('gives each trip its OWN status, not the job roll-up', () => {
    const [done, upcoming] = jobToEvents(LIVE_JOB_MIXED_TRIPS, NY);
    expect(boardEventStatus(done!)).toBe('COMPLETED');
    expect(boardEventStatus(upcoming!)).toBe('SCHEDULED');
    // The defect: both resolved to the job's IN_PROGRESS and painted identically.
    expect(boardEventStatus(done!)).not.toBe(boardEventStatus(upcoming!));
  });

  it('does not read a completed job onto its still-scheduled trip', () => {
    const [card] = jobToEvents(COMPLETED_JOB_FUTURE_TRIP, NY);
    expect(boardEventStatus(card!)).toBe('SCHEDULED');
    expect(isCompletedEvent(card!)).toBe(false);
  });

  it('marks the finished trip completed and leaves its live sibling alone', () => {
    const [done, upcoming] = jobToEvents(LIVE_JOB_MIXED_TRIPS, NY);
    expect(isCompletedEvent(done!)).toBe(true);
    expect(isCompletedEvent(upcoming!)).toBe(false);
    expect(IN_FLIGHT_STATUSES.has(boardEventStatus(upcoming!) ?? '')).toBe(false);
  });

  it('falls back to the parent status for a job with no visit row behind it', () => {
    const bare = { id: 'job-3', job_number: 'J00239', status: 'SCHEDULED', visits: [] };
    const [card] = jobToEvents(bare, NY);
    expect(card!.visitStatus).toBeUndefined();
    expect(boardEventStatus(card!)).toBe('SCHEDULED');
  });

  it('leaves walkthroughs reading their parent, which is the only status they have', () => {
    expect(boardEventStatus({ type: 'walkthrough', raw: { status: 'NEW' } })).toBe('NEW');
  });

  it('tolerates the untyped outside-drag preview stub react-big-calendar passes in', () => {
    expect(() => boardEventStatus({ type: 'job' } as never)).not.toThrow();
  });
});

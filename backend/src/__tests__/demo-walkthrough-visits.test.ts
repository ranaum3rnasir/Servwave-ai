import { describe, it, expect } from 'vitest';
import { demoVisitsForLeadStatus } from '../lib/demo-walkthrough-visits';

/**
 * Walkthrough lead statuses, slice 01 - the demo-org seeder gives each lead visits that AGREE with
 * its status: Walkthrough Scheduled has an open visit and Walkthrough Completed has finished
 * visits and nothing open (PRD section 9). Every other status gets none.
 */
const FUTURE = new Date('2026-10-10T15:00:00Z');
const PAST = new Date('2026-10-01T15:00:00Z');
const OPEN = ['SCHEDULED'];

describe('demoVisitsForLeadStatus', () => {
  it('Walkthrough Scheduled: one open visit in the future, nothing finished', () => {
    const visits = demoVisitsForLeadStatus('WALKTHROUGH_SCHEDULED', { scheduledAt: FUTURE, completedAt: PAST });
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ status: 'SCHEDULED', scheduled_at: FUTURE, completed_at: null });
  });

  it('Walkthrough Completed: finished visits only, none open', () => {
    const visits = demoVisitsForLeadStatus('WALKTHROUGH_COMPLETED', { scheduledAt: FUTURE, completedAt: PAST });
    expect(visits.length).toBeGreaterThanOrEqual(1);
    expect(visits.filter((v) => OPEN.includes(v.status))).toEqual([]);
    for (const v of visits) {
      expect(v.status).toBe('COMPLETED');
      expect(v.completed_at).toEqual(PAST);
      expect(v.scheduled_at!.getTime()).toBeLessThanOrEqual(v.completed_at!.getTime());
    }
  });

  it.each(['NEW', 'CONTACTED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED'])('%s gets no visits', (status) => {
    expect(demoVisitsForLeadStatus(status, { scheduledAt: FUTURE, completedAt: PAST })).toEqual([]);
  });
});

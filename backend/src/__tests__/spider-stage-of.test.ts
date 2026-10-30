/**
 * spider-stage-of.test.ts — SPEC-4 §6.12.4 / §7.3: where a lead's New stay starts.
 *
 * D7 (Ran, 24 Oct): a lead whose last outbound contact is taken off it goes back to New, and Spider
 * counts that as a fresh New stay from the moment it moved back. The stay's instant is the lead's
 * `returned_to_new_at`; a lead that never moved back is in New from its creation, as before.
 *
 * SEAM: `spiderStageOf`, pure. The sweep's claim key and its counted-from both read this instant,
 * so this is the one place the rule is stated; spider-sweep-db.test.ts shows the alert it makes.
 */
import { describe, it, expect } from 'vitest';
import { spiderStageOf, type SpiderLeadTimes } from '../services/spider/config';

const CREATED = new Date('2026-10-01T09:00:00.000Z');
const CONTACTED = new Date('2026-10-02T10:00:00.000Z');
const BACK_IN_NEW = new Date('2026-10-03T11:00:00.000Z');

function lead(overrides: Partial<SpiderLeadTimes> = {}): SpiderLeadTimes {
  return {
    status: 'NEW',
    created_at: CREATED,
    contacted_at: null,
    returned_to_new_at: null,
    walkthrough_first_booked_at: null,
    last_visit_completed_at: null,
    first_estimate_sent_at: null,
    won_at: null,
    lost_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe('spiderStageOf — the New stay', () => {
  it('a lead that never moved back is in New from its creation', () => {
    expect(spiderStageOf(lead())).toEqual({ stage: 'NEW', enteredAt: CREATED });
  });

  it('a lead moved back to New is in New from the moment it moved back', () => {
    expect(spiderStageOf(lead({ returned_to_new_at: BACK_IN_NEW }))).toEqual({ stage: 'NEW', enteredAt: BACK_IN_NEW });
  });

  it('a lead contacted again after moving back is in Contacted from its new contact, whatever returned_to_new_at holds', () => {
    const again = new Date('2026-10-04T12:00:00.000Z');
    expect(spiderStageOf(lead({ status: 'CONTACTED', contacted_at: again, returned_to_new_at: BACK_IN_NEW }))).toEqual({
      stage: 'CONTACTED',
      enteredAt: again,
    });
  });

  it('a Contacted lead that never moved back is in Contacted from its contact time', () => {
    expect(spiderStageOf(lead({ status: 'CONTACTED', contacted_at: CONTACTED }))).toEqual({ stage: 'CONTACTED', enteredAt: CONTACTED });
  });
});

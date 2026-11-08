import { describe, it, expect } from 'vitest';

import { jobToEvents } from '@/components/schedule/eventAdapters';

import {
  projectCustomerSchedule,
  type CustomerSchedule, type CustomerScheduleVisit,
} from './customerSchedule';

const ANA = { id: 'u1', first_name: 'Ana', last_name: 'Lee' };
const BEN = { id: 'u2', first_name: 'Ben', last_name: 'Ortiz' };
const CY = { id: 'u3', first_name: 'Cy', last_name: 'Park' };

function visit(over: Partial<CustomerScheduleVisit> & Pick<CustomerScheduleVisit, 'id' | 'visit_seq'>): CustomerScheduleVisit {
  return {
    status: 'SCHEDULED',
    scheduled_at: '2026-10-01T14:00:00.000Z',
    scheduled_end: '2026-10-01T16:00:00.000Z',
    is_all_day: false,
    created_at: '2026-09-20T00:00:00.000Z',
    crew: [],
    ...over,
  };
}

/** The demo org's J00044 shape: three visits, a different crew on each. */
const THREE_VISIT_JOB = {
  id: 'job-3v',
  job_number: 'J00044',
  status: 'SCHEDULED',
  scope_notes: 'Replace garage door',
  visits: [
    // Deliberately NOT in time order: sorting is the projection's job, not the API's.
    visit({ id: 'v3', visit_seq: 3, scheduled_at: '2026-10-05T14:00:00.000Z', scheduled_end: '2026-10-05T17:00:00.000Z', crew: [ANA, CY] }),
    visit({ id: 'v1', visit_seq: 1, scheduled_at: '2026-10-01T14:00:00.000Z', crew: [ANA] }),
    visit({ id: 'v2', visit_seq: 2, scheduled_at: '2026-10-03T14:00:00.000Z', crew: [BEN] }),
  ],
};

const schedule = (over: Partial<CustomerSchedule>): CustomerSchedule => ({ jobs: [], leads: [], ...over });

describe('projectCustomerSchedule — one row per visit', () => {
  it('a job with three visits yields three rows, Visit 1 of 3 to Visit 3 of 3, each with its own time and crew', () => {
    const rows = projectCustomerSchedule(schedule({ jobs: [THREE_VISIT_JOB] }));

    expect(rows.map((r) => r.visitLabel)).toEqual(['Visit 1 of 3', 'Visit 2 of 3', 'Visit 3 of 3']);
    expect(rows.map((r) => r.start)).toEqual([
      '2026-10-01T14:00:00.000Z', '2026-10-03T14:00:00.000Z', '2026-10-05T14:00:00.000Z',
    ]);
    expect(rows.map((r) => r.crew)).toEqual([['Ana Lee'], ['Ben Ortiz'], ['Ana Lee', 'Cy Park']]);
    expect(rows[2]?.end).toBe('2026-10-05T17:00:00.000Z');
    expect(rows.every((r) => r.kind === 'job' && r.parentId === 'job-3v' && r.number === 'J00044')).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });
});

const TWO_WALKTHROUGH_LEAD = {
  id: 'lead-2w',
  lead_number: 'L00075',
  status: 'NEW',
  service_request: 'Quote a new gate',
  visits: [
    visit({ id: 'w1', visit_seq: 1, scheduled_at: '2026-10-02T15:00:00.000Z', crew: [BEN] }),
    visit({ id: 'w2', visit_seq: 2, scheduled_at: '2026-10-04T15:00:00.000Z', crew: [] }),
  ],
};

describe('projectCustomerSchedule — walkthroughs', () => {
  it("every walkthrough visit of a lead is its own row, interleaved with job visits by time", () => {
    const rows = projectCustomerSchedule(schedule({ jobs: [THREE_VISIT_JOB], leads: [TWO_WALKTHROUGH_LEAD] }));

    expect(rows.map((r) => [r.kind, r.visitId])).toEqual([
      ['job', 'v1'], ['walkthrough', 'w1'], ['job', 'v2'], ['walkthrough', 'w2'], ['job', 'v3'],
    ]);
    const walkthroughs = rows.filter((r) => r.kind === 'walkthrough');
    expect(walkthroughs.map((r) => r.visitLabel)).toEqual(['Visit 1 of 2', 'Visit 2 of 2']);
    expect(walkthroughs[0]).toMatchObject({ parentId: 'lead-2w', number: 'L00075', title: 'Quote a new gate', crew: ['Ben Ortiz'] });
    expect(walkthroughs[1]?.crew).toEqual([]);
  });
});

describe('projectCustomerSchedule — cancelled visits', () => {
  it('a cancelled visit stays as a marked row labelled "Visit n" with no total; the live ones count only live trips', () => {
    // J09901's shape: visits 1 and 2 live, visit 3 cancelled. The board reads "of 2", so must we.
    const job = {
      ...THREE_VISIT_JOB,
      visits: [
        visit({ id: 'v1', visit_seq: 1, scheduled_at: '2026-10-01T14:00:00.000Z' }),
        visit({ id: 'v2', visit_seq: 2, scheduled_at: '2026-10-03T14:00:00.000Z' }),
        visit({ id: 'v3', visit_seq: 3, status: 'CANCELLED', scheduled_at: '2026-10-05T14:00:00.000Z' }),
      ],
    };
    const rows = projectCustomerSchedule(schedule({ jobs: [job] }));

    expect(rows.map((r) => [r.visitId, r.cancelled, r.visitLabel])).toEqual([
      ['v1', false, 'Visit 1 of 2'],
      ['v2', false, 'Visit 2 of 2'],
      ['v3', true, 'Visit 3'],
    ]);
  });

  it('a cancelled EARLIER visit keeps the survivors on the seq axis: Visit 2 of 2 after a cancelled Visit 1', () => {
    const lead = {
      ...TWO_WALKTHROUGH_LEAD,
      visits: [
        visit({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: '2026-10-02T15:00:00.000Z' }),
        visit({ id: 'w2', visit_seq: 2, scheduled_at: '2026-10-04T15:00:00.000Z' }),
      ],
    };
    const rows = projectCustomerSchedule(schedule({ leads: [lead] }));

    expect(rows.map((r) => [r.visitId, r.cancelled, r.visitLabel])).toEqual([
      ['w1', true, 'Visit 1'],
      ['w2', false, 'Visit 2 of 2'],
    ]);
  });

  it('agrees with the scheduler board on "Visit n of m" for every live visit', () => {
    const cases = [
      [visit({ id: 'a1', visit_seq: 1 }), visit({ id: 'a2', visit_seq: 2 }), visit({ id: 'a3', visit_seq: 3, status: 'CANCELLED' })],
      [visit({ id: 'b1', visit_seq: 1, status: 'CANCELLED' }), visit({ id: 'b2', visit_seq: 2 }), visit({ id: 'b3', visit_seq: 3 })],
      [visit({ id: 'c1', visit_seq: 1, status: 'COMPLETED' }), visit({ id: 'c2', visit_seq: 2 })],
    ];
    for (const visits of cases) {
      const job = { ...THREE_VISIT_JOB, visits };
      const tabLabels = projectCustomerSchedule(schedule({ jobs: [job] }))
        .filter((r) => !r.cancelled)
        .map((r) => r.visitLabel);
      const boardLabels = jobToEvents({ ...job, customer: null }, 'America/New_York')
        .map((e) => `Visit ${e.visitSeq} of ${e.visitCount}`);
      expect(tabLabels).toEqual(boardLabels);
    }
  });
});

describe('projectCustomerSchedule — a lead marked lost', () => {
  it('its called-off walkthrough stays listed but marked cancelled, never as a live booking', () => {
    // Marking a lead lost (or cancelled) cancels its live walkthrough visit; the row must not
    // keep reading as a booked visit.
    const lost = {
      ...TWO_WALKTHROUGH_LEAD,
      status: 'LOST',
      visits: [visit({ id: 'w1', visit_seq: 1, status: 'CANCELLED', scheduled_at: '2026-10-02T15:00:00.000Z', crew: [BEN] })],
    };
    const rows = projectCustomerSchedule(schedule({ leads: [lost] }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'walkthrough', parentId: 'lead-2w', status: 'CANCELLED', cancelled: true, visitLabel: 'Visit 1' });
  });
});

describe('projectCustomerSchedule — a job with no visit yet', () => {
  it('still gets one unscheduled row, sorted after every timed row', () => {
    const unscheduled = { id: 'job-0', job_number: 'J00099', status: 'UNSCHEDULED', scope_notes: null, visits: [] };
    const rows = projectCustomerSchedule(schedule({ jobs: [unscheduled, THREE_VISIT_JOB] }));

    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      kind: 'job', parentId: 'job-0', number: 'J00099', title: 'Job',
      visitId: null, visitLabel: null, start: null, cancelled: false, crew: [],
    });
  });

  it('a lead with no walkthrough visit contributes no row (nothing is booked)', () => {
    const rows = projectCustomerSchedule(schedule({ leads: [{ ...TWO_WALKTHROUGH_LEAD, visits: [] }] }));
    expect(rows).toEqual([]);
  });
});

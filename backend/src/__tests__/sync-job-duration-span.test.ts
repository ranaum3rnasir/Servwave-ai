/**
 * Multi-visit S8 §4 (D14(i), decision A2+): syncJobFromVisits also maintains the BACKWARD-
 * LOOKING duration span - first_visit_start / last_visit_end / last_visit_completed_at - over
 * the same non-cancelled visit set the milestone mirror uses (see sync-job-milestone-mirror.
 * test.ts for that half). Fixture shape and the `runSync` helper are copied from that file
 * rather than imported, matching this suite's existing per-slice test-file convention.
 *
 *   first_visit_start       = MIN(scheduled_at)   over non-cancelled visits   [PLANNED start]
 *   last_visit_end          = MAX(scheduled_end)  over non-cancelled visits   [PLANNED end]
 *   last_visit_completed_at = MAX(completed_at)   over non-cancelled visits   [ACTUAL end]
 *
 * Unlike the milestone mirror, there is no "leave it alone" branch: these three columns have no
 * job-level writer of their own to protect, so "no qualifying visit" is always an unconditional
 * NULL - proven by the zero-visits case below.
 */
import { describe, it, expect, vi } from 'vitest';

import { syncJobFromVisits } from '../services/walkthrough.service';

const JOB_ID = 'job-1';
const ORG_ID = 'org-1';

function visit(over: Record<string, unknown> = {}) {
  return {
    id: 'v1', organization_id: ORG_ID, job_id: JOB_ID, lead_id: null,
    visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-01T13:00:00.000Z'),
    scheduled_end: new Date('2026-09-01T15:00:00.000Z'),
    is_all_day: false,
    en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    cancelled_at: null, created_at: new Date('2026-08-20T12:00:00.000Z'),
    ...over,
  };
}

const DEFAULT_JOB = { status: 'SCHEDULED', started_at: null, en_route_at: null, on_site_at: null };

/** Runs the sync against a fake tx and returns the `data` it wrote to the job row. */
async function runSync(visits: Record<string, unknown>[], job: Record<string, unknown> = DEFAULT_JOB) {
  const update = vi.fn().mockResolvedValue({});
  const tx = {
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    job: { findUnique: vi.fn().mockResolvedValue(job), update },
  } as never;
  await syncJobFromVisits(tx, { jobId: JOB_ID, orgId: ORG_ID });
  return update.mock.calls[0][0].data as Record<string, unknown>;
}

describe('syncJobFromVisits maintains the duration span (A2+)', () => {
  it('3 visits, one CANCELLED: span columns are computed over the non-cancelled set only', async () => {
    // The cancelled visit is the earliest by scheduled_at AND carries the latest scheduled_end
    // and completed_at of the three - if any of it leaked into the aggregates, this test would
    // pick it up on every column.
    const cancelled = visit({
      id: 'cancelled', status: 'CANCELLED',
      scheduled_at: new Date('2026-08-01T09:00:00.000Z'),
      scheduled_end: new Date('2026-09-05T09:00:00.000Z'),
      completed_at: new Date('2026-09-10T09:00:00.000Z'),
      cancelled_at: new Date('2026-08-02T09:00:00.000Z'),
    });
    const earliest = visit({
      id: 'earliest', status: 'COMPLETED',
      scheduled_at: new Date('2026-08-10T09:00:00.000Z'),
      scheduled_end: new Date('2026-08-10T11:00:00.000Z'),
      completed_at: new Date('2026-08-10T11:05:00.000Z'),
    });
    const latest = visit({
      id: 'latest', status: 'COMPLETED',
      scheduled_at: new Date('2026-08-20T09:00:00.000Z'),
      scheduled_end: new Date('2026-08-20T11:00:00.000Z'),
      completed_at: new Date('2026-08-21T09:00:00.000Z'),
    });
    const data = await runSync([cancelled, earliest, latest]);
    expect(data.first_visit_start).toEqual(earliest.scheduled_at);
    expect(data.last_visit_end).toEqual(latest.scheduled_end);
    expect(data.last_visit_completed_at).toEqual(latest.completed_at);
  });

  it('cancelling the earliest trip moves first_visit_start forward to the next one', async () => {
    const first = new Date('2026-08-01T09:00:00.000Z');
    const second = new Date('2026-08-15T09:00:00.000Z');

    const beforeCancel = await runSync([
      visit({ id: 'a', status: 'SCHEDULED', scheduled_at: first }),
      visit({ id: 'b', status: 'SCHEDULED', scheduled_at: second }),
    ]);
    expect(beforeCancel.first_visit_start).toEqual(first);

    const afterCancel = await runSync([
      visit({ id: 'a', status: 'CANCELLED', scheduled_at: first, cancelled_at: first }),
      visit({ id: 'b', status: 'SCHEDULED', scheduled_at: second }),
    ]);
    expect(afterCancel.first_visit_start).toEqual(second);
  });

  it('a job with zero visits gets all three span columns NULL - unconditionally, not "write nothing"', async () => {
    const data = await runSync([], { status: 'UNSCHEDULED', started_at: null, en_route_at: null, on_site_at: null });
    expect(data.first_visit_start).toBeNull();
    expect(data.last_visit_end).toBeNull();
    expect(data.last_visit_completed_at).toBeNull();
  });

  it('completing a visit sets last_visit_completed_at, and rewinding it clears the column back', async () => {
    const completedAt = new Date('2026-08-22T15:00:00.000Z');

    const completed = await runSync([visit({ status: 'COMPLETED', completed_at: completedAt })]);
    expect(completed.last_visit_completed_at).toEqual(completedAt);

    // A backward move (en-route on a previously-COMPLETED visit) nulls the visit's own
    // completed_at - the mirror must follow, not keep the stale stamp.
    const rewound = await runSync([visit({ status: 'EN_ROUTE', completed_at: null, en_route_at: completedAt })]);
    expect(rewound.last_visit_completed_at).toBeNull();
  });
});

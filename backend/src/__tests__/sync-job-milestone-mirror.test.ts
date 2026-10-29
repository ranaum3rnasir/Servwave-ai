/**
 * Section 4.1 of the multi-visit QA run: jobs.started_at is write-once in practice, so a
 * job can answer IN_PROGRESS for ever.
 *
 * syncJobFromVisits' `earliest()` helper wrote a milestone column only when SOME visit
 * still carried a stamp, and returned {} otherwise - so the column could be set but never
 * cleared. deriveJobStatusFromVisits opens on that column, so rule 1 permanently outranked
 * both the cancelled-exclusion in rule 2 and the live-set test in rule 3.
 *
 * Two routes were reproduced on staging:
 *
 *   1. Create a job, add one visit, start it, cancel it. The job reads IN_PROGRESS with
 *      zero live visits and a blanked hero (J00258). MV-LIFE-05 - the same shape without
 *      the Start - correctly gives UNSCHEDULED.
 *   2. A backward correction does not re-derive. POST .../en-route on a COMPLETED visit
 *      correctly rewinds the VISIT's started_at and completed_at, but jobs.started_at
 *      survived, so the job still answered IN_PROGRESS where Appendix B row 3 gives
 *      SCHEDULED for a lone EN_ROUTE visit.
 *
 * walkthrough.service's own docstring on VISIT_MILESTONE_COLUMNS predicted exactly this:
 * "the job would keep answering IN_PROGRESS ... silently undoing the dispatcher's
 * correction". The rewind it prescribes was implemented on the visit row and not on the
 * job mirror, so the failure it was written to prevent still happened one level up.
 *
 * The one case that must NOT rewind is the urgent workflow (story 45): a job created
 * UNSCHEDULED and started on the spot has no visit at all, so the whole visit set says
 * "nobody has started" while the crew is in the customer's house. Booking the return trip
 * must not then null the job's own stamp.
 */
import { describe, it, expect, vi } from 'vitest';

import { syncJobFromVisits } from '../services/walkthrough.service';

const JOB_ID = 'job-1';
const ORG_ID = 'org-1';

// Ordering is the whole point of these fixtures. A trip is BOOKED before it is worked, so
// a job stamp that came from a visit is always LATER than that visit's created_at; the
// urgent workflow is the one case where the job's stamp comes first.
const T_BOOKED = new Date('2026-08-20T12:00:00.000Z'); // visit row created
const T_WORKED = new Date('2026-08-20T14:00:00.000Z'); // it was then started
const T_LATER = new Date('2026-08-20T16:00:00.000Z'); // a trip booked after a job-level start

function visit(over: Record<string, unknown> = {}) {
  return {
    id: 'v1', organization_id: ORG_ID, job_id: JOB_ID, lead_id: null,
    visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-01T13:00:00.000Z'),
    scheduled_end: new Date('2026-09-01T15:00:00.000Z'),
    is_all_day: false,
    en_route_at: null, on_site_at: null, started_at: null, completed_at: null,
    cancelled_at: null, created_at: T_BOOKED,
    ...over,
  };
}

/** Runs the sync against a fake tx and returns the `data` it wrote to the job row. */
async function runSync(visits: Record<string, unknown>[], job: Record<string, unknown>) {
  const update = vi.fn().mockResolvedValue({});
  const tx = {
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    job: { findUnique: vi.fn().mockResolvedValue(job), update },
  } as never;
  await syncJobFromVisits(tx, { jobId: JOB_ID, orgId: ORG_ID });
  return update.mock.calls[0][0].data as Record<string, unknown>;
}

describe('syncJobFromVisits mirrors the milestone columns off the live visit set', () => {
  it('mirrors a visit start onto the job', async () => {
    const data = await runSync(
      [visit({ status: 'IN_PROGRESS', started_at: T_WORKED })],
      { status: 'SCHEDULED', started_at: null, en_route_at: null, on_site_at: null },
    );
    expect(data.started_at).toEqual(T_WORKED);
  });

  it('REWINDS the job when a backward correction cleared the visit stamp - route 2', async () => {
    // The visit was driven back to EN_ROUTE, which nulls its started_at and completed_at.
    const data = await runSync(
      [visit({ status: 'EN_ROUTE', en_route_at: T_WORKED, started_at: null })],
      { status: 'IN_PROGRESS', started_at: T_WORKED, en_route_at: null, on_site_at: null },
    );
    expect(data.started_at).toBeNull();
    // Appendix B row 3: a lone EN_ROUTE visit is SCHEDULED, not IN_PROGRESS.
    expect(data.status).toBe('SCHEDULED');
  });

  it('releases a job whose only started trip was called off - route 1', async () => {
    // A CANCELLED row keeps its stamps as history (D19) and must not read as work done -
    // deriveJobStatusFromVisits already excludes them, and the mirror now agrees.
    const data = await runSync(
      [visit({ status: 'CANCELLED', started_at: T_WORKED, cancelled_at: T_WORKED })],
      { status: 'IN_PROGRESS', started_at: T_WORKED, en_route_at: null, on_site_at: null },
    );
    expect(data.started_at).toBeNull();
    expect(data.status).toBe('UNSCHEDULED');
  });

  it('leaves a job-level start alone when the job holds no visits at all', async () => {
    // The urgent workflow: started on the spot, no trip booked yet.
    const data = await runSync(
      [],
      { status: 'IN_PROGRESS', started_at: T_WORKED, en_route_at: null, on_site_at: null },
    );
    expect(data).not.toHaveProperty('started_at');
  });

  it('does not null a job-level start when a return trip is booked afterwards', async () => {
    // Story 45. The job was started before this visit existed, so the visit set saying
    // "nobody has started" is not evidence that nobody has.
    const data = await runSync(
      // The job was started at T_WORKED; this trip was only booked at T_LATER, so the visit
      // set saying "nobody has started" is not evidence that nobody has.
      [visit({ status: 'SCHEDULED', created_at: T_LATER })],
      { status: 'IN_PROGRESS', started_at: T_WORKED, en_route_at: null, on_site_at: null },
    );
    expect(data).not.toHaveProperty('started_at');
  });

  // S8 (RATIFIED): en_route_at/on_site_at are DROPPED from `jobs` entirely - there is no job-level
  // mirror left to rewind. Only started_at survives (deriveJobStatus's urgent-workflow branch
  // still needs it); en_route_at/on_site_at are NEVER written to the job row again, no matter what
  // the visit set's OWN en_route_at/on_site_at columns say. This replaces the pre-drop test of the
  // same name, which asserted the mirror DID rewind those two columns.
  it('never writes en_route_at or on_site_at to the job row, even when the visit set is mid-rewind', async () => {
    // Driving a trip back to EN_ROUTE nulls ITS OWN on_site_at and started_at (visit-level fact,
    // untouched by this assertion) - only started_at is still mirrored onto the job.
    const data = await runSync(
      [visit({ status: 'EN_ROUTE', en_route_at: T_WORKED, on_site_at: null, started_at: null })],
      { status: 'IN_PROGRESS', started_at: T_WORKED },
    );
    expect(data).not.toHaveProperty('en_route_at');
    expect(data).not.toHaveProperty('on_site_at');
    expect(data.started_at).toBeNull();
  });

  it('leaves the job milestones alone when NO trip has ever been worked', async () => {
    // The urgent-workflow shape from the other side: the job carries stamps, the visit set
    // has never been touched, so the visit set is not evidence that the work stopped.
    const data = await runSync(
      [visit({ status: 'SCHEDULED' })],
      { status: 'IN_PROGRESS', started_at: T_WORKED, en_route_at: T_WORKED, on_site_at: T_WORKED },
    );
    expect(data).not.toHaveProperty('started_at');
    expect(data).not.toHaveProperty('en_route_at');
    expect(data).not.toHaveProperty('on_site_at');
  });

  it('takes the EARLIEST stamp across the live set', async () => {
    const early = new Date('2026-08-21T10:00:00.000Z');
    const late = new Date('2026-08-22T10:00:00.000Z');
    const data = await runSync(
      [
        visit({ id: 'a', status: 'COMPLETED', started_at: late }),
        visit({ id: 'b', status: 'IN_PROGRESS', started_at: early }),
      ],
      { status: 'SCHEDULED', started_at: null, en_route_at: null, on_site_at: null },
    );
    expect(data.started_at).toEqual(early);
  });

  it('ignores a cancelled row when picking the earliest', async () => {
    const cancelledEarly = new Date('2026-08-19T10:00:00.000Z');
    const liveLater = new Date('2026-08-22T10:00:00.000Z');
    const data = await runSync(
      [
        visit({ id: 'a', status: 'CANCELLED', started_at: cancelledEarly, cancelled_at: cancelledEarly }),
        visit({ id: 'b', status: 'IN_PROGRESS', started_at: liveLater }),
      ],
      { status: 'SCHEDULED', started_at: null, en_route_at: null, on_site_at: null },
    );
    expect(data.started_at).toEqual(liveLater);
  });
});

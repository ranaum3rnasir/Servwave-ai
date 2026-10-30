/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.12 - the pieces of the Missing crew test every reader shares.

   The Schedule's "No crew" filter, the dashboard tile and the Needs Attention item all build their query from
   `lib/missingCrew`; this checks the pure builders, without a database. The rows they select are checked against a
   real database in missing-crew-db.test.ts and permission-schedule-no-crew-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  MISSING_CREW_JOB_STATUSES,
  missingCrewBookedVisit,
  missingCrewJobWhere,
  missingCrewLeadWhere,
  missingCrewVisitWhereIn,
  missingCrewWindowEnd,
} from '../lib/missingCrew';
import { COMPLETED_OR_LATER_JOB_STATUSES, JOB_STATUS_ORDER } from '../lib/job-status-order';
import { OPEN_LEAD_STATUSES } from '../services/lead-status-options';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const ZONE = 'America/New_York';

describe('the Missing crew statuses', () => {
  it('are the job statuses that are neither Cancelled nor completed-or-later', () => {
    expect([...MISSING_CREW_JOB_STATUSES]).toEqual(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS']);
  });

  it('leave out every status of the shared completed-or-later set, and Cancelled', () => {
    for (const status of COMPLETED_OR_LATER_JOB_STATUSES) expect(MISSING_CREW_JOB_STATUSES).not.toContain(status);
    expect(MISSING_CREW_JOB_STATUSES).not.toContain('CANCELLED');
  });

  it('place every job status either in the set or in one the shared lists leave out', () => {
    const left = [...COMPLETED_OR_LATER_JOB_STATUSES, 'CANCELLED'];
    expect([...MISSING_CREW_JOB_STATUSES, ...left].sort()).toEqual([...JOB_STATUS_ORDER].sort());
  });
});

describe('the window', () => {
  it('runs to the end of the 7th calendar day in the company\'s zone, counting today', () => {
    // 8:00 AM on Oct 12 in New York: the 7th day is Oct 18, which ends where Oct 19 begins (4:00 AM UTC, daylight time).
    expect(missingCrewWindowEnd(NOW, ZONE)).toEqual(new Date('2026-10-19T04:00:00.000Z'));
  });

  it('reads today on the company\'s clock, not on the server\'s', () => {
    // 10:00 PM on Oct 12 in New York is already Oct 13 in UTC; the company\'s today is still Oct 12.
    expect(missingCrewWindowEnd(new Date('2026-10-13T02:00:00.000Z'), ZONE)).toEqual(new Date('2026-10-19T04:00:00.000Z'));
    expect(missingCrewWindowEnd(new Date('2026-10-13T02:00:00.000Z'), 'Pacific/Auckland')).toEqual(new Date('2026-10-19T11:00:00.000Z'));
  });

  it('does not slip an hour across the clocks going back', () => {
    // The 7th day from Oct 26 is Nov 1, the day the clocks go back (25 hours long): the window ends where Nov 2 begins, 5:00 AM UTC.
    expect(missingCrewWindowEnd(new Date('2026-10-26T12:00:00.000Z'), ZONE)).toEqual(new Date('2026-11-02T05:00:00.000Z'));
  });
});

describe('the booked visit', () => {
  it('is live, timed from now to the end of the window, and has nobody on its crew', () => {
    const where = missingCrewBookedVisit(NOW, ZONE);
    expect(where.assignees).toEqual({ none: {} });
    expect(where.scheduled_at).toEqual({ gte: NOW, lt: new Date('2026-10-19T04:00:00.000Z') });
    expect(where.status).toEqual({ in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] });
  });
});

describe('the builders over a record', () => {
  it('a job is in it by status and by holding a booked visit', () => {
    expect(missingCrewJobWhere(NOW, ZONE)).toEqual({
      status: { in: [...MISSING_CREW_JOB_STATUSES] },
      visits: { some: missingCrewBookedVisit(NOW, ZONE) },
    });
  });

  it('a lead is in it by being open and by holding a booked visit', () => {
    expect(missingCrewLeadWhere(NOW, ZONE)).toEqual({
      status: { in: [...OPEN_LEAD_STATUSES] },
      visits: { some: missingCrewBookedVisit(NOW, ZONE) },
    });
  });
});

describe('the visit builder over a row scope', () => {
  it('holds the company and both scopes, each under its own record', () => {
    const jobScope = { dispatcher_id: 'u1' };
    const leadScope = { commission_owner_id: 'u1' };
    const where = missingCrewVisitWhereIn({ organization_id: 'org1' }, { job: jobScope, lead: leadScope }, NOW, ZONE);
    expect(where.organization_id).toBe('org1');
    expect(where.OR).toEqual([
      { job: { AND: [jobScope, { status: { in: [...MISSING_CREW_JOB_STATUSES] } }] } },
      { lead: { AND: [leadScope, { status: { in: [...OPEN_LEAD_STATUSES] } }] } },
    ]);
  });

  it('holds no walkthrough half when the person may not see leads (their lead scope is null)', () => {
    const jobScope = { dispatcher_id: 'u1' };
    const where = missingCrewVisitWhereIn({ organization_id: 'org1' }, { job: jobScope, lead: null }, NOW, ZONE);
    expect(where.OR).toEqual([{ job: { AND: [jobScope, { status: { in: [...MISSING_CREW_JOB_STATUSES] } }] } }]);
  });
});

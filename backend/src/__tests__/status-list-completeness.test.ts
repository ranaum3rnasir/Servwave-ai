import { describe, it, expect } from 'vitest';
import { JobStatus, VisitStatus } from '@prisma/client';
import { STATUS_LABEL } from '../services/jobs-report';

const ALL_STATUSES = Object.values(JobStatus);

describe('every JobStatus is handled', () => {
  it('has five values - a new one means every list in this file needs review', () => {
    // Multi-visit S4 (D12/D17) narrowed this from seven. EN_ROUTE and ON_SITE are properties of a
    // TRIP, not of a job, and moved to VisitStatus; UNSCHEDULED / SCHEDULED / IN_PROGRESS are
    // DERIVED from the visit set and COMPLETED / CANCELLED are human-set.
    expect(ALL_STATUSES.sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'IN_PROGRESS', 'SCHEDULED', 'UNSCHEDULED'],
    );
  });

  it('jobs-report labels every status', () => {
    for (const s of ALL_STATUSES) expect(STATUS_LABEL[s]).toBeDefined();
  });

  it('keeps EN_ROUTE and ON_SITE reachable, on the VISIT', () => {
    // The information Spec B1's B-8 asked for is not lost, it moved: a dispatcher can still tell
    // "on the way" from "on site" from "working", one level down.
    expect(Object.values(VisitStatus).sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_SITE', 'SCHEDULED'],
    );
  });
});

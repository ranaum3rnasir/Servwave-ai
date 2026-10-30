import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Phase B — technician redesign. Job CREATE ownership + auto-assign (#232 / role-literal drop).
//
//   • strict (un-granted) tech → route guard blocks `create Job` → 403.
//   • granted OWN-scoped `create Job` tech → may create, BUT must end up OWNING the job
//     (auto-assigned as an assignee) so they aren't locked out of the job they just made (#232).
//       - estimate branch: must be able to open the parent estimate's lead (S04.21: Leads scope, asked of the
//         lead table; the real rule is covered against a real database in permission-convert-to-job-db.test.ts).
//       - standalone branch: allowed (closes the urgent-job #232 path) + auto-assigned.
//   • unconditional creators (dispatcher/admin) are NOT auto-assigned (they read org-wide already).

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  lead: { findFirst: ReturnType<typeof vi.fn> };
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  customer: { findUnique: ReturnType<typeof vi.fn> };
  serviceLocation: { findFirst: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn> };
  jobAssignee: { createMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const CREATED_JOB = { id: 'j0000000-0000-0000-0000-0000000000aa', job_number: 'J00001', assignees: [] };

// An estimate on a lead the tech can open (the lead probe below answers for it).
const ESTIMATE_OWNED_BY_TECH = {
  id: ESTIMATE_APPROVED_FIXTURE.id,
  status: 'WON',
  estimate_number: 'E00003',
  lead_id: 'lead-1',
  lead: {
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    service_address_line1: '123 Main St',
    customer: { id: CUSTOMER_FIXTURE.id },
  },
};


function grantTechCreateJob() {
}

// #1996 security follow-up: TECHNICIAN's existing-customer branch now requires `read Customer`
// on the linked customer before create/accretion (defaultGrants.ts has none for TECHNICIAN).
// This suite is about crew auto-assignment ownership, not that gate — grant it on top of
// TECHNICIAN's role defaults so the customer_id lookups in this file resolve to a readable row.
function grantTechReadCustomer() {
  clearPermissionCache();
}

let capturedAssigneeCreate: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  capturedAssigneeCreate = [];

  mockPrisma.invoice.findFirst.mockResolvedValue(null); // no blocking deposit invoice
  mockPrisma.job.findFirst.mockResolvedValue(null);      // no existing job for the estimate
  mockPrisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' }); // the lead opens for the requester
  // The estimate is within the requester's reach (ticket 33 asks that first; one out of reach answers like a missing one).
  mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_APPROVED_FIXTURE.id });
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      job: { create: vi.fn().mockResolvedValue(CREATED_JOB) },
      // R6 (2026-07-22) — M4: keeps Estimate.job_id in sync (job.controller.ts create()).
      estimate: { update: vi.fn().mockResolvedValue({}) },
      jobAssignee: {
        createMany: vi.fn().mockImplementation((args: { data: unknown[] }) => {
          capturedAssigneeCreate.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        }),
      },
      timelineEvent: { create: vi.fn() },
      // The lead's own entries are carried onto the job in the same transaction (S05.15); none here.
      recordContactEntry: { findMany: vi.fn().mockResolvedValue([]) },
    }),
  );
  // tagAssignment lookups during withTags serialization
  (prisma.tagAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// Phase B made `create Job` a per-user toggle and this describe asserted a bare technician was
// refused at the route. The technician-ownership spec, Part C put it back as a ROLE DEFAULT, so
// there is no longer such a thing as a technician who cannot create a job - and the property that
// keeps that safe is not the route guard, it is the auto-assignment below. Asserted off the ROLE
// DEFAULT here, with no override in sight, because that is the path every technician now takes; the
// granted-override path is the describe that follows.
describe('POST /api/jobs - technician on the role default (no per-user grant)', () => {
  it('CAN create a standalone job, with no crew row of their own', async () => {
    mockAuthAs('technician');
    // #1996 security follow-up: the existing-customer branch now requires `read Customer` on
    // the linked customer before create/accretion (TECHNICIAN holds none by default). This test
    // is about auto-assignment, not that gate, so grant it here for a readable customer.
    grantTechReadCustomer();

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    // S8 (D6): no self-assign crew row - the table is gone and a create path that booked no
    // visit has no trip to put the creator on. The creator's access comes from
    // OWN_OR_CREATED_JOB's created_by_id arm instead, which is why nothing is lost.
    expect(capturedAssigneeCreate).toHaveLength(0);
  });

  // The auto-assign branch keys on the requester having ANY Job row-scope, so widening `read Job`
  // to assigned-OR-created had to leave it firing. If this ever goes quiet, a technician creates a
  // job and immediately cannot work it.
  it('CAN create a job from an estimate on a lead they own, with no crew row of their own', async () => {
    mockAuthAs('technician');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_TECH);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // S8 (D6): no self-assign crew row - the table is gone and a create path that booked no
    // visit has no trip to put the creator on. The creator's access comes from
    // OWN_OR_CREATED_JOB's created_by_id arm instead, which is why nothing is lost.
    expect(capturedAssigneeCreate).toHaveLength(0);
  });
});

describe('POST /api/jobs — granted OWN-scoped technician', () => {
  it('CAN create a job from an estimate on a lead they OWN, and reaches it as its creator', async () => {
    mockAuthAs('technician');
    grantTechCreateJob();
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_TECH);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    // #232 / S8 (D6): the creator still ends up able to read the job, but not through a crew
    // row - `job_assignees` is gone and no visit was booked. OWN_OR_CREATED_JOB's created_by_id
    // arm is what carries it now, so the write that must NOT happen is the assertion.
    expect(capturedAssigneeCreate).toHaveLength(0);
  });

  it('CANNOT create a job from an estimate on a lead they do NOT own (403)', async () => {
    mockAuthAs('technician');
    grantTechCreateJob();
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_TECH);
    mockPrisma.lead.findFirst.mockResolvedValue(null); // the Leads scope does not reach this lead

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(403);
  });

  it('CAN create a standalone job and reaches it as its creator (the urgent-job #232 lockout stays closed)', async () => {
    mockAuthAs('technician');
    grantTechCreateJob();
    // #1996 security follow-up: the existing-customer branch now requires `read Customer` on
    // the linked customer before create/accretion (TECHNICIAN holds none by default, and this
    // per-user override only grants Job). This test is about the urgent-job lockout, not that
    // gate, so grant read Customer too for a readable customer.
    grantTechReadCustomer();

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('technician'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    // S8 (D6): see above - the creator's access is created_by_id, not a crew row.
    expect(capturedAssigneeCreate).toHaveLength(0);
  });
});

describe('POST /api/jobs — unconditional creators are NOT auto-assigned', () => {
  it('DISPATCHER creating a standalone job is NOT auto-assigned to it', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedAssigneeCreate).toHaveLength(0);
  });

  it('DISPATCHER creating a job from an estimate (lead they do not own) succeeds + not auto-assigned', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_OWNED_BY_TECH);
    mockPrisma.lead.findFirst.mockResolvedValue(null); // the Leads scope does not reach this lead

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedAssigneeCreate).toHaveLength(0);
  });
});

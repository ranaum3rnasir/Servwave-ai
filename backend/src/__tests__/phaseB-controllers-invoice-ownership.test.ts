import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
  JOB_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// Phase B — technician redesign. Invoice CREATE ownership (#235 / F-013).
//
// The route already gates `canDo('create','Invoice')`. The controller must verify the requester
// may invoice THIS job — role-agnostically:
//   • a per-user OWN-scoped `create Invoice` grantee → only a job they're ASSIGNED to.
//   • an unconditional create grant (dispatcher / admin) → any job.
//   • nobody without the grant (strict tech / SALES) reaches the controller at all (route blocks).
// No `role === 'SALES'` / `role === 'TECHNICIAN'` literal may remain that defeats the per-user grant.

const mockPrisma = prisma as unknown as {
  job: { findUnique: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  userPermissionOverride: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// Estimate line items required to clear the "no line items" 400 (invoice.controller.ts:370).
const ESTIMATE_WITH_LINES = {
  ...ESTIMATE_APPROVED_FIXTURE,
  line_items: [
    { id: 'li1', sequence: 1, description: 'AC', quantity: 1, unit_price: 800, is_taxable: true, line_total: 800, discount_amount: 0 },
  ],
  discount_amount: 0,
  tax_rate: 0.0625,
};

// A job the technician OWNS (assigned). Loaded shape mirrors invoice.controller.ts:324-336.
function jobOwnedByTech() {
  return {
    ...JOB_FIXTURE,
    status: 'COMPLETED',
    source_plan_id: null,
    customer: { id: CUSTOMER_FIXTURE.id, payment_type: 'NET_30', tax_exempt: false },
    service_location: { state: 'TX' },
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
    estimate: ESTIMATE_WITH_LINES,
    // SRVW-85: the job door bills the Items tab now. These MIRROR ESTIMATE_WITH_LINES so the
    // money is unchanged; linked_estimates is dereferenced unconditionally.
    linked_estimates: [],
    job_line_items: [
      { id: 'jli1', sequence: 1, description: 'AC', quantity: 1, unit_price: 800, is_taxable: true, line_total: 800, item_type: 'SERVICE', price_book_item_id: null, unit_cost: null, markup_percent: null },
    ],
  };
}

// The same job but the technician is NOT an assignee (someone else owns it).
function jobNotOwnedByTech() {
  return {
    ...jobOwnedByTech(),
    visits: [{ assignees: [{ user_id: TEST_USERS.dispatcher.id }] }],
  };
}

function grantTechCreateInvoice() {
  // Per-user OWN-scoped allow override (DB row is bare; defineAbility looks up the own-condition).
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([
    { action: 'create', subject: 'Invoice', effect: 'allow' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  // No ACTIVE invoice yet (clears the 409 dup guard at invoice.controller.ts:349).
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  // Full tx surface for the create path (deposit lookup → create → job.update → timeline).
  // The ownership 403 fires BEFORE the tx, so this only matters for the 201 paths.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      invoice: {
        // SRVW-85: the deposit lookup is invoice.findMany now (the multi-deposit union). An empty
        // list short-circuits before remainingDepositCredit, so no payment/refund aggregates needed.
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'inv-new', invoice_number: 'I00001' }),
      },
      job: { update: vi.fn().mockResolvedValue({}) },
      payment: { create: vi.fn() },
      depositCreditApplication: { create: vi.fn(), aggregate: vi.fn().mockResolvedValue({ _sum: {} }) },
      timelineEvent: { create: vi.fn() },
    }),
  );
});

describe('POST /api/invoices — Phase B ownership (granted OWN-scoped technician)', () => {
  it('granted tech CAN invoice a job they are ASSIGNED to (no role-literal 403)', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();
    mockPrisma.job.findUnique.mockResolvedValue(jobOwnedByTech());

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ job_id: JOB_FIXTURE.id });

    // Must NOT be the old hard 403. Reaches creation (201) — never the role-literal 403.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it('granted tech CANNOT invoice a job they are NOT assigned to (403)', async () => {
    mockAuthAs('technician');
    grantTechCreateInvoice();
    mockPrisma.job.findUnique.mockResolvedValue(jobNotOwnedByTech());

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(403);
  });

  it('strict (un-granted) tech is blocked at the route guard (403), never reaching create', async () => {
    mockAuthAs('technician'); // no override → strict default has no create Invoice
    mockPrisma.job.findUnique.mockResolvedValue(jobOwnedByTech());

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('technician'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/invoices — Phase B ownership (unconditional creators unaffected)', () => {
  it('DISPATCHER (unconditional create) can invoice a job they do NOT own', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockResolvedValue(jobNotOwnedByTech()); // assignee is someone else

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('dispatcher'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it('ADMIN can invoice any job', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(jobNotOwnedByTech());

    const res = await request(app)
      .post('/api/invoices')
      .set(authHeader('admin'))
      .send({ job_id: JOB_FIXTURE.id });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });
});

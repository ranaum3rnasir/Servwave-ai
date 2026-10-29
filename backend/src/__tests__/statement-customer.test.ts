import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

// ─── Typed mocks ──────────────────────────────────────

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  invoice: { findMany: ReturnType<typeof vi.fn> };
};

// ─── Fixtures ─────────────────────────────────────────

const PARENT_ID = 'c2000000-0000-0000-0000-000000000001';
// member-A bills the parent (INCLUDED in the roll-up)
const MEMBER_A_ID = 'c2000000-0000-0000-0000-000000000002';
// member-B bills itself (EXCLUDED — shares parent_id but bill_to = self)
const MEMBER_B_ID = 'c2000000-0000-0000-0000-000000000003';

const PARENT_CUSTOMER = {
  id: PARENT_ID,
  first_name: null,
  last_name: null,
  company_name: 'Acme Corp',
  email: 'billing@acme.com',
  bill_to_customer_id: null,
  parent_id: null,
};

const MEMBER_A = {
  id: MEMBER_A_ID,
  first_name: 'Site',
  last_name: 'A',
  company_name: null,
};

// member-A invoice (billed to parent → invoice.customer_id = parent)
const PARENT_INVOICE = {
  id: 'd2000000-0000-0000-0000-000000000001',
  invoice_number: 'I01001',
  kind: 'STANDARD',
  status: 'SENT',
  total_amount: 5000,
  tax_amount: 0,
  created_at: new Date('2026-04-01T10:00:00Z'),
  customer_id: PARENT_ID,
  customer: { id: PARENT_ID, first_name: null, last_name: null, company_name: 'Acme Corp' },
  payments: [
    {
      id: 'p2000000-0000-0000-0000-000000000001',
      amount: 2000,
      method: 'CHECK',
      paid_at: new Date('2026-04-02T10:00:00Z'),
      reference_number: 'CHK-1',
      stripe_payment_intent_id: null,
      created_at: new Date('2026-04-02T10:00:00Z'),
    },
  ],
  refunds: [],
  credits: [],
};

// member-A's own invoice carrying customer_id = MEMBER_A only matters when bill_to=A;
// here member-A bills the parent, so its invoice's customer_id is the PARENT (above).
// This invoice (customer_id = MEMBER_A) represents work that — were member-A self-billing —
// would surface; it is included because MEMBER_A is in the member set, billed to parent.
const MEMBER_A_INVOICE = {
  id: 'd2000000-0000-0000-0000-000000000002',
  invoice_number: 'I01002',
  kind: 'STANDARD',
  status: 'SENT',
  total_amount: 1000,
  tax_amount: 0,
  created_at: new Date('2026-04-03T10:00:00Z'),
  customer_id: MEMBER_A_ID,
  customer: { id: MEMBER_A_ID, first_name: 'Site', last_name: 'A', company_name: null },
  payments: [],
  refunds: [],
  credits: [],
};

describe('GET /api/statements/customer/:customerId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(PARENT_CUSTOMER);
    // The member-resolution query returns only member-A (the one whose bill_to = parent).
    mockPrisma.customer.findMany.mockResolvedValue([MEMBER_A]);
    mockPrisma.invoice.findMany.mockResolvedValue([PARENT_INVOICE, MEMBER_A_INVOICE]);
  });

  it('rolls up by bill_to: a member that bills the parent IS included; a member that bills itself is NOT', async () => {
    const res = await request(app)
      .get(`/api/statements/customer/${PARENT_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('customer');

    // member set = [self, member-A]; member-B (bill_to self) must never be queried.
    const invWhere = mockPrisma.invoice.findMany.mock.calls[0]![0].where;
    expect(invWhere.customer_id.in).toEqual(expect.arrayContaining([PARENT_ID, MEMBER_A_ID]));
    expect(invWhere.customer_id.in).not.toContain(MEMBER_B_ID);

    // members header lists the resolved member-A (plus self is the customer header).
    expect(res.body.members.map((m: { id: string }) => m.id)).toContain(MEMBER_A_ID);

    // billed = 5000 + 1000 = 6000; paid = 2000; balance = 4000.
    expect(res.body.totals.billed).toBe(6000);
    expect(res.body.totals.paid).toBe(2000);
    expect(res.body.totals.balance).toBe(4000);
    const last = res.body.lines[res.body.lines.length - 1];
    expect(last.running_balance).toBe(res.body.totals.balance);
  });

  it('keys the member-resolution query off bill_to_customer_id NOT parent_id', async () => {
    await request(app).get(`/api/statements/customer/${PARENT_ID}`).set(authHeader('admin'));

    const memberWhere = mockPrisma.customer.findMany.mock.calls[0]![0].where;
    expect(memberWhere.bill_to_customer_id).toBe(PARENT_ID);
    expect(memberWhere.parent_id).toBeUndefined();
  });

  it('re-applies tenantWhere on EVERY hop (customer, members, invoices)', async () => {
    await request(app).get(`/api/statements/customer/${PARENT_ID}`).set(authHeader('admin'));

    expect(mockPrisma.customer.findUnique.mock.calls[0]![0].where.organization_id).toBe(ALPHA_ORG_ID);
    expect(mockPrisma.customer.findMany.mock.calls[0]![0].where.organization_id).toBe(ALPHA_ORG_ID);
    expect(mockPrisma.invoice.findMany.mock.calls[0]![0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('cross-org negative: a member-shaped row in org B does not leak into an org-A customer statement', async () => {
    // Even if the invoice mock is handed an org-B-shaped row, the WHERE always carries org A.
    const ORG_B_INVOICE = {
      ...PARENT_INVOICE,
      id: 'd2000000-0000-0000-0000-0000000000bb',
      organization_id: '00000000-0000-0000-0000-000000000002',
    };
    mockPrisma.invoice.findMany.mockResolvedValue([ORG_B_INVOICE]);

    await request(app).get(`/api/statements/customer/${PARENT_ID}`).set(authHeader('admin'));

    const invWhere = mockPrisma.invoice.findMany.mock.calls[0]![0].where;
    expect(invWhere.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('a forged out-of-tenant customer id yields 404 (scoped customer.findUnique → null)', async () => {
    mockPrisma.customer.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/statements/customer/${PARENT_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Customer not found');
    // Never reaches the member/invoice hops.
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/statements/customer/${PARENT_ID}`);
    expect(res.status).toBe(401);
  });
});

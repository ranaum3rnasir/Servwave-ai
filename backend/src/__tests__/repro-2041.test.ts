/**
 * #2041 — SALES sees only ASSOCIATED customers on the Customers page, its aggregates, and
 * global search; create-form pickers stay org-wide by design (QA 019).
 *
 * Pass A (prod, `Servwave Demo`, commit 48ecfc615) confirmed: a SALES user with zero
 * association to a customer lists it, opens it by id (200, not 404), sees it counted in
 * `/api/customers/stats`, and finds it via `/api/search` — see
 * `md_files/plans/agents/runs/issue-2041/handoffs/reproduce-a.md`.
 *
 * Root cause (entry points, all cited in Pass A):
 *   - `defaultGrants.ts:110-112` — SALES's `read Customer` grant carries NO `conditions` key
 *     (contrast `read Lead` two lines below, which carries `conditions: OWN_LEAD`). Because
 *     `mockAuthAs('sales')` loads the REAL `DEFAULT_GRANTS` (not a hand-rolled persona), every
 *     test below reproduces the bug from the actual shipped grant table — no fixture needed to
 *     manufacture the defect.
 *   - `customer.controller.ts:355-418` (`buildCustomerListWhere`) and `:1391-1408` (`getStats`)
 *     build `where`/counts from `tenantWhere(req)` only — no row-scope OR.
 *   - `customer.controller.ts:678-693` (`getById`) — `prisma.customer.findUnique({ where: { id,
 *     ...tenantWhere(req) } })`, no per-row ownership check; route guard
 *     `customer.routes.ts:26` is ability-level only (`canDo('read','Customer')`).
 *   - `search.controller.ts:361-388` — `skipCustomers = !req.ability!.can('read','Customer')`;
 *     Customer is explicitly NOT run through `scopeWhereForReq`, unlike Job/Lead/Estimate/Invoice.
 *   - `scopeWhereFor.ts:17` — the `ScopeResource` union omits `'Customer'` entirely, so there is
 *     no row-scope machinery for it to plug into yet.
 *
 * Design doc (`md_files/plans/019-customer-row-scoping/00-design.md`) names the intended
 * condition: `OR[ leads.some(lead_assignees.some(user_id=me)), jobs.some(visits.some(assignees.
 * some(user_id=me))), created_by_id=me ]`. `hasOwnerScope` below detects that shape generically
 * (by checking the actual `where`/`count`-filter argument reaching Prisma for the requester's own
 * id or one of the three association keys) so these tests fail on the ABSENCE of scoping, not on
 * a guess at the exact clause the fix will emit.
 *
 * Every fixture id/name here is `qa-2041-` prefixed per the run's naming convention.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────
// Customer A — associated to the SALES user via the third OR-arm the design doc names
// (`created_by_id = me`) — the positive control.
const CUSTOMER_A = {
  ...CUSTOMER_FIXTURE,
  id: 'c2041000-0000-0000-0000-00000000a041',
  first_name: 'Assoc',
  last_name: 'QA2041',
  company_name: 'qa-2041-Assoc Customer',
  created_by_id: SALES_ID,
};

// Customer B — NO association whatsoever to the SALES user: not created by them, not reached
// via a lead assignee or a visit assignee. The negative case Pass A exercised on prod.
const CUSTOMER_B = {
  ...CUSTOMER_FIXTURE,
  id: 'c2041000-0000-0000-0000-00000000b041',
  first_name: 'Other',
  last_name: 'QA2041',
  company_name: 'qa-2041-Other Customer',
  created_by_id: null,
};

/**
 * Does `where` (or a `count`/`findMany` filter argument) carry ANY trace of a row-scope tied to
 * `userId` — the requester's id appearing anywhere in the fragment, or one of the three
 * association keys the design doc's OR condition would use (`lead_assignees`, `created_by_id`,
 * or a `visits`/`assignees` hop off `jobs`)? A plain `tenantWhere` + filter fragment (today's
 * behavior) contains none of these.
 */
function hasOwnerScope(where: unknown, userId: string): boolean {
  const s = JSON.stringify(where ?? {});
  return s.includes(userId) || s.includes('lead_assignees') || s.includes('created_by_id');
}

// Zero-value summary mocks for getById (financials/estimates/deposits $queryRaw calls), same
// shape customers.test.ts's `mockSummaryQueries` uses.
function mockSummaryQueries() {
  mockPrisma.$queryRaw
    .mockResolvedValueOnce([{ lifetime_revenue: '0', total_invoiced: '0', past_due_balance: '0', due_balance: '0', unpaid_invoice_count: '0', paid_invoice_count: '0' }])
    .mockResolvedValueOnce([{ total: '0', pending: '0', approved: '0', total_value: '0' }])
    .mockResolvedValueOnce([{ deposits_collected: '0', deposits_pending: '0' }]);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (1) GET /api/customers — list where carries no row-scope clause for SALES
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 (1) GET /api/customers — list is not row-scoped for SALES', () => {
  it('RED — the findMany `where` carries no ownership condition, and an unassociated customer B is returned', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_B]);
    mockPrisma.customer.count.mockResolvedValue(1);

    const res = await request(app).get('/api/customers').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.customer.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // Desired (00-design.md): the where must carry an OR tied to the requester's own id
    // (lead_assignees / jobs.visits.assignees / created_by_id). Today it does not.
    expect(hasOwnerScope(where, SALES_ID)).toBe(true);
    // Desired: an unassociated customer must not come back at all. Today the mock always
    // returns whatever we handed it, because nothing in the code path would have filtered it.
    const ids = (res.body.customers as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(CUSTOMER_B.id);
  });

  it('control (may pass on base): customer C, created BY this SALES user, is still returned once scoping lands', async () => {
    mockAuthAs('sales');
    const CUSTOMER_C = { ...CUSTOMER_FIXTURE, id: 'c2041000-0000-0000-0000-00000000c041', company_name: 'qa-2041-Created Customer', created_by_id: SALES_ID };
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_C]);
    mockPrisma.customer.count.mockResolvedValue(1);

    const res = await request(app).get('/api/customers').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const ids = (res.body.customers as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(CUSTOMER_C.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (2) GET /api/customers/:id — by-id is an existence oracle for SALES
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 (2) GET /api/customers/:id — no per-row ownership check for SALES', () => {
  it('RED — customer B (no association) answers 200 with full detail, not 404', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === CUSTOMER_B.id ? CUSTOMER_B : null),
    );
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app).get(`/api/customers/${CUSTOMER_B.id}`).set(authHeader('sales'));

    // Desired: a requester with no lead/visit/created_by association to this customer must get
    // the same 404 a cross-org id already gets — existence must not be confirmed. Today: 200.
    expect(res.status).toBe(404);
  });

  it('control (passes on base, unaffected by the fix): customer A, created BY this SALES user, stays 200', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === CUSTOMER_A.id ? CUSTOMER_A : null),
    );
    mockPrisma.note.findMany.mockResolvedValue([]);
    mockSummaryQueries();

    const res = await request(app).get(`/api/customers/${CUSTOMER_A.id}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe(CUSTOMER_A.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (3) GET /api/customers/stats — aggregates are org-wide for SALES
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 (3) GET /api/customers/stats — counts are org-wide for SALES', () => {
  it('RED — every count() where is scope-free (no ownership condition tied to the requester)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.count.mockResolvedValue(9);

    const res = await request(app).get('/api/customers/stats').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const wheres = mockPrisma.customer.count.mock.calls.map((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where);
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) {
      // Desired: every stats count must be scoped the same way the list is. Today none are —
      // this is the "byte-identical to ADMIN" leak Pass A measured on prod (evidence #3).
      expect(hasOwnerScope(w, SALES_ID)).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// (4) GET /api/search — Customer is not a scopeWhereForReq resource
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 (4) GET /api/search — customer results are not row-scoped for SALES', () => {
  it('RED — global search still returns customer B though SALES has no association to it', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_B]);

    const res = await request(app).get('/api/search?q=qa-2041-Other').set(authHeader('sales'));

    expect(res.status).toBe(200);
    // search.controller.ts:361-363 — "Customer is not a scopeWhereForReq resource"; SALES holds
    // an unconditional read Customer, so skipCustomers is false and the query runs org-wide.
    const custWheres = mockPrisma.customer.findMany.mock.calls.map((c: unknown[]) => (c[0] as { where: Record<string, unknown> }).where);
    expect(custWheres.length).toBeGreaterThan(0);
    for (const w of custWheres) {
      // Desired: same ownership OR as list/getById/stats. Today: absent.
      expect(hasOwnerScope(w, SALES_ID)).toBe(true);
    }
    const ids = (res.body.results.customers as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(CUSTOMER_B.id);
  });
});

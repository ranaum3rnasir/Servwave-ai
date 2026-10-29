/**
 * `GET /api/customers/picker` and `GET /api/customers/picker/:id`, the dedicated org-wide
 * picker endpoint the lead/job/estimate/standalone-invoice create forms repoint to (Ran's
 * carve-out, spec "Solution" item 4, decision 7, R6, R9, R13).
 *
 * Originally slice 1 shipped `isPickerRowReadable` hardcoded `true` (SALES's `read Customer`
 * grant was still unconditional then) — a deliberate no-op narrowing (R13). #2041 slice 2
 * conditions the grant (OWN_CUSTOMER) and wires `isPickerRowReadable` to the real
 * `canReadCustomerById` verdict, so most tests below now exercise the REAL per-row check: an
 * unassociated customer (`PICKER_ROW`, no `created_by_id`/lead/job tie to the SALES test user)
 * comes back `restricted: true`, and the org-wide RESULT SET still includes it (decision 7's
 * carve-out — the row is NEVER dropped from the picker, only its projection narrows).
 *
 * See `md_files/plans/agents/runs/issue-2041/slice-1.md` and `spec.md` decision 7 / R6 / R9.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS, mockAuthAs, mockRoleGrantsWithout, authHeader, CUSTOMER_FIXTURE, LOCATION_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { projectPickerRow } from '../controllers/customer.controller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
});

const PICKER_ROW = {
  ...CUSTOMER_FIXTURE,
  id: 'c2041000-0000-0000-0000-00000000f041',
  company_name: 'qa-2041-Funnel Customer',
  service_locations: [LOCATION_FIXTURE],
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Guard — canDoAny([['create','Lead'],['create','Job'],['create','Estimate'],['create','Invoice']])
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 slice 1 — GET /api/customers/picker guard (canDoAny)', () => {
  it('a role holding create Lead only -> 200', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['create', 'Estimate']);
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('a role holding create Invoice only -> 200 (R9 — the forced Invoice pair)', async () => {
    mockAuthAs('dispatcher');
    mockRoleGrantsWithout('DISPATCHER', ['create', 'Lead'], ['create', 'Job']);
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });

  it('a role holding none of the four -> 403, same body as canDo', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['create', 'Job'], ['create', 'Estimate']);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('GET /api/customers/picker/:id — same guard applies', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['create', 'Job'], ['create', 'Estimate']);

    const res = await request(app)
      .get(`/api/customers/picker/${PICKER_ROW.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Guard — a SUBJECT-level `read Customer` probe on top of canDoAny (findings 3/4/8): a role with
// unconditional `create Job`/`create Estimate` but NO `read Customer` grant at all must still get
// 403 on the picker, not the org-wide directory. Same fail-closed probe `comm-calls.controller.ts`
// (`canReadCustomers`) uses — `req.ability?.can('read','Customer')` — chained after PICKER_GUARD.
// TECHNICIAN below is `mockAuthAs('technician')` with UNMODIFIED DEFAULT_GRANTS: it holds
// unconditional `create Job` (defaultGrants.ts:409) and `create Estimate` (:423) and holds no
// `Customer` grant whatsoever, so it clears `canDoAny` but must still be refused here.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 — picker also requires a subject-level read Customer grant (fail-closed for zero-grant roles)', () => {
  it('TECHNICIAN with DEFAULT grants (unstripped) -> 403 on GET /picker, same body as the create-grant 403', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'ab' })
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('TECHNICIAN with DEFAULT grants (unstripped) -> 403 on GET /picker/:id', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/customers/picker/${PICKER_ROW.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it('SALES with DEFAULT (conditioned) read Customer grant -> 200, readable AND restricted rows unchanged', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([PICKER_ROW]);
    mockPrisma.customer.findUnique.mockResolvedValue(PICKER_ROW);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041-Funnel' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers[0]).toEqual(projectPickerRow(PICKER_ROW, false));
  });

  it('DISPATCHER with unconditioned read Customer grant -> 200', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Route ordering — /picker declared before /:id (mutation target: revert and this reddens)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 slice 1 — /picker is not swallowed by /:id', () => {
  it('routes through the findMany-backed picker handler, never the :id detail handler', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.customer.findMany).toHaveBeenCalled();
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The org-wide carve-out (decision 7, R13): an unassociated customer is NEVER dropped from the
// picker result set — only its projection narrows once slice 2's real verdict is wired.
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 — org-wide result set (the carve-out — row never dropped, decision 7)', () => {
  it('an unassociated customer still comes back in the result set, restricted:true, AC7 projection', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([PICKER_ROW]);
    // The real per-row verdict (slice 2) issues its own proof-only probe.
    mockPrisma.customer.findUnique.mockResolvedValue(PICKER_ROW);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041-Funnel', limit: 6 })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0]).toEqual(projectPickerRow(PICKER_ROW, false));
    expect(res.body.customers[0].restricted).toBe(true);
    for (const key of ['email', 'phone', 'service_locations', 'customer_number']) {
      expect(res.body.customers[0]).not.toHaveProperty(key);
    }
  });

  it('an ASSOCIATED customer (created_by_id = requester) still comes back restricted:false, with todays fields', async () => {
    mockAuthAs('sales');
    const ownedRow = { ...PICKER_ROW, created_by_id: TEST_USERS.sales.id };
    mockPrisma.customer.findMany.mockResolvedValue([ownedRow]);
    mockPrisma.customer.findUnique.mockResolvedValue(ownedRow);

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041-Funnel', limit: 6 })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0]).toMatchObject({
      id: ownedRow.id,
      restricted: false,
      email: ownedRow.email,
      phone: ownedRow.phone,
      company_name: ownedRow.company_name,
      tax_exempt: ownedRow.tax_exempt,
    });
  });

  it('the where carries tenantWhere only — no ownership/scope clause (deliberate carve-out)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041' })
      .set(authHeader('sales'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where as Record<string, unknown>;
    const whereJson = JSON.stringify(where);
    expect(whereJson).not.toContain('lead_assignees');
    expect(whereJson).not.toContain('created_by_id');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R6 — search required, >= 2 chars
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 slice 1 — search validation (R6)', () => {
  it('search absent -> empty list, never the book, no query issued', async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/customers/picker').set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('search 1 char -> empty list, no query issued', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/customers/picker')
      .query({ search: 'q' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toEqual([]);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R6 — limit clamped server-side to <= 25
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 slice 1 — limit clamp (R6)', () => {
  it('limit=500 clamps to <= 25, never trusting the client', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/customers/picker')
      .query({ search: 'qa-2041', limit: 500 })
      .set(authHeader('sales'));

    const args = mockPrisma.customer.findMany.mock.calls[0][0];
    expect(args.take).toBeLessThanOrEqual(25);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GET /picker/:id — exact parity with the list projection + 404 out-of-org
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 — GET /api/customers/picker/:id', () => {
  it('an unassociated row returns the redacted projection (real verdict, R6 parity with the list picker)', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue(PICKER_ROW);

    const res = await request(app)
      .get(`/api/customers/picker/${PICKER_ROW.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customer).toEqual(projectPickerRow(PICKER_ROW, false));
    expect(res.body.customer).not.toHaveProperty('customer_number');
    expect(res.body.customer).not.toHaveProperty('_count');
    expect(res.body.customer).not.toHaveProperty('tax_exempt');
  });

  it('an ASSOCIATED row returns the full projection, restricted:false', async () => {
    mockAuthAs('sales');
    const ownedRow = { ...PICKER_ROW, created_by_id: TEST_USERS.sales.id };
    mockPrisma.customer.findUnique.mockResolvedValue(ownedRow);

    const res = await request(app)
      .get(`/api/customers/picker/${ownedRow.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customer).toEqual(projectPickerRow(ownedRow, true));
    expect(res.body.customer).not.toHaveProperty('customer_number');
    expect(res.body.customer).not.toHaveProperty('_count');
  });

  it('carries tax_exempt for an associated row so the standalone-invoice form tax preview keeps working through the picker', async () => {
    mockAuthAs('sales');
    const exemptRow = { ...PICKER_ROW, tax_exempt: true, created_by_id: TEST_USERS.sales.id };
    mockPrisma.customer.findUnique.mockResolvedValue(exemptRow);

    const res = await request(app)
      .get(`/api/customers/picker/${exemptRow.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.customer.tax_exempt).toBe(true);
  });

  it('404 with the standard body for an out-of-org / nonexistent id', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/customers/picker/00000000-0000-0000-0000-00000000dead')
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
  });

  it('a malformed id -> 404, byte-identical to the nonexistent-uuid 404, never reaches Prisma (finding 9)', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/customers/picker/not-a-uuid')
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    expect(mockPrisma.customer.findUnique).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Projection — pure helper, key-by-key (decision 7's redacted shape; forward-compatible with
// slice 2, which will feed this a real per-row verdict instead of a hardcoded `true`)
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('#2041 slice 1 — projectPickerRow', () => {
  it('a readable row carries todays picker fields and restricted:false, no phone_last4/city', () => {
    const projected = projectPickerRow(PICKER_ROW, true);

    expect(projected).toMatchObject({
      id: PICKER_ROW.id,
      first_name: PICKER_ROW.first_name,
      last_name: PICKER_ROW.last_name,
      company_name: PICKER_ROW.company_name,
      phone: PICKER_ROW.phone,
      phone_ext: PICKER_ROW.phone_ext,
      email: PICKER_ROW.email,
      ad_source: PICKER_ROW.ad_source,
      tax_exempt: PICKER_ROW.tax_exempt,
      restricted: false,
    });
    expect(projected.service_locations).toEqual(PICKER_ROW.service_locations);
    expect(projected).not.toHaveProperty('phone_last4');
    expect(projected).not.toHaveProperty('city');
  });

  it('a readable row reflects the customers real tax_exempt value, not a hardcoded default', () => {
    const exemptRow = { ...PICKER_ROW, tax_exempt: true };
    const projected = projectPickerRow(exemptRow, true);

    expect(projected.tax_exempt).toBe(true);
  });

  it('an unreadable row is redacted to id/name/company/phone_last4/city only — never email, phone, address lines, customer_number, _count, ad_source or tax_exempt', () => {
    const projected = projectPickerRow(PICKER_ROW, false);

    expect(projected).toEqual({
      id: PICKER_ROW.id,
      first_name: PICKER_ROW.first_name,
      last_name: PICKER_ROW.last_name,
      company_name: PICKER_ROW.company_name,
      phone_last4: '4567',
      city: LOCATION_FIXTURE.city,
      restricted: true,
    });
    expect(projected).not.toHaveProperty('tax_exempt');
    expect(projected).not.toHaveProperty('email');
  });

  it('an unreadable row with no service locations gets city: null, never throws', () => {
    const noLocationRow = { ...PICKER_ROW, service_locations: [] };
    const projected = projectPickerRow(noLocationRow, false);

    expect(projected.city).toBeNull();
  });
});

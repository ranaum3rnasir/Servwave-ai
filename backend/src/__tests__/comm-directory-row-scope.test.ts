/**
 * #2041 AC12 — the comm directory follows the Customer row-scope: `GET /api/communication/contacts`
 * (listPhoneCustomers), `GET /api/communication/contacts/:id` (getPhoneCustomer) and
 * `GET /api/communication/dialer-search` (dialerSearch's customers group).
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
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
});

describe('GET /api/communication/contacts — listPhoneCustomers row-scope', () => {
  it('SALES: the where carries the OWN_CUSTOMER scope', async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/communication/contacts').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    const s = JSON.stringify(where);
    expect(s.includes(SALES_ID) && (s.includes('lead_assignees') || s.includes('created_by_id'))).toBe(true);
  });

  it('DISPATCHER: unconditional, unchanged', async () => {
    mockAuthAs('dispatcher');

    await request(app).get('/api/communication/contacts').set(authHeader('dispatcher'));

    const where = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('a role with no read Customer grant at all -> 403, no query', async () => {
    mockAuthAs('technician');

    const res = await request(app).get('/api/communication/contacts').set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/communication/contacts/:id — getPhoneCustomer row-scope', () => {
  it('SALES, unassociated customer -> 404 (same body a nonexistent id gets)', async () => {
    mockAuthAs('sales');
    // The row-scoped `where` (AND-composed) never matches an unassociated row against the mock,
    // which is asserted directly below; simulate the real DB behaviour by resolving null.
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/communication/contacts/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    const where = mockPrisma.customer.findFirst.mock.calls[0][0].where;
    const s = JSON.stringify(where);
    expect(s.includes(SALES_ID) && (s.includes('lead_assignees') || s.includes('created_by_id'))).toBe(true);
  });

  it('SALES, associated customer -> 200', async () => {
    mockAuthAs('sales');
    mockPrisma.customer.findFirst.mockResolvedValue({ ...CUSTOMER_FIXTURE, created_by_id: SALES_ID });

    const res = await request(app)
      .get(`/api/communication/contacts/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it('a role with no read Customer grant at all -> 403 (existing all-or-nothing gate, unchanged)', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .get(`/api/communication/contacts/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/communication/dialer-search — customers group row-scope', () => {
  it('SALES: the customers-group where carries the OWN_CUSTOMER scope, composed clobber-safely with the search OR', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .get('/api/communication/dialer-search')
      .query({ q: 'qa-2041-Other' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    const call = mockPrisma.customer.findMany.mock.calls[0][0];
    const s = JSON.stringify(call.where);
    expect(s.includes(SALES_ID) && (s.includes('lead_assignees') || s.includes('created_by_id'))).toBe(true);
    // The search terms are still present (clobber-safe composition, not lost).
    expect(s).toContain('qa-2041-Other');
  });

  it('the jobs/identity groups still answer for SALES even when customers are scoped out', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findMany.mockResolvedValue([
      { id: 'j-1', job_number: 'J00001', status: 'SCHEDULED', customer: null, service_location: null },
    ]);

    const res = await request(app)
      .get('/api/communication/dialer-search')
      .query({ q: 'qa-2041-Other' })
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
  });
});

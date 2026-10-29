/**
 * SRVW-89 - end-to-end coverage for parseSortParams across all 9 list callers.
 *
 * Two vocabularies used to drift with nothing forcing them together: the frontend sends
 * TanStack column ids, the backend allowlisted raw Prisma field names, and a handful of ids
 * were flat-out fake (Customers `company`, price-book `item_type`) which 500'd against a real
 * DB but not against these mocked-Prisma tests - hence the parallel DMMF guard
 * (sort-field-map-schema-validity.test.ts). This suite is the behavioural layer: it asserts the
 * exact `orderBy` array handed to Prisma, and that an unmappable `sortBy` 400s before any
 * `findMany` is reached.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  customer: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  job: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  lead: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  payment: { aggregate: ReturnType<typeof vi.fn> };
  priceBookItem: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  asset: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');

  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.customer.count.mockResolvedValue(0);

  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.job.count.mockResolvedValue(0);
  mockPrisma.job.groupBy.mockResolvedValue([]);

  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.estimate.groupBy.mockResolvedValue([]);
  mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });

  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.lead.count.mockResolvedValue(0);

  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.count.mockResolvedValue(0);
  mockPrisma.invoice.aggregate.mockResolvedValue({ _sum: { amount_due: 0 }, _count: 0 });
  mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: 0 });
  mockPrisma.job.count.mockResolvedValue(0);

  mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
  mockPrisma.priceBookItem.count.mockResolvedValue(0);

  mockPrisma.asset.findMany.mockResolvedValue([]);
  mockPrisma.asset.count.mockResolvedValue(0);
});

describe('previously-broken columns now sort on the right data', () => {
  it('GET /api/customers?sortBy=company&sortDir=asc orders by company_name', async () => {
    const res = await request(app).get('/api/customers?sortBy=company&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.customer.findMany.mock.calls[0][0].orderBy).toEqual([{ company_name: 'asc' }]);
  });

  it('GET /api/customers?sortBy=name&sortDir=asc orders by first_name then last_name', async () => {
    const res = await request(app).get('/api/customers?sortBy=name&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.customer.findMany.mock.calls[0][0].orderBy).toEqual([
      { first_name: 'asc' },
      { last_name: 'asc' },
    ]);
  });

  // A1 (multi-visit S8 §4, RATIFIED): NOT scheduled_start - that column is the forward-looking
  // mirror and reads null for any job whose last live visit has already been worked, which
  // staging measured at 7,492 jobs including nearly the whole of the biggest org. first_visit_
  // start is the backward-looking span start (A2+); see sortFields.ts's own comment.
  it('GET /api/jobs?sortBy=scheduled&sortDir=asc orders by first_visit_start', async () => {
    const res = await request(app).get('/api/jobs?sortBy=scheduled&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.job.findMany.mock.calls[0][0].orderBy).toEqual([{ first_visit_start: 'asc' }]);
  });

  it('GET /api/estimates?sortBy=total&sortDir=desc orders by total_amount', async () => {
    const res = await request(app).get('/api/estimates?sortBy=total&sortDir=desc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.findMany.mock.calls[0][0].orderBy).toEqual([{ total_amount: 'desc' }]);
  });

  it('GET /api/leads?sortBy=lead_number&sortDir=asc orders by lead_number', async () => {
    const res = await request(app).get('/api/leads?sortBy=lead_number&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.lead.findMany.mock.calls[0][0].orderBy).toEqual([{ lead_number: 'asc' }, { id: 'asc' }]);
  });

  it('GET /api/price-book/items?sortBy=type&sortDir=desc orders by type', async () => {
    const res = await request(app).get('/api/price-book/items?sortBy=type&sortDir=desc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.findMany.mock.calls[0][0].orderBy).toEqual([{ type: 'desc' }]);
  });
});

describe('an unmappable sortBy is rejected with 400 and never reaches Prisma', () => {
  const cases: [string, string][] = [
    ['/api/customers', 'bogus'],
    ['/api/jobs', 'bogus'],
    ['/api/estimates', 'bogus'],
    ['/api/leads', 'bogus'],
    ['/api/invoices', 'bogus'],
    ['/api/price-book/items', 'item_type'],
    ['/api/inventory/assets', 'bogus'],
    ['/api/inventory/items', 'bogus'],
    ['/api/inventory/movements', 'bogus'],
  ];

  it.each(cases)('%s?sortBy=%s -> 400 INVALID_SORT_FIELD, no findMany call', async (path, sortBy) => {
    const res = await request(app).get(`${path}?sortBy=${sortBy}`).set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SORT_FIELD');
    expect(res.body.field).toBe(sortBy);
  });

  it('customers findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/customers?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('jobs findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/jobs?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
  });

  it('estimates findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/estimates?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.estimate.findMany).not.toHaveBeenCalled();
  });

  it('leads findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/leads?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('invoices findMany is never called when sortBy is unmappable (proves the hoist)', async () => {
    await request(app).get('/api/invoices?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('price-book items findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/price-book/items?sortBy=item_type').set(authHeader('admin'));
    expect(mockPrisma.priceBookItem.findMany).not.toHaveBeenCalled();
  });

  it('inventory assets findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/inventory/assets?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.asset.findMany).not.toHaveBeenCalled();
  });

  it('inventory catalog items findMany is never called when sortBy is unmappable', async () => {
    await request(app).get('/api/inventory/items?sortBy=bogus').set(authHeader('admin'));
    expect(mockPrisma.priceBookItem.findMany).not.toHaveBeenCalled();
  });
});

describe('the three accidental-fallback ids resolve explicitly and do NOT 400', () => {
  it('GET /api/jobs?sortBy=created&sortDir=asc returns 200 ordered by created_at', async () => {
    const res = await request(app).get('/api/jobs?sortBy=created&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.job.findMany.mock.calls[0][0].orderBy).toEqual([{ created_at: 'asc' }]);
  });

  it('GET /api/estimates?sortBy=date&sortDir=asc returns 200 ordered by created_at', async () => {
    const res = await request(app).get('/api/estimates?sortBy=date&sortDir=asc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.estimate.findMany.mock.calls[0][0].orderBy).toEqual([{ created_at: 'asc' }]);
  });

  it('GET /api/leads?sortBy=created&sortDir=desc returns 200 ordered by created_at', async () => {
    const res = await request(app).get('/api/leads?sortBy=created&sortDir=desc').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.lead.findMany.mock.calls[0][0].orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
  });
});

describe('the three sortBy-less callers with no prior orderBy assertion keep their exact default', () => {
  it('GET /api/price-book/items defaults to sort_order asc', async () => {
    const res = await request(app).get('/api/price-book/items').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.findMany.mock.calls[0][0].orderBy).toEqual([{ sort_order: 'asc' }]);
  });

  it('GET /api/inventory/assets defaults to updated_at desc', async () => {
    const res = await request(app).get('/api/inventory/assets').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.asset.findMany.mock.calls[0][0].orderBy).toEqual([{ updated_at: 'desc' }]);
  });

  it('GET /api/inventory/items defaults to sort_order asc', async () => {
    const res = await request(app).get('/api/inventory/items').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.priceBookItem.findMany.mock.calls[0][0].orderBy).toEqual([{ sort_order: 'asc' }]);
  });
});

describe('absent sortBy never 400s', () => {
  const NEWEST_FIRST = [{ created_at: 'desc' }];
  const cases: [string, ReturnType<typeof vi.fn>, unknown[]][] = [
    ['/api/customers', mockPrisma.customer.findMany, NEWEST_FIRST],
    ['/api/jobs', mockPrisma.job.findMany, NEWEST_FIRST],
    ['/api/estimates', mockPrisma.estimate.findMany, NEWEST_FIRST],
    // Visits slice 06: the leads list breaks created_at ties on the id (stable numbered pages).
    ['/api/leads', mockPrisma.lead.findMany, [...NEWEST_FIRST, { id: 'asc' }]],
    ['/api/invoices', mockPrisma.invoice.findMany, NEWEST_FIRST],
  ];

  it.each(cases)('%s with no sortBy returns 200 ordered by created_at desc', async (path, findMany, orderBy) => {
    const res = await request(app).get(path).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0][0].orderBy).toEqual(orderBy);
  });
});

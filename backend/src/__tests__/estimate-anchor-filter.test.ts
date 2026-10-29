/**
 * #2026 slice 1 — the estimate list gains an explicit ANCHOR parameter.
 *
 * `customer_id` alone matches every estimate that reaches the customer, including the ones
 * anchored to one of that customer's leads or jobs — Estimate.customer_id is denormalised onto
 * every row. The tab strip on a customer-anchored estimate needs the narrower question: estimates
 * anchored to THIS customer, with no lead and no job.
 *
 * Asserted on the `where` the route hands Prisma, because that clause IS the behaviour: the rows
 * come back from a mock either way, so a test that only counted results could not fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  invoice: { aggregate: ReturnType<typeof vi.fn> };
};

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const LEAD_ID = '10000000-0000-0000-0000-0000000000bb';
const JOB_ID = 'a0000000-0000-0000-0000-0000000000cc';

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.estimate.groupBy.mockResolvedValue([]);
  mockPrisma.estimate.aggregate.mockResolvedValue({ _count: 0, _sum: { total_amount: 0 } });
  mockPrisma.invoice.aggregate.mockResolvedValue({ _count: 0, _sum: { amount_due: null } });
});

/** Every clause the route actually asked for, flattened out of the where + its AND list. */
async function whereFor(query: string): Promise<Record<string, unknown>> {
  await request(app).get(`/api/estimates${query}`).set(authHeader('admin')).expect(200);
  const where = mockPrisma.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;
  const and = Array.isArray(where.AND) ? (where.AND as Record<string, unknown>[]) : [];
  return Object.assign({}, where, ...and);
}

describe('the estimate list anchor filter', () => {
  it('narrows a customer to the estimates anchored to the customer itself', async () => {
    const where = await whereFor(`?customer_id=${CUSTOMER_ID}&anchor=customer`);

    expect(where).toMatchObject({ customer_id: CUSTOMER_ID, lead_id: null, job_id: null });
  });

  it('narrows a job to the estimates anchored to that job', async () => {
    const where = await whereFor(`?job_id=${JOB_ID}&anchor=job`);

    expect(where).toMatchObject({ job_id: JOB_ID, lead_id: null });
  });

  it('narrows a lead to the estimates anchored to that lead', async () => {
    const where = await whereFor(`?lead_id=${LEAD_ID}&anchor=lead`);

    expect(where).toMatchObject({ lead_id: LEAD_ID, job_id: null });
  });

  it('leaves the result set exactly as it is today when no anchor is given', async () => {
    const where = await whereFor(`?customer_id=${CUSTOMER_ID}`);

    expect(where).toMatchObject({ customer_id: CUSTOMER_ID });
    expect(where).not.toHaveProperty('lead_id');
    expect(where).not.toHaveProperty('job_id');
  });

  it('ignores an anchor value it does not recognise rather than inventing a clause', async () => {
    const where = await whereFor(`?customer_id=${CUSTOMER_ID}&anchor=banana`);

    expect(where).not.toHaveProperty('lead_id');
    expect(where).not.toHaveProperty('job_id');
  });

  it('composes with tenant scoping — the org clause survives the anchor filter', async () => {
    await request(app)
      .get(`/api/estimates?customer_id=${CUSTOMER_ID}&anchor=customer`)
      .set(authHeader('admin'))
      .expect(200);

    const where = mockPrisma.estimate.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.organization_id).toBeTruthy();
  });
});

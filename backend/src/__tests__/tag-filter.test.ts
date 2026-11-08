import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LEAD_FIXTURE,
} from './helpers';

// SRVW-58 - the `tags` list facet, end to end through a real route.
//
// After this change GET /api/leads hits prisma.tagAssignment.findMany TWICE per
// request: once in the facet (resolution, `select: { entity_id }`) and once in
// loadTagsByEntity via withTagsMany (hydration, `select: { entity_id, tag }`,
// which does `list.push(a.tag)`). A single blanket mockResolvedValue would push
// `undefined` into every lead's tags array, so both calls are sequenced with
// mockResolvedValueOnce and every assertion names its call index.

const mockPrisma = prisma as unknown as {
  lead: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  tagAssignment: { findMany: ReturnType<typeof vi.fn> };
};

const TAG = { id: 'a0000000-0000-0000-0000-0000000000aa', name: 'Recurring billing', color: '#2F7D5D' };
const OTHER_ORG_TAG_ID = 'b0000000-0000-0000-0000-0000000000bb';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
});

describe('GET /api/leads?tags=<id>', () => {
  it('narrows the page query and the count identically', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);
    mockPrisma.tagAssignment.findMany
      // call 1 - facet resolution
      .mockResolvedValueOnce([{ entity_id: LEAD_FIXTURE.id }])
      // call 2 - loadTagsByEntity hydration
      .mockResolvedValueOnce([{ entity_id: LEAD_FIXTURE.id, tag: TAG }]);

    const res = await request(app)
      .get(`/api/leads?tags=${TAG.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    const resolution = mockPrisma.tagAssignment.findMany.mock.calls[0][0];
    expect(resolution.where).toEqual({
      entity_type: 'LEAD',
      tag_id: { in: [TAG.id] },
      organization_id: ALPHA_ORG_ID,
    });

    const pageWhere = mockPrisma.lead.findMany.mock.calls[0][0].where;
    const countWhere = mockPrisma.lead.count.mock.calls[0][0].where;
    expect(pageWhere.id).toEqual({ in: [LEAD_FIXTURE.id] });
    // Same mutated object reaches both, so the total can never disagree with the rows.
    expect(countWhere).toBe(pageWhere);
  });

  it('hydration still returns real tag objects when the facet is active', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([LEAD_FIXTURE]);
    mockPrisma.lead.count.mockResolvedValue(1);
    mockPrisma.tagAssignment.findMany
      .mockResolvedValueOnce([{ entity_id: LEAD_FIXTURE.id }])
      .mockResolvedValueOnce([{ entity_id: LEAD_FIXTURE.id, tag: TAG }]);

    const res = await request(app)
      .get(`/api/leads?tags=${TAG.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // The facet's entity_id-only select must not poison loadTagsByEntity's list.push(a.tag).
    expect(res.body.leads[0].tags).toEqual([TAG]);
  });
});

describe('GET /api/customers?tags=<id>', () => {
  it('a tag id from another org returns zero customers rather than leaking', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    mockPrisma.customer.count.mockResolvedValue(0);
    // Tenant-scoped resolution finds nothing for a foreign tag id.
    mockPrisma.tagAssignment.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get(`/api/customers?tags=${OTHER_ORG_TAG_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(0);

    const findManyWhere = mockPrisma.customer.findMany.mock.calls[0][0].where;
    expect(findManyWhere.id).toEqual({ in: [] });

    // loadTagsByEntity early-returns on an empty id list, so only the resolution
    // call fires on this path.
    expect(mockPrisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
  });

  it('resolves a same-org tag id and narrows the customer list', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([{ ...CUSTOMER_FIXTURE, _count: { leads: 0, jobs: 0 } }]);
    mockPrisma.customer.count.mockResolvedValue(1);
    mockPrisma.tagAssignment.findMany
      .mockResolvedValueOnce([{ entity_id: CUSTOMER_FIXTURE.id }])
      .mockResolvedValueOnce([{ entity_id: CUSTOMER_FIXTURE.id, tag: TAG }]);

    const res = await request(app)
      .get(`/api/customers?tags=${TAG.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const resolution = mockPrisma.tagAssignment.findMany.mock.calls[0][0];
    expect(resolution.where.entity_type).toBe('CUSTOMER');
    expect(mockPrisma.customer.findMany.mock.calls[0][0].where.id).toEqual({ in: [CUSTOMER_FIXTURE.id] });
    expect(res.body.customers[0].tags).toEqual([TAG]);
  });
});

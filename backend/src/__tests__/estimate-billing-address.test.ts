import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, CUSTOMER_FIXTURE } from './helpers';

// SERV10X-61 - the estimate workspace's document header renders a "Prepared For" column from the
// customer's BILLING address (billing_address_line1/2, billing_city, billing_state, billing_zip).
// estimateDetailSelect selects the customer twice - the direct `customer` anchor (lead-less) and
// the nested `lead.customer` (lead-anchored) - and neither carried a single billing_* field, so
// the column silently degraded to name + phone + email on every estimate. These tests pin both
// customer selects, since a fix that widens only one leaves half the estimates broken.

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
};

const BILLING = {
  billing_address_line1: '900 Oak Ave',
  billing_address_line2: 'Suite 210',
  billing_city: 'Round Rock',
  billing_state: 'TX',
  billing_zip: '78664',
};

/**
 * Project a fixture row through a Prisma `select` the way the real client does: a key the select
 * does not ask for is ABSENT from the returned row. The suite's prisma is fully mocked, so without
 * this the mock hands back the fixture verbatim and a "does the response carry billing_*"
 * assertion would pass even with the fields missing from estimateDetailSelect - a placebo. With
 * it, the assertion fails until the select actually asks for them.
 */
function projectThroughSelect(row: unknown, select: Record<string, unknown>): unknown {
  if (Array.isArray(row)) return row.map((r) => projectThroughSelect(r, select));
  if (row === null || row === undefined || typeof row !== 'object') return row;
  if (row instanceof Date) return row;
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!(key in src)) continue;
    if (spec && typeof spec === 'object' && 'select' in (spec as Record<string, unknown>)) {
      out[key] = projectThroughSelect(src[key], (spec as { select: Record<string, unknown> }).select);
    } else if (spec) {
      out[key] = src[key];
    }
  }
  return out;
}

/** Serve `row` back through whatever select GET /api/estimates/:id actually passes. */
function serveProjected(row: Record<string, unknown>) {
  mockPrisma.estimate.findUnique.mockImplementation((args: { select: Record<string, unknown> }) =>
    Promise.resolve(projectThroughSelect(row, args.select)),
  );
}

const LEAD_ANCHORED = {
  ...ESTIMATE_FIXTURE,
  lead: {
    ...ESTIMATE_FIXTURE.lead,
    customer: { ...ESTIMATE_FIXTURE.lead.customer, ...BILLING },
  },
};

const LEAD_LESS = {
  ...ESTIMATE_FIXTURE,
  id: 'f0000000-0000-0000-0000-0000000000bb',
  estimate_number: 'E00778',
  lead_id: null,
  lead: null,
  customer_id: CUSTOMER_FIXTURE.id,
  job_id: null,
  customer: {
    id: CUSTOMER_FIXTURE.id,
    first_name: 'Nora',
    last_name: 'Vance',
    company_name: 'Vance Plumbing',
    email: 'nora@vance.com',
    phone: '5550001111',
    ...BILLING,
  },
};

describe('GET /api/estimates/:id - customer billing address (header "Prepared For")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the billing address on the nested lead.customer for a LEAD-anchored estimate', async () => {
    mockAuthAs('admin');
    serveProjected(LEAD_ANCHORED);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.lead.customer).toMatchObject(BILLING);
  });

  it('returns the billing address on the direct customer for a LEAD-LESS estimate', async () => {
    mockAuthAs('admin');
    serveProjected(LEAD_LESS);

    const res = await request(app)
      .get(`/api/estimates/${LEAD_LESS.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.lead).toBeNull();
    expect(res.body.estimate.customer).toMatchObject(BILLING);
  });

  it('asks for the billing fields on BOTH customer selects, so neither anchor is left behind', async () => {
    mockAuthAs('admin');
    serveProjected(LEAD_ANCHORED);

    await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('admin'));

    const select = mockPrisma.estimate.findUnique.mock.calls[0][0].select;
    for (const field of Object.keys(BILLING)) {
      expect(select.customer.select[field]).toBe(true);
      expect(select.lead.select.customer.select[field]).toBe(true);
    }
  });

  it('still carries the existing identity + service fields (widening only, nothing dropped)', async () => {
    mockAuthAs('admin');
    serveProjected(LEAD_ANCHORED);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.lead.customer).toMatchObject({
      company_name: 'Doe HVAC',
      email: 'john@doe.com',
      phone: '5551234567',
    });
    // The Service Location column's source, unchanged by this widening.
    expect(res.body.estimate.lead.service_address_line1).toBe('123 Main St');
  });
});

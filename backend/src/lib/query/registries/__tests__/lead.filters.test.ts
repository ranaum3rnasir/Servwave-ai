import { describe, it, expect } from 'vitest';
import { applyFilters } from '../../filterEngine';
import { leadFacets } from '../lead.filters';
import { MISSING_LEAD_OWNER_WHERE } from '../../../missingLeadOwner';

function reqWith(query: Record<string, unknown>) {
  return { query } as any;
}

describe('leadFacets: status (enum-validated)', () => {
  it('single valid status uses equals', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NEW' }), leadFacets({}));
    expect(where.status).toBe('NEW');
  });

  it('multiple valid statuses use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'CONTACTED'] }), leadFacets({}));
    expect(where.status).toEqual({ in: ['NEW', 'CONTACTED'] });
  });

  it('drops an invalid status value instead of passing it through to Prisma', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NOT_A_REAL_STATUS' }), leadFacets({}));
    expect(where.status).toBeUndefined();
  });

  it('keeps only the valid values when mixed with an invalid one', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'NOT_A_REAL_STATUS'] }), leadFacets({}));
    expect(where.status).toBe('NEW');
  });

  // Cancelled is retired for leads (S05.18): every lead that was Cancelled is Lost now, so a saved link or bookmark that
  // still filters on Cancelled shows the Lost leads instead of dropping the filter and showing every lead.
  it('reads a saved Cancelled filter as Lost', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'CANCELLED' }), leadFacets({}));
    expect(where.status).toBe('LOST');
  });

  it('reads Cancelled beside Lost as Lost once, and beside another status as both', async () => {
    const both: any = {};
    await applyFilters(both, reqWith({ status: ['LOST', 'CANCELLED'] }), leadFacets({}));
    expect(both.status).toBe('LOST');

    const mixed: any = {};
    await applyFilters(mixed, reqWith({ status: ['NEW', 'CANCELLED'] }), leadFacets({}));
    expect(mixed.status).toEqual({ in: ['NEW', 'LOST'] });
  });
});

describe('leadFacets: job_type', () => {
  it('is a plain equalsOrIn column facet', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ job_type: ['Plumbing', 'HVAC'] }), leadFacets({}));
    expect(where.job_type).toEqual({ in: ['Plumbing', 'HVAC'] });
  });
});

describe('leadFacets: customer_id', () => {
  it('single value is scalar (not wrapped in `in`)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ customer_id: 'cust-1' }), leadFacets({}));
    expect(where.customer_id).toBe('cust-1');
  });

  it('multiple values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ customer_id: ['cust-1', 'cust-2'] }), leadFacets({}));
    expect(where.customer_id).toEqual({ in: ['cust-1', 'cust-2'] });
  });
});

describe('leadFacets: ad_source (Customer relation)', () => {
  it('writes through where.customer.ad_source, not a direct column', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ ad_source: 'Google' }), leadFacets({}));
    expect(where.customer).toEqual({ ad_source: 'Google' });
  });

  it('multiple values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ ad_source: ['Google', 'Referral'] }), leadFacets({}));
    expect(where.customer).toEqual({ ad_source: { in: ['Google', 'Referral'] } });
  });

  it('merges into an existing where.customer instead of clobbering it', async () => {
    const where: any = { customer: { kind: 'PERSON' } };
    await applyFilters(where, reqWith({ ad_source: 'Google' }), leadFacets({}));
    expect(where.customer).toEqual({ kind: 'PERSON', ad_source: 'Google' });
  });
});

// Walkthrough-as-entity redesign, PR-B2: the bucket collapses to Walkthrough.status =
// REQUESTED — no lead status default/involved at all.
describe('leadFacets: walkthrough_status (synthetic/derived)', () => {
  // Multi-visit D22a: the bucket is the ABSENCE of a live visit, not a REQUESTED placeholder.
  it("'needs_scheduling' expands to a visits relation filter on having NO live visit with a time", async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ walkthrough_status: 'needs_scheduling' }), leadFacets({}));
    expect(where.visits).toEqual({ none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] }, scheduled_at: { not: null } } });
    expect(where.status).toBeUndefined();
  });

  it('coexists with an explicit status filter (no longer defaults or overrides it)', async () => {
    const where: any = {};
    await applyFilters(
      where,
      reqWith({ status: 'CONTACTED', walkthrough_status: 'needs_scheduling' }),
      leadFacets({}),
    );
    expect(where.status).toBe('CONTACTED');
    expect(where.visits).toEqual({ none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] }, scheduled_at: { not: null } } });
  });

  it('any value other than needs_scheduling is a no-op (only value in the system today)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ walkthrough_status: 'bogus' }), leadFacets({}));
    expect(where.visits).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  // SECURITY: the row-scope lives in `some`; the bucket condition is `none`. Prisma ANDs the two
  // on the same relation, so the facet must ADD its key rather than replace `where.visits` -
  // replacing it would drop a TECHNICIAN's OWN_WALKTHROUGH scope, an RBAC bypass.
  it('SECURITY: keeps an existing scopeWhere.visits some-clause (TECHNICIAN OWN_WALKTHROUGH) alongside its own none-clause', async () => {
    const scopeWhere = { visits: { some: { assignees: { some: { user_id: 'the-tech' } } } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ walkthrough_status: 'needs_scheduling' }), leadFacets(scopeWhere));
    expect(where.visits).toEqual({
      some: { assignees: { some: { user_id: 'the-tech' } } },
      none: { status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] }, scheduled_at: { not: null } },
    });
  });
});

describe('leadFacets: assigned_to (SECURITY: scope-guard)', () => {
  it('applies normally when scopeWhere does not already constrain lead_assignees', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: ['u1', 'u2'] }), leadFacets({}));
    expect(where.lead_assignees).toEqual({ some: { user_id: { in: ['u1', 'u2'] } } });
  });

  it.each(['NO_OWNER', 'UNASSIGNED'])('%s means the Missing lead owner predicate, composed under AND', async (sentinel) => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: sentinel }), leadFacets({}));
    expect(where.AND).toEqual([MISSING_LEAD_OWNER_WHERE]);
    // Nothing is written onto a key the row-scope may own.
    expect(where.lead_assignees).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  it('is a NO-OP when scopeWhere already set lead_assignees (row-scoped role) — the RBAC-critical case', async () => {
    const scopeWhere = { lead_assignees: { some: { user_id: 'the-sales-rep' } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ assigned_to: 'someone-else' }), leadFacets(scopeWhere));
    // Must still be the scope's own restriction — NOT widened/replaced by the query param.
    expect(where.lead_assignees).toEqual({ some: { user_id: 'the-sales-rep' } });
  });

  it('keeps the scope intact for the No owner sentinel, which only narrows it (AND), and ignores named owners', async () => {
    const scopeWhere = { lead_assignees: { some: { user_id: 'the-sales-rep' } } };
    const where: any = { ...scopeWhere };
    await applyFilters(where, reqWith({ assigned_to: ['NO_OWNER', 'someone-else'] }), leadFacets(scopeWhere));
    expect(where.lead_assignees).toEqual({ some: { user_id: 'the-sales-rep' } });
    expect(where.AND).toEqual([MISSING_LEAD_OWNER_WHERE]);
  });
});

describe('leadFacets: created dateRange', () => {
  // Bare 'YYYY-MM-DD' bounds are ORG days, and the "to" day is INCLUSIVE - so the far edge is
  // `lt` the start of the NEXT org day, not `lte` the start of its own (which dropped the last
  // day of every range and made a single-day range empty). See lib/orgDayRange.ts.
  it('created_after/before -> a half-open org-day window on created_at', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_after: '2026-01-01', created_before: '2026-02-01' }), leadFacets({}));
    expect(where.created_at.gte).toBeInstanceOf(Date);
    expect(where.created_at.lt).toBeInstanceOf(Date);
    expect(where.created_at.lte).toBeUndefined();
  });

  it('includes the whole of the "to" day', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_before: '2026-02-01' }), leadFacets({}));
    // Default org zone America/New_York, UTC-5 in February.
    expect(where.created_at.lt).toEqual(new Date('2026-02-02T05:00:00.000Z'));
  });
});

describe('leadFacets: dispatcher', () => {
  it('a person narrows to that Dispatcher, under AND', async () => {
    const where: any = {};
    const id = '6b0ff11b-5581-4fc0-9acf-0cb6eb4de37f';
    await applyFilters(where, reqWith({ dispatcher: id }), leadFacets({}));
    expect(where.AND).toEqual([{ dispatcher_id: { in: [id] } }]);
  });

  it('NO_DISPATCHER means no Dispatcher, and either choice may be combined', async () => {
    const id = '6b0ff11b-5581-4fc0-9acf-0cb6eb4de37f';
    const none: any = {};
    await applyFilters(none, reqWith({ dispatcher: 'NO_DISPATCHER' }), leadFacets({}));
    expect(none.AND).toEqual([{ dispatcher_id: null }]);
    const both: any = {};
    await applyFilters(both, reqWith({ dispatcher: [id, 'NO_DISPATCHER'] }), leadFacets({}));
    expect(both.AND).toEqual([{ OR: [{ dispatcher_id: { in: [id] } }, { dispatcher_id: null }] }]);
  });

  it('drops a value that is not a person and adds nothing', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ dispatcher: 'not-a-person' }), leadFacets({}));
    expect(where.AND).toBeUndefined();
  });

  it('keeps an existing row-scope AND beside its own clause', async () => {
    const where: any = { AND: [{ id: { in: ['x'] } }] };
    await applyFilters(where, reqWith({ dispatcher: 'NO_DISPATCHER' }), leadFacets({}));
    expect(where.AND).toEqual([{ id: { in: ['x'] } }, { dispatcher_id: null }]);
  });
});

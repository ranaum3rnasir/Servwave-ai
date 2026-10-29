import { describe, it, expect, vi } from 'vitest';
import { applyFilters, equalsOrIn, relationSome } from '../filterEngine';


// The org zone is resolved by the REAL `getOrgTimezone`, reading a stubbed `organization`
// row - mocking the timezone module's export would not intercept `getRequestOrgTimezone`'s
// own intra-module call to it, and would test less. `findUnique` doubles as the probe for
// "was a database lookup made at all".
const { findUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(async ({ where }: any) => ({
    timezone: where.id === 'org-manila' ? 'Asia/Manila' : 'America/New_York',
  })),
}));
vi.mock('../../prisma', () => ({ prisma: { organization: { findUnique } } }));

function reqWith(query: Record<string, unknown>) {
  return { query } as any;
}

const statusFacet = { key: 'status', kind: 'multi' as const, param: 'status', apply: equalsOrIn('status') };
const createdFacet = { key: 'created', kind: 'dateRange' as const, afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' };
const assigneeFacet = { key: 'assigned_to', kind: 'multi' as const, param: 'assigned_to', apply: relationSome('lead_assignees', 'user_id') };

describe('filterEngine: multi', () => {
  it('single value uses equals', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NEW' }), [statusFacet]);
    expect(where.status).toBe('NEW');
  });
  it('many values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'WON'] }), [statusFacet]);
    expect(where.status).toEqual({ in: ['NEW', 'WON'] });
  });
  it('relation helper nests under the relation key and AND-appends', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: ['u1', 'u2'] }), [assigneeFacet]);
    expect(where.lead_assignees).toEqual({ some: { user_id: { in: ['u1', 'u2'] } } });
  });
  it('missing param leaves where untouched', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({}), [statusFacet]);
    expect(where.status).toBeUndefined();
  });

  it('two multi facets sharing one relation both land under the same .some without clobbering each other', async () => {
    // This is the exact scenario Task 10 (Jobs) depends on: "Assigned To" and
    // "Department" both write into where.assignees.some via relationSome, on
    // different fields. Neither facet may overwrite the other's contribution.
    const assignedToFacet = {
      key: 'assigned_to',
      kind: 'multi' as const,
      param: 'assigned_to',
      apply: relationSome('assignees', 'user_id'),
    };
    const departmentFacet = {
      key: 'department',
      kind: 'multi' as const,
      param: 'department',
      apply: relationSome('assignees', 'department'),
    };
    const where: any = {};
    await applyFilters(
      where,
      reqWith({ assigned_to: ['u1', 'u2'], department: 'HVAC' }),
      [assignedToFacet, departmentFacet],
    );
    expect(where.assignees).toEqual({
      some: { user_id: { in: ['u1', 'u2'] }, department: 'HVAC' },
    });
  });
});

describe('filterEngine: dateRange', () => {
  it('created_after/before -> gte/lte Date', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_after: '2026-01-01' }), [createdFacet]);
    expect((where.created_at as any).gte).toBeInstanceOf(Date);
  });

  // The wire contract sends BARE org-zone days ('YYYY-MM-DD'). `new Date(day)` read those as
  // midnight UTC, which made the inclusive "to" day an EXCLUSIVE bound at that day's START:
  // a single-day range ("Today") was zero-width and could never match, and every longer
  // range silently dropped its last day. The bound is now `lt` on the start of the NEXT org
  // day, so the "to" day is genuinely included. See lib/orgDayRange.ts.
  it('a bare "to" DAY is inclusive: lt the NEXT org day, not lte its own start', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_before: '2026-02-01' }), [createdFacet]);
    // Default org zone is America/New_York (UTC-5 in February).
    expect(where.created_at).toEqual({ lt: new Date('2026-02-02T05:00:00.000Z') });
  });

  it('a single-day range is a full org day, so a "Today" filter can actually match', async () => {
    const where: any = {};
    await applyFilters(
      where,
      reqWith({ created_after: '2026-08-24', created_before: '2026-08-24' }),
      [createdFacet],
    );
    expect(where.created_at).toEqual({
      gte: new Date('2026-08-24T04:00:00.000Z'),
      lt: new Date('2026-08-25T04:00:00.000Z'),
    });
  });

  it('anchors bare days on the ORG zone, not UTC and not the server clock', async () => {
    const where: any = {};
    await applyFilters(
      where,
      { query: { created_after: '2026-08-24' }, user: { organization_id: 'org-manila' } } as any,
      [createdFacet],
    );
    // Manila is UTC+8, so the org day begins on the PREVIOUS UTC day.
    expect(where.created_at).toEqual({ gte: new Date('2026-08-23T16:00:00.000Z') });
  });

  it('leaves a full ISO instant on the OLD gte/lte semantics — the schedule board path', async () => {
    const where: any = {};
    const after = '2026-08-24T04:00:00.000Z';
    const before = '2026-08-25T03:59:59.999Z';
    await applyFilters(where, reqWith({ created_after: after, created_before: before }), [createdFacet]);
    expect(where.created_at).toEqual({ gte: new Date(after), lte: new Date(before) });
  });

  it('does not hit the database to resolve a zone it cannot use', async () => {
    findUnique.mockClear();
    const where: any = {};
    await applyFilters(
      where,
      { query: { created_after: '2026-08-24T04:00:00.000Z' }, user: { organization_id: 'org-manila' } } as any,
      [createdFacet],
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('resolves the org zone ONCE for several dateRange facets on one request', async () => {
    findUnique.mockClear();
    const dueFacet = {
      key: 'due', kind: 'dateRange' as const,
      afterParam: 'due_after', beforeParam: 'due_before', column: 'due_date',
    };
    const where: any = {};
    await applyFilters(
      where,
      { query: { created_after: '2026-08-24', due_before: '2026-08-31' }, user: { organization_id: 'org-manila' } } as any,
      [createdFacet, dueFacet],
    );
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('filterEngine: range', () => {
  // Self-defined facet for this pure-engine test — deliberately using param
  // names distinct from any real entity's wire contract, since this suite
  // tests the mechanism (min/max -> gte/lte on the mapped column), not any
  // specific entity's param naming.
  const totalFacet = {
    key: 'total',
    kind: 'range' as const,
    minParam: 'min_total',
    maxParam: 'max_total',
    column: 'total_amount',
  };

  it('min+max -> gte/lte on the mapped column', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ min_total: '100', max_total: '500' }), [totalFacet]);
    expect(where.total_amount).toEqual({ gte: 100, lte: 500 });
  });

  it('blank max is open-ended (gte only)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ min_total: '100' }), [totalFacet]);
    expect(where.total_amount).toEqual({ gte: 100 });
  });

  it('blank min is open-ended (lte only)', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ max_total: '500' }), [totalFacet]);
    expect(where.total_amount).toEqual({ lte: 500 });
  });

  it('neither bound present is a no-op', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({}), [totalFacet]);
    expect(where.total_amount).toBeUndefined();
  });
});

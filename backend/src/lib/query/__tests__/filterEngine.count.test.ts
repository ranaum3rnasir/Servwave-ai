/**
 * Fast unit tests for the `countRange` facet kind (Task 3), using the global
 * mocked Prisma client from `src/__tests__/setup.ts` — no real DB access.
 * Complements `filterEngine.count.integration.test.ts`, which exercises the
 * real groupBy/having SQL against a seeded org (gated, real-DB only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyFilters, FacetDef } from '../filterEngine';
import { prisma } from '../../prisma';

function reqWithOrg(orgId: string, query: Record<string, unknown>) {
  return { query, user: { organization_id: orgId } } as any;
}

const countFacet: FacetDef = {
  key: 'estimates',
  kind: 'countRange',
  minParam: 'min_estimates',
  maxParam: 'max_estimates',
  countOn: { model: 'estimate', groupField: 'lead_id' },
};

const ORG = 'org-1';

describe('filterEngine: countRange (unit, mocked prisma)', () => {
  beforeEach(() => {
    vi.mocked(prisma.estimate.groupBy).mockReset();
  });

  it('no min/max params is a no-op — no groupBy call, where untouched', async () => {
    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, {}), [countFacet]);
    expect(prisma.estimate.groupBy).not.toHaveBeenCalled();
    expect(where.id).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it('min only: one groupBy call (gte), sets where.id = { in }', async () => {
    vi.mocked(prisma.estimate.groupBy).mockResolvedValueOnce([{ lead_id: 'lead-b' }, { lead_id: 'lead-c' }] as any);
    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { min_estimates: '1' }), [countFacet]);

    expect(prisma.estimate.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.estimate.groupBy).toHaveBeenCalledWith({
      by: ['lead_id'],
      where: { organization_id: ORG },
      _count: { _all: true },
      having: { lead_id: { _count: { gte: 1 } } },
    });
    expect(where.id).toEqual({ in: ['lead-b', 'lead-c'] });
  });

  it('max=0 is zero-inclusive: excludes leads with >0 estimates via notIn', async () => {
    vi.mocked(prisma.estimate.groupBy).mockResolvedValueOnce([{ lead_id: 'lead-b' }, { lead_id: 'lead-c' }] as any);
    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { max_estimates: '0' }), [countFacet]);

    expect(prisma.estimate.groupBy).toHaveBeenCalledWith({
      by: ['lead_id'],
      where: { organization_id: ORG },
      _count: { _all: true },
      having: { lead_id: { _count: { gt: 0 } } },
    });
    expect(where.id).toEqual({ notIn: ['lead-b', 'lead-c'] });
  });

  it('min+max: two groupBy calls (gte min, gt max), AND-merges in + notIn', async () => {
    vi.mocked(prisma.estimate.groupBy)
      .mockResolvedValueOnce([{ lead_id: 'lead-a' }, { lead_id: 'lead-b' }] as any) // >= min
      .mockResolvedValueOnce([{ lead_id: 'lead-b' }] as any); // > max

    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { min_estimates: '1', max_estimates: '3' }), [countFacet]);

    expect(prisma.estimate.groupBy).toHaveBeenCalledTimes(2);
    expect(prisma.estimate.groupBy).toHaveBeenNthCalledWith(1, {
      by: ['lead_id'],
      where: { organization_id: ORG },
      _count: { _all: true },
      having: { lead_id: { _count: { gte: 1 } } },
    });
    expect(prisma.estimate.groupBy).toHaveBeenNthCalledWith(2, {
      by: ['lead_id'],
      where: { organization_id: ORG },
      _count: { _all: true },
      having: { lead_id: { _count: { gt: 3 } } },
    });
    expect(where.AND).toEqual([{ id: { in: ['lead-a', 'lead-b'] } }, { id: { notIn: ['lead-b'] } }]);
    expect(where.id).toBeUndefined();
  });

  it('preserves an existing scalar where.id by converting to AND rather than clobbering it', async () => {
    vi.mocked(prisma.estimate.groupBy).mockResolvedValueOnce([{ lead_id: 'lead-b' }] as any);
    const where: any = { id: 'lead-preexisting' };
    await applyFilters(where, reqWithOrg(ORG, { min_estimates: '1' }), [countFacet]);

    expect(where.id).toBeUndefined();
    expect(where.AND).toEqual([{ id: 'lead-preexisting' }, { id: { in: ['lead-b'] } }]);
  });

  it('preserves an existing where.AND array by pushing rather than clobbering', async () => {
    vi.mocked(prisma.estimate.groupBy).mockResolvedValueOnce([{ lead_id: 'lead-b' }] as any);
    const where: any = { AND: [{ status: 'NEW' }] };
    await applyFilters(where, reqWithOrg(ORG, { min_estimates: '1' }), [countFacet]);

    expect(where.AND).toEqual([{ status: 'NEW' }, { id: { in: ['lead-b'] } }]);
  });
});

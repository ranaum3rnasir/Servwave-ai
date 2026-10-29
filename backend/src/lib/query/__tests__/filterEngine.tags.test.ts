/**
 * SRVW-58 - unit tests for the `tags` facet kind, using the global mocked
 * Prisma client from `src/__tests__/setup.ts` (no real DB access). Mirrors
 * filterEngine.count.test.ts, which covers the only other id-resolving facet
 * kind.
 *
 * The tags facet is the first filter that cannot be expressed as a Prisma
 * `where` on the parent row at all: TagAssignment has no back-relation to
 * Lead/Job/Customer/Estimate/Invoice, so the ids must be resolved first and
 * AND-merged through the same `mergeIdFilter` path `applyCountRange` uses.
 * Getting that merge wrong is a row-scope leak, not a cosmetic bug - hence
 * the three collision cases below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyFilters, FacetDef } from '../filterEngine';
import { prisma } from '../../prisma';

function reqWithOrg(orgId: string, query: Record<string, unknown>) {
  return { query, user: { organization_id: orgId } } as any;
}

const tagsFacet: FacetDef = {
  key: 'tags',
  kind: 'tags',
  param: 'tags',
  entityType: 'LEAD',
};

const ORG = 'org-1';
const TAG_A = '11111111-1111-4111-8111-111111111111';
const TAG_B = '22222222-2222-4222-8222-222222222222';

describe('filterEngine: tags (unit, mocked prisma)', () => {
  beforeEach(() => {
    vi.mocked(prisma.tagAssignment.findMany).mockReset();
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValue([] as any);
  });

  it('a missing tags param is a no-op', async () => {
    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, {}), [tagsFacet]);

    expect(prisma.tagAssignment.findMany).not.toHaveBeenCalled();
    expect(where.id).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it('resolves tag ids to entity ids and sets where.id = { in: [...] }', async () => {
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([
      { entity_id: 'lead-a' },
      { entity_id: 'lead-b' },
    ] as any);

    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    expect(prisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
    expect(where.id).toEqual({ in: ['lead-a', 'lead-b'] });
  });

  it('tenant-scopes the tag-id resolution query', async () => {
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([] as any);

    await applyFilters({}, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    const args = vi.mocked(prisma.tagAssignment.findMany).mock.calls[0]![0] as any;
    expect(args.where).toEqual({
      entity_type: 'LEAD',
      tag_id: { in: [TAG_A] },
      organization_id: ORG,
    });
    expect(args.select).toEqual({ entity_id: true });
  });

  it('preserves the MATCH_NOTHING fail-closed row scope instead of clobbering it', async () => {
    // scopeWhereFor.ts:4 MATCH_NOTHING is `{ id: { in: [] } }` - an OBJECT, never
    // a scalar. This is the exact production shape a fail-closed row scope writes.
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([{ entity_id: 'lead-a' }] as any);

    const where: any = { id: { in: [] } };
    await applyFilters(where, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    expect(where.id).toBeUndefined();
    expect(where.AND).toEqual([{ id: { in: [] } }, { id: { in: ['lead-a'] } }]);
  });

  it('preserves an existing scalar where.id instead of clobbering it', async () => {
    // mergeIdFilter's branch is a truthy test, so both the object and the scalar
    // shape must survive it.
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([{ entity_id: 'lead-a' }] as any);

    const where: any = { id: 'lead-preexisting' };
    await applyFilters(where, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    expect(where.id).toBeUndefined();
    expect(where.AND).toEqual([{ id: 'lead-preexisting' }, { id: { in: ['lead-a'] } }]);
  });

  it('appends to an existing where.AND rather than replacing it', async () => {
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([{ entity_id: 'lead-a' }] as any);

    const where: any = { AND: [{ customer_id: 'c1' }] };
    await applyFilters(where, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({ customer_id: 'c1' });
    expect(where.AND[1]).toEqual({ id: { in: ['lead-a'] } });
  });

  it('multiple selected tags are OR, resolved in one query', async () => {
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([
      { entity_id: 'lead-a' },
      { entity_id: 'lead-b' },
    ] as any);

    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { tags: `${TAG_A},${TAG_B}` }), [tagsFacet]);

    expect(prisma.tagAssignment.findMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.tagAssignment.findMany).mock.calls[0]![0] as any;
    expect(args.where.tag_id).toEqual({ in: [TAG_A, TAG_B] });
    expect(where.id).toEqual({ in: ['lead-a', 'lead-b'] });
  });

  it('drops non-uuid values before querying (no Prisma 500)', async () => {
    // tag_id is @db.Uuid - an unguarded `{ in: ['not-a-uuid'] }` throws.
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([{ entity_id: 'lead-a' }] as any);

    await applyFilters({}, reqWithOrg(ORG, { tags: `${TAG_A},not-a-uuid` }), [tagsFacet]);

    const args = vi.mocked(prisma.tagAssignment.findMany).mock.calls[0]![0] as any;
    expect(args.where.tag_id).toEqual({ in: [TAG_A] });
  });

  it('an all-garbage tags param issues no query and leaves where untouched', async () => {
    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { tags: 'not-a-uuid' }), [tagsFacet]);

    expect(prisma.tagAssignment.findMany).not.toHaveBeenCalled();
    expect(where.id).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it('an empty resolution filters to zero rows, never to an unfiltered list', async () => {
    vi.mocked(prisma.tagAssignment.findMany).mockResolvedValueOnce([] as any);

    const where: any = {};
    await applyFilters(where, reqWithOrg(ORG, { tags: TAG_A }), [tagsFacet]);

    expect(where.id).toEqual({ in: [] });
  });
});

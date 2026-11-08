import { parseArrayParam } from './parseArrayParam';
import { tenantWhere } from '../tenant';
import { prisma as defaultPrisma } from '../prisma';
import { isBareOrgDay, orgDayRange } from '../orgDayRange';
import { DEFAULT_TIMEZONE, getRequestOrgTimezone } from '../timezone';
import type { TagEntityType } from '../tags';

export type MultiApply = (where: Record<string, any>, values: string[]) => void;

/**
 * Applies an "equals or in" filter to a scalar column: a single value writes
 * `where[column] = value`, multiple values write `where[column] = { in: values }`.
 * No-ops when there are no values, so it never clobbers a key another facet set.
 */
export function equalsOrIn(column: string): MultiApply {
  return (where, values) => {
    if (values.length === 0) return;
    where[column] = values.length === 1 ? values[0] : { in: values };
  };
}

/**
 * Applies a multi-select filter against a to-many relation via Prisma's
 * `some`. Merges into any existing `where[relation]` / `where[relation].some`
 * rather than replacing it, so multiple facets targeting the same relation
 * (e.g. "Assigned To" + "Department" both filtering `assignees.some`) AND
 * their conditions together instead of clobbering one another.
 */
export function relationSome(relation: string, field: string): MultiApply {
  return (where, values) => {
    if (values.length === 0) return;
    const filter = values.length === 1 ? values[0] : { in: values };
    where[relation] = {
      ...(where[relation] ?? {}),
      some: { ...(where[relation]?.some ?? {}), [field]: filter },
    };
  };
}

export interface CountSpec {
  model: string;
  groupField: string;
}

export type FacetDef =
  | { key: string; kind: 'multi'; param: string; apply: MultiApply }
  | { key: string; kind: 'range'; minParam: string; maxParam: string; column: string }
  | { key: string; kind: 'dateRange'; afterParam: string; beforeParam: string; column: string }
  | { key: string; kind: 'countRange'; minParam: string; maxParam: string; countOn: CountSpec }
  | { key: string; kind: 'tags'; param: string; entityType: TagEntityType };

/**
 * Minimal shape `applyCountRange` / `applyTagFilter` need from a Prisma
 * client: any model delegate exposing `groupBy` and `findMany`. Lets callers
 * inject a real `PrismaClient`, a test double, or (in tests) the mocked shared
 * client - without this file depending on the full generated `PrismaClient`
 * type.
 */
export type PrismaClientLike = Record<
  string,
  { groupBy: (args: any) => Promise<any[]>; findMany: (args: any) => Promise<any[]> }
>;

/**
 * AND-merges an `{ id: { in|notIn } }` filter into `where` without clobbering
 * an id filter another facet - or a row-scope - already put there. Shared by
 * the two id-resolving facet kinds (`countRange` and `tags`).
 *
 * Branch order matters: `where.AND` is tested BEFORE `where.id`, so when both
 * are present the merge appends rather than rebuilding. The `where.id` branch
 * is a truthy test, which must hold for BOTH shapes production writes - a
 * scalar id, and the fail-closed row scope `MATCH_NOTHING` from
 * `lib/permissions/scopeWhereFor.ts`, which is the object `{ id: { in: [] } }`.
 */
function mergeIdFilter(where: Record<string, any>, idFilter: { in?: string[]; notIn?: string[] }): void {
  if (where.AND) {
    (where.AND as unknown[]).push({ id: idFilter });
  } else if (where.id) {
    where.AND = [{ id: where.id }, { id: idFilter }];
    delete where.id;
  } else {
    where.id = idFilter;
  }
}

/**
 * `Tag.id` / `TagAssignment.tag_id` are `@db.Uuid`, so an unguarded
 * `{ in: ['garbage'] }` throws a Prisma validation error (500) instead of the
 * "silently ignore garbage" behaviour every other facet has. Same literal as
 * inv-po.controller.ts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Filters parent rows by how many related child rows they have (e.g. "leads
 * with 1-3 estimates"). Prisma's `where` can't express "count of a relation
 * is in this range" directly, so this runs a `groupBy` + `having` on the
 * child model to resolve the set of qualifying parent ids, then AND-merges
 * an `{ id: { in|notIn } }` filter into the main `where` — without clobbering
 * an existing `where.id` or `where.AND` set by another facet.
 */
async function applyCountRange(
  where: Record<string, any>,
  req: { query: Record<string, unknown>; user?: { organization_id: string } },
  facet: Extract<FacetDef, { kind: 'countRange' }>,
  prisma: PrismaClientLike,
): Promise<void> {
  const minRaw = req.query[facet.minParam];
  const maxRaw = req.query[facet.maxParam];
  const min = minRaw != null ? Number(minRaw) : undefined;
  const max = maxRaw != null ? Number(maxRaw) : undefined;
  if (min === undefined && max === undefined) return;

  const { model, groupField } = facet.countOn;
  const tenantScope = tenantWhere(req as any);

  let includeIds: string[] | null = null;
  if (min !== undefined) {
    const groups = await prisma[model].groupBy({
      by: [groupField],
      where: tenantScope,
      _count: { _all: true },
      having: { [groupField]: { _count: { gte: min } } },
    });
    includeIds = groups.map((g: any) => g[groupField]);
  }

  let excludeIds: string[] | null = null;
  if (max !== undefined) {
    // "count <= max" is expressed as its complement, "count > max", so
    // max=0 (zero-inclusive) correctly excludes only groups with 1+ rows —
    // parents with NO child rows never appear in a groupBy result at all,
    // so they're never at risk of being excluded here.
    const overMax = await prisma[model].groupBy({
      by: [groupField],
      where: tenantScope,
      _count: { _all: true },
      having: { [groupField]: { _count: { gt: max } } },
    });
    excludeIds = overMax.map((g: any) => g[groupField]);
  }

  if (includeIds && excludeIds) {
    mergeIdFilter(where, { in: includeIds });
    mergeIdFilter(where, { notIn: excludeIds });
  } else if (includeIds) {
    mergeIdFilter(where, { in: includeIds });
  } else if (excludeIds) {
    mergeIdFilter(where, { notIn: excludeIds });
  }
}

/**
 * Filters parent rows by the tags assigned to them. `TagAssignment` is
 * polymorphic (`entity_type` + `entity_id`) and has NO Prisma back-relation to
 * Lead/Job/Customer/Estimate/Invoice, so this cannot be a `relationSome` - the
 * assignments are resolved to a set of entity ids first, then AND-merged into
 * the main `where` through the same `mergeIdFilter` path `applyCountRange`
 * uses, so the fail-closed row scope and any pre-existing `where.AND` survive.
 *
 * Multi-select is OR (one `{ tag_id: { in: [...] } }` query, never one per
 * tag), matching every other multi facet. The query rides the
 * `@@id([tag_id, entity_type, entity_id])` primary-key index prefix, so no new
 * index is needed. The resolved id array is unbounded - the same accepted
 * characteristic `applyCountRange`'s groupBy result already has; capping it
 * would silently return wrong rows.
 */
async function applyTagFilter(
  where: Record<string, any>,
  req: { query: Record<string, unknown>; user?: { organization_id: string } },
  facet: Extract<FacetDef, { kind: 'tags' }>,
  prisma: PrismaClientLike,
): Promise<void> {
  const ids = parseArrayParam(req.query[facet.param]).filter((v) => UUID_RE.test(v));
  if (ids.length === 0) return;

  const rows = await prisma.tagAssignment.findMany({
    where: {
      entity_type: facet.entityType,
      tag_id: { in: ids },
      ...tenantWhere(req as any),
    },
    select: { entity_id: true },
    distinct: ['entity_id'],
  });

  mergeIdFilter(where, { in: rows.map((r: any) => r.entity_id) });
}

export async function applyFilters(
  where: Record<string, any>,
  req: { query: Record<string, unknown>; user?: { organization_id: string } },
  facets: FacetDef[],
  prisma: PrismaClientLike = defaultPrisma as unknown as PrismaClientLike,
): Promise<void> {
  /**
   * The org clock, resolved ONLY when a bound actually needs it. A pair of full ISO instants
   * (the schedule board, the copilot job tool) is zone-independent, so those callers must not
   * pay for a database lookup - and an unauthenticated/`user`-less caller resolves to the
   * shared default without one either. `getRequestOrgTimezone` memoizes on the request, so
   * several dateRange facets on one list (e.g. invoices' `created` + `due`) share one lookup.
   */
  const timezoneFor = async (after: unknown, before: unknown): Promise<string> => {
    if (!isBareOrgDay(after) && !isBareOrgDay(before)) return DEFAULT_TIMEZONE;
    return getRequestOrgTimezone(req);
  };

  for (const facet of facets) {
    if (facet.kind === 'multi') {
      facet.apply(where, parseArrayParam(req.query[facet.param]));
    } else if (facet.kind === 'dateRange') {
      const after = req.query[facet.afterParam];
      const before = req.query[facet.beforeParam];
      if (!after && !before) continue;
      // The wire contract (frontend/src/lib/filters/types.ts) sends BARE org-zone day
      // strings, which `new Date('YYYY-MM-DD')` used to read as midnight UTC - dropping the
      // inclusive "to" day and anchoring both edges to the wrong clock. `orgDayRange` reads a
      // bare day on the ORG's clock and leaves a full ISO instant exactly as it was; see
      // lib/orgDayRange.ts. The org lookup is memoized per request and skipped entirely when
      // neither bound is a bare day.
      const range = orgDayRange(after, before, await timezoneFor(after, before));
      if (!range) continue;
      where[facet.column] = { ...(where[facet.column] ?? {}), ...range };
    } else if (facet.kind === 'countRange') {
      await applyCountRange(where, req, facet, prisma);
    } else if (facet.kind === 'tags') {
      await applyTagFilter(where, req, facet, prisma);
    } else if (facet.kind === 'range') {
      const minRaw = req.query[facet.minParam];
      const maxRaw = req.query[facet.maxParam];
      const min = minRaw != null ? Number(minRaw) : NaN;
      const max = maxRaw != null ? Number(maxRaw) : NaN;
      if (Number.isNaN(min) && Number.isNaN(max)) continue;
      const range: { gte?: number; lte?: number } = {};
      if (!Number.isNaN(min)) range.gte = min;
      if (!Number.isNaN(max)) range.lte = max;
      where[facet.column] = { ...((where[facet.column] as object) ?? {}), ...range };
    }
  }
}

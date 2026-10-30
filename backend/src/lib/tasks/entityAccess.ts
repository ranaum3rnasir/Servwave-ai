import { prisma } from '../prisma';
import {
  scopeWhereForUser,
  scopeTemplateForProfile,
  type PermissionUser,
} from '../permissions/enforce';
import type { AppAbility } from '../permissions/defineAbility';
import type { ScopeResource } from '../permissions/scopeWhereFor';

/** A task's polymorphic link target. `type` is untrusted input - unknown values fail closed. */
export interface EntityRef {
  type: string;
  id: string;
}

/** The reader being asked about. `req.user` satisfies it, and so does a plain `users` row. */
export type EntityAccessReader = PermissionUser;

export const entityRefKey = (type: string, id: string): string => `${type}:${id}`;

/**
 * Minimal delegate slice - `any` for the same contravariance reason as enforce.ts's RowDelegate:
 * a concrete Prisma delegate types `where` as its model-specific WhereInput, which is not
 * assignable to a narrower `{ where: unknown }` parameter.
 */
export type EntityDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args: any): Promise<{ id: string } | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany(args: any): Promise<{ id: string }[]>;
};

const SCOPED: Record<string, ScopeResource> = {
  JOB: 'Job',
  LEAD: 'Lead',
  ESTIMATE: 'Estimate',
  // #2041 — Customer is now a ScopeResource (SALES's read Customer carries OWN_CUSTOMER), so it
  // takes the same SQL row-scope path every other subject here does; the special CASL
  // subject-level branch this used to fall through to is gone.
  CUSTOMER: 'Customer',
};

// Getters, not values: the client is read when a delegate is asked for, never while this module loads. A test file
// that mocks '../lib/prisma' with no client (the real-database suites, when no database is configured) must still be
// able to import everything that imports this file, so it can skip instead of crashing at import.
export const ENTITY_DELEGATES: Record<string, EntityDelegate> = {
  get JOB() {
    return prisma.job;
  },
  get LEAD() {
    return prisma.lead;
  },
  get ESTIMATE() {
    return prisma.estimate;
  },
  get CUSTOMER() {
    return prisma.customer;
  },
};

/**
 * Records an ALERT can be about but a task cannot link to. An invoice is reached through its job (or, with no job,
 * its estimate); the alert "someone" test (lib/permissions/alertSomeone.ts) asks who can open it. Kept apart from
 * ENTITY_DELEGATES, which is also the list of kinds a task may link to.
 */
const ALERT_ONLY_SCOPED: Record<string, ScopeResource> = { INVOICE: 'Invoice' };
export const ALERT_RECORD_DELEGATES: Record<string, EntityDelegate> = {
  // Not `...ENTITY_DELEGATES`: spreading would read every getter at load.
  get JOB() {
    return ENTITY_DELEGATES.JOB;
  },
  get LEAD() {
    return ENTITY_DELEGATES.LEAD;
  },
  get ESTIMATE() {
    return ENTITY_DELEGATES.ESTIMATE;
  },
  get CUSTOMER() {
    return ENTITY_DELEGATES.CUSTOMER;
  },
  get INVOICE() {
    return prisma.invoice;
  },
};

/**
 * `profile` switches the answer from "this reader" to "any reader with this permission profile":
 * `{{userId}}` resolves to `userIdPlaceholder`.
 * The caller substitutes real ids into the returned fragment - see entityAccessCohort.ts.
 */
export interface EntityScopeOpts {
  ability?: AppAbility;
  profile?: { userIdPlaceholder: string };
}

export interface EntityAccessScope {
  /** Tenant + grant-derived read scope. Spread it next to your own `id` predicate. */
  where: Record<string, unknown>;
  /**
   * True when `where` narrows beyond tenant + existence. It is the difference between "this row
   * is not yours" and "this row is not there": on an UNRESTRICTED scope a miss can only mean the
   * entity is gone, so a caller must not report it as redacted.
   */
  restricted: boolean;
}

/**
 * THE linked-entity access rule (#245), expressed as a Prisma `where` fragment so both the
 * single-row probe (`canAccessLinkedEntity`) and the batched readers below can enforce it without
 * either restating it. Change the policy here and both move together.
 *
 * JOB/LEAD/ESTIMATE/CUSTOMER (#2041) all resolve to tenant + the grant-derived read scope - SQL
 * rather than CASL, because @casl/prisma's in-memory matcher throws on the nested to-many
 * conditions these subjects carry (OWN_CUSTOMER included, since #2041 conditioned SALES's read
 * Customer). `scopeWhereForUser` fails closed on a missing grant exactly the way the deleted
 * CASL-subject branch did, so a TECHNICIAN (no `read Customer` at all) still resolves to
 * MATCH_NOTHING here.
 *
 * Returns null when the reader cannot reach the type AT ALL - an unknown type. Null means "no
 * query, nothing is accessible": fail closed.
 *
 * Deliberately NOT a fast path. Even an unrestricted reader gets tenant + existence, because
 * `create` leans on this to refuse a link to an id outside the tenant.
 *
 * `opts.ability` reuses the ability `attachAbility` already built; omit it and one is derived from
 * `reader`, which is what makes every entry point here answerable for a user who is not the
 * caller.
 */
export async function entityAccessScope(
  reader: EntityAccessReader,
  type: string,
  opts: EntityScopeOpts = {},
): Promise<EntityAccessScope | null> {
  const tenant = { organization_id: reader.organization_id };

  const resource = SCOPED[type] ?? ALERT_ONLY_SCOPED[type];
  if (resource) {
    const scope = opts.profile
      ? await scopeTemplateForProfile(reader, resource, opts.profile.userIdPlaceholder)
      : await scopeWhereForUser(reader, resource);
    return { where: { ...tenant, ...scope }, restricted: Object.keys(scope).length > 0 };
  }
  return null;
}

/**
 * Which of `refs` can this reader open? The batched form of the rule above.
 *
 * BATCHED: at most ONE findMany per entity type - four for the whole input, however many refs it
 * holds. Never call this inside a loop over rows; hand it the entire set.
 *
 * Exported for any caller that needs the yes/no set rather than labels (the label enricher runs
 * the same fragment with a wider select, so it does not pay for a second pass).
 */
export async function accessibleEntityRefs(
  reader: EntityAccessReader,
  refs: EntityRef[],
  opts: EntityScopeOpts = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const byType = groupRefs(refs);
  if (!byType.size) return out;

  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const scope = await entityAccessScope(reader, type, opts);
      const delegate = ENTITY_DELEGATES[type];
      if (!scope || !delegate) return;
      const rows = await delegate.findMany({
        where: { id: { in: ids }, ...scope.where },
        select: { id: true },
      });
      rows.forEach((row) => out.add(entityRefKey(type, row.id)));
    }),
  );

  return out;
}

/** Dedupe and bucket refs by type - the shape every batched reader here iterates. */
export function groupRefs(refs: EntityRef[]): Map<string, string[]> {
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r?.type || !r?.id) continue;
    const bucket = byType.get(r.type) ?? new Set<string>();
    bucket.add(r.id);
    byType.set(r.type, bucket);
  }
  return new Map([...byType].map(([type, ids]) => [type, [...ids]]));
}

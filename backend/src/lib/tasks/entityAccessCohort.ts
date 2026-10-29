import { logger } from '../logger';
import type { PermissionUser } from '../permissions/enforce';
import { grantRoleKey, isSuperUser } from '../permissions/effectiveRole';
import { loadUserOverridesMany } from '../permissions/loadUserOverrides';
import type { PermissionOverride } from '../permissions/defineAbility';
import { entityAccessScope, ENTITY_DELEGATES, type EntityRef } from './entityAccess';

/**
 * THE TRANSPOSE of entityAccess.ts (#05).
 *
 * `accessibleEntityRefs` answers "one reader, many entities". The assignee picker asks the
 * opposite: ONE entity, every candidate assignee. Written the obvious way that is a permission
 * derivation and at least one query per candidate - the same N+1 #01 removed from the task list,
 * moved into the picker.
 *
 * Two facts collapse it:
 *
 *   1. The scope fragment is identical for everyone sharing a permission PROFILE (super-user-ness,
 *      grant role key, base role, department, location, override set), so it is derived once per
 *      profile with `{{userId}}` left as a placeholder. Overrides for the whole cohort load in one
 *      query. Grants are already cached per role.
 *
 *   2. Profile alone does NOT settle the answer, and assuming it does is the trap here: an
 *      own-scoped grant (`visits.some.assignees.some.user_id = {{userId}}`) gives two technicians
 *      with the same role, department and location DIFFERENT answers for the same job, because the
 *      placeholder is the thing that differs. Those profiles are resolved by substituting the whole
 *      cohort's ids as an `in` filter and reading back WHICH of them matched, through a `select`
 *      mirroring the condition's own relation path. One query per profile, not per candidate.
 *
 * Read-only and advisory. Nothing here gates a write.
 */

/** Stands in for `{{userId}}` in a profile's fragment. Not a uuid, so it cannot be a real id. */
const COHORT_USER = '__COHORT_USER__';

export interface CohortEntityAccess {
  /** Ids of readers who can open the entity. Everyone else in the input cannot. */
  withAccess: Set<string>;
  /** Entity probes issued. The batching test asserts on this; it must not scale with the cohort. */
  probes: number;
  /**
   * Arms the mirror could not express, each then resolved ONE READER AT A TIME. Correct but linear,
   * so a non-zero value means the batching this module exists for is off for that grant shape.
   * Surfaced rather than merely logged because it is invisible in the answer: staging ran 704
   * differential checks with `probes == readers` and a perfect result, which is exactly how the
   * ESTIMATE creator-arm collapse survived review.
   */
  fallbacks: number;
}

type ProbeDelegate = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFirst(args: any): Promise<Record<string, unknown> | null>;
};

interface Profile {
  members: PermissionUser[];
  overrides: PermissionOverride[];
}

/** Readers who resolved to one byte-identical scope fragment, and therefore share one probe. */
interface Cohort {
  where: Record<string, unknown>;
  ids: string[];
}

interface Counter {
  probes: number;
  fallbacks: number;
}

/**
 * Which of `readers` can open `ref`? Fails CLOSED per reader: an unknown entity type, a missing
 * subject grant or a probe that throws all leave the reader out of the returned set.
 */
export async function readersWithEntityAccess(
  readers: PermissionUser[],
  ref: EntityRef,
): Promise<CohortEntityAccess> {
  const withAccess = new Set<string>();
  const counter: Counter = { probes: 0, fallbacks: 0 };
  const delegate = ENTITY_DELEGATES[ref.type] as unknown as ProbeDelegate | undefined;
  if (!readers.length || !delegate) return { withAccess, ...counter };

  const overridesByUser = await loadUserOverridesMany(
    readers.filter((r) => !isSuperUser(r)).map((r) => r.id),
  );

  // Step 1 bounds how often the scope is DERIVED: once per permission profile, in memory, off
  // already-cached grants.
  const profiles = new Map<string, Profile>();
  for (const reader of readers) {
    const overrides = isSuperUser(reader) ? [] : overridesByUser.get(reader.id) ?? [];
    const key = profileKey(reader, overrides);
    const existing = profiles.get(key);
    if (existing) existing.members.push(reader);
    else profiles.set(key, { members: [reader], overrides });
  }

  // Step 2 bounds how often the entity is PROBED, and it is a DIFFERENT key. Profile identity has
  // to be conservative (it decides what may share a derivation), so it carries department and
  // location whether or not any grant condition mentions them - on staging that made a 52-reader
  // roster spread over distinct departments cost 92 probes for one job, worse than the per-reader
  // implementation this module replaces. The fragment is the honest grouping: two profiles that
  // resolve to byte-identical SQL necessarily get the same answer for the same row, so they share
  // one probe. A department no condition references collapses away here instead of costing a query.
  const cohorts = new Map<string, Cohort>();
  await Promise.all(
    [...profiles.values()].map(async (profile) => {
      const scope = await entityAccessScope(profile.members[0], ref.type, {
        profile: { userIdPlaceholder: COHORT_USER, overrides: profile.overrides },
      });
      if (!scope) return; // unknown type, or a subject grant this profile does not hold: no probe
      const key = JSON.stringify(scope.where);
      const bucket = cohorts.get(key);
      if (bucket) bucket.ids.push(...profile.members.map((m) => m.id));
      else cohorts.set(key, { where: scope.where, ids: profile.members.map((m) => m.id) });
    }),
  );

  await Promise.all(
    [...cohorts.values()].map(async ({ where, ids }) => {
      const granted = await resolveCohort(delegate, ref, where, [...new Set(ids)], counter);
      granted.forEach((id) => withAccess.add(id));
    }),
  );

  return { withAccess, ...counter };
}

/**
 * The profile identity: everything `scopeTemplateForProfile` reads, plus the override set (per-USER,
 * so it cannot be assumed uniform across a role) and the tenant.
 *
 * `organization_id` is in the key even though every caller today sources its candidates from one
 * `tenantWhere(req)`. This is an exported helper taking a plain array: without it, two readers from
 * different orgs sharing a role and department would share a profile, and the whole group would be
 * answered under the REPRESENTATIVE's tenant and grant cache. Keying on it makes a mixed-tenant list
 * merely wasteful instead of wrong.
 *
 * Deliberately conservative - it only decides what may share a DERIVATION. Probes are grouped by the
 * resolved fragment instead, so an attribute no grant condition mentions costs nothing.
 */
function profileKey(user: PermissionUser, overrides: PermissionOverride[]): string {
  return JSON.stringify([
    user.organization_id,
    isSuperUser(user),
    grantRoleKey(user),
    user.role,
    user.department_id ?? null,
    user.location_id ?? null,
    overrides.map((o) => `${o.action}:${o.subject}:${o.effect}`).sort(),
  ]);
}

/** One distinct scope fragment, answered for every reader that resolved to it. */
async function resolveCohort(
  delegate: ProbeDelegate,
  ref: EntityRef,
  where: Record<string, unknown>,
  ids: string[],
  counter: Counter,
): Promise<string[]> {
  // Reader-independent fragment (ADMIN, an unconditional read, a department/location condition):
  // one probe settles the whole cohort.
  if (!containsPlaceholder(where)) {
    counter.probes += 1;
    const hit = await delegate.findFirst({ where: { id: ref.id, ...where }, select: { id: true } });
    return hit ? ids : [];
  }

  const granted = new Set<string>();
  for (const arm of splitArms(where)) {
    if (granted.size === ids.length) break;
    const matched = await resolveArm(delegate, ref, arm, ids, counter);
    matched.forEach((id) => granted.add(id));
  }
  return [...granted];
}

/**
 * One OR-arm of a profile's fragment, resolved for the whole cohort at once.
 *
 * `scopeWhereFor` unions independent read grants as a top-level `OR`, so an arm is a self-contained
 * condition and evaluating arms separately is exact. Within an arm the placeholder occurs on one
 * relation path; substituting `{ in: ids }` there and mirroring that path into the `select` returns
 * the ids that satisfied it.
 */
async function resolveArm(
  delegate: ProbeDelegate,
  ref: EntityRef,
  arm: Record<string, unknown>,
  ids: string[],
  counter: Counter,
): Promise<string[]> {
  if (!containsPlaceholder(arm)) {
    counter.probes += 1;
    const hit = await delegate.findFirst({ where: { id: ref.id, ...arm }, select: { id: true } });
    return hit ? ids : [];
  }

  const mirror = buildMirror(arm, ids);
  if (mirror) {
    try {
      counter.probes += 1;
      const row = await delegate.findFirst({
        where: { id: ref.id, ...(substitutePlaceholder(arm, ids) as Record<string, unknown>) },
        select: { id: true, ...mirror },
      });
      const found = new Set<string>();
      if (row) collectMirrored(row, mirror, found);
      return ids.filter((id) => found.has(id));
    } catch (err) {
      // A condition shape the mirror got wrong must not 500 the picker, and must not silently
      // report everyone as having access. Fall through to the per-reader path, which is the
      // canonical one.
      logger.warn('entityAccessCohort: mirrored probe failed, falling back per reader', err);
    }
  }
  // The OTHER way to reach here is `buildMirror` returning null, which used to be silent - and being
  // silent is how the ESTIMATE creator arm shipped costing one query per candidate while every
  // correctness check passed. Both routes now count and log.
  logger.warn(
    `entityAccessCohort: cannot batch a ${ref.type} scope arm, resolving ${ids.length} readers one at a time`,
    { arm: JSON.stringify(arm) },
  );
  counter.fallbacks += 1;
  return perReaderProbe(delegate, ref, ids, arm, counter);
}

/**
 * Correctness floor for a condition shape the mirror cannot express: substitute one real id at a
 * time, which is byte-for-byte the fragment `scopeWhereForUser` would have produced for that
 * reader. Linear in the cohort, so it is a fallback and never the normal path.
 */
async function perReaderProbe(
  delegate: ProbeDelegate,
  ref: EntityRef,
  ids: string[],
  arm: Record<string, unknown>,
  counter: Counter,
): Promise<string[]> {
  const granted: string[] = [];
  for (const id of ids) {
    counter.probes += 1;
    const hit = await delegate.findFirst({
      where: { id: ref.id, ...(substitutePlaceholder(arm, id) as Record<string, unknown>) },
      select: { id: true },
    });
    if (hit) granted.push(id);
  }
  return granted;
}

// ─── condition-tree helpers ────────────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function containsPlaceholder(v: unknown): boolean {
  if (v === COHORT_USER) return true;
  if (Array.isArray(v)) return v.some(containsPlaceholder);
  if (isPlainObject(v)) return Object.values(v).some(containsPlaceholder);
  return false;
}

/** Replace every placeholder occurrence with `ids` (an `in` filter) or a single id. */
function substitutePlaceholder(v: unknown, ids: string[] | string): unknown {
  if (v === COHORT_USER) return typeof ids === 'string' ? ids : { in: ids };
  if (Array.isArray(v)) return v.map((x) => substitutePlaceholder(x, ids));
  if (isPlainObject(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitutePlaceholder(x, ids)]));
  }
  return v;
}

/**
 * Flatten a top-level `OR` union into independent arms, carrying the sibling keys (tenant, and any
 * scalar filter) into each. Recurses, because a grant condition can itself be an `OR`.
 */
function splitArms(where: Record<string, unknown>): Record<string, unknown>[] {
  const { OR, ...rest } = where as { OR?: unknown };
  if (!Array.isArray(OR)) return [where];
  return OR.flatMap((branch) =>
    isPlainObject(branch) ? splitArms(conjoin(rest as Record<string, unknown>, branch)) : [],
  );
}

/** AND two condition objects, using Prisma's `AND` only when a key would otherwise be clobbered. */
function conjoin(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(a).length) return b;
  const collides = Object.keys(b).some((k) => k in a);
  return collides ? { AND: [a, b] } : { ...a, ...b };
}

/**
 * A `select` mirroring the arm's placeholder path, so the probe reads back which cohort ids matched
 * instead of a bare yes/no. `{ visits: { some: { assignees: { some: { user_id: P } } } } }` becomes
 * `{ visits: { where: …, select: { assignees: { where: { user_id: { in } }, select: { user_id } } } } }`.
 *
 * Every relation step carries its own `where`, so a sibling filter alongside the placeholder inside
 * a `some` narrows the rows read back exactly as it narrows the match. Returns null for anything it
 * cannot express - the caller falls back to a per-reader probe rather than guessing.
 */
function buildMirror(cond: Record<string, unknown>, ids: string[]): Record<string, unknown> | null {
  const bearing = Object.keys(cond).filter((k) => containsPlaceholder(cond[k]));
  if (bearing.length !== 1) return null;
  const key = bearing[0];
  const value = cond[key];

  if (value === COHORT_USER) return { [key]: true };

  if (Array.isArray(value)) {
    // `AND` is the only array a select can follow. Its siblings are plain predicates already carried
    // in the probe's own `where`, and `AND` is not a select key, so the bearing element's mirror
    // flattens straight onto this level. `{ AND: [{ lead_id: null }, { created_by: P }] }` - the
    // creator arm of OWN_ESTIMATE_VIA_LEAD_OR_CREATOR, held by SALES and TECHNICIAN alike - is the
    // live case, and rejecting it is what silently made every ESTIMATE-linked picker per-candidate.
    if (key !== 'AND') return null;
    const bearing = value.filter(containsPlaceholder);
    // Two AND'd placeholder predicates mean a reader must satisfy BOTH; unioning their terminals
    // would over-report, so that shape goes to the per-reader path rather than be guessed at.
    if (bearing.length !== 1 || !isPlainObject(bearing[0])) return null;
    return buildMirror(bearing[0], ids);
  }
  if (!isPlainObject(value)) return null;

  if ('some' in value) {
    if (Object.keys(value).length !== 1) return null;
    const inner = value.some;
    if (!isPlainObject(inner)) return null;
    const sub = buildMirror(inner, ids);
    if (!sub) return null;
    return { [key]: { where: substitutePlaceholder(inner, ids), select: sub } };
  }

  // A to-one relation hop. It takes no `where` in a select; the probe's own where already required
  // the whole chain to match.
  const sub = buildMirror(value, ids);
  return sub ? { [key]: { select: sub } } : null;
}

/** Walk the returned row along the mirror and collect the terminal ids. */
function collectMirrored(node: unknown, mirror: Record<string, unknown>, out: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectMirrored(n, mirror, out));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, spec] of Object.entries(mirror)) {
    const value = node[key];
    if (spec === true) {
      if (typeof value === 'string') out.add(value);
      continue;
    }
    if (isPlainObject(spec) && isPlainObject(spec.select)) {
      collectMirrored(value, spec.select as Record<string, unknown>, out);
    }
  }
}

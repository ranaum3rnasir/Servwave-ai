/**
 * A tiny in-memory evaluator for the subset of Prisma `where` shapes the
 * anchor-inherited visibility filter emits (lib/permissions/anchorVisibility.ts).
 *
 * WHY THIS EXISTS. This suite runs against a fully-mocked prisma, so there is no
 * query engine to execute a `where` against. Asserting the emitted SHAPE proves
 * only that some object was passed; it says nothing about MEANING - and both
 * hazards this filter exists to dodge are meaning bugs that a shape assertion
 * happily green-lights:
 *   - `{ job: {} }` on a NULLABLE to-one is not "no restriction", it is "a
 *     related job must exist";
 *   - MATCH_NOTHING (`{ id: { in: [] } }`) nested under a relation key also
 *     excludes rows whose relation is NULL.
 * Running fixture rows through the captured `where` is what turns "the handler
 * passed a filter" into "a technician sees job A's row and not job B's".
 *
 * TEST-ONLY. Deliberately supports just the operators the filter uses; anything
 * else is a signal that the filter grew a shape the tests are not proving.
 */
export type Row = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

export function matchesWhere(row: Row | null | undefined, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matchesWhere(row, c));
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((c) => matchesWhere(row, c));
    const actual = row?.[key];
    if (cond === null) return actual === null || actual === undefined;
    if (isPlainObject(cond)) {
      if ('not' in cond) {
        return cond.not === null ? actual !== null && actual !== undefined : actual !== cond.not;
      }
      if ('in' in cond) return (cond.in as unknown[]).includes(actual);
      if ('some' in cond) {
        return (
          Array.isArray(actual) &&
          actual.some((e) => matchesWhere(e as Row, cond.some as Record<string, unknown>))
        );
      }
      // A to-one relation filter: a NULL relation can never satisfy one.
      if (actual === null || actual === undefined) return false;
      return matchesWhere(actual as Row, cond);
    }
    return actual === cond;
  });
}

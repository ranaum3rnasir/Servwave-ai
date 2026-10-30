/**
 * Record ids have one spelling (security review SR-1, SR-2, SR-7, pre-PR review fixes).
 *
 * Every record id is a uuid, and the server and every client write it one way: lower case, with the four dashes. The readers
 * behind a lookup are more lenient. The database client reads the same uuid without dashes, in braces, as `urn:uuid:...`, or
 * in upper or mixed case, and the database itself reads braces, any case and a dash after any four digits; either way the
 * record is found. A check that recognises an id only in the usual spelling, and steps aside for anything else, can then be
 * walked around: the check skips, the lookup behind it still finds the record.
 *
 * So the rule is fail closed. A uuid in any other spelling names no record: a route answers it 404 before anything reads the
 * record (middleware/canonicalIds.ts), and a check that meets one refuses instead of stepping aside. `isOtherSpellingOfId`
 * is a superset of what either reader accepts, so nothing they would read as a record gets past it. A value that is not a
 * uuid in any spelling (`job-1`, a slug) names no record in either reader, so it keeps the answer it always had.
 */

/** The one spelling of a record id. No `i` flag: upper case is another spelling. */
export const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isCanonicalId = (value: unknown): value is string => typeof value === 'string' && CANONICAL_ID.test(value);

/**
 * Is this a uuid written some other way: a spelling the database would still read as a record id (or close enough that it
 * might), but not the canonical one? Errs on the side of yes: braces, a `urn:uuid:` prefix, dashes anywhere, any case.
 */
export function isOtherSpellingOfId(value: string): boolean {
  if (CANONICAL_ID.test(value)) return false;
  const core = value.trim().replace(/^urn:uuid:/i, '').replace(/^\{([^{}]*)\}$/, '$1').replace(/-/g, '');
  return /^[0-9a-f]{32}$/i.test(core);
}

/**
 * The route steps that already answer 404 for an id param not in the canonical spelling, and the params each one covers
 * (`requireUuidParam`, the reach wrapper of ticket 33). The guard that every route gets (middleware/canonicalIds.ts) reads
 * this, so a param one of them already refuses keeps that step's own "not found" words.
 */
const guards = new WeakMap<object, readonly string[]>();

export function markCanonicalIdGuard<T extends object>(params: readonly string[], fn: T): T {
  guards.set(fn, [...(guards.get(fn) ?? []), ...params]);
  return fn;
}

export const canonicalIdParamsOf = (handle: unknown): readonly string[] =>
  (typeof handle === 'function' ? guards.get(handle) : undefined) ?? [];

/**
 * Route steps that may run before the guard because they read no record: a rate limiter, a plan-feature gate, the Spider gate.
 * The route-table test (permission-canonical-ids-guard.test.ts) reads this; it changes nothing at run time.
 */
const recordFree = new WeakSet<object>();
export function markReadsNoRecord<T extends object>(fn: T): T {
  recordFree.add(fn);
  return fn;
}
export const readsNoRecord = (handle: unknown): boolean => typeof handle === 'function' && recordFree.has(handle);

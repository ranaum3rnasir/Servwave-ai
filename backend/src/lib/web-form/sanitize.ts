/**
 * Make a parsed webhook body safe to store.
 *
 * POSTGRES ACCEPTS A NUL IN NEITHER `text` NOR `jsonb`. Verified against
 * PostgreSQL 16, where the six-character JSON escape for NUL (backslash, u,
 * 0, 0, 0, 0) is the form the driver actually sends, because that is what
 * JSON.stringify emits for one:
 *   - a real NUL in a text column  -> ERROR: null character not permitted
 *   - a real NUL in a jsonb string -> ERROR: null character not permitted
 *   - the escape, in jsonb         -> ERROR: unsupported Unicode escape
 *                                    sequence; cannot be converted to text
 *
 * That makes one byte a total, silent loss on this receiver. The 200 has
 * already gone out; the INSERT then throws; there is no ledger row, no
 * Customer and no Lead, and the only trace is one generic failure line. The
 * vendor never resends.
 *
 * `JSON.parse` rejects a RAW NUL inside a string literal ("Bad control
 * character in string literal"), so the only way one reaches a parsed body is
 * that escape - and it can land in a KEY as readily as in a value, so both are
 * cleaned.
 *
 * ITERATIVE, with an explicit stack and no recursion. A recursive walk over an
 * attacker-supplied body is the same unbounded-recursion hazard that made a
 * ~10KB payload answer this endpoint with nothing at all; the cure must not
 * reintroduce the disease.
 *
 * The constant below is a char code rather than a string escape ON PURPOSE. A
 * source file that spells it with a literal NUL is one git treats as BINARY,
 * so it stops producing a reviewable diff - which happened once while writing
 * this file, and is the same class of mistake the file exists to prevent.
 */

const NUL = String.fromCharCode(0);

/** Remove every NUL from one string. */
export function stripNul(value: string): string {
  return value.includes(NUL) ? value.split(NUL).join('') : value;
}

type Container = Record<string, unknown> | unknown[];

/**
 * Deep-copy a parsed JSON value with every NUL removed from keys and values.
 *
 * Copies rather than mutating in place because a key has to be RENAMED, and the
 * containers are null-prototype: on a plain object `to['__proto__'] = child`
 * invokes the inherited setter and stores nothing, which would drop the one key
 * a crafted payload is most likely to carry.
 */
export function stripNulDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripNul(value);
  if (value === null || typeof value !== 'object') return value;

  const root: Container = Array.isArray(value) ? [] : Object.create(null);
  const stack: Array<{ from: object; to: Container }> = [{ from: value, to: root }];

  while (stack.length) {
    const { from, to } = stack.pop()!;
    for (const [rawKey, child] of Object.entries(from)) {
      const key = stripNul(rawKey);
      if (typeof child === 'string') {
        (to as Record<string, unknown>)[key] = stripNul(child);
      } else if (child === null || typeof child !== 'object') {
        (to as Record<string, unknown>)[key] = child;
      } else {
        const next: Container = Array.isArray(child) ? [] : Object.create(null);
        (to as Record<string, unknown>)[key] = next;
        stack.push({ from: child, to: next });
      }
    }
  }

  return root;
}

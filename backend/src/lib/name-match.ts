/**
 * A Prisma string filter for "this exact text, ignoring letter case".
 *
 * Prisma compiles `{ equals, mode: 'insensitive' }` on Postgres to `ILIKE`, and does NOT escape the
 * value, so `%`, `_` and `\` in it act as LIKE wildcards: "Part_order" collided with "Part order",
 * and a name of "%" collided with every name in the list. Escaping them (Postgres' default LIKE
 * escape character is backslash) leaves an ILIKE that only a case-insensitive equal can satisfy.
 *
 * Pinned against a real database by task-category-writes-db.test.ts, so a Prisma change in how it
 * compiles this filter shows up there rather than as a silent duplicate.
 */
export function equalsIgnoringCase(value: string): { equals: string; mode: 'insensitive' } {
  return { equals: escapeLike(value), mode: 'insensitive' };
}

/**
 * The value with LIKE's wildcards (`%`, `_`) and its escape character (`\`) escaped, so a filter Prisma compiles to
 * LIKE / ILIKE matches the text literally (see above: Prisma does not escape `equals` or `contains`).
 */
export function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

/**
 * A Prisma string filter for "contains this text, ignoring letter case", literally: `%` and `_` in a search match only
 * themselves, never every row.
 */
export function containsIgnoringCase(value: string): { contains: string; mode: 'insensitive' } {
  return { contains: escapeLike(value), mode: 'insensitive' };
}

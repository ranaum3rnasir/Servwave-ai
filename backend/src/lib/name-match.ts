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
  return { equals: value.replace(/([\\%_])/g, '\\$1'), mode: 'insensitive' };
}

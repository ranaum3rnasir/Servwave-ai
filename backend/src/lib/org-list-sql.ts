/**
 * V7-03 - the pure (Prisma-free, Express-free) half of lib/org-list-rows.ts: the constants, the name rule and the SQL that
 * copies an org's JSON list into rows. Split out because the onboarding SQL builder (entitlements/ops-sql.ts) imports it and
 * must not drag the Prisma client in, the same reason lib/tasks/categories.ts is client-free. org-list-rows.ts re-exports it.
 */
import { z } from 'zod';

export type ListTable = 'job_types' | 'lead_sources';

export const MAX_LIST_ROWS = 500;
export const LIST_NAME_MAX = 50;
/** NEW COPY (C-18). Reaches the UI through extractApiError. */
export const LIST_FULL_MSG = 'This list can hold up to 500 items.';

// --- The name rule (mockup settings.js nameValid, repeated server-side) ---------------------------------------------

/** The one spelling a list name is stored and compared in: invisible format characters out, trimmed, runs of space collapsed. */
export function normaliseListName(raw: string): string {
  return raw.replace(/\p{Cf}/gu, '').trim().replace(/\s+/g, ' ');
}

/** Trim and collapse BEFORE the length checks, so sixty spaces are "Enter a name." and not a valid 60-character name. */
const nameField = z
  .string({ required_error: 'Enter a name.', invalid_type_error: 'Enter a name.' })
  .transform(normaliseListName)
  .pipe(z.string().min(1, 'Enter a name.').max(LIST_NAME_MAX, 'Use 50 characters or fewer.'));

export const listNameBodySchema = z.object({ name: nameField }).strict();

export const listReorderBodySchema = z
  .object({
    ordered_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_LIST_ROWS)
      .refine((a) => new Set(a).size === a.length, { message: 'Duplicate id in reorder list' }),
  })
  .strict();

// --- JSON column -> rows ---------------------------------------------------------------------------------------------

export const JSON_COLUMN: Record<ListTable, 'job_type_options' | 'source_options'> = {
  job_types: 'job_type_options',
  lead_sources: 'source_options',
};
export const LIST_TABLES: ReadonlyArray<ListTable> = ['job_types', 'lead_sources'];

/**
 * The idempotent INSERT that copies ONE organization's JSON list into rows, given the org id as a SQL expression (a
 * quoted literal for the onboarding SQL, `$1::uuid` for the Prisma paths). Without `table` it returns both statements,
 * for the org creators.
 *
 * Only strings count; each is trimmed, its whitespace collapsed and cut to 50 characters; empties are skipped; names that
 * match case-insensitively collapse to the first; `sort_order` is the 0-based position among the survivors. An org that
 * already has ANY row in the table is left alone (so re-running never undoes an admin's rename), and ON CONFLICT covers
 * the race the NOT EXISTS cannot. Same shape as `starterTaskCategoriesSql` in lib/tasks/categories.ts.
 */
export function listRowsFromOrgJsonSql(orgIdSql: string, table?: ListTable): string {
  if (!table) return LIST_TABLES.map((t) => listRowsFromOrgJsonSql(orgIdSql, t)).join('\n\n');
  const col = JSON_COLUMN[table];
  return (
    `INSERT INTO "${table}" ("id", "organization_id", "name", "sort_order", "created_at", "updated_at")\n` +
    `SELECT gen_random_uuid(), o."id", n."name", (row_number() OVER (PARTITION BY o."id" ORDER BY n."ord") - 1)::int, now(), now()\n` +
    `FROM "organizations" o\n` +
    `CROSS JOIN LATERAL (\n` +
    `  SELECT DISTINCT ON (lower(c."name")) c."name", c."ord"\n` +
    `  FROM (\n` +
    `    SELECT btrim(left(btrim(regexp_replace(e."value" #>> '{}', '\\s+', ' ', 'g')), ${LIST_NAME_MAX})) AS "name", e."ord"\n` +
    `    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o."${col}") = 'array' THEN o."${col}" ELSE '[]'::jsonb END)\n` +
    `      WITH ORDINALITY AS e("value", "ord")\n` +
    `    WHERE jsonb_typeof(e."value") = 'string'\n` +
    `  ) c\n` +
    `  WHERE c."name" <> ''\n` +
    `  ORDER BY lower(c."name"), c."ord"\n` +
    `) n\n` +
    `WHERE o."id" = ${orgIdSql}\n` +
    `  AND NOT EXISTS (SELECT 1 FROM "${table}" t WHERE t."organization_id" = o."id")\n` +
    `ON CONFLICT DO NOTHING;`
  );
}

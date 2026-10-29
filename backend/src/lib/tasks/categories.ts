/**
 * Task categories (visits-and-task-categories slice 08) - what a category is outside its own
 * controller: the starter list every organization begins with, how it is seeded, and the shape a
 * task carries its category in.
 *
 * Deliberately free of the Prisma client and of Express: the onboarding SQL builder
 * (entitlements/ops-sql.ts) imports it. The request-bound same-org check lives in
 * categoryScope.ts.
 */

/**
 * The colors a task category may take: the Tags palette, in the pickers' order. Slice 09 limits
 * category colors to it at the API, not only in the picker.
 *
 * The frontend's copy is TAG_COLORS in frontend/src/lib/tag-colors.ts - the palette both tag
 * pickers and the category manager draw from. The two cannot share a module (separate packages),
 * so frontend/src/__tests__/task-category-palette-parity.test.ts reads this file and fails if
 * the lists differ.
 */
export const TASK_CATEGORY_COLORS: ReadonlyArray<string> = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280', '#14B8A6',
];

/**
 * The one spelling a category name is stored and compared in: invisible format characters
 * removed, trimmed, every run of whitespace collapsed to a single space. "Part  order" and " Part order " are the same category as
 * "Part order" - the duplicate check (case-insensitive on top of this) must see them as one, and
 * the list must never show two rows that differ only in spacing. The frontend applies the same
 * rule before comparing (lib/tasks/taskCategoryDefaults.ts).
 */
export function normaliseTaskCategoryName(name: string): string {
  // Invisible format characters (\p{Cf}: zero-width space/joiners, BOM, word joiner, soft
  // hyphen...) go first, so "Call<U+200B>back" is the same name as "Callback".
  return name.replace(/\p{Cf}/gu, '').trim().replace(/\s+/g, ' ');
}

/**
 * The three categories every organization starts with, in display order.
 *
 * The migration 20260928080000_task_categories backfilled exactly these into every organization
 * that existed then; task-categories-seed-db.test.ts pins the two lists together.
 */
export const STARTER_TASK_CATEGORIES: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Follow-up', color: '#22C55E' },
  { name: 'Part order', color: '#F97316' },
  { name: 'Internal', color: '#6B7280' },
];

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The idempotent INSERT that seeds the starters into ONE organization, given as a SQL expression
 * (a quoted literal for the onboarding SQL, a bind parameter for the Prisma paths).
 *
 * An existing category with the same name in ANY letter case is left alone - the per-org name
 * uniqueness is case-insensitive - so re-running it, or running it on an org that already made
 * its own "follow-up", seeds nothing twice. ON CONFLICT covers the race the NOT EXISTS cannot.
 */
export function starterTaskCategoriesSql(orgIdSql: string): string {
  const values = STARTER_TASK_CATEGORIES
    .map((c, i) => `(${sqlString(c.name)}, ${sqlString(c.color)}, ${i})`)
    .join(', ');
  return (
    `INSERT INTO "task_categories" ("id", "organization_id", "name", "color", "sort_order", "created_at", "updated_at")\n` +
    `SELECT gen_random_uuid(), ${orgIdSql}, s."name", s."color", s."sort_order", now(), now()\n` +
    `FROM (VALUES ${values}) AS s("name", "color", "sort_order")\n` +
    `WHERE NOT EXISTS (\n` +
    `  SELECT 1 FROM "task_categories" t\n` +
    `  WHERE t."organization_id" = ${orgIdSql} AND lower(t."name") = lower(s."name")\n` +
    `)\n` +
    `ON CONFLICT DO NOTHING;`
  );
}

/** Seed the starters into one organization. Safe to call any number of times. */
export async function seedStarterTaskCategories(
  db: { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> },
  orgId: string,
): Promise<void> {
  await db.$executeRawUnsafe(starterTaskCategoriesSql('$1::uuid'), orgId);
}

/** How a task carries its category on every task payload: enough to draw the chip. */
export const TASK_CATEGORY_REF_SELECT = { id: true, name: true, color: true } as const;

/** The include every task read and write answers with, so the chip never needs a second fetch. */
export const TASK_CATEGORY_INCLUDE = { category: { select: TASK_CATEGORY_REF_SELECT } } as const;

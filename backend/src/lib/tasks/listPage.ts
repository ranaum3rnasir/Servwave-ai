import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as appClient } from '../prisma';
import { entityAccessScope, type EntityAccessReader } from './entityAccess';
import type { AppAbility } from '../permissions/defineAbility';
import { openTaskStatusFilter } from './status';
import { atRiskIds, type AtRiskRow } from './atRisk';
import { userFullName } from './enrich';

/**
 * GET /api/tasks as one bounded PAGE (mobile slice 72).
 *
 * The list used to answer with every task in the organisation and every filter ran in the
 * browser, so a phone downloaded and held the whole org to show twenty rows. With `limit` the
 * same filters and the sort run here, in the query, and the response is one page plus enough to
 * ask for the next. Without `limit` the legacy full list is untouched (the board, calendar,
 * My Day, History and Dashboard views and the entity tabs still read that).
 *
 * THE FILTERS MEAN WHAT THEY MEANT IN THE BROWSER (`applyTaskFilter`, tasks-logic.ts):
 *   member       any-assignee, never equality on one person
 *   department   any assignee who sits in the department
 *   overdue      due before now AND not finished
 *   due/created  whole UTC days, ends included (the browser compared `iso.slice(0, 10)`)
 *   category     any of the ids, `none` for tasks with no category
 *   drill        the Dashboard KPI drill-down: open, blocked, onTime, atRisk
 *   atRisk       the "Only show: At risk" flag
 *   q            the List's search: title, ANY assignee's name, the linked record's label
 *
 * Every query here sits UNDER the caller's visibility scope (`scopeWhere`: the tenant, plus
 * assignee-or-watcher for anyone who is not an admin), so no filter can widen what a caller sees.
 */

export const TASK_PAGE_MAX = 100;

export const TASK_SORT_FIELDS = [
  'created_at', 'due_at', 'priority', 'status', 'title', 'task_number', 'updated_at',
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

const NO_CATEGORY = 'none';

const utcDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)), 'not a real date');
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = z.string().transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean));

export const taskPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TASK_PAGE_MAX),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(TASK_SORT_FIELDS).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  member_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  category_ids: csv.pipe(z.array(z.union([z.literal(NO_CATEGORY), z.string().uuid()])).max(50)).optional(),
  overdue: flag.optional(),
  at_risk: flag.optional(),
  drill: z.enum(['open', 'atRisk', 'onTime', 'blocked']).optional(),
  due_from: utcDay.optional(),
  due_to: utcDay.optional(),
  created_from: utcDay.optional(),
  created_to: utcDay.optional(),
  q: z.string().trim().max(200).optional(),
});
export type TaskPageQuery = z.infer<typeof taskPageQuerySchema>;

/** A paged read is asked for by `limit`; no `limit` means the legacy full list. */
export const isPagedTaskQuery = (query: Record<string, unknown>): boolean => query.limit !== undefined;

type Db = Pick<PrismaClient, 'task' | 'user'>;
type Where = Prisma.TaskWhereInput;

/** A clause that matches no task (an empty `in` is false in Postgres). */
const NOTHING: Where = { id: { in: [] } };

const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const dayAfter = (day: string): Date => new Date(dayStart(day).getTime() + 24 * 3_600_000);

function dayRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  return { ...(from ? { gte: dayStart(from) } : {}), ...(to ? { lt: dayAfter(to) } : {}) };
}

export function taskOrderBy(sort: TaskSortField, dir: 'asc' | 'desc'): Prisma.TaskOrderByWithRelationInput[] {
  // The id breaks every tie, so two pages of one sort never overlap or skip a row.
  const tieBreak = { id: 'asc' as const };
  // A task with no due date sorts after the ones that have one, whichever way the dates run.
  if (sort === 'due_at') return [{ due_at: { sort: dir, nulls: 'last' } }, tieBreak];
  return [{ [sort]: dir } as Prisma.TaskOrderByWithRelationInput, tieBreak];
}

export interface LinkedRecordSearch {
  /** `where` clauses on Task: the tasks whose linked record's label contains `q`. */
  (q: string): Promise<Where[]>;
}

/**
 * The linked-record half of the List search, within what the caller may OPEN: the label of a
 * record they cannot open is the redacted placeholder, so its real number or name must never
 * match (it would let a search probe a record's existence). Each type is searched through the same
 * read scope the label is resolved with (`entityAccessScope`).
 */
export function linkedRecordSearch(reader: EntityAccessReader, ability?: AppAbility): LinkedRecordSearch {
  const CAP = 200;
  const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });
  const specs: Array<{
    type: 'JOB' | 'LEAD' | 'ESTIMATE' | 'CUSTOMER';
    find: (where: Record<string, unknown>) => Promise<{ id: string }[]>;
    fields: (q: string) => Record<string, unknown>[];
  }> = [
    {
      type: 'JOB',
      find: (where) => appClient.job.findMany({ where, select: { id: true }, take: CAP }),
      fields: (q) => [{ job_number: contains(q) }, { job_type: contains(q) }],
    },
    {
      type: 'LEAD',
      find: (where) => appClient.lead.findMany({ where, select: { id: true }, take: CAP }),
      fields: (q) => [{ lead_number: contains(q) }, { job_type: contains(q) }],
    },
    {
      type: 'ESTIMATE',
      find: (where) => appClient.estimate.findMany({ where, select: { id: true }, take: CAP }),
      fields: (q) => [{ estimate_number: contains(q) }],
    },
    {
      type: 'CUSTOMER',
      find: (where) => appClient.customer.findMany({ where, select: { id: true }, take: CAP }),
      fields: (q) => [
        { company_name: contains(q) }, { first_name: contains(q) }, { last_name: contains(q) },
        { customer_number: contains(q) },
      ],
    },
  ];

  return async (q) => {
    const clauses = await Promise.all(
      specs.map(async (spec): Promise<Where | null> => {
        const scope = await entityAccessScope(reader, spec.type, { ability });
        if (!scope) return null;
        const rows = await spec.find({ AND: [scope.where, { OR: spec.fields(q) }] });
        if (!rows.length) return null;
        return { linked_entity_type: spec.type, linked_entity_id: { in: rows.map((r) => r.id) } };
      }),
    );
    return clauses.filter((c): c is Where => c !== null);
  };
}

export interface TaskPageContext {
  /** Tenant + visibility: `taskVisibilityWhere(req, ...)`. Everything below sits under it. */
  scopeWhere: Where;
  orgId: string;
  now: Date;
  db?: Db;
  searchLinked: LinkedRecordSearch;
}

const AT_RISK_SELECT = { id: true, status: true, due_at: true, updated_at: true, assignee_ids: true } as const;

/**
 * The two `where`s a page needs: the rows themselves, and the same rows with the Category facet
 * left open (what the Category counts are taken over, so ticking a category shows exactly the
 * number beside it).
 */
export async function buildTaskPageWhere(
  q: TaskPageQuery,
  ctx: TaskPageContext,
): Promise<{ where: Where; whereWithoutCategory: Where }> {
  const db: Db = ctx.db ?? appClient;
  const { scopeWhere, orgId, now } = ctx;
  const base: Where[] = [];

  if (q.member_id) base.push({ assignee_ids: { has: q.member_id } });

  if (q.department_id) {
    const people = await db.user.findMany({
      where: { organization_id: orgId, department_id: q.department_id },
      select: { id: true },
    });
    base.push(people.length ? { assignee_ids: { hasSome: people.map((p) => p.id) } } : NOTHING);
  }

  if (q.overdue) base.push({ status: openTaskStatusFilter(), due_at: { lt: now } });

  if (q.due_from || q.due_to) base.push({ due_at: dayRange(q.due_from, q.due_to) });
  if (q.created_from || q.created_to) base.push({ created_at: dayRange(q.created_from, q.created_to) });

  if (q.at_risk) {
    // The load behind the score is each assignee's open tasks over the caller's WHOLE visible
    // list, not over the filtered one - so this reads the whole scope, as the browser did.
    const open = await db.task.findMany({
      where: { AND: [scopeWhere, { status: openTaskStatusFilter() }] },
      select: AT_RISK_SELECT,
    });
    base.push({ id: { in: atRiskIds(open as AtRiskRow[], open as AtRiskRow[], now) } });
  }

  const scoped: Where = { AND: [scopeWhere, ...base] };

  // The Dashboard drill-down, applied on top of everything above (and before Category).
  const drill: Where[] = [];
  if (q.drill === 'open') drill.push({ status: openTaskStatusFilter() });
  if (q.drill === 'blocked') drill.push({ status: 'BLOCKED' });
  if (q.drill === 'onTime') {
    // completed no later than due: a comparison of two columns, so it is decided on the narrowed
    // candidates rather than in the `where`.
    const done = await db.task.findMany({
      where: { AND: [scoped, { status: 'DONE', completed_at: { not: null }, due_at: { not: null } }] },
      select: { id: true, completed_at: true, due_at: true },
    });
    drill.push({
      id: { in: done.filter((t) => t.completed_at!.getTime() <= t.due_at!.getTime()).map((t) => t.id) },
    });
  }
  if (q.drill === 'atRisk') {
    // Sized over the FILTERED list, so it matches the Dashboard's At Risk card for that scope.
    const open = await db.task.findMany({
      where: { AND: [scoped, { status: openTaskStatusFilter() }] },
      select: AT_RISK_SELECT,
    });
    drill.push({ id: { in: atRiskIds(open as AtRiskRow[], open as AtRiskRow[], now) } });
  }

  const search: Where[] = [];
  const text = q.q?.trim().toLowerCase();
  if (text) {
    const [users, linked] = await Promise.all([
      db.user.findMany({
        where: { organization_id: orgId },
        select: { id: true, first_name: true, last_name: true },
      }),
      ctx.searchLinked(text),
    ]);
    // The browser matched the resolved FULL name, so a two-word search spans first and last.
    const people = users.filter((u) => userFullName(u).toLowerCase().includes(text)).map((u) => u.id);
    const arms: Where[] = [{ title: { contains: text, mode: 'insensitive' } }];
    if (people.length) arms.push({ assignee_ids: { hasSome: people } });
    // An assignee's id is searchable too (the only handle on one whose name no longer resolves).
    if (z.string().uuid().safeParse(text).success) arms.push({ assignee_ids: { has: text } });
    search.push({ OR: [...arms, ...linked] });
  }

  const whereWithoutCategory: Where = { AND: [scoped, ...drill, ...search] };

  const categories = q.category_ids ?? [];
  if (!categories.length) return { where: whereWithoutCategory, whereWithoutCategory };

  const ids = categories.filter((c) => c !== NO_CATEGORY);
  const arms: Where[] = [];
  if (ids.length) arms.push({ category_id: { in: ids } });
  if (categories.includes(NO_CATEGORY)) arms.push({ category_id: null });
  return { where: { AND: [whereWithoutCategory, { OR: arms }] }, whereWithoutCategory };
}

/** `{ <category id | 'none'>: count }` from a groupBy over `category_id`. */
export function categoryCounts(groups: Array<{ category_id: string | null; _count: { _all: number } }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) out[g.category_id ?? NO_CATEGORY] = g._count._all;
  return out;
}

import { prisma } from '../../lib/prisma';
import { isSuperUser } from '../../lib/permissions/effectiveRole';
import { scopeWhereForReq } from '../../lib/permissions/enforce';
import { redactDollarAmounts } from '../../lib/permissions/companyFigures';
import { invoiceOpenerFor, type InvoiceOpener } from '../../lib/permissions/invoiceAccess';
import { hideMirroredInvoiceEvents } from '../../lib/job-change-history';
import { invoiceIdsNamedBy, mayShowInvoiceEntry } from '../../lib/job-review-changeset';
import { invoiceIdsOfMovedBack, withoutInvoiceItems, UNKNOWN_INVOICE } from '../../lib/job-back-out';
import { resolveDeletedTaskLabels } from '../../lib/tasks/deletion';
import { hideUnopenableTaskFileNames } from '../../lib/tasks/fileActivity';
import { openableTaskIds, seesAllTasks } from '../../lib/tasks/visibility';
import { withScope, type DashContext, type Where } from './context';
import type { Prisma } from '@prisma/client';

/**
 * Recent Activity (PRD 9): the newest twenty events among those on records the person can open. Every event is its own
 * category - it needs the View switch of what it is about, and the record has to be inside the person's row scope. An
 * event on a record the person cannot open is skipped, not shown blank. A task event follows the task rule: the
 * assignee or a watcher, anyone who can open the record it is linked to, or someone with See all tasks (a task that is
 * gone can be opened only by the last). The Admin box can open everything.
 *
 * An invoice's money and file events are also written on its job (S06.6 to S06.9, the job's Activity reads them there).
 * Such a copy names its invoice, so it is shown only to a person who can open that invoice (the rule the job's Activity
 * and the office review follow, through the same helpers), and it is listed once beside the invoice's own entry.
 *
 * COST. The hosted database gives the service one connection, so what this tile costs is its number of queries, and the
 * feed must not cost more of them the less of the company a person can open. Per kind of record the person's reach is
 * one of three things: every record (no read at all: the events are taken by type), a narrow list of ids (read once, up
 * to `reachCap`, and pushed into the events query, so only openable events come back and the newest twenty are near the
 * top however much else happens in the company), or too wide to list (the events are then checked a page at a time,
 * which ends fast because a wide reach means most events are theirs). A task event is checked a page at a time in one
 * batched read; a record's invoice mirrors in one more. The depth is bounded by `maxPages` whatever the data.
 */

/** Tests move the line between "pushed into the query" and "checked page by page" by lowering `reachCap`. */
export const ACTIVITY_LIMITS = { pageSize: 100, maxPages: 5, reachCap: 2000 };
const FEED_SIZE = 20;

type Event = {
  id: string;
  event_type: string;
  description: string;
  entity_type: string;
  entity_id: string;
  created_at: Date;
  metadata: unknown;
  created_by: string | null;
};

const SELECT = {
  id: true,
  event_type: true,
  description: true,
  entity_type: true,
  entity_id: true,
  created_at: true,
  metadata: true,
  created_by: true,
} as const;

/** The kinds of record an event can be about, the View switch each needs, and how to list the ones a scope reaches. */
const RECORD_KINDS: Array<{
  type: string;
  view: string;
  scope: (ctx: DashContext) => Promise<Where>;
  ids: (where: Where, take: number) => Promise<{ id: string }[]>;
}> = [
  { type: 'JOB', view: 'view_jobs', scope: (c) => c.scope('Job'), ids: (where, take) => prisma.job.findMany({ where, select: { id: true }, take }) },
  { type: 'LEAD', view: 'view_leads', scope: (c) => c.scope('Lead'), ids: (where, take) => prisma.lead.findMany({ where, select: { id: true }, take }) },
  { type: 'ESTIMATE', view: 'view_estimates', scope: (c) => c.scope('Estimate'), ids: (where, take) => prisma.estimate.findMany({ where, select: { id: true }, take }) },
  { type: 'INVOICE', view: 'view_invoices', scope: (c) => c.scope('Invoice'), ids: (where, take) => prisma.invoice.findMany({ where, select: { id: true }, take }) },
  {
    type: 'CUSTOMER',
    view: 'view_customers',
    scope: (c) => c.memo('scope:Customer', () => scopeWhereForReq(c.req, 'Customer')),
    ids: (where, take) => prisma.customer.findMany({ where, select: { id: true }, take }),
  },
];

/** How the person's reach on one kind of record is applied to the events. */
type Reach = { how: 'all' } | { how: 'ids'; ids: string[] } | { how: 'check'; scope: Where };

async function reachOf(ctx: DashContext, kind: (typeof RECORD_KINDS)[number]): Promise<Reach> {
  const scope = await kind.scope(ctx);
  if (Object.keys(scope).length === 0) return { how: 'all' };
  const cap = ACTIVITY_LIMITS.reachCap;
  if (cap <= 0) return { how: 'check', scope };
  const rows = await kind.ids(withScope({ ...ctx.orgWhere }, scope), cap + 1);
  return rows.length > cap ? { how: 'check', scope } : { how: 'ids', ids: rows.map((r) => r.id) };
}

type Plan = {
  reach: Map<string, Reach>;
  /** TASK events are part of the feed (View tasks); who may open one is decided a page at a time. */
  tasks: boolean;
  where: Prisma.TimelineEventWhereInput;
};

/** What the person's switches and reach let the feed hold, as one events query. Null when it can hold nothing. */
async function planFor(ctx: DashContext): Promise<Plan | null> {
  const kinds = RECORD_KINDS.filter((k) => ctx.has(k.view));
  const reaches = await Promise.all(kinds.map((k) => reachOf(ctx, k)));
  const reach = new Map(kinds.map((k, i) => [k.type, reaches[i]!]));
  const tasks = ctx.has('view_tasks');
  const byType = kinds.filter((k) => reach.get(k.type)!.how !== 'ids').map((k) => k.type);
  if (tasks) byType.push('TASK');
  const arms: Prisma.TimelineEventWhereInput[] = [];
  if (byType.length > 0) arms.push({ entity_type: { in: byType } });
  for (const [type, r] of reach) if (r.how === 'ids' && r.ids.length > 0) arms.push({ entity_type: type, entity_id: { in: r.ids } });
  if (arms.length === 0) return null;
  return { reach, tasks, where: { ...ctx.orgWhere, OR: arms } };
}

/** The events of one page whose record the person can open: the kinds listed up front pass, the rest are checked in batches. */
async function openableEvents(ctx: DashContext, plan: Plan, events: Event[]): Promise<Event[]> {
  const idsOf = (type: string) => [...new Set(events.filter((e) => e.entity_type === type).map((e) => e.entity_id))];
  const org = ctx.orgWhere;
  const open = new Set<string>();

  await Promise.all([
    ...RECORD_KINDS.map(async (kind) => {
      const reach = plan.reach.get(kind.type);
      const ids = idsOf(kind.type);
      if (reach?.how !== 'check' || ids.length === 0) return;
      const rows = await kind.ids(withScope({ id: { in: ids }, ...org }, reach.scope), ids.length);
      rows.forEach((r) => open.add(`${kind.type}:${r.id}`));
    }),
    (async () => {
      const ids = idsOf('TASK');
      if (ids.length === 0) return;
      // A task that no longer exists keeps its events; only See all tasks opens them.
      if (seesAllTasks(ctx.req)) {
        ids.forEach((id) => open.add(`TASK:${id}`));
        return;
      }
      const tasks = await prisma.task.findMany({
        where: { id: { in: ids }, ...org },
        select: { id: true, assignee_ids: true, watcher_ids: true, linked_entity_type: true, linked_entity_id: true },
      });
      (await openableTaskIds(ctx.req, tasks)).forEach((id) => open.add(`TASK:${id}`));
    })(),
  ]);
  // The copy of an invoice's event on a job: only for a person who can open every invoice it names. One batched read.
  // A job sent back to Office review by an invoice item names that item in its sentence; the sentence keeps the item only
  // for a person who can open its invoice (the job's History applies the same rule).
  const named = (e: Event) => (e.entity_type !== 'JOB' ? [] : [...invoiceIdsNamedBy(e), ...invoiceIdsOfMovedBack(e.metadata)]);
  const invoiceIds = [...new Set(events.flatMap(named))].filter((id) => id !== UNKNOWN_INVOICE);
  let openInvoices = new Set<string>();
  if (invoiceIds.length > 0) {
    const opener = await ctx.memo<InvoiceOpener>('invoiceOpener', () => invoiceOpenerFor(ctx.req));
    openInvoices = await opener(invoiceIds);
  }
  const shown = events.filter((e) => {
    if (e.entity_type !== 'TASK' && plan.reach.get(e.entity_type)?.how !== 'check') {
      // Listed up front (or every record): already inside the person's reach, except for the invoice-mirror rule on a job.
      return e.entity_type !== 'JOB' || mayShowInvoiceEntry(e, openInvoices);
    }
    return open.has(`${e.entity_type}:${e.entity_id}`) && (e.entity_type !== 'JOB' || mayShowInvoiceEntry(e, openInvoices));
  });
  return withoutInvoiceItems(shown, openInvoices);
}

async function newestEvents(ctx: DashContext): Promise<Event[]> {
  const org = ctx.orgWhere;
  // The Admin box opens every record: the newest twenty, with no per-record check. It reads twice that so the pairs
  // listed once still leave twenty (a pair is two events, so at most twenty are dropped).
  if (isSuperUser(ctx.req.user!)) {
    const events = await prisma.timelineEvent.findMany({ where: { ...org }, select: SELECT, orderBy: { created_at: 'desc' }, take: FEED_SIZE * 2 });
    return hideMirroredInvoiceEvents(events).slice(0, FEED_SIZE);
  }
  const plan = await planFor(ctx);
  if (!plan) return [];
  const { pageSize, maxPages } = ACTIVITY_LIMITS;
  let feed: Event[] = [];
  for (let page = 0; page < maxPages && feed.length < FEED_SIZE; page++) {
    const events = await prisma.timelineEvent.findMany({
      where: plan.where,
      select: SELECT,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: page * pageSize,
      take: pageSize,
    });
    // Pairs are left out after the openable check, so an invoice's own entry is never dropped for a copy the person cannot open.
    feed = hideMirroredInvoiceEvents([...feed, ...(await openableEvents(ctx, plan, events))]);
    if (events.length < pageSize) break;
  }
  return feed.slice(0, FEED_SIZE);
}

export async function recentActivity(ctx: DashContext) {
  const feed = await newestEvents(ctx);
  // The names of the people who made the twenty events, in one read (not one per page of candidates).
  const creatorIds = [...new Set(feed.flatMap((e) => (e.created_by ? [e.created_by] : [])))];
  const creators = new Map(
    (creatorIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, first_name: true, last_name: true } }) : []).map((u) => [u.id, u]),
  );
  // A task's timeline outlives the task, so an event can point at a row that is gone. `entity_deleted` says so and
  // `entity_label` carries the snapshot taken at delete time. A client must not offer navigation to such an event.
  const deletedTaskLabels = await resolveDeletedTaskLabels(ctx.orgWhere.organization_id, feed);
  // A task's file names only for a viewer who may open the task (its files' own rule).
  const visible = await hideUnopenableTaskFileNames(ctx.req, feed);
  return visible.map((e) => {
    const deletedLabel = e.entity_type === 'TASK' ? deletedTaskLabels.get(e.entity_id) ?? null : null;
    return {
      id: e.id,
      event_type: e.event_type,
      // Dollar amounts in the feed are company figures.
      description: ctx.sees ? e.description : redactDollarAmounts(e.description),
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      entity_deleted: deletedLabel !== null,
      entity_label: deletedLabel,
      created_at: e.created_at.toISOString(),
      creator_name: e.created_by && creators.has(e.created_by) ? `${creators.get(e.created_by)!.first_name} ${creators.get(e.created_by)!.last_name}` : null,
    };
  });
}

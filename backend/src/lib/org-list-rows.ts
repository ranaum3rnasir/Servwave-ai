/**
 * V7-03 - the two Lists-page lists that live as rows: Job types (`job_types`) and Lead/Customer sources
 * (`lead_sources`).
 *
 * One implementation for both, so jobType.controller.ts and leadSource.controller.ts stay thin. It owns the name rule,
 * the 500-row cap, the JSON-column fill, the used-by counts, the rename rewrite and the handlers themselves.
 *
 * THE RECORDS STORE TEXT, NOT AN ID. A job, lead, customer or estimate keeps the typed name; renaming a row therefore
 * rewrites that text on this org's records inside the same transaction, and archiving never touches a record.
 *
 * CASE-INSENSITIVE UNIQUENESS IS ENFORCED HERE, IN CODE (C-16): there is no raw lower(name) index (the schema-drift
 * check stays green, task_categories precedent). Every write therefore starts by taking a per-org, per-list advisory
 * lock inside its transaction, so two writers cannot both pass the check; the exact-name unique index is the backstop.
 *
 * DEPLOY OVERLAP. Until the data backfill has run an org has NO rows. "No rows at all" (archived rows count; rows are
 * only deleted by the C-11 Undo of Create) means "never filled": reads fall back to the org's JSON column and every
 * write first copies that column into rows with `fillFromOrgJson`. The JSON columns are not dropped.
 */
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { logAudit } from './audit';
import { ListTable, LIST_TABLES, JSON_COLUMN, MAX_LIST_ROWS, LIST_FULL_MSG, listRowsFromOrgJsonSql } from './org-list-sql';

// The pure half (constants, name rule, JSON -> rows SQL) lives in org-list-sql.ts so the onboarding SQL can import it
// without the Prisma client; callers get everything from here.
export * from './org-list-sql';

/** Copy the org's JSON list into rows if it has none. Idempotent; call inside the write transaction. */
export async function fillFromOrgJson(tx: Prisma.TransactionClient, orgId: string, table: ListTable): Promise<void> {
  await tx.$executeRawUnsafe(listRowsFromOrgJsonSql('$1::uuid', table), orgId);
}

/** Seed both lists of a NEW organization from its own JSON columns (the column defaults). Safe to call any number of times. */
export async function seedListRows(db: { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> }, orgId: string): Promise<void> {
  for (const table of LIST_TABLES) await db.$executeRawUnsafe(listRowsFromOrgJsonSql('$1::uuid', table), orgId);
}

/** Serialise writers to one org's one list for the rest of the transaction. */
async function lockList(tx: Prisma.TransactionClient, orgId: string, table: ListTable): Promise<void> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `${table}:${orgId}`);
}

async function lockAndFill(tx: Prisma.TransactionClient, orgId: string, table: ListTable): Promise<void> {
  await lockList(tx, orgId, table);
  await fillFromOrgJson(tx, orgId, table);
}

// --- Per-list configuration ------------------------------------------------------------------------------------------

interface ListRow {
  id: string;
  name: string;
  sort_order: number;
  archived_at: Date | null;
}
/** The calls both models answer identically; typed by hand so one code path serves two Prisma delegates. */
interface RowDelegate {
  findMany(args: Record<string, unknown>): Promise<ListRow[]>;
  create(args: Record<string, unknown>): Promise<ListRow>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

export interface ListKind {
  table: ListTable;
  /** Capitalised noun the duplicate message prints: `Job type “X” already exists.` */
  noun: string;
  plural: string;
  /** Audit prefix and resource type. */
  audit: string;
  resourceType: string;
  /** Record text columns holding the name; a rename rewrites each (case-insensitive match, this org only). */
  rewrites: ReadonlyArray<{ table: string; column: string }>;
  /** SQL ($1 = org id) answering `key` (lower-cased name) and `n` (records carrying it). */
  usedCountSql: string;
  delegate(db: Prisma.TransactionClient): RowDelegate;
}

export const JOB_TYPE_KIND: ListKind = {
  table: 'job_types',
  noun: 'Job type',
  plural: 'job types',
  audit: 'job_type',
  resourceType: 'JobType',
  rewrites: [
    { table: 'jobs', column: 'job_type' },
    { table: 'leads', column: 'job_type' },
    { table: 'estimates', column: 'job_type' },
    { table: 'service_plan_templates', column: 'job_type' },
  ],
  // Jobs plus leads that carry the name.
  usedCountSql:
    `SELECT lower(u."k") AS "key", sum(u."n")::int AS "n" FROM (\n` +
    `  SELECT "job_type" AS "k", count(*) AS "n" FROM "jobs" WHERE "organization_id" = $1::uuid AND "job_type" IS NOT NULL GROUP BY 1\n` +
    `  UNION ALL\n` +
    `  SELECT "job_type", count(*) FROM "leads" WHERE "organization_id" = $1::uuid AND "job_type" IS NOT NULL GROUP BY 1\n` +
    `) u GROUP BY 1`,
  delegate: (db) => db.jobType as unknown as RowDelegate,
};

export const LEAD_SOURCE_KIND: ListKind = {
  table: 'lead_sources',
  noun: 'Source',
  plural: 'sources',
  audit: 'lead_source',
  resourceType: 'LeadSource',
  rewrites: [
    { table: 'customers', column: 'ad_source' },
    { table: 'customers', column: 'source' },
    { table: 'estimates', column: 'lead_source' },
    { table: 'web_form_integrations', column: 'default_lead_source' },
  ],
  // Leads whose customer carries the name (`Lead.source` is a dead column; the customer's ad_source is the live one).
  usedCountSql:
    `SELECT lower(c."ad_source") AS "key", count(*)::int AS "n" FROM "leads" l\n` +
    `JOIN "customers" c ON c."id" = l."customer_id" AND c."organization_id" = $1::uuid\n` +
    `WHERE l."organization_id" = $1::uuid AND c."ad_source" IS NOT NULL GROUP BY 1`,
  delegate: (db) => db.leadSource as unknown as RowDelegate,
};

const KIND_BY_TABLE: Record<ListTable, ListKind> = { job_types: JOB_TYPE_KIND, lead_sources: LEAD_SOURCE_KIND };

// --- Org record compatibility ----------------------------------------------------------------------------------------

/**
 * The two string lists the org record hands the forms: the ACTIVE rows in `sort_order`; an org with no rows at all keeps
 * the JSON column (returned as `undefined` here so the caller leaves it alone). Read-only, never writes.
 */
export async function activeListsForOrg(orgId: string): Promise<{ job_type_options?: string[]; source_options?: string[] }> {
  const out: { job_type_options?: string[]; source_options?: string[] } = {};
  await Promise.all(
    LIST_TABLES.map(async (table) => {
      const rows = await KIND_BY_TABLE[table].delegate(prisma as unknown as Prisma.TransactionClient).findMany({
        where: { organization_id: orgId },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, sort_order: true, archived_at: true },
      });
      if (rows.length === 0) return;
      out[JSON_COLUMN[table]] = rows.filter((r) => r.archived_at === null).map((r) => r.name);
    }),
  );
  return out;
}

// --- Handlers --------------------------------------------------------------------------------------------------------

function dto(r: ListRow, used: number) {
  return { id: r.id, name: r.name, sort_order: r.sort_order, archived: r.archived_at !== null, used_count: used };
}

async function usedCounts(kind: ListKind, db: Prisma.TransactionClient, orgId: string): Promise<Map<string, number>> {
  const rows = await db.$queryRawUnsafe<Array<{ key: string; n: number }>>(kind.usedCountSql, orgId);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

const usedOf = (m: Map<string, number>, name: string) => m.get(name.toLowerCase()) ?? 0;

function orderedRows(kind: ListKind, db: Prisma.TransactionClient, orgId: string) {
  return kind.delegate(db).findMany({
    where: { organization_id: orgId },
    orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
  });
}

const full = (res: Response) => res.status(409).json({ error: LIST_FULL_MSG });
const missing = (kind: ListKind, res: Response) => res.status(404).json({ error: `${kind.noun} not found` });
function nameExists(kind: ListKind, res: Response, existing: string) {
  return res.status(409).json({ code: 'NAME_EXISTS', name: existing, error: `${kind.noun} “${existing}” already exists.` });
}
const isUniqueClash = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** The routes' handlers for one list. The caller (controller file) just names the kind. */
export function listHandlers(kind: ListKind) {
  const d = kind.delegate;
  const orgOf = (req: Request) => req.user!.organization_id;
  const param = (req: Request) => req.params.id as string;
  const fail = (res: Response, what: string, err: unknown) => {
    logger.error(`${what} ${kind.plural} error:`, err);
    res.status(500).json({ error: `Failed to ${what} ${kind.plural}` });
  };

  async function list(req: Request, res: Response) {
    try {
      const orgId = orgOf(req);
      // Reads copy the JSON list only when the org has no rows, so the common case is a plain read.
      const none = (await d(prisma as unknown as Prisma.TransactionClient).findMany({ where: { organization_id: orgId }, take: 1 })).length === 0;
      if (none) await prisma.$transaction((tx) => lockAndFill(tx, orgId, kind.table));
      const db = prisma as unknown as Prisma.TransactionClient;
      const [rows, used] = await Promise.all([orderedRows(kind, db, orgId), usedCounts(kind, db, orgId)]);
      const archived = rows.filter((r) => r.archived_at !== null).length;
      res.json({ items: rows.map((r) => dto(r, usedOf(used, r.name))), counts: { active: rows.length - archived, archived } });
    } catch (err) {
      fail(res, 'list', err);
    }
  }

  async function create(req: Request, res: Response) {
    try {
      const orgId = orgOf(req);
      const { name } = req.body as { name: string };
      const out = await prisma.$transaction(async (tx) => {
        await lockAndFill(tx, orgId, kind.table);
        const rows = await d(tx).findMany({ where: { organization_id: orgId }, select: { id: true, name: true, sort_order: true } });
        const clash = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
        if (clash) return { kind: 'exists' as const, name: clash.name };
        if (rows.length >= MAX_LIST_ROWS) return { kind: 'full' as const };
        const row = await d(tx).create({ data: { organization_id: orgId, name, sort_order: rows.reduce((m, r) => Math.max(m, r.sort_order), -1) + 1 } });
        return { kind: 'created' as const, row };
      });
      if (out.kind === 'exists') return void nameExists(kind, res, out.name);
      if (out.kind === 'full') return void full(res);
      void logAudit({ req, action: `${kind.audit}.created`, resourceType: kind.resourceType, resourceId: out.row.id, metadata: { name } });
      res.status(201).json({ item: dto(out.row, 0) });
    } catch (err) {
      if (isUniqueClash(err)) return void nameExists(kind, res, (req.body as { name: string }).name);
      fail(res, 'create', err);
    }
  }

  async function rename(req: Request, res: Response) {
    try {
      const orgId = orgOf(req);
      const id = param(req);
      const { name } = req.body as { name: string };
      const out = await prisma.$transaction(async (tx) => {
        await lockAndFill(tx, orgId, kind.table);
        const rows = await d(tx).findMany({ where: { organization_id: orgId } });
        const row = rows.find((r) => r.id === id);
        if (!row) return { kind: 'missing' as const };
        const clash = rows.find((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase());
        if (clash) return { kind: 'exists' as const, name: clash.name };
        if (row.name === name) return { kind: 'renamed' as const, row, rewritten: 0 };
        await d(tx).updateMany({ where: { id, organization_id: orgId }, data: { name } });
        // The records keep the TEXT, so the same transaction rewrites it on this org's records. Case-insensitive match on
        // the old name; nothing else in the column is touched, and no other org's rows are in reach.
        let rewritten = 0;
        for (const c of kind.rewrites) {
          rewritten += await tx.$executeRawUnsafe(
            `UPDATE "${c.table}" SET "${c.column}" = $1 WHERE "organization_id" = $2::uuid AND lower("${c.column}") = lower($3) AND "${c.column}" IS DISTINCT FROM $1`,
            name,
            orgId,
            row.name,
          );
        }
        return { kind: 'renamed' as const, row: { ...row, name }, rewritten };
      });
      if (out.kind === 'missing') return void missing(kind, res);
      if (out.kind === 'exists') return void nameExists(kind, res, out.name);
      void logAudit({ req, action: `${kind.audit}.renamed`, resourceType: kind.resourceType, resourceId: id, metadata: { name, records_updated: out.rewritten } });
      const used = await usedCounts(kind, prisma as unknown as Prisma.TransactionClient, orgId);
      res.json({ item: dto(out.row, usedOf(used, out.row.name)) });
    } catch (err) {
      if (isUniqueClash(err)) return void nameExists(kind, res, (req.body as { name: string }).name);
      fail(res, 'rename', err);
    }
  }

  function setArchived(archive: boolean) {
    return async (req: Request, res: Response) => {
      try {
        const orgId = orgOf(req);
        const id = param(req);
        const out = await prisma.$transaction(async (tx) => {
          await lockAndFill(tx, orgId, kind.table);
          const rows = await d(tx).findMany({ where: { organization_id: orgId } });
          const row = rows.find((r) => r.id === id);
          if (!row) return null;
          const changes = archive ? row.archived_at === null : row.archived_at !== null;
          if (!changes) return row;
          // Archived rows keep their sort_order; Restore goes to the END of the active list (C-41).
          const data = archive
            ? { archived_at: new Date() }
            : { archived_at: null, sort_order: rows.reduce((m, r) => Math.max(m, r.sort_order), -1) + 1 };
          await d(tx).updateMany({ where: { id, organization_id: orgId }, data });
          return { ...row, ...data } as ListRow;
        });
        if (!out) return void missing(kind, res);
        void logAudit({ req, action: `${kind.audit}.${archive ? 'archived' : 'unarchived'}`, resourceType: kind.resourceType, resourceId: id });
        const used = await usedCounts(kind, prisma as unknown as Prisma.TransactionClient, orgId);
        res.json({ item: dto(out, usedOf(used, out.name)) });
      } catch (err) {
        fail(res, archive ? 'archive' : 'unarchive', err);
      }
    };
  }

  /** Hard delete, only at used_count 0: it exists so Undo of Create works (C-11). Removal for users stays archive. */
  async function remove(req: Request, res: Response) {
    try {
      const orgId = orgOf(req);
      const id = param(req);
      const out = await prisma.$transaction(async (tx) => {
        await lockAndFill(tx, orgId, kind.table);
        const row = (await d(tx).findMany({ where: { organization_id: orgId } })).find((r) => r.id === id);
        if (!row) return { kind: 'missing' as const };
        if (usedOf(await usedCounts(kind, tx, orgId), row.name) > 0) return { kind: 'used' as const, name: row.name };
        await d(tx).deleteMany({ where: { id, organization_id: orgId } });
        return { kind: 'deleted' as const, name: row.name };
      });
      if (out.kind === 'missing') return void missing(kind, res);
      if (out.kind === 'used') return void res.status(409).json({ error: `${kind.noun} “${out.name}” is in use and cannot be removed.` });
      void logAudit({ req, action: `${kind.audit}.deleted`, resourceType: kind.resourceType, resourceId: id, metadata: { name: out.name } });
      res.status(204).send();
    } catch (err) {
      fail(res, 'delete', err);
    }
  }

  /** Whole list or nothing: the body must name every ACTIVE row exactly once, all of them this org's. */
  async function reorder(req: Request, res: Response) {
    try {
      const orgId = orgOf(req);
      const { ordered_ids } = req.body as { ordered_ids: string[] };
      const out = await prisma.$transaction(async (tx) => {
        await lockAndFill(tx, orgId, kind.table);
        const active = (await d(tx).findMany({ where: { organization_id: orgId } })).filter((r) => r.archived_at === null);
        if (ordered_ids.length !== active.length) return { kind: 'incomplete' as const, total: active.length };
        const activeIds = new Set(active.map((r) => r.id));
        if (!ordered_ids.every((id) => activeIds.has(id))) return { kind: 'unknown' as const };
        await tx.$executeRawUnsafe(
          `UPDATE "${kind.table}" t SET "sort_order" = (v."ord" - 1)::int, "updated_at" = now() ` +
            `FROM unnest($1::uuid[]) WITH ORDINALITY AS v("id", "ord") WHERE t."id" = v."id" AND t."organization_id" = $2::uuid`,
          ordered_ids,
          orgId,
        );
        return { kind: 'reordered' as const };
      });
      if (out.kind === 'incomplete') {
        return void res.status(400).json({ error: `Send all ${out.total} active ${kind.plural} when reordering, in the order you want them offered in` });
      }
      if (out.kind === 'unknown') return void res.status(400).json({ error: `Unknown ${kind.noun.toLowerCase()} in reorder` });
      void logAudit({ req, action: `${kind.audit}s.reordered`, resourceType: kind.resourceType, metadata: { count: ordered_ids.length } });
      res.status(204).send();
    } catch (err) {
      fail(res, 'reorder', err);
    }
  }

  return { list, create, rename, archive: setArchived(true), unarchive: setArchived(false), remove, reorder };
}

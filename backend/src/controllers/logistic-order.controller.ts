/**
 * Logistic Orders — HTTP controller (LO-2, plan §2.1).
 *
 * Every stock-moving verb (process / edit-processed / unwind) delegates to the shared engine in
 * `lib/logisticOrders.ts` so there is exactly ONE implementation of each doctrine rule. This file
 * owns the HTTP shape, the CRUD/lifecycle state machine, anchored numbering at creation, and the
 * three guards the engine cannot express on its own: org-scoped anchor validation (E18), the
 * cancelled-job transition guard (L3/E12), and the fast-forward capability check (E20).
 *
 * ⚠️ TENANCY IS MANUAL. canAccessRow(req, 'LogisticOrder', …) is NOT a tenancy gate — every
 * LO-reading role holds an UNCONDITIONAL read, so scopeWhereFor returns {} and canAccessRow
 * short-circuits to `true` WITHOUT a query, passing a cross-org UUID. EVERY query below therefore
 * spreads tenantWhere(req) into its OWN where clause. See the banner in scopeWhereFor.ts.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { LogisticOrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq, canActOnRow, canCreateOnAnchor } from '../lib/permissions/enforce';
import {
  pickAnchor,
  allocateNumber,
  allocateAnchoredNumber,
  type AnchorColumn,
  type AnchorIds,
} from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import {
  processLogisticOrder as runProcessLogisticOrder,
  returnProcessedLo,
  applyProcessedLineDiff,
  loActorContext,
  logisticOrderErrorResponse,
  loNotFoundResponse,
  LoLineValidationError,
  LoStatusError,
  type LoLineRow,
  type LoLineValidationDetail,
} from '../lib/logisticOrders';
import {
  ShortageError,
  shortageResponse,
  orgBlocksNegativeStock,
} from './inv-stock.controller';
import { emit } from '../services/notifications/notificationService';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const lineInputSchema = z.object({
  // Present = an existing line (PROCESSED diff keys off it); absent = a new line.
  id: z.string().uuid().optional(),
  item_id: z.string().uuid(),
  qty: z.number().positive(),
  from_location_id: z.string().uuid().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
});

export const createLogisticOrderSchema = z
  .object({
    job_id: z.string().uuid().optional(),
    invoice_id: z.string().uuid().optional(),
    estimate_id: z.string().uuid().optional(),
    lead_id: z.string().uuid().optional(),
    customer_id: z.string().uuid().optional(),
    service_plan_id: z.string().uuid().optional(),
    notes: z.string().max(5000).nullable().optional(),
    lines: z.array(lineInputSchema).default([]),
  })
  .strict();

export const updateLogisticOrderSchema = z
  .object({
    notes: z.string().max(5000).nullable().optional(),
    cancelled_reason: z.string().max(5000).nullable().optional(),
    // Full-replace, diffed server-side. PROCESSED routes through applyProcessedLineDiff.
    lines: z.array(lineInputSchema).optional(),
  })
  .strict()
  // Each existing-line id may appear at most once. A repeated id makes the PROCESSED diff post
  // its qty delta once per occurrence — two stock movements against a row written once, a silent
  // ledger desync — so reject it here (400) before any transaction opens. New lines carry no id
  // and are exempt. applyProcessedLineDiff backstops the same rule for direct callers.
  .refine(
    (b) => {
      const ids = (b.lines ?? []).map((l) => l.id).filter((id): id is string => !!id);
      return new Set(ids).size === ids.length;
    },
    { message: 'A line id may appear at most once', path: ['lines'] },
  );

export const cancelLogisticOrderSchema = z
  .object({
    cancelled_reason: z.string().max(5000).nullable().optional(),
  })
  .strict();

const listQuerySchema = z.object({
  status: z
    .enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSED', 'CANCELLED', 'RETURNED'])
    .optional(),
  job_id: z.string().uuid().optional(),
  invoice_id: z.string().uuid().optional(),
  service_plan_id: z.string().uuid().optional(),
  q: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

// ─── Includes + mappers ─────────────────────────────────────────────────────

const loLineSelect = {
  id: true,
  item_id: true,
  item_sku: true,
  item_name: true,
  qty: true,
  from_location_id: true,
  sequence: true,
} as const;

const loDetailInclude = {
  lines: {
    orderBy: { sequence: 'asc' as const },
    select: { ...loLineSelect, from_location: { select: { id: true, name: true } } },
  },
  job: { select: { id: true, job_number: true } },
  invoice: { select: { id: true, invoice_number: true } },
  estimate: { select: { id: true, estimate_number: true } },
  lead: { select: { id: true, lead_number: true } },
  customer: { select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true } },
  service_plan: { select: { id: true, service_plan_number: true } },
  creator: { select: { id: true, first_name: true, last_name: true } },
  submitter: { select: { id: true, first_name: true, last_name: true } },
  approver: { select: { id: true, first_name: true, last_name: true } },
  processor: { select: { id: true, first_name: true, last_name: true } },
} as const;

const loListInclude = {
  job: { select: { id: true, job_number: true } },
  invoice: { select: { id: true, invoice_number: true } },
  estimate: { select: { id: true, estimate_number: true } },
  lead: { select: { id: true, lead_number: true } },
  customer: { select: { id: true, customer_number: true } },
  service_plan: { select: { id: true, service_plan_number: true } },
  creator: { select: { id: true, first_name: true, last_name: true } },
  _count: { select: { lines: true } },
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function person(u: any): { id: string; name: string } | null {
  if (!u) return null;
  return { id: u.id, name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() };
}

// The precedence-winning anchor's human number — the label a link renders.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anchorSummary(lo: any) {
  return {
    jobId: lo.job_id ?? undefined,
    jobNumber: lo.job?.job_number ?? undefined,
    invoiceId: lo.invoice_id ?? undefined,
    invoiceNumber: lo.invoice?.invoice_number ?? undefined,
    estimateId: lo.estimate_id ?? undefined,
    estimateNumber: lo.estimate?.estimate_number ?? undefined,
    leadId: lo.lead_id ?? undefined,
    leadNumber: lo.lead?.lead_number ?? undefined,
    customerId: lo.customer_id ?? undefined,
    customerNumber: lo.customer?.customer_number ?? undefined,
    servicePlanId: lo.service_plan_id ?? undefined,
    servicePlanNumber: lo.service_plan?.service_plan_number ?? undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapLoLine(l: any) {
  return {
    id: l.id,
    itemId: l.item_id ?? undefined,
    itemSku: l.item_sku,
    itemName: l.item_name,
    qty: Number(l.qty),
    fromLocationId: l.from_location_id ?? undefined,
    fromLocationName: l.from_location?.name ?? undefined,
    sequence: l.sequence,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapLoDetail(lo: any) {
  return {
    id: lo.id,
    number: lo.number,
    seq: lo.seq ?? null,
    status: lo.status,
    notes: lo.notes ?? null,
    anchors: anchorSummary(lo),
    lines: (lo.lines ?? []).map(mapLoLine),
    lineCount: (lo.lines ?? []).length,
    createdBy: person(lo.creator),
    submittedBy: person(lo.submitter),
    approvedBy: person(lo.approver),
    processedBy: person(lo.processor),
    submittedAt: lo.submitted_at ?? null,
    approvedAt: lo.approved_at ?? null,
    processedAt: lo.processed_at ?? null,
    cancelledAt: lo.cancelled_at ?? null,
    cancelledReason: lo.cancelled_reason ?? null,
    createdAt: lo.created_at,
    updatedAt: lo.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapLoListRow(lo: any) {
  return {
    id: lo.id,
    number: lo.number,
    seq: lo.seq ?? null,
    status: lo.status,
    anchors: anchorSummary(lo),
    lineCount: lo._count?.lines ?? 0,
    createdBy: person(lo.creator),
    processedAt: lo.processed_at ?? null,
    createdAt: lo.created_at,
  };
}

// ─── Anchor org-scope validation (E18) ──────────────────────────────────────

type RowProbe = { findFirst(args: unknown): Promise<{ id: string } | null> };

function anchorDelegate(column: AnchorColumn): RowProbe {
  const map: Record<AnchorColumn, RowProbe> = {
    job_id: prisma.job as unknown as RowProbe,
    invoice_id: prisma.invoice as unknown as RowProbe,
    estimate_id: prisma.estimate as unknown as RowProbe,
    lead_id: prisma.lead as unknown as RowProbe,
    customer_id: prisma.customer as unknown as RowProbe,
    service_plan_id: prisma.servicePlan as unknown as RowProbe,
  };
  return map[column];
}

/** Every provided anchor id must resolve IN THE CALLER ORG, else 404 and no LO is minted (E18). */
async function assertAnchorsInOrg(req: Request, anchors: AnchorIds): Promise<AnchorColumn | null> {
  for (const [column, id] of Object.entries(anchors) as [AnchorColumn, string | null | undefined][]) {
    if (!id) continue;
    const row = await anchorDelegate(column).findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!row) return column;
  }
  return null;
}

// ─── Line validation + snapshots (create + non-processed replace + new processed lines) ──

/**
 * Resolve every line's catalog item + source location on the GLOBAL client (pre-tx). Enforces the
 * add-time line rules: item must exist and be `track_inventory: true`; a present `from_location_id`
 * must be org-scoped (null is legal on a draft). Returns the sku/name snapshot map for persistence.
 * Throws LoLineValidationError (→ 422) naming every bad line at once.
 */
async function validateAndSnapshotLines(
  req: Request,
  lines: { item_id: string; from_location_id?: string | null }[],
): Promise<Map<string, { sku: string; name: string }>> {
  const snapshots = new Map<string, { sku: string; name: string }>();
  if (lines.length === 0) return snapshots;

  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  const items = await prisma.priceBookItem.findMany({
    where: { id: { in: itemIds }, ...tenantWhere(req) },
    select: { id: true, sku: true, name: true, track_inventory: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  const locIds = [...new Set(lines.map((l) => l.from_location_id).filter(Boolean) as string[])];
  const locs = locIds.length
    ? await prisma.inventoryLocation.findMany({
        where: { id: { in: locIds }, ...tenantWhere(req) },
        select: { id: true },
      })
    : [];
  const locSet = new Set(locs.map((l) => l.id));

  const issues: LoLineValidationDetail[] = [];
  for (const line of lines) {
    const item = itemById.get(line.item_id);
    if (!item || !item.track_inventory) {
      issues.push({
        lineId: null,
        itemSku: item?.sku ?? null,
        itemName: item?.name ?? null,
        reason: 'ITEM_UNAVAILABLE',
        message: `Item ${line.item_id} is not a tracked inventory item in this organization`,
      });
      continue;
    }
    if (line.from_location_id && !locSet.has(line.from_location_id)) {
      issues.push({
        lineId: null,
        itemSku: item.sku,
        itemName: item.name,
        reason: 'UNKNOWN_LOCATION',
        message: `${item.sku} points at a location that is not in this organization`,
      });
      continue;
    }
    snapshots.set(line.item_id, { sku: item.sku ?? '', name: item.name });
  }
  if (issues.length > 0) throw new LoLineValidationError(issues);
  return snapshots;
}

/**
 * Org-scope the `from_location_id` on every given line. Mirrors the location half of
 * validateAndSnapshotLines (an org-scoped InventoryLocation lookup → the same 422 UNKNOWN_LOCATION),
 * without re-checking items — used for EXISTING lines on a PROCESSED edit, whose item is guarded by
 * applyProcessedLineDiff's swap check but whose changed `from_location_id` would otherwise reach
 * applyStockMovement unvalidated. applyProcessedLineDiff's location-change branch only rejects a
 * MISSING location, never a cross-org one, so an unguarded cross-org id is a cross-tenant stock
 * write. canAccessRow is NOT a tenancy gate for LOs — every incoming location id is org-scoped here.
 */
async function validateLineLocationsInOrg(
  req: Request,
  lines: { from_location_id?: string | null }[],
): Promise<void> {
  const locIds = [...new Set(lines.map((l) => l.from_location_id).filter(Boolean) as string[])];
  if (locIds.length === 0) return;

  const locs = await prisma.inventoryLocation.findMany({
    where: { id: { in: locIds }, ...tenantWhere(req) },
    select: { id: true },
  });
  const locSet = new Set(locs.map((l) => l.id));

  const issues: LoLineValidationDetail[] = [];
  for (const id of locIds) {
    if (!locSet.has(id)) {
      issues.push({
        lineId: null,
        itemSku: null,
        itemName: null,
        reason: 'UNKNOWN_LOCATION',
        message: `Location ${id} is not in this organization`,
      });
    }
  }
  if (issues.length > 0) throw new LoLineValidationError(issues);
}

const OPEN_STATUSES: LogisticOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

function staleStatus(res: Response, message: string, expected: LogisticOrderStatus[]): void {
  res.status(409).json({ error: 'STALE_STATUS', message, expected_status: expected });
}

function jobCancelled(res: Response, verb: string): void {
  res.status(409).json({
    error: 'JOB_CANCELLED',
    message: `Cannot ${verb} a logistic order whose job is cancelled`,
  });
}

// ─── Notifications (fire AFTER the write, never inside a tx; process NEVER emits) ──
//
// Fired via the generic `emit()` (which swallows its own errors) so this stream stays decoupled
// from the concurrently-built inventoryEmit LO helpers. The `lo.submitted` / `lo.approved`
// templates + resolveRecipients cases supply the copy and the recipient sets (approve-grant
// holders ∪ ADMINs / creator). LOGISTIC_ORDER is absent from filterByAccess's SCOPE_TYPE_MAP, so
// recipients are NOT row-scope-filtered downstream — the approver query's `is_active` filter IS
// the gate. Suppression on the fast-forward /process path is structural: process never calls these.

function actorDisplayName(req: Request): string {
  return `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
}

/**
 * lo.submitted → approve-grant holders ∪ ADMINs. The approver lookup is the only throwing step, so
 * the whole helper is wrapped and called fire-and-forget: a notification failure must never turn a
 * committed submit into a 500. A per-submit dedupKey keeps a re-submit after rejection notifiable.
 */
async function notifyLoSubmitted(req: Request, lo: { id: string; number: string }): Promise<void> {
  try {
    const orgId = req.user!.organization_id;
    const rows = await prisma.userPermissionOverride.findMany({
      where: {
        organization_id: orgId,
        subject: 'LogisticOrder',
        action: 'approve',
        effect: 'allow',
        user: { is_active: true },
      },
      select: { user_id: true },
    });
    await emit({
      verb: 'lo.submitted',
      organizationId: orgId,
      actorId: req.user!.id,
      object: { type: 'LOGISTIC_ORDER', id: lo.id, label: lo.number },
      entity: { approver_ids: rows.map((r) => r.user_id) },
      data: {
        logistic_order_id: lo.id,
        object_label: lo.number,
        actor_name: actorDisplayName(req),
      },
      dedupKey: `lo.submitted:${lo.id}:${Date.now()}`,
    });
  } catch (err) {
    logger.warn('notifyLoSubmitted failed', err);
  }
}

/** lo.approved → the creator. Self-approval drops the actor downstream → no row, no error. */
function notifyLoApproved(
  req: Request,
  lo: { id: string; number: string; created_by: string },
): void {
  void emit({
    verb: 'lo.approved',
    organizationId: req.user!.organization_id,
    actorId: req.user!.id,
    object: { type: 'LOGISTIC_ORDER', id: lo.id, label: lo.number },
    entity: { created_by_id: lo.created_by },
    data: {
      logistic_order_id: lo.id,
      object_label: lo.number,
      actor_name: actorDisplayName(req),
    },
    dedupKey: `lo.approved:${lo.id}`,
  }).catch((err) => logger.warn('notifyLoApproved failed', err));
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const listLogisticOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }
    const q = parsed.data;

    // scopeWhereFor applied on the list (agrees with the CASL ability); {} for LO's org-wide reads.
    const scope = await scopeWhereForReq(req, 'LogisticOrder');
    const where: Record<string, unknown> = { ...tenantWhere(req), ...scope };
    if (q.status) where.status = q.status;
    if (q.job_id) where.job_id = q.job_id;
    if (q.invoice_id) where.invoice_id = q.invoice_id;
    if (q.service_plan_id) where.service_plan_id = q.service_plan_id;
    if (q.q) {
      // AND-wrap so a text search never clobbers a scope/other OR key.
      where.AND = [
        {
          OR: [
            { number: { contains: q.q, mode: 'insensitive' } },
            { notes: { contains: q.q, mode: 'insensitive' } },
          ],
        },
      ];
    }

    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '50', 10) || 50));

    const [rows, total] = await Promise.all([
      prisma.logisticOrder.findMany({
        where,
        orderBy: { created_at: q.sortDir ?? 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: loListInclude,
      }),
      prisma.logisticOrder.count({ where }),
    ]);

    res.status(200).json({ data: rows.map(mapLoListRow), page, limit, total });
  } catch (err) {
    logger.error('listLogisticOrders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    // #2042 (R8): mirror listLogisticOrders - spread the read-scope fragment into the SAME
    // tenant-scoped findFirst rather than a canAccessRow + second round-trip. One query, and it
    // cannot be bypassed by a later edit that moves the guard.
    const lo = await prisma.logisticOrder.findFirst({
      where: {
        id: req.params.id as string,
        ...tenantWhere(req),
        ...(await scopeWhereForReq(req, 'LogisticOrder')),
      },
      include: loDetailInclude,
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }
    res.status(200).json(mapLoDetail(lo));
  } catch (err) {
    logger.error('getLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId = req.user!.organization_id;
    const body = req.body as z.infer<typeof createLogisticOrderSchema>;
    const anchors: AnchorIds = {
      job_id: body.job_id,
      invoice_id: body.invoice_id,
      estimate_id: body.estimate_id,
      lead_id: body.lead_id,
      customer_id: body.customer_id,
      service_plan_id: body.service_plan_id,
    };

    // #2042 (spec §3) — a conditioned `create LogisticOrder` grant (this slice's migration is
    // #2042 slice 2) is anchored to the caller's OWN job via the grant's condition; an
    // unconditional caller (ADMIN/DISPATCHER, and SALES's default today) short-circuits to
    // `true` here and nothing below changes for them. 403, no row minted, for a conditioned
    // caller whose `job_id` belongs to someone else's job OR is absent entirely.
    if (!(await canCreateOnAnchor(req, 'LogisticOrder', 'create', 'job', prisma.job, body.job_id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // R4 — a conditioned caller may anchor ONLY on `job_id`; any other anchor alongside it would
    // let the create ride the job check while rendering a foreign anchor's number (and, for
    // `customer_id`, the customer's name) on a row the rep could not otherwise read
    // (`loDetailInclude`). Re-probe with `anchorId: null`: an UNCONDITIONAL caller still resolves
    // `true` (step 2 of `canCreateOnAnchor` short-circuits before `anchorId` is even examined,
    // same as above); a conditioned caller resolves `false` (step 3, no anchor to satisfy the
    // condition with) - that is exactly the signal for "this caller is conditioned".
    const unconditionalCreate = await canCreateOnAnchor(req, 'LogisticOrder', 'create', 'job', prisma.job, null);
    if (!unconditionalCreate) {
      const hasOtherAnchor =
        !!anchors.invoice_id || !!anchors.estimate_id || !!anchors.lead_id ||
        !!anchors.customer_id || !!anchors.service_plan_id;
      if (hasOtherAnchor) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
    }

    // E18 — every anchor id must be in-org, else 404 and nothing is minted.
    const badAnchor = await assertAnchorsInOrg(req, anchors);
    if (badAnchor) {
      res.status(404).json({
        error: 'ANCHOR_NOT_FOUND',
        message: `The ${badAnchor.replace('_id', '')} anchor does not exist in this organization`,
        anchor: badAnchor,
      });
      return;
    }

    // Line rules enforced pre-tx (item tracked, location in-org). Snapshots persisted with the row.
    const snapshots = await validateAndSnapshotLines(req, body.lines);

    const picked = pickAnchor(anchors);

    const created = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      // Numbering MUST be the first statement of the create tx (row-lock held to commit).
      let number: string;
      let seq: number | null;
      if (picked) {
        const anchored = await allocateAnchoredNumber(tx, {
          organizationId: orgId,
          anchorTable: picked.table,
          anchorColumn: picked.column,
          anchorId: picked.id,
        });
        number = anchored.number;
        seq = anchored.seq;
      } else {
        number = await allocateNumber(tx, 'logistic_order', orgId);
        seq = null;
      }

      return tx.logisticOrder.create({
        data: {
          number,
          seq,
          status: 'DRAFT',
          job_id: body.job_id ?? null,
          invoice_id: body.invoice_id ?? null,
          estimate_id: body.estimate_id ?? null,
          lead_id: body.lead_id ?? null,
          customer_id: body.customer_id ?? null,
          service_plan_id: body.service_plan_id ?? null,
          notes: body.notes ?? null,
          created_by: req.user!.id,
          organization_id: orgId,
          lines: {
            create: body.lines.map((l, i) => ({
              organization_id: orgId,
              item_id: l.item_id,
              item_sku: snapshots.get(l.item_id)!.sku,
              item_name: snapshots.get(l.item_id)!.name,
              qty: l.qty,
              from_location_id: l.from_location_id ?? null,
              sequence: l.sequence ?? i,
            })),
          },
        },
        include: loDetailInclude,
      });
    }), { label: 'logistic_order.create' });

    res.status(201).json(mapLoDetail(created));
  } catch (err) {
    if (logisticOrderErrorResponse(res, err)) return;
    logger.error('createLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof updateLogisticOrderSchema>;

    // #2042 (R7) — a conditioned `update LogisticOrder` reaches STOCK: a PROCESSED edit runs
    // applyProcessedLineDiff below, which moves inventory. Bounded to the rep's own job by the
    // condition, and `update` cannot re-anchor (updateLogisticOrderSchema is `.strict()` with no
    // anchor field), so this stays inside "create/edit/delete their own" - but it means SALES is
    // not literally writing NOTHING in the inventory module. No DRAFT-only restriction here -
    // that would be a new decision. Same 404 as a tenancy miss (loNotFoundResponse); intersects
    // the read scope with the verb's own scope, so DISPATCHER/ADMIN (unconditional both) are
    // unchanged - `canActOnRow` is not a tenancy gate, so the findFirst below keeps its own
    // `tenantWhere(req)` regardless.
    if (!(await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'update'))) {
      loNotFoundResponse(res);
      return;
    }

    const lo = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        number: true,
        status: true,
        job_id: true,
        organization_id: true,
        job: { select: { status: true } },
        lines: { orderBy: { sequence: 'asc' }, select: loLineSelect },
      },
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }
    const status = lo.status as LogisticOrderStatus;

    const metaData: Record<string, unknown> = {};
    if (body.notes !== undefined) metaData.notes = body.notes;
    if (body.cancelled_reason !== undefined) metaData.cancelled_reason = body.cancelled_reason;

    if (body.lines !== undefined) {
      if (status === 'CANCELLED' || status === 'RETURNED') {
        staleStatus(res, `Cannot edit lines on a ${status.toLowerCase()} logistic order`, [
          ...OPEN_STATUSES,
          'PROCESSED',
        ]);
        return;
      }

      if (status === 'PROCESSED') {
        // #2042 security fix round 1 (F1) — a PROCESSED edit MOVES stock via
        // applyProcessedLineDiff below; the row-ownership condition on `update LogisticOrder`
        // bounds WHICH LO the caller may touch, not WHETHER touching it is allowed to move
        // stock. Require `process LogisticOrder` on this same row too. DISPATCHER/ADMIN hold it
        // unconditionally, so canActOnRow short-circuits to true for them without a query - this
        // is a no-op for anyone who could already process; SALES holds no `process` grant at
        // all, so this always refuses them here, before any stock write.
        if (!(await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'process'))) {
          res.status(403).json({
            error: 'Only a user who can process logistic orders can change a processed order.',
          });
          return;
        }
        // A processed edit MOVES stock — refuse it on a cancelled job (L3/E12).
        if (lo.job?.status === 'CANCELLED') {
          jobCancelled(res, 'edit');
          return;
        }
        // New lines still obey the add-time rules; existing lines are validated by the engine.
        await validateAndSnapshotLines(
          req,
          body.lines.filter((l) => !l.id),
        );
        // Existing lines can also carry a changed from_location_id — org-validate every incoming
        // location so a cross-org id 422s here instead of reaching applyStockMovement (a
        // cross-tenant stock write). New-line locations are already covered above.
        await validateLineLocationsInOrg(
          req,
          body.lines.filter((l) => l.id),
        );
        const blockNegative = await orgBlocksNegativeStock(lo.organization_id);
        const actor = loActorContext(req, blockNegative);
        await prisma.$transaction(async (tx) => {
          // A processed edit MOVES stock, so it must serialize like process / return —
          // an in-tx status CAS is the whole concurrency story (invariant: canAccessRow is
          // NOT the gate here). The updateMany takes the LO row lock, so a concurrent edit or
          // unwind blocks here until we commit; on unblock the WHERE re-evaluates against
          // committed state, so a racing job-cancel / invoice-void / delete that already flipped
          // the LO to RETURNED matches 0 rows → 409, having moved nothing.
          const claim = await tx.logisticOrder.updateMany({
            where: { id: lo.id, status: 'PROCESSED', organization_id: lo.organization_id },
            data: { updated_at: new Date() },
          });
          if (claim.count === 0) throw new LoStatusError(lo.id, ['PROCESSED']);

          // Re-read the lines INSIDE the tx (after the row lock) so the diff is computed against
          // committed state, not the pre-tx snapshot — otherwise a concurrent edit's qty change is
          // lost-updated (the same delta consumed twice + line-vs-movement ledger desync).
          const currentLines = await tx.logisticOrderLine.findMany({
            where: { logistic_order_id: lo.id },
            orderBy: { sequence: 'asc' },
            select: loLineSelect,
          });

          await applyProcessedLineDiff(
            tx,
            { id: lo.id, number: lo.number, job_id: lo.job_id, lines: currentLines as LoLineRow[] },
            body.lines!.map((l, i) => ({
              id: l.id ?? null,
              item_id: l.item_id,
              qty: l.qty,
              from_location_id: l.from_location_id ?? null,
              sequence: l.sequence ?? i,
            })),
            actor,
          );
          if (Object.keys(metaData).length > 0) {
            await tx.logisticOrder.update({ where: { id: lo.id }, data: metaData });
          }
        });
      } else {
        // DRAFT / PENDING_APPROVAL / APPROVED — no stock moves; full replace.
        //
        // #2042 security round 2 (C) — an APPROVED order has been REVIEWED, and this branch
        // replaces its lines wholesale without touching `status` / `approved_at` / `approved_by`.
        // A rep could get one cheap widget approved and swap in 250 openers from the main
        // warehouse before the dispatcher pressed process: `process` re-reads the lines live
        // (lib/logisticOrders.ts) and never compares them to what was approved, and nothing
        // writes an audit row. The approval would then cover an order nobody ever saw.
        //
        // So an APPROVED lines edit needs the authority over THAT ROW to have approved it in the
        // first place, or to be the person who will fulfil it: `approve` (per-user capability,
        // the only source of that grant) or `process` (DISPATCHER holds it unconditionally,
        // ADMIN short-circuits as a superuser). Grant-based, never a role name — a SALES rep
        // handed "Approve logistic orders" passes here on their own row, and a role that loses
        // `process` stops passing without anyone editing this file. Both probes intersect the
        // caller's read scope with the verb's own, so neither widens anything.
        //
        // Scoped to a LINES edit on purpose: `body.lines === undefined` never reaches this
        // branch, so a notes-only PATCH on an APPROVED order still 200s (the requester adding
        // "customer will meet the crew at 8" is not the attack, and refusing it would break a
        // legitimate flow). DRAFT and PENDING_APPROVAL are untouched — nobody has reviewed them
        // yet, and re-editing before approval is the normal path.
        if (status === 'APPROVED') {
          const mayChangeApproved =
            (await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'approve')) ||
            (await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'process'));
          if (!mayChangeApproved) {
            res.status(409).json({
              error:
                "This order has already been approved and can't be changed. Ask an approver to cancel it and submit a new one.",
            });
            return;
          }
        }
        const snapshots = await validateAndSnapshotLines(req, body.lines);
        await prisma.$transaction(async (tx) => {
          await tx.logisticOrderLine.deleteMany({ where: { logistic_order_id: lo.id } });
          if (body.lines!.length > 0) {
            await tx.logisticOrderLine.createMany({
              data: body.lines!.map((l, i) => ({
                logistic_order_id: lo.id,
                organization_id: lo.organization_id,
                item_id: l.item_id,
                item_sku: snapshots.get(l.item_id)!.sku,
                item_name: snapshots.get(l.item_id)!.name,
                qty: l.qty,
                from_location_id: l.from_location_id ?? null,
                sequence: l.sequence ?? i,
              })),
            });
          }
          if (Object.keys(metaData).length > 0) {
            await tx.logisticOrder.update({ where: { id: lo.id }, data: metaData });
          }
        });
      }
    } else if (Object.keys(metaData).length > 0) {
      await prisma.logisticOrder.update({ where: { id: lo.id }, data: metaData });
    }

    const updated = await prisma.logisticOrder.findFirst({
      where: { id: lo.id, ...tenantWhere(req) },
      include: loDetailInclude,
    });
    res.status(200).json(mapLoDetail(updated));
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    if (logisticOrderErrorResponse(res, err)) return;
    logger.error('updateLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const submitLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    // #2042 - a conditioned `submit LogisticOrder` is bounded to the rep's own job; same 404 as
    // a tenancy miss. `canActOnRow` is not a tenancy gate, so the findFirst below keeps its own
    // `tenantWhere(req)` regardless.
    if (!(await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'submit'))) {
      loNotFoundResponse(res);
      return;
    }
    const lo = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, number: true, status: true, job: { select: { status: true } } },
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }
    if (lo.job?.status === 'CANCELLED') {
      jobCancelled(res, 'submit');
      return;
    }
    if (lo.status !== 'DRAFT') {
      staleStatus(res, 'Only a draft logistic order can be submitted', ['DRAFT']);
      return;
    }

    const claim = await prisma.logisticOrder.updateMany({
      where: { id, status: 'DRAFT', ...tenantWhere(req) },
      data: { status: 'PENDING_APPROVAL', submitted_at: new Date(), submitted_by: req.user!.id },
    });
    if (claim.count === 0) {
      staleStatus(res, 'Only a draft logistic order can be submitted', ['DRAFT']);
      return;
    }

    // Notify approve-grant holders ∪ ADMINs. Fire-and-forget, AFTER the write (never in a tx).
    void notifyLoSubmitted(req, { id: lo.id, number: lo.number });

    const updated = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      include: loDetailInclude,
    });
    res.status(200).json(mapLoDetail(updated));
  } catch (err) {
    logger.error('submitLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const approveLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const lo = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, number: true, status: true, created_by: true, job: { select: { status: true } } },
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }
    if (lo.job?.status === 'CANCELLED') {
      jobCancelled(res, 'approve');
      return;
    }
    if (lo.status !== 'PENDING_APPROVAL') {
      staleStatus(res, 'Only a submitted logistic order can be approved', ['PENDING_APPROVAL']);
      return;
    }

    const claim = await prisma.logisticOrder.updateMany({
      where: { id, status: 'PENDING_APPROVAL', ...tenantWhere(req) },
      data: { status: 'APPROVED', approved_at: new Date(), approved_by: req.user!.id },
    });
    if (claim.count === 0) {
      staleStatus(res, 'Only a submitted logistic order can be approved', ['PENDING_APPROVAL']);
      return;
    }

    // Notify the creator. Suppressed automatically if the approver IS the creator (actor drop).
    notifyLoApproved(req, { id: lo.id, number: lo.number, created_by: lo.created_by });

    // #2042 security round 2 (A) — the WRITE above is deliberately org-wide: approval is an
    // org-wide authority (`approve LogisticOrder` declares no ownCondition — "an approver reviews
    // other people's requests"). The 200 BODY is a different question. It is `mapLoDetail` over
    // `loDetailInclude`: the customer's name and number, the job number, and every line's sku /
    // qty / source location — for a row whose GET 404s for this same caller one handler earlier,
    // now that #2042 made SALES a row-scoped LO reader. The ids are discovered legitimately (the
    // `lo.submitted` notification carries id + number to every approve-override holder, and
    // LOGISTIC_ORDER has no `SCOPE_TYPE_MAP` entry in filterByAccess), so the response body was a
    // read channel around the new scope.
    //
    // Build it through the caller's OWN read scope instead, the way getLogisticOrder does (R8:
    // spread the fragment into the same findFirst rather than add a guard that can drift). A
    // caller who can read the row — DISPATCHER, ADMIN, an approver acting on their own job — is
    // byte-identical to before. A caller who cannot gets a slim acknowledgement: the id they put
    // in the URL, the number their own notification already gave them, and the status they just
    // set. Enough to confirm the click, nothing they could not already see.
    const updated = await prisma.logisticOrder.findFirst({
      where: {
        id,
        ...tenantWhere(req),
        ...(await scopeWhereForReq(req, 'LogisticOrder')),
      },
      include: loDetailInclude,
    });
    if (!updated) {
      res.status(200).json({ id: lo.id, number: lo.number, status: 'APPROVED' });
      return;
    }
    res.status(200).json(mapLoDetail(updated));
  } catch (err) {
    logger.error('approveLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const processLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    // L3/E12 — the engine does not know the job's status; guard the transition here.
    const guard = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, job: { select: { status: true } } },
    });
    if (!guard) {
      loNotFoundResponse(res);
      return;
    }
    if (guard.job?.status === 'CANCELLED') {
      jobCancelled(res, 'process');
      return;
    }

    // Fast-forward (E20): a caller who ALSO holds approve moves DRAFT/PENDING straight through,
    // stamping the full trail. Notifications are SUPPRESSED on this path — process never emits.
    const canApprove = req.ability!.can('approve', 'LogisticOrder');
    const opts = canApprove
      ? {
          allowedFromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as LogisticOrderStatus[],
          fastForward: true,
        }
      : { allowedFromStatuses: ['APPROVED'] as LogisticOrderStatus[], fastForward: false };

    const result = await runProcessLogisticOrder(prisma, req, id, opts);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    if (logisticOrderErrorResponse(res, err)) return;
    logger.error('processLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const cancelLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof cancelLogisticOrderSchema>;
    const lo = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, job: { select: { status: true } } },
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }
    if (lo.job?.status === 'CANCELLED') {
      jobCancelled(res, 'cancel');
      return;
    }
    // Never from PROCESSED (document verbs own that unwind) — nor from a terminal state.
    if (!OPEN_STATUSES.includes(lo.status as LogisticOrderStatus)) {
      staleStatus(res, 'Only an open (pre-processed) logistic order can be cancelled', OPEN_STATUSES);
      return;
    }

    const claim = await prisma.logisticOrder.updateMany({
      where: { id, status: { in: OPEN_STATUSES }, ...tenantWhere(req) },
      data: {
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancelled_reason: body.cancelled_reason ?? null,
      },
    });
    if (claim.count === 0) {
      staleStatus(res, 'Only an open (pre-processed) logistic order can be cancelled', OPEN_STATUSES);
      return;
    }

    const updated = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      include: loDetailInclude,
    });
    res.status(200).json(mapLoDetail(updated));
  } catch (err) {
    logger.error('cancelLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteLogisticOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    // #2042 (R7) — a conditioned `delete LogisticOrder` also reaches STOCK: deleting a PROCESSED
    // LO unwinds it via returnProcessedLo below. Bounded to the rep's own job by the condition.
    // Same 404 as a tenancy miss; `canActOnRow` is not a tenancy gate, so the findFirst below
    // keeps its own `tenantWhere(req)` regardless.
    if (!(await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'delete'))) {
      loNotFoundResponse(res);
      return;
    }
    const lo = await prisma.logisticOrder.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        number: true,
        status: true,
        job_id: true,
        organization_id: true,
        lines: { orderBy: { sequence: 'asc' }, select: loLineSelect },
      },
    });
    if (!lo) {
      loNotFoundResponse(res);
      return;
    }

    if (lo.status === 'PROCESSED') {
      // #2042 security fix round 1 (F1) — deleting a PROCESSED LO MOVES stock via
      // returnProcessedLo below; the row-ownership condition on `delete LogisticOrder` bounds
      // WHICH LO, not WHETHER unwinding it is allowed. Same reasoning as updateLogisticOrder's
      // matching check - DISPATCHER/ADMIN are unaffected (unconditional `process`), SALES holds
      // no `process` grant so this always refuses it here, before any stock write.
      if (!(await canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, 'process'))) {
        res.status(403).json({
          error: 'Only a user who can process logistic orders can change a processed order.',
        });
        return;
      }
    }

    const actor = loActorContext(req, false);
    await prisma.$transaction(async (tx) => {
      // E13: a processed LO returns its stock FIRST (movement FKs must exist at insert; the
      // cascade delete then SetNull-preserves the ledger rows), then the row is deleted — one tx.
      if (lo.status === 'PROCESSED') {
        await returnProcessedLo(tx, {
          id: lo.id,
          number: lo.number,
          organization_id: lo.organization_id,
          job_id: lo.job_id,
          lines: lo.lines as LoLineRow[],
          actor: actor.actor,
          actorUserId: actor.actorUserId,
        });
      }
      await tx.logisticOrder.delete({ where: { id: lo.id } });
    });

    res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof ShortageError) {
      shortageResponse(res, err);
      return;
    }
    if (logisticOrderErrorResponse(res, err)) return;
    logger.error('deleteLogisticOrder error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

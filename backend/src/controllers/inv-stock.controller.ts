import { Request, Response } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { canSeePricing } from '../lib/permissions/enforce';
import { parsePagination, parseSortParams, buildPaginationMeta, respondInvalidSort } from '../lib/pagination';
import { STOCK_MOVEMENT_SORT_FIELDS } from '../lib/sortFields';
import { emitStockApprovalRequested, emitLowStockIfCrossing } from '../services/notifications/inventoryEmit';
import { inclusiveEndOfDay } from '../lib/dateBounds';

// ─── Mappers (snake_case Prisma row → camelCase mock contract) ──────────────
//
// The frontend (frontend/src/lib/api/_mock/inventory/*) is typed against these
// shapes; the seam (frontend/src/lib/api/inventory.ts) reads `r.data.movements`
// and `r.data.stockApprovals`. Keys/optionality must match the mock types.

// P5 Action log: every pre-P5 key is preserved (item-panel back-compat); the
// enrichment keys (ids + server-joined display names) come from the read-path
// include below. unit_cost is cost data → strip-by-omission for requesters
// without canSeePricing (same predicate as stripMappedItemCost / job-lines).
function mapMovement(m: any, withCost = false) {
  return {
    id: m.id,
    occurredAt: m.occurred_at instanceof Date ? m.occurred_at.toISOString() : m.occurred_at,
    itemSku: m.item_sku,
    itemName: m.item_name,
    type: m.type,
    qty: Number(m.qty),
    fromLocationId: m.from_location_id ?? undefined,
    toLocationId: m.to_location_id ?? undefined,
    reference: m.reference,
    actor: m.actor,
    itemId: m.item_id ?? undefined,
    jobId: m.job_id ?? undefined,
    jobNumber: m.job?.job_number ?? undefined,
    // §14 H2: an LO-issued movement has no invoice LINE, so invoice attribution rides the
    // LO's own invoice anchor. Line-born movements keep their existing (higher-precedence) ref.
    invoiceId: m.invoice_line_item?.invoice?.id ?? m.logistic_order?.invoice?.id ?? undefined,
    invoiceNumber:
      m.invoice_line_item?.invoice?.invoice_number ??
      m.logistic_order?.invoice?.invoice_number ??
      undefined,
    logisticOrderId: m.logistic_order_id ?? undefined,
    logisticOrderNumber: m.logistic_order?.number ?? undefined,
    logisticOrderLineId: m.logistic_order_line_id ?? undefined,
    fromLocationName: m.from_location?.name ?? undefined,
    toLocationName: m.to_location?.name ?? undefined,
    actorUserId: m.actor_user_id ?? undefined,
    ...(withCost && m.unit_cost != null ? { unitCost: Number(m.unit_cost) } : {}),
  };
}

// Display-name joins for the movements read paths (StockMovement FKs are all
// SetNull — every join is null-safe; snapshots still carry the fallback text).
// NB: there is no invoice_id FK — invoice context rides invoice_line_item → invoice.
const movementInclude = {
  from_location: { select: { id: true, name: true } },
  to_location: { select: { id: true, name: true } },
  job: { select: { id: true, job_number: true } },
  invoice_line_item: { select: { invoice: { select: { id: true, invoice_number: true } } } },
  // §14 H2: LO drill-through. The nested invoice is what keeps INVOICE attribution alive for
  // LO-issued movements — they carry no invoice_line_item, so without it an invoice-anchored
  // LO's consumption would show a job but no invoice anywhere in the Action log.
  logistic_order: {
    select: { id: true, number: true, invoice: { select: { id: true, invoice_number: true } } },
  },
} as const;

function mapApprovalModification(mod: any) {
  return {
    at: mod.at instanceof Date ? mod.at.toISOString() : mod.at,
    byName: mod.by_name,
    note: mod.note,
    postDecision: mod.post_decision,
  };
}

function mapStockApproval(a: any) {
  return {
    id: a.id,
    requestedAt: a.requested_at instanceof Date ? a.requested_at.toISOString() : a.requested_at,
    requestedByTechId: a.requested_by_tech_id ?? '',
    requestedByTechName: a.requested_by_tech_name,
    type: a.type,
    itemSku: a.item_sku,
    itemName: a.item_name,
    uom: a.uom,
    qty: a.qty != null ? Number(a.qty) : 0,
    fromLocationId: a.from_location_id ?? '',
    fromLocationName: a.from_location_name,
    toLocationId: a.to_location_id ?? undefined,
    toLocationName: a.to_location_name ?? undefined,
    jobNumber: a.job_number ?? undefined,
    customer: a.customer ?? undefined,
    reason: a.reason ?? undefined,
    serialCaptured: a.serial_captured ?? undefined,
    photoUrl: a.photo_url ?? undefined,
    status: a.status,
    reviewedAt: a.reviewed_at
      ? a.reviewed_at instanceof Date
        ? a.reviewed_at.toISOString()
        : a.reviewed_at
      : undefined,
    reviewedByName: a.reviewed_by_name ?? undefined,
    reviewComment: a.review_comment ?? undefined,
    modifications:
      a.modifications && a.modifications.length > 0
        ? a.modifications.map(mapApprovalModification)
        : undefined,
  };
}

// ─── Shared stock side-effect helper (V5) ───────────────────────────────────

export type MovementType = 'receive' | 'transfer' | 'consume' | 'return' | 'adjust';

/** Thrown by applyStockMovement when blockNegative is set and the conditional
 *  decrement matched 0 rows. Aborts the surrounding tx BEFORE the movement row
 *  is written. Controllers map it to 409 { error: 'SHORTAGE', ... }. */
export class ShortageError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly itemName: string,
    public readonly locationId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(`Insufficient stock for ${itemName}: requested ${requested}, available ${available}`);
    this.name = 'ShortageError';
  }
}

export interface StockMovementInput {
  orgId: string;
  type: MovementType;
  itemSku: string;
  itemName: string;
  qty: number;                        // Decimal-safe: persisted as-is (DB column is Decimal(10,2)).
                                      // Positive for every type EXCEPT 'adjust', which may be signed (§3.3 count).
  itemId?: string | null;             // resolved PriceBookItem id (balance updates + ledger FK)
  jobId?: string | null;              // ledger FK; display snapshot stays in `reference`
  jobLineItemId?: string | null;      // P1 deduct/reversal threads it
  invoiceLineItemId?: string | null;  // P1 threads it
  logisticOrderId?: string | null;    // §14 H2: LO drill-through from the ledger
  logisticOrderLineId?: string | null;// §14 H2: which LO line issued these units
  unitCost?: number | null;           // cost snapshot at movement time (item/PO-line cost)
  actorUserId?: string | null;        // req.user.id; `actor` string stays the display snapshot
  fromLocationId?: string | null;
  toLocationId?: string | null;
  blockNegative?: boolean;            // org.block_negative_stock — consume/transfer source decrement becomes conditional-atomic
  reference: string;
  actor: string;
}

export interface StockMovementResult {
  /** Post-movement on_hand at the decremented location (consume / transfer source),
   *  else at the incremented destination; null when no balance row was touched. */
  onHandAfter: number | null;
  /** true when the decremented location went (or stayed) below zero — warn-mode over-draw. */
  shortage: boolean;
}

/**
 * Emit a StockMovement and adjust StockBalance(s) in one transaction.
 * 'receive'/'return'/'adjust' add to the destination; 'consume' subtracts from the source;
 * 'transfer' moves source→destination. Balance updates are skipped when itemId is unknown
 * (SKU not in catalog) or the relevant location is null. qty is Decimal(10,2) and is
 * persisted unrounded (2.5 ft of wire deducts 2.5). The ledger carries item_id/job_id/
 * line refs/unit_cost/actor_user_id as append-only context; movements still never touch
 * JobCharge/Invoice — material COST stays a read-side roll-up (Task 6).
 *
 * Order matters (P1 §0.1 / risk 5b): balance writes FIRST, movement row LAST — when block
 * mode throws ShortageError out of the balance step the movement insert is never reached, so
 * the ledger cannot gain a row for a refused deduction even if a future caller ran this
 * outside a $transaction. blockNegative is honored by 'consume' and the SOURCE side of
 * 'transfer' only; additions ('receive'/'return') can't over-draw, and 'adjust' is exempt by
 * design (a physical count is truth, §3.3).
 */
export async function applyStockMovement(tx: Prisma.TransactionClient, input: StockMovementInput): Promise<StockMovementResult> {
  const qty = input.qty;
  let onHandAfter: number | null = null;

  const onHandOf = (balance: unknown): number | null =>
    balance != null && (balance as any).on_hand != null ? Number((balance as any).on_hand) : null;

  if (input.itemId) {
    // Single write path for StockBalance. Warn mode uses the unclamped upsert; BLOCK mode uses
    // a conditional atomic UPDATE (… SET on_hand = on_hand - q WHERE … AND on_hand >= q,
    // rowcount 0 → ShortageError) — never check-then-write. Do not add balance writes elsewhere.
    // ONE named exception (SRVW-91): setThresholds writes min/max only - never on_hand, never
    // reserved, never a StockMovement - so quantity still has exactly one write path. Do not
    // route a quantity change through the thresholds endpoint.
    const addTo = async (locationId: string, delta: number) => {
      return tx.stockBalance.upsert({
        where: { item_id_location_id: { item_id: input.itemId!, location_id: locationId } },
        // No clamp: a consume against a missing balance row must record the true negative (risk 5b).
        create: { item_id: input.itemId!, location_id: locationId, on_hand: delta, reserved: 0, organization_id: input.orgId },
        update: { on_hand: { increment: delta } },
      });
    };

    // Decrement `q` from `locationId`. Warn mode: unclamped upsert (negative allowed, row
    // created negative if missing — risk 5b). Block mode: conditional atomic UPDATE — never
    // check-then-write (TOCTOU): rowcount 0 ⇒ ShortageError (tx aborts, movement never written).
    // Note: emitLowStockIfCrossing is fire-and-forget from inside a tx — inherently best-effort
    // (pre-existing behavior, unchanged).
    const decrementFrom = async (locationId: string, q: number): Promise<number | null> => {
      if (input.blockNegative) {
        const r = await tx.stockBalance.updateMany({
          where: { item_id: input.itemId!, location_id: locationId, on_hand: { gte: q } },
          data: { on_hand: { decrement: q } },
        });
        if (r.count === 0) {
          const row = await tx.stockBalance.findUnique({
            where: { item_id_location_id: { item_id: input.itemId!, location_id: locationId } },
            select: { on_hand: true },
          });
          // Missing row = 0 available. The read is informational (409 payload); tx aborts anyway.
          throw new ShortageError(input.itemId!, input.itemName, locationId, q, row ? Number(row.on_hand) : 0);
        }
        const after = await tx.stockBalance.findUnique({
          where: { item_id_location_id: { item_id: input.itemId!, location_id: locationId } },
          select: { on_hand: true, min: true },
        });
        if (after) {
          emitLowStockIfCrossing(
            input.orgId,
            input.itemId!,
            input.itemName,
            locationId,
            Number(after.on_hand),
            -q,
            after.min != null ? Number(after.min) : null,
          );
        }
        return onHandOf(after);
      }
      // Warn mode — existing unclamped upsert path + low-stock DOWNWARD-CROSSING emit
      // (prev >= min AND new < min). on_hand round-trips as Prisma.Decimal — cast at the boundary.
      const balance = await addTo(locationId, -q);
      if (balance != null) {
        emitLowStockIfCrossing(
          input.orgId,
          input.itemId!,
          input.itemName,
          locationId,
          Number((balance as any).on_hand),
          -q,       // delta used to reconstruct prevOnHand = newOnHand - delta
          (balance as any).min != null ? Number((balance as any).min) : null,
        );
      }
      return onHandOf(balance);
    };

    if ((input.type === 'receive' || input.type === 'return' || input.type === 'adjust') && input.toLocationId) {
      onHandAfter = onHandOf(await addTo(input.toLocationId, qty));
    } else if (input.type === 'consume' && input.fromLocationId) {
      onHandAfter = await decrementFrom(input.fromLocationId, qty);
    } else if (input.type === 'transfer' && input.fromLocationId && input.toLocationId) {
      // Source first — a block-mode shortage aborts before the destination is credited.
      onHandAfter = await decrementFrom(input.fromLocationId, qty);
      await addTo(input.toLocationId, qty);
    }
  }

  await tx.stockMovement.create({
    data: {
      occurred_at: new Date(),
      item_sku: input.itemSku,
      item_name: input.itemName,
      type: input.type,
      qty,
      item_id: input.itemId ?? null,
      job_id: input.jobId ?? null,
      job_line_item_id: input.jobLineItemId ?? null,
      invoice_line_item_id: input.invoiceLineItemId ?? null,
      logistic_order_id: input.logisticOrderId ?? null,
      logistic_order_line_id: input.logisticOrderLineId ?? null,
      unit_cost: input.unitCost ?? null,
      actor_user_id: input.actorUserId ?? null,
      from_location_id: input.fromLocationId ?? null,
      to_location_id: input.toLocationId ?? null,
      reference: input.reference,
      actor: input.actor,
      organization_id: input.orgId,
    },
  });

  return { onHandAfter, shortage: onHandAfter != null && onHandAfter < 0 };
}

/** Map a ShortageError to the canonical 409 SHORTAGE payload (mirrors OverBillError's
 *  typed-throw handling in job.controller.ts). Shared by every deduct call site. */
export function shortageResponse(res: Response, err: ShortageError): void {
  res.status(409).json({
    error: 'SHORTAGE',
    message: err.message,
    item_id: err.itemId,
    item_name: err.itemName,
    location_id: err.locationId,
    requested: err.requested,
    available: err.available,
  });
}

// ─── P1 shared lookups (consumed by job-lines / invoice-lines / job / invoice controllers) ───

export interface TrackedItemInfo {
  id: string;
  sku: string;
  name: string;
  unitCost: number | null;
  tracked: boolean;
}

/** Org-scoped item resolution for the deduct/sync/reversal paths. Returns null for a
 *  missing/cross-org id — callers treat null exactly like an untracked/free-text line
 *  (behavior-preserving: today addLine never validates price_book_item_id at all).
 *
 *  `db` defaults to the global client for the (majority) pre-transaction call sites. Callers
 *  that are ALREADY inside an interactive transaction MUST pass their `tx`: querying the
 *  global client there checks out a second pooled connection while the first is still held,
 *  which starves the pool and fails the whole transaction with P2024 on a connection-limited
 *  deployment (invisible locally, where spare connections mask it). */
export async function resolveTrackedItem(
  orgId: string,
  priceBookItemId: string | null | undefined,
  db: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<TrackedItemInfo | null> {
  if (!priceBookItemId) return null;
  const item = await db.priceBookItem.findFirst({
    where: { id: priceBookItemId, organization_id: orgId },
    select: { id: true, sku: true, name: true, unit_cost: true, track_inventory: true },
  });
  if (!item) return null;
  return {
    id: item.id,
    sku: item.sku ?? '',
    name: item.name,
    unitCost: item.unit_cost != null ? Number(item.unit_cost) : null,
    tracked: item.track_inventory,
  };
}

/** One-per-request read of the org's negative-stock policy (D7). */
export async function orgBlocksNegativeStock(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { block_negative_stock: true },
  });
  return !!org?.block_negative_stock;
}

/** Batch item lookup for reversal loops (job cancel / job delete / invoice void|delete).
 *  Intentionally does NOT filter on track_inventory — reversals key off LINE state (plan §3.2). */
export async function resolveItemsById(
  tx: Prisma.TransactionClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, { id: string; sku: string; name: string; unitCost: number | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.priceBookItem.findMany({
    where: { id: { in: [...new Set(ids)] }, organization_id: orgId },
    select: { id: true, sku: true, name: true, unit_cost: true },
  });
  return new Map(rows.map((r) => [r.id, { id: r.id, sku: r.sku ?? '', name: r.name, unitCost: r.unit_cost != null ? Number(r.unit_cost) : null }]));
}

/** §0.3 reversal/delta location resolution: the line's own stock_location_id → the org default →
 *  null (ledger-only: the movement row is written, no balance touched). fellBack=true means the
 *  line's original location was deleted (FK SetNull) — callers append " (original location
 *  deleted)" to the movement reference. */
export async function resolveLineStockLocation(
  tx: Prisma.TransactionClient,
  orgId: string,
  lineLocationId: string | null,
): Promise<{ locationId: string | null; fellBack: boolean }> {
  if (lineLocationId) return { locationId: lineLocationId, fellBack: false };
  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: { default_inventory_location_id: true },
  });
  return { locationId: org?.default_inventory_location_id ?? null, fellBack: true };
}

// ─── P3 restricted-tech van forcing (D10/D13, plan §3.7) ─────────────────────

/** Thrown at a forward-deduction seam when a restricted technician targets a location other
 *  than their own van. Controllers map it to 403 { error: 'VAN_RESTRICTED', ... } — same
 *  typed-throw pattern as ShortageError above. */
export class VanRestrictedError extends Error {
  constructor(public readonly vanLocationId: string | null) {
    super('Inventory deductions are restricted to your assigned van');
    this.name = 'VanRestrictedError';
  }
}

/** Map a VanRestrictedError to the canonical 403 VAN_RESTRICTED payload (mirrors
 *  shortageResponse). van_location_id is the tech's van (null when none is assigned) so the
 *  client can self-correct. */
export function vanRestrictedResponse(res: Response, err: VanRestrictedError): void {
  res.status(403).json({
    error: 'VAN_RESTRICTED',
    message: err.message,
    van_location_id: err.vanLocationId,
  });
}

// ─── C2 legacy stock-line freeze (LO-4, spec §14) ────────────────────────────

/** Thrown when a QUANTITY edit is attempted on a legacy `stock_status='SYNCED'` line. Logistic
 *  Orders now own all stock deduction, so a qty change on a line the retired inline flow deducted
 *  would silently desync stock — it is refused. Controllers map it to 400 LEGACY_STOCK_LINE. The
 *  in-family precedent is LINE_NOT_SYNCABLE (same two -lines controllers, same refusal class):
 *  bare code in `error` + a `reason` discriminator, no human message (the frontend string-maps). */
export class LegacyStockLineError extends Error {
  constructor() {
    super('Quantity edits are frozen on legacy synced stock lines');
    this.name = 'LegacyStockLineError';
  }
}

/** Map the freeze to the canonical 400 payload. Used by BOTH -lines controllers so the shape is
 *  identical (job-lines refuses pre-tx; invoice-lines throws in-tx and maps here in the catch). */
export function legacyStockLineResponse(res: Response): void {
  res.status(400).json({ error: 'LEGACY_STOCK_LINE', reason: 'qty_frozen' });
}

/** D10/D13: the restriction is ON only for role TECHNICIAN carrying the
 *  `location_restricted:Inventory` allow-override. The role gate is REQUIRED: ADMIN is
 *  `manage all` (defineAbility short-circuit) so a bare ability check would read true for
 *  every admin; a DISPATCHER carrying a stray override row is also exempt by role.
 *  vanId = the tech's own van (InventoryLocation.primary_tech_id, one-van-per-tech by
 *  convention — deterministic oldest-first if ever violated); null when none assigned. */
export async function resolveRestrictedVan(
  req: Request,
): Promise<{ restricted: boolean; vanId: string | null }> {
  if (req.user!.role !== 'TECHNICIAN' || !req.ability?.can('location_restricted', 'Inventory')) {
    return { restricted: false, vanId: null };
  }
  const van = await prisma.inventoryLocation.findFirst({
    where: { ...tenantWhere(req), primary_tech_id: req.user!.id },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  return { restricted: true, vanId: van?.id ?? null };
}

/** A line row as the reversal loops need it (subset of JobLineItem / InvoiceLineItem). */
export interface SyncedLineForReturn {
  id: string;
  quantity: unknown;                   // Prisma Decimal | number
  price_book_item_id: string | null;
  stock_location_id: string | null;
}

/**
 * Auto-return loop shared by the document verbs (job cancel/delete, invoice void/delete — §4):
 * one `return` movement per given line toward §0.3's resolved location. Lines whose catalog ref
 * was hard-deleted are skipped (stamp-only). Returns are never blocked (additions). Does NOT
 * stamp stock_status — callers decide (cancel/void stamp UNSYNCED; deletes let the rows die).
 * Callers pass ONLY SYNCED lines (the `stock_status: 'SYNCED'` filter IS the scope rule) and
 * must run this BEFORE deleting the parent rows (movement FKs must exist at insert; SetNull
 * fires on delete). Returns the number of movement rows written.
 */
export async function returnSyncedLines(
  tx: Prisma.TransactionClient,
  lines: SyncedLineForReturn[],
  opts: {
    orgId: string;
    reference: string;
    actor: string;
    actorUserId?: string | null;
    jobId?: string | null;
    /** Which line-ref FK the movement rows carry. */
    lineRef: 'job' | 'invoice';
  },
): Promise<number> {
  if (lines.length === 0) return 0;
  const items = await resolveItemsById(
    tx,
    opts.orgId,
    lines.map((l) => l.price_book_item_id).filter(Boolean) as string[],
  );
  // Lazily read the org default (§0.3) at most once, only when some line lost its location.
  let fallback: string | null | undefined;
  let written = 0;
  for (const line of lines) {
    const item = line.price_book_item_id ? items.get(line.price_book_item_id) : undefined;
    if (!item) continue; // hard-deleted catalog ref: stamp-only (caller's stamp still applies)
    let toLocationId = line.stock_location_id;
    let reference = opts.reference;
    if (!toLocationId) {
      if (fallback === undefined) {
        fallback = (await resolveLineStockLocation(tx, opts.orgId, null)).locationId;
      }
      toLocationId = fallback;
      reference = `${opts.reference} (original location deleted)`;
    }
    await applyStockMovement(tx, {
      orgId: opts.orgId,
      type: 'return',
      itemSku: item.sku,
      itemName: item.name,
      qty: Number(line.quantity),
      itemId: item.id,
      jobId: opts.jobId ?? null,
      jobLineItemId: opts.lineRef === 'job' ? line.id : null,
      invoiceLineItemId: opts.lineRef === 'invoice' ? line.id : null,
      unitCost: item.unitCost,
      actorUserId: opts.actorUserId ?? null,
      toLocationId,
      reference,
      actor: opts.actor,
    });
    written++;
  }
  return written;
}

// Maps a stock-approval `type` to the StockMovement type applied on approval (V5).
const TYPE_TO_MOVEMENT: Record<string, MovementType> = {
  consume_on_job: 'consume',
  return_to_warehouse: 'return',
  transfer_to_van: 'transfer',
  writeoff: 'adjust',
};

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const APPROVAL_TYPES = ['consume_on_job', 'return_to_warehouse', 'writeoff', 'transfer_to_van'] as const;

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  itemSku: z.string().min(1, 'Item SKU is required').max(200),
  itemName: z.string().min(1, 'Item name is required').max(300),
  uom: z.string().min(1).max(20),
  qty: z.number().min(0),
  fromLocationId: z.string().nullable().optional(),
  fromLocationName: z.string().min(1).max(200),
  toLocationId: z.string().nullable().optional(),
  toLocationName: z.string().max(200).nullable().optional(),
  requestedByTechId: z.string().uuid().nullable().optional(),
  requestedByTechName: z.string().min(1).max(200),
  jobId: z.string().uuid().nullable().optional(),
  jobNumber: z.string().max(50).nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  customer: z.string().max(200).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
  serialCaptured: z.string().max(200).nullable().optional(),
  photoUrl: z.string().max(5000).nullable().optional(),
});

export const decideApprovalSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  reviewedByName: z.string().min(1).max(200),
  reviewComment: z.string().max(2000).nullable().optional(),
});

// ─── Movement Handlers ───────────────────────────────────────────────────────

// P5 Action log filters. Query strings are parsed in-handler (validate() targets
// bodies — report-controller precedent). location_id matches EITHER side.
const listMovementsQuerySchema = z.object({
  type: z.enum(['receive', 'consume', 'return', 'transfer', 'adjust']).optional(),
  item_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  logistic_order_id: z.string().uuid().optional(),
  actor_user_id: z.string().uuid().optional(),
  occurred_from: z.coerce.date().optional(),
  occurred_to: inclusiveEndOfDay,
  page: z.string().optional(),
  limit: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

// GET /movements — {data,meta} envelope (P5 §3.5 normalization; the pre-P5
// {movements} envelope's single consumer, useMovements, migrates in the same PR).
export async function listMovements(req: Request, res: Response) {
  try {
    const parsed = listMovementsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const q = parsed.data;
    const { page, limit, skip } = parsePagination(q);
    const sort = parseSortParams(req.query as any, STOCK_MOVEMENT_SORT_FIELDS, 'occurred_at', 'desc');
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const where: Record<string, unknown> = { ...tenantWhere(req) };
    if (q.type) where.type = q.type;
    if (q.item_id) where.item_id = q.item_id;
    if (q.job_id) where.job_id = q.job_id;
    if (q.logistic_order_id) where.logistic_order_id = q.logistic_order_id;
    if (q.actor_user_id) where.actor_user_id = q.actor_user_id;
    if (q.location_id) {
      where.OR = [{ from_location_id: q.location_id }, { to_location_id: q.location_id }];
    }
    if (q.occurred_from || q.occurred_to) {
      where.occurred_at = {
        ...(q.occurred_from ? { gte: q.occurred_from } : {}),
        ...(q.occurred_to ? { lte: q.occurred_to } : {}),
      };
    }

    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({ where, skip, take: limit, orderBy, include: movementInclude }),
      prisma.stockMovement.count({ where }),
    ]);

    const withCost = canSeePricing(req);
    res.json({
      data: movements.map((m) => mapMovement(m, withCost)),
      meta: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('Failed to list movements:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getMovement(req: Request, res: Response) {
  try {
    const movement = await prisma.stockMovement.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: movementInclude,
    });

    if (!movement) {
      res.status(404).json({ error: 'Movement not found' });
      return;
    }

    res.json({ movement: mapMovement(movement, canSeePricing(req)) });
  } catch (err) {
    logger.error('Failed to get movement:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Low-stock view (P5 §1.1) ────────────────────────────────────────────────

// Server-computed per-(item, location) low stock: min set AND on_hand < min.
// Unbounded and authoritative — the client-side header/KPI detection stays
// capped at the FE's 100-item window. No cost fields here at all.
const lowStockQuerySchema = z.object({
  location_id: z.string().uuid().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

function mapLowStockRow(r: any) {
  return {
    itemId: r.item_id,
    sku: r.item?.sku ?? '',
    name: r.item?.name ?? '',
    kind: r.item?.kind ?? undefined,
    status: r.item?.status ?? undefined,
    isActive: !!r.item?.is_active,
    trackInventory: !!r.item?.track_inventory,
    vendorId: r.item?.vendor_id ?? null,
    vendorName: r.item?.vendor?.name ?? null, // vendor NAME — the P2 proposal groups on it
    locationId: r.location_id,
    locationName: r.location?.name ?? '',
    locationType: r.location?.type ?? undefined,
    onHand: Number(r.on_hand),
    min: r.min,
    max: r.max ?? null,
  };
}

// GET /low-stock — Prisma 6.3 cannot compare on_hand (Decimal) to min (Int)
// column-to-column, so fetch the min-configured candidate set (small by
// construction) and filter/paginate in JS — report-controller style.
export async function listLowStock(req: Request, res: Response) {
  try {
    const parsed = lowStockQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
      return;
    }
    const { page, limit, skip } = parsePagination(parsed.data);

    const rows = await prisma.stockBalance.findMany({
      where: {
        ...tenantWhere(req),
        min: { not: null },
        ...(parsed.data.location_id ? { location_id: parsed.data.location_id } : {}),
      },
      include: {
        // Deactivated items stay visible on stock surfaces (QA-105) — no is_active filter.
        item: {
          select: {
            id: true, sku: true, name: true, kind: true, status: true, is_active: true,
            track_inventory: true, vendor_id: true, vendor: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true, type: true } },
      },
    });

    const low = rows
      .filter((r: any) => Number(r.on_hand) < r.min!)
      .sort(
        (a: any, b: any) =>
          (a.location?.name ?? '').localeCompare(b.location?.name ?? '') ||
          (a.item?.name ?? '').localeCompare(b.item?.name ?? ''),
      );

    res.json({
      data: low.slice(skip, skip + limit).map(mapLowStockRow),
      meta: buildPaginationMeta(low.length, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('Failed to list low stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Count adjustment — "Set quantity" (P1 §3.3 / QA-205) ────────────────────

export const setQuantitySchema = z.object({
  item_id: z.string().uuid(),
  location_id: z.string().uuid(),
  counted_qty: z.number().min(0),          // fractional allowed (Decimal ledger); a physical count is never negative
  reason: z.string().max(500).optional(),
});

// POST /api/inventory/stock/set-quantity — "Counted N" → ONE signed `adjust` movement of
// (counted − on_hand). Zero delta ⇒ no movement, no audit (no ledger noise; I-2 holds — no
// mutation happened). Block-mode is EXEMPT (physical truth wins; counted_qty ≥ 0 so the result
// is never negative anyway). The read-then-write inside the tx is an accepted TOCTOU tolerance
// for a human count action — a racing movement between the read and the adjust would skew the
// delta by that movement, which the next count corrects.
// Tenant-scoped item + location resolution shared by the stock-write handlers below.
// Kept local (not the near-identical inv-catalog.controller helper of the same name)
// to avoid an import cycle - inv-catalog already imports applyStockMovement from here.
async function loadItemAndLocation(req: Request, itemId: string, locationId: string) {
  const [item, location] = await Promise.all([
    prisma.priceBookItem.findFirst({ where: { id: itemId, ...tenantWhere(req) }, select: { id: true, sku: true, name: true } }),
    prisma.inventoryLocation.findFirst({ where: { id: locationId, ...tenantWhere(req) }, select: { id: true } }),
  ]);
  return { item, location };
}

export async function setQuantity(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const { item_id, location_id, counted_qty, reason } = req.body as z.infer<typeof setQuantitySchema>;
    const { item, location } = await loadItemAndLocation(req, item_id, location_id);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    if (!location) { res.status(404).json({ error: 'Location not found' }); return; }
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    const { delta, previous } = await prisma.$transaction(async (tx) => {
      const bal = await tx.stockBalance.findUnique({
        where: { item_id_location_id: { item_id, location_id } },
        select: { on_hand: true },
      });
      const prev = bal ? Number(bal.on_hand) : 0;
      const diff = Math.round((counted_qty - prev) * 100) / 100;
      if (diff !== 0) {
        await applyStockMovement(tx, {
          orgId,
          type: 'adjust',
          itemSku: item.sku ?? '',
          itemName: item.name,
          qty: diff,                                   // SIGNED — the one type where qty may be negative (§0.1)
          itemId: item.id,
          toLocationId: location.id,
          unitCost: null,                              // a count is a quantity correction, not a cost event
          actorUserId: req.user!.id,
          reference: reason ? `count: ${reason}` : 'count',
          actor,
        });
      }
      return { delta: diff, previous: prev };
    });

    if (delta !== 0) {
      void logAudit({
        req,
        action: 'inventory.stock_counted',
        resourceType: 'PriceBookItem',
        resourceId: item_id,
        metadata: { location_id, counted_qty, previous_on_hand: previous, delta, ...(reason ? { reason } : {}) },
      });
    }
    res.json({ success: true, on_hand: counted_qty, delta });
  } catch (err) {
    logger.error('Failed to set stock quantity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Reserve levels - per-(item, location) min/max (SRVW-91) ─────────────────

// Absolute set: both columns are always present and both are nullable, so
// "clear the min, keep the max" is { min: null, max: 20 } and there is no
// absent-versus-null ambiguity. min 0 is legal and means "never low".
export const setThresholdsSchema = z
  .object({
    item_id: z.string().uuid(),
    location_id: z.string().uuid(),
    min: z.number().int().min(0).nullable(),
    max: z.number().int().min(0).nullable(),
  })
  .refine((v) => v.min == null || v.max == null || v.max >= v.min, {
    message: 'max must be greater than or equal to min',
    path: ['max'],
  });

// PUT /api/inventory/stock/thresholds - the ONLY writer of StockBalance.min/max.
// TENANCY: @@unique([item_id, location_id]) omits organization_id, so the compound-key
// upsert must never see a user-supplied id. Both ids are resolved through tenantWhere(req)
// first and a miss 404s before any write, which is what makes the upsert below safe (the
// same argument that makes applyStockMovement's addTo upsert safe - server-derived ids).
// A pair with no balance row gets one at on_hand 0 / reserved 0: ledger-neutral (no
// StockMovement, no quantity delta), but the location must exist for its min to mean anything.
export async function setThresholds(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const { item_id, location_id, min, max } = req.body as z.infer<typeof setThresholdsSchema>;
    const { item, location } = await loadItemAndLocation(req, item_id, location_id);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    if (!location) { res.status(404).json({ error: 'Location not found' }); return; }

    const balance = await prisma.stockBalance.upsert({
      where: { item_id_location_id: { item_id: item.id, location_id: location.id } },
      create: { item_id: item.id, location_id: location.id, on_hand: 0, reserved: 0, min, max, organization_id: orgId },
      // min/max ONLY - never on_hand, never reserved (see the invariant note above).
      update: { min, max },
    });

    void logAudit({
      req,
      action: 'inventory.thresholds_set',
      resourceType: 'PriceBookItem',
      resourceId: item.id,
      metadata: { location_id: location.id, min, max },
    });

    res.json({
      success: true,
      item_id: item.id,
      location_id: location.id,
      min: balance.min,
      max: balance.max,
      on_hand: Number(balance.on_hand),
    });
  } catch (err) {
    logger.error('Failed to set stock thresholds:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Stock Approval Handlers ──────────────────────────────────────────────────

export async function listStockApprovals(req: Request, res: Response) {
  try {
    const approvals: any = await prisma.stockApproval.findMany({
      where: tenantWhere(req),
      orderBy: { requested_at: 'desc' },
      include: {
        modifications: { orderBy: { at: 'asc' } },
      },
    });

    res.json({ stockApprovals: approvals.map(mapStockApproval) });
  } catch (err) {
    logger.error('Failed to list stock approvals:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getStockApproval(req: Request, res: Response) {
  try {
    const approval: any = await prisma.stockApproval.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        modifications: { orderBy: { at: 'asc' } },
      },
    });

    if (!approval) {
      res.status(404).json({ error: 'Stock approval not found' });
      return;
    }

    res.json({ stockApproval: mapStockApproval(approval) });
  } catch (err) {
    logger.error('Failed to get stock approval:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createStockApproval(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const b = req.body;

    const approval: any = await prisma.stockApproval.create({
      data: {
        requested_at: new Date(),
        requested_by_tech_id: b.requestedByTechId ?? null,
        requested_by_tech_name: b.requestedByTechName,
        type: b.type,
        item_sku: b.itemSku,
        item_name: b.itemName,
        uom: b.uom,
        qty: b.qty,
        from_location_id: b.fromLocationId ?? null,
        from_location_name: b.fromLocationName,
        to_location_id: b.toLocationId ?? null,
        to_location_name: b.toLocationName ?? null,
        job_id: b.jobId ?? null,
        job_number: b.jobNumber ?? null,
        customer_id: b.customerId ?? null,
        customer: b.customer ?? null,
        reason: b.reason ?? null,
        serial_captured: b.serialCaptured ?? null,
        photo_url: b.photoUrl ?? null,
        status: 'pending',
        organization_id: orgId,
      },
      include: {
        modifications: { orderBy: { at: 'asc' } },
      },
    });

    // inventory.stock_approval_requested — fire after persisting; fire-and-forget, no await.
    emitStockApprovalRequested(
      orgId,
      req.user!.id,
      approval.id,
      approval.item_name,
    );

    res.status(201).json({ stockApproval: mapStockApproval(approval) });
  } catch (err) {
    logger.error('Failed to create stock approval:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /stock-approvals/decide — approve or reject a pending approval.
// (The seam's useDecideApproval posts here rather than to a REST :id route.)
export async function decideStockApproval(req: Request, res: Response) {
  try {
    const { id, decision, reviewedByName, reviewComment } = req.body;

    const existing = await prisma.stockApproval.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Stock approval not found' });
      return;
    }

    if (existing.status !== 'pending') {
      res.status(400).json({ error: 'Stock approval has already been decided' });
      return;
    }

    // updateMany with id+org filter is atomic — no TOCTOU window between the
    // existence/status check and the decision write. On approval, apply the
    // stock side-effect (StockMovement + StockBalance) in the same transaction (V5).
    const orgId = req.user!.organization_id;
    const actor = reviewedByName;
    const approval: any = await prisma.$transaction(async (tx) => {
      const result = await tx.stockApproval.updateMany({
        where: { id, status: 'pending', ...tenantWhere(req) },
        data: {
          status: decision,
          reviewed_at: new Date(),
          reviewed_by_id: req.user!.id,        // P5 reviewer-id capture
          reviewed_by_name: reviewedByName,
          review_comment: reviewComment ?? null,
        },
      });
      if (result.count === 0) return null;

      if (decision === 'approved') {
        const movementType = TYPE_TO_MOVEMENT[existing.type];
        if (movementType) {
          const item = await tx.priceBookItem.findFirst({
            where: { sku: existing.item_sku, ...tenantWhere(req) }, select: { id: true, unit_cost: true },
          });
          await applyStockMovement(tx, {
            orgId, type: movementType,
            itemSku: existing.item_sku, itemName: existing.item_name,
            qty: Number(existing.qty), itemId: item?.id ?? null,
            jobId: existing.job_id ?? null,
            unitCost: item?.unit_cost != null ? Number(item.unit_cost) : null,
            actorUserId: req.user!.id,
            fromLocationId: existing.from_location_id ?? null,
            toLocationId: existing.to_location_id ?? null,
            reference: existing.job_number ?? `approval:${id}`,
            actor,
          });
        }
      }
      // F3: surface the decision on the linked job's central timeline.
      // (Inside the post-Phase-1 $transaction — use tx so it commits atomically.)
      if (existing.job_id) {
        await tx.timelineEvent.create({
          data: {
            organization_id: orgId,
            entity_type: 'JOB', entity_id: existing.job_id,
            event_type: 'STOCK_APPROVAL_DECIDED',
            description: `Stock approval ${decision}: ${existing.item_name} ×${existing.qty}`,
            metadata: { stock_approval_id: id, decision },
            created_by: req.user!.id,
          },
        });
      }
      return tx.stockApproval.findFirst({ where: { id, ...tenantWhere(req) }, include: { modifications: { orderBy: { at: 'asc' } } } });
    });
    if (!approval) { res.status(404).json({ error: 'Stock approval not found' }); return; }
    res.json({ stockApproval: mapStockApproval(approval) });
  } catch (err) {
    logger.error('Failed to decide stock approval:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Logistic Orders — shared engine.
 *
 * Everything that MOVES STOCK for an LO lives here, so there is exactly one implementation of
 * each doctrine rule and every caller (controller, document verbs, service-plan instantiation)
 * inherits it:
 *
 *   • processLogisticOrder — APPROVED -> PROCESSED, one consume movement per line.
 *   • returnProcessedLo    — THE single unwind (spec 14 H1). Every unwind path calls this
 *                            and only this; its compare-and-set makes a multi-anchor
 *                            double-return structurally impossible (E8).
 *   • applyProcessedLineDiff — the PROCESSED line-ops table (spec 14 M5 / plan 2.3).
 *
 * THREE INVARIANTS THIS FILE EXISTS TO HOLD — do not "simplify" past them:
 *
 * 1. TENANCY IS MANUAL. canAccessRow(req, 'LogisticOrder', ...) is NOT a tenancy gate: every
 *    LO-reading role holds an UNCONDITIONAL read LogisticOrder, so scopeWhereFor returns
 *    {} and canAccessRow short-circuits to true WITHOUT running a query — a UUID from
 *    another org passes. Every LO query here therefore spreads tenantWhere(req) (or an
 *    explicit organization_id) into its OWN where clause. See the banner in
 *    lib/permissions/scopeWhereFor.ts.
 *
 * 2. POOL DISCIPLINE (PR #859). All resolution happens on the GLOBAL client BEFORE
 *    $transaction opens; inside the transaction every query uses tx. A global query
 *    while a transaction holds a pooled connection checks out a SECOND connection and dies
 *    with P2024 on a connection-limited deployment. orgBlocksNegativeStock uses the global
 *    client internally — it is pre-tx only, which is why blockNegative is carried on
 *    LoActorContext rather than read on demand.
 *    Regression fence: src/__tests__/inventory-tx-connection-isolation.test.ts.
 *
 * 3. MOVEMENTS GO THROUGH applyStockMovement (spec 14 H2). It owns balance-before-movement
 *    ordering, the block-mode conditional-atomic decrement, low-stock alerts and the ledger
 *    snapshots. Writing stockMovement.create directly from here would silently drop all four.
 */
import type { Request, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantWhere } from './tenant';
import { pickAnchor, allocateAnchoredNumber } from './numbering';
import {
  applyStockMovement,
  orgBlocksNegativeStock,
  resolveItemsById,
  resolveLineStockLocation,
} from '../controllers/inv-stock.controller';

// --- Types -------------------------------------------------------------------

export type LogisticOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSED'
  | 'CANCELLED'
  | 'RETURNED';

/**
 * A logistic_order_lines row as the engine needs it (mirrors SyncedLineForReturn's shape
 * rules). qty is unknown because Prisma hands back a Decimal — normalise at the boundary
 * with Number(), never before.
 *
 * item_sku / item_name are the CREATION-TIME snapshots and outlive a SetNull'd catalog
 * item; that is what lets the 422 name a sku instead of rendering a blank row.
 */
export interface LoLineRow {
  id: string;
  item_id: string | null;
  item_sku: string;
  item_name: string;
  qty: unknown;
  from_location_id: string | null;
  sequence?: number;
}

/**
 * Who is acting, plus the org policy snapshot — all resolved OUTSIDE any transaction
 * (invariant 2). Build it with loActorContext(req, await orgBlocksNegativeStock(orgId)).
 */
export interface LoActorContext {
  orgId: string;
  /** Display snapshot written to StockMovement.actor. */
  actor: string;
  actorUserId: string | null;
  /** organization.block_negative_stock, read pre-tx. */
  blockNegative: boolean;
}

/** Build the actor context. blockNegative must come from a PRE-TRANSACTION read. */
export function loActorContext(req: Request, blockNegative: boolean): LoActorContext {
  return {
    orgId: req.user!.organization_id,
    actor: `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown',
    actorUserId: req.user!.id,
    blockNegative,
  };
}

// --- Errors + HTTP mappers ---------------------------------------------------
//
// There is no error middleware in this codebase — every call site catches manually. These
// mirror shortageResponse / vanRestrictedResponse in inv-stock.controller.ts so the LO
// verbs answer in the same idiom. logisticOrderErrorResponse handles all of them at once.

export interface AggregateShortageDetail {
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationName: string | null;
  /** Total requested across EVERY line pulling this item from this location. */
  requested: number;
  onHand: number;
}

/**
 * Block-mode shortage raised by the ALL-LINES pre-check, before a single movement is written.
 *
 * Distinct from ShortageError (one line, thrown from inside the conditional decrement) on
 * purpose: LO processing is one transaction for all lines, so a first-failure-only error would
 * tell the user about line 3 and stay silent about lines 4 and 5 — degrading the signed
 * per-line contract (E2). ShortageError still backstops the race between the pre-check and
 * the decrement.
 */
export class AggregateShortageError extends Error {
  constructor(public readonly details: AggregateShortageDetail[]) {
    super(
      `Insufficient stock for ${details.length} line${details.length === 1 ? '' : 's'}: ` +
        details
          .map((d) => `${d.itemName} (requested ${d.requested}, available ${d.onHand})`)
          .join('; '),
    );
    this.name = 'AggregateShortageError';
  }
}

/** 409, same error: 'SHORTAGE' code as shortageResponse so one client handler covers both. */
export function aggregateShortageResponse(res: Response, err: AggregateShortageError): void {
  res.status(409).json({
    error: 'SHORTAGE',
    message: err.message,
    details: err.details.map((d) => ({
      item_id: d.itemId,
      item_sku: d.itemSku,
      item_name: d.itemName,
      location_id: d.locationId,
      location_name: d.locationName,
      requested: d.requested,
      available: d.onHand,
    })),
  });
}

export type LoLineIssue =
  | 'NO_LINES'
  | 'MISSING_LOCATION'
  | 'UNKNOWN_LOCATION'
  | 'ITEM_UNAVAILABLE'
  | 'UNKNOWN_LINE'
  // A single line id listed more than once in one PROCESSED edit. Its qty delta would post
  // once per occurrence (two movements) while the row is written once — a silent ledger desync.
  | 'DUPLICATE_LINE';

export interface LoLineValidationDetail {
  /** null only for whole-order issues (NO_LINES) and not-yet-persisted new lines. */
  lineId: string | null;
  itemSku: string | null;
  itemName: string | null;
  reason: LoLineIssue;
  message: string;
}

/**
 * 422 — the LO cannot be processed as it stands. Every bad line is reported at once so the
 * editor can flag them all in one pass.
 *
 * ITEM_UNAVAILABLE is load-bearing rather than cosmetic: applyStockMovement skips ALL
 * balance work when itemId is null but still writes the ledger row, so processing a
 * SetNull'd line would silently record a consumption that deducted nothing.
 */
export class LoLineValidationError extends Error {
  constructor(public readonly details: LoLineValidationDetail[]) {
    super(details.map((d) => d.message).join('; ') || 'Logistic order lines are not processable');
    this.name = 'LoLineValidationError';
  }
}

export function loLineValidationResponse(res: Response, err: LoLineValidationError): void {
  res.status(422).json({
    error: 'LO_LINE_INVALID',
    message: err.message,
    details: err.details.map((d) => ({
      line_id: d.lineId,
      item_sku: d.itemSku,
      item_name: d.itemName,
      reason: d.reason,
      message: d.message,
    })),
  });
}

/**
 * 409 — the LO was not in a status this verb can claim. Raised both pre-transaction (cheap
 * guard) and from the in-transaction compare-and-set (the real one: it closes the TOCTOU
 * window two concurrent Process clicks would otherwise drive a double-deduction through).
 *
 * Deliberately 409 rather than the 404 decideStockApproval answers for the same situation —
 * the row exists and the client is allowed to see it; only its state is stale.
 */
export class LoStatusError extends Error {
  constructor(
    public readonly logisticOrderId: string,
    public readonly expected: LogisticOrderStatus[],
  ) {
    super(`Logistic order is no longer in ${expected.join(' / ')}`);
    this.name = 'LoStatusError';
  }
}

export function loStatusResponse(res: Response, err: LoStatusError): void {
  res.status(409).json({
    error: 'STALE_STATUS',
    message: err.message,
    expected_status: err.expected,
  });
}

/** 404 — no LO with that id IN THIS ORG (see invariant 1: this is the tenancy answer). */
export class LoNotFoundError extends Error {
  constructor(public readonly logisticOrderId: string) {
    super('Logistic order not found');
    this.name = 'LoNotFoundError';
  }
}

export function loNotFoundResponse(res: Response): void {
  res.status(404).json({ error: 'Logistic order not found' });
}

/**
 * 400 — swapping the ITEM on an existing PROCESSED line is refused (spec 14 M5). Allowing it
 * would mean returning item A and consuming item B under one line id, which makes the ledger
 * read as though a single line issued two different products. Delete the line and add a new one.
 */
export class LoItemSwapError extends Error {
  constructor(public readonly lineId: string) {
    super('Cannot change the item on a processed line — remove the line and add a new one');
    this.name = 'LoItemSwapError';
  }
}

export function loItemSwapResponse(res: Response, err: LoItemSwapError): void {
  res.status(400).json({ error: 'ITEM_SWAP_FORBIDDEN', message: err.message, line_id: err.lineId });
}

/**
 * Map any engine error to its canonical response. Returns false when err is not an LO error,
 * so callers keep their own logger.error + 500 tail:
 *
 *   } catch (err) {
 *     if (logisticOrderErrorResponse(res, err)) return;
 *     logger.error('...', err);
 *     res.status(500).json({ error: 'Internal server error' });
 *   }
 *
 * NB: ShortageError from inv-stock.controller.ts is NOT handled here — it is the per-line
 * race backstop and callers already map it via shortageResponse. Keep both in your catch.
 */
export function logisticOrderErrorResponse(res: Response, err: unknown): boolean {
  if (err instanceof AggregateShortageError) {
    aggregateShortageResponse(res, err);
    return true;
  }
  if (err instanceof LoLineValidationError) {
    loLineValidationResponse(res, err);
    return true;
  }
  if (err instanceof LoStatusError) {
    loStatusResponse(res, err);
    return true;
  }
  if (err instanceof LoNotFoundError) {
    loNotFoundResponse(res);
    return true;
  }
  if (err instanceof LoItemSwapError) {
    loItemSwapResponse(res, err);
    return true;
  }
  return false;
}

// --- Shared internals --------------------------------------------------------

interface ConsumeNeed {
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  requested: number;
}

/**
 * Block-mode gate: aggregate every pending consume by (item, location) and compare ONE total
 * against ONE balance, throwing before any movement is written.
 *
 * The aggregation is the point. Two lines pulling the same item from the same location are
 * individually satisfiable but jointly are not; a per-line check would pass both, then the
 * second conditional decrement would blow up mid-loop — a 409 that names one line when two
 * were short, after the first has already moved.
 *
 * Must be called with tx: in the diff path it runs AFTER the return side has posted, so it
 * has to observe the transaction's own uncommitted writes.
 */
async function assertAggregateAvailability(
  tx: Prisma.TransactionClient,
  orgId: string,
  needs: ConsumeNeed[],
  locationNameById: Map<string, string | null>,
): Promise<void> {
  if (needs.length === 0) return;

  const byKey = new Map<string, ConsumeNeed>();
  for (const need of needs) {
    const key = `${need.itemId}::${need.locationId}`;
    const prev = byKey.get(key);
    if (prev) prev.requested += need.requested;
    else byKey.set(key, { ...need });
  }

  const balances = await tx.stockBalance.findMany({
    where: {
      organization_id: orgId,
      OR: [...byKey.values()].map((n) => ({ item_id: n.itemId, location_id: n.locationId })),
    },
    select: { item_id: true, location_id: true, on_hand: true },
  });
  const onHandByKey = new Map(
    balances.map((b) => [`${b.item_id}::${b.location_id}`, Number(b.on_hand)]),
  );

  const details: AggregateShortageDetail[] = [];
  for (const [key, need] of byKey) {
    // A missing balance row is 0 available, exactly as the conditional decrement treats it.
    const onHand = onHandByKey.get(key) ?? 0;
    if (onHand < need.requested) {
      details.push({
        itemId: need.itemId,
        itemSku: need.itemSku,
        itemName: need.itemName,
        locationId: need.locationId,
        locationName: locationNameById.get(need.locationId) ?? null,
        requested: need.requested,
        onHand,
      });
    }
  }
  if (details.length > 0) throw new AggregateShortageError(details);
}

// --- Processing --------------------------------------------------------------

export interface ProcessedLineResult {
  lineId: string;
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  qty: number;
  /** Post-movement on_hand at the source location; null when no balance row was touched. */
  onHandAfter: number | null;
  /** Warn mode only — the location went (or stayed) below zero. Never true in block mode. */
  shortage: boolean;
}

export interface ProcessLogisticOrderResult {
  id: string;
  number: string;
  status: 'PROCESSED';
  processedAt: Date;
  lines: ProcessedLineResult[];
  /** The subset of lines that went negative — the payload the client toasts on. */
  warnings: ProcessedLineResult[];
}

export interface ProcessLogisticOrderOptions {
  /**
   * Statuses the compare-and-set may claim from. Defaults to ['APPROVED'].
   * The fast-forward route (caller holds the approve capability) passes
   * ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] — THE CAPABILITY CHECK IS THE CALLER'S JOB;
   * this option only widens the state machine.
   */
  allowedFromStatuses?: LogisticOrderStatus[];
  /**
   * Fast-forward: also stamp submitted_* / approved_* in the same claim. Only NULL fields
   * are filled — an LO that really was submitted keeps its true submitted_at/by.
   */
  fastForward?: boolean;
}

/**
 * APPROVED -> PROCESSED: deduct every line, all-or-nothing, in one transaction.
 *
 * Pre-transaction (global client): load + tenancy-scope, status guard, negative-stock policy,
 * batch item resolution, org-scope every from_location_id, build the actor string.
 * In-transaction (tx for EVERYTHING): atomic status claim -> block-mode aggregate pre-check ->
 * one applyStockMovement per line.
 *
 * occurred_at is the PROCESSING time (spec 5, settling the old date-axis debate) — that is
 * applyStockMovement's own new Date(), not something this function overrides.
 *
 * Notifications are the CALLER's job and fire AFTER this resolves, never inside the
 * transaction (inventoryEmit pattern).
 *
 * @throws LoNotFoundError 404 · LoStatusError 409 · LoLineValidationError 422 ·
 *         AggregateShortageError 409 · ShortageError 409 (per-line race backstop)
 */
export async function processLogisticOrder(
  db: PrismaClient,
  req: Request,
  loId: string,
  opts: ProcessLogisticOrderOptions = {},
): Promise<ProcessLogisticOrderResult> {
  const orgId = req.user!.organization_id;
  const allowed: LogisticOrderStatus[] = opts.allowedFromStatuses ?? ['APPROVED'];

  // -- PRE-TRANSACTION (global client only — invariant 2) ----------------------
  const lo = await db.logisticOrder.findFirst({
    // tenantWhere is the ONLY thing standing between a cross-org UUID and this deduction.
    where: { id: loId, ...tenantWhere(req) },
    select: {
      id: true,
      number: true,
      status: true,
      job_id: true,
      submitted_at: true,
      submitted_by: true,
      approved_at: true,
      approved_by: true,
      lines: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          item_id: true,
          item_sku: true,
          item_name: true,
          qty: true,
          from_location_id: true,
          sequence: true,
        },
      },
    },
  });
  if (!lo) throw new LoNotFoundError(loId);
  if (!allowed.includes(lo.status as LogisticOrderStatus)) throw new LoStatusError(loId, allowed);

  const blockNegative = await orgBlocksNegativeStock(orgId);

  const items = await resolveItemsById(
    db as unknown as Prisma.TransactionClient,
    orgId,
    lo.lines.map((l) => l.item_id).filter(Boolean) as string[],
  );

  const locationIds = [
    ...new Set(lo.lines.map((l) => l.from_location_id).filter(Boolean) as string[]),
  ];
  const locations = locationIds.length
    ? await db.inventoryLocation.findMany({
        where: { id: { in: locationIds }, ...tenantWhere(req) },
        select: { id: true, name: true },
      })
    : [];
  const locationNameById = new Map<string, string | null>(locations.map((l) => [l.id, l.name]));

  const issues: LoLineValidationDetail[] = [];
  if (lo.lines.length === 0) {
    issues.push({
      lineId: null,
      itemSku: null,
      itemName: null,
      reason: 'NO_LINES',
      message: `${lo.number} has no lines to process`,
    });
  }
  for (const line of lo.lines) {
    const item = line.item_id ? items.get(line.item_id) : undefined;
    if (!item) {
      issues.push({
        lineId: line.id,
        itemSku: line.item_sku,
        itemName: line.item_name,
        reason: 'ITEM_UNAVAILABLE',
        message: `${line.item_sku} is no longer in the catalog — remove the line or re-add the item`,
      });
    }
    if (!line.from_location_id) {
      issues.push({
        lineId: line.id,
        itemSku: line.item_sku,
        itemName: line.item_name,
        reason: 'MISSING_LOCATION',
        message: `${line.item_sku} has no source location`,
      });
    } else if (!locationNameById.has(line.from_location_id)) {
      issues.push({
        lineId: line.id,
        itemSku: line.item_sku,
        itemName: line.item_name,
        reason: 'UNKNOWN_LOCATION',
        message: `${line.item_sku} points at a location that no longer exists in this organization`,
      });
    }
  }
  if (issues.length > 0) throw new LoLineValidationError(issues);

  const actor = loActorContext(req, blockNegative);

  // -- TRANSACTION (tx client for EVERYTHING — invariant 2) --------------------
  return db.$transaction(async (tx) => {
    const now = new Date();

    // Atomic status claim. updateMany filtered on id + status + org is the whole
    // concurrency story: two simultaneous Process clicks both reach here, the first flips
    // the row, the second matches 0 rows and 409s having deducted nothing.
    const claim = await tx.logisticOrder.updateMany({
      where: { id: loId, status: { in: allowed }, ...tenantWhere(req) },
      data: {
        status: 'PROCESSED',
        processed_at: now,
        processed_by: actor.actorUserId,
        ...(opts.fastForward
          ? {
              // Fill only what is still NULL: a genuinely submitted LO keeps its real trail.
              submitted_at: lo.submitted_at ?? now,
              submitted_by: lo.submitted_by ?? actor.actorUserId,
              approved_at: lo.approved_at ?? now,
              approved_by: lo.approved_by ?? actor.actorUserId,
            }
          : {}),
      },
    });
    if (claim.count === 0) throw new LoStatusError(loId, allowed);

    if (actor.blockNegative) {
      await assertAggregateAvailability(
        tx,
        orgId,
        lo.lines.map((line) => {
          const item = items.get(line.item_id!)!;
          return {
            itemId: item.id,
            itemSku: item.sku,
            itemName: item.name,
            locationId: line.from_location_id!,
            requested: Number(line.qty),
          };
        }),
        locationNameById,
      );
    }

    const results: ProcessedLineResult[] = [];
    for (const line of lo.lines) {
      const item = items.get(line.item_id!)!;
      const qty = Number(line.qty);
      const moved = await applyStockMovement(tx, {
        orgId,
        type: 'consume',
        itemSku: item.sku,
        itemName: item.name,
        qty,
        itemId: item.id,
        // The LO's job anchor is what keeps job attribution alive in the usage report.
        jobId: lo.job_id ?? null,
        logisticOrderId: lo.id,
        logisticOrderLineId: line.id,
        unitCost: item.unitCost,
        actorUserId: actor.actorUserId,
        fromLocationId: line.from_location_id,
        blockNegative: actor.blockNegative,
        reference: lo.number,
        actor: actor.actor,
      });
      results.push({
        lineId: line.id,
        itemId: item.id,
        itemSku: item.sku,
        itemName: item.name,
        locationId: line.from_location_id!,
        qty,
        onHandAfter: moved.onHandAfter,
        shortage: moved.shortage,
      });
    }

    return {
      id: lo.id,
      number: lo.number,
      status: 'PROCESSED' as const,
      processedAt: now,
      lines: results,
      warnings: results.filter((r) => r.shortage),
    };
  });
}

// --- Unwind ------------------------------------------------------------------

/**
 * Everything returnProcessedLo needs, assembled by the caller. actor / actorUserId
 * describe who is performing the UNWIND (the cancelling / voiding user), not who processed it.
 */
export interface LoUnwindInput {
  id: string;
  number: string;
  organization_id: string;
  /** The LO's job anchor, stamped onto the return movements. */
  job_id: string | null;
  lines: LoLineRow[];
  actor: string;
  actorUserId?: string | null;
}

/**
 * THE single unwind (spec 14 H1): PROCESSED -> RETURNED plus one return movement per line.
 *
 * EVERY unwind path in the codebase must call this and ONLY this — job cancel, job delete,
 * invoice void, invoice DRAFT delete, LO delete. The compare-and-set is why: a multi-anchor LO
 * (job AND invoice) is reachable twice inside one job-cancel transaction, once via the
 * cascade-voided invoice and once via the job pass. The second call matches 0 rows and returns
 * 0 without writing anything, so double-return is structurally impossible rather than a rule
 * every call site has to remember (E8).
 *
 * Must run BEFORE the anchor row is deleted: the movement's logistic_order_line_id FK has to
 * exist at insert, and SetNull then preserves the ledger row afterwards.
 *
 * RETURNED and CANCELLED are different terminal states on purpose — RETURNED means
 * "deducted, then unwound", CANCELLED means "never deducted". Moving OPEN LOs to CANCELLED is
 * the caller's job; this function only handles the deducted case.
 *
 * @returns the number of movement rows written; 0 means the CAS no-oped (already unwound).
 */
export async function returnProcessedLo(
  tx: Prisma.TransactionClient,
  lo: LoUnwindInput,
): Promise<number> {
  const claim = await tx.logisticOrder.updateMany({
    where: { id: lo.id, status: 'PROCESSED', organization_id: lo.organization_id },
    data: { status: 'RETURNED' },
  });
  if (claim.count === 0) return 0;

  const items = await resolveItemsById(
    tx,
    lo.organization_id,
    lo.lines.map((l) => l.item_id).filter(Boolean) as string[],
  );

  // Read the org default at most once, and only if some line lost its location.
  let fallback: string | null | undefined;
  let written = 0;
  for (const line of lo.lines) {
    const item = line.item_id ? items.get(line.item_id) : undefined;
    // Hard-deleted catalog ref: there is no balance to credit. The LO row still flips to
    // RETURNED — the status describes the document, not how many rows we could write.
    if (!item) continue;

    let toLocationId = line.from_location_id;
    let reference = `${lo.number} returned`;
    if (!toLocationId) {
      if (fallback === undefined) {
        fallback = (await resolveLineStockLocation(tx, lo.organization_id, null)).locationId;
      }
      toLocationId = fallback;
      reference = `${reference} (original location deleted)`;
    }

    // Returns are additions — never blocked, so no blockNegative here by design.
    await applyStockMovement(tx, {
      orgId: lo.organization_id,
      type: 'return',
      itemSku: item.sku,
      itemName: item.name,
      qty: Number(line.qty),
      itemId: item.id,
      jobId: lo.job_id ?? null,
      logisticOrderId: lo.id,
      logisticOrderLineId: line.id,
      unitCost: item.unitCost,
      actorUserId: lo.actorUserId ?? null,
      toLocationId,
      reference,
      actor: lo.actor,
    });
    written++;
  }
  return written;
}

// --- Anchored-entity unwind (spec §14 C1 — document-verb integration) --------
//
// The unwind that job cancel / job delete / invoice void / invoice DRAFT-delete owe to the LOs
// anchored to the document they are destroying. Split into two halves on purpose:
//
//   collectAnchoredLoUnwind  — GLOBAL client, resolves WHICH LOs unwind, BEFORE the tx opens.
//   applyAnchoredLoUnwind    — tx client, performs the unwind INSIDE the caller's tx.
//
// The split is the pool-starvation discipline (PR #859): the read is resolution, and resolution
// never runs inside the transaction. The document verbs already hold an open $transaction, so
// their controllers call collect BEFORE opening it and apply INSIDE it. The staleness that a
// pre-tx read introduces is absorbed by returnProcessedLo's compare-and-set (a PROCESSED LO that
// flipped to RETURNED in the window is a CAS no-op) and by the status-filtered CANCELLED update
// (an open LO that advanced is simply not re-cancelled).

const OPEN_LO_STATUSES: LogisticOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

/**
 * The resolved unwind, produced pre-tx. `processed` deliberately KEEPS DUPLICATES: a multi-anchor
 * LO surfaced by more than one clause (job AND a cascade-voided invoice) is enqueued once per
 * clause, and returnProcessedLo's CAS collapses the redundant return to a no-op. Single-return is
 * therefore guaranteed by the CAS, never by pre-dedup (spec §14 H1 / E8).
 */
export interface AnchoredLoUnwindPlan {
  orgId: string;
  processed: LoUnwindInput[];
  openLoIds: string[];
}

export interface CollectAnchoredLoOptions {
  orgId: string;
  /** One or more anchor filters, e.g. [{ job_id }, { invoice_id: { in } }]. Each is queried
   *  separately — a multi-anchor LO is intentionally NOT de-duplicated across clauses. */
  where: Prisma.LogisticOrderWhereInput | Prisma.LogisticOrderWhereInput[];
  actor: string;
  actorUserId?: string | null;
}

/**
 * Resolve the LOs anchored to a document being cancelled/voided/deleted. GLOBAL client only —
 * call BEFORE opening the caller's transaction (invariant 2). organization_id is the ONLY tenancy
 * gate (invariant 1), spread into every clause.
 */
export async function collectAnchoredLoUnwind(
  db: PrismaClient,
  opts: CollectAnchoredLoOptions,
): Promise<AnchoredLoUnwindPlan> {
  const clauses = Array.isArray(opts.where) ? opts.where : [opts.where];
  const processed: LoUnwindInput[] = [];
  const openLoIds = new Set<string>();

  for (const clause of clauses) {
    const los = await db.logisticOrder.findMany({
      where: { ...clause, organization_id: opts.orgId },
      select: {
        id: true,
        number: true,
        status: true,
        job_id: true,
        organization_id: true,
        lines: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            item_id: true,
            item_sku: true,
            item_name: true,
            qty: true,
            from_location_id: true,
            sequence: true,
          },
        },
      },
    });
    for (const lo of los) {
      if (lo.status === 'PROCESSED') {
        processed.push({
          id: lo.id,
          number: lo.number,
          organization_id: lo.organization_id,
          job_id: lo.job_id,
          lines: lo.lines,
          actor: opts.actor,
          actorUserId: opts.actorUserId ?? null,
        });
      } else if (OPEN_LO_STATUSES.includes(lo.status as LogisticOrderStatus)) {
        openLoIds.add(lo.id);
      }
    }
  }

  return { orgId: opts.orgId, processed, openLoIds: [...openLoIds] };
}

export interface AnchoredLoUnwindResult {
  /** LOs that actually returned stock (a CAS no-op is excluded). */
  returnedLoIds: string[];
  cancelledLoIds: string[];
  movementsWritten: number;
}

/**
 * Apply a pre-resolved plan INSIDE the caller's transaction (tx client for every write). PROCESSED
 * LOs are unwound through returnProcessedLo — the ONLY unwind path (spec §14 H1); its CAS collapses
 * the duplicate a multi-anchor LO produces into a single set of return movements (E8). Open LOs are
 * CANCELLED only when `cancelOpen` is set — job verbs cancel them; invoice verbs leave them alone
 * as still-valid intent (spec §14 C1).
 *
 * Must run BEFORE the caller deletes the anchor row: the return movement's logistic_order_line_id
 * FK has to exist at insert, and SetNull then keeps the ledger row afterwards.
 *
 * An EMPTY plan touches no logistic-order delegate at all — a document with no materials order
 * costs nothing and needs no extra tx surface.
 */
export async function applyAnchoredLoUnwind(
  tx: Prisma.TransactionClient,
  plan: AnchoredLoUnwindPlan,
  opts: { cancelOpen: boolean },
): Promise<AnchoredLoUnwindResult> {
  let movementsWritten = 0;
  const returnedLoIds: string[] = [];
  for (const lo of plan.processed) {
    const written = await returnProcessedLo(tx, lo);
    if (written > 0) {
      movementsWritten += written;
      returnedLoIds.push(lo.id);
    }
  }

  let cancelledLoIds: string[] = [];
  if (opts.cancelOpen && plan.openLoIds.length > 0) {
    const cancelled = await tx.logisticOrder.updateMany({
      where: {
        id: { in: plan.openLoIds },
        status: { in: OPEN_LO_STATUSES },
        organization_id: plan.orgId,
      },
      data: { status: 'CANCELLED', cancelled_at: new Date() },
    });
    if (cancelled.count > 0) cancelledLoIds = plan.openLoIds;
  }

  return { returnedLoIds, cancelledLoIds, movementsWritten };
}

// --- PROCESSED line-ops diff -------------------------------------------------

/** The LO being edited, as applyProcessedLineDiff needs it. Org comes from the actor context. */
export interface ProcessedLoForDiff {
  id: string;
  number: string;
  job_id: string | null;
  /** The CURRENT persisted lines — the left-hand side of the diff. */
  lines: LoLineRow[];
}

/** One line of the PATCH payload. id present = existing line; absent = new line. */
export interface IncomingLoLine {
  id?: string | null;
  item_id: string;
  qty: number;
  from_location_id: string | null;
  sequence?: number;
}

export interface LoDiffMovement {
  lineId: string;
  type: 'consume' | 'return';
  itemId: string;
  locationId: string;
  qty: number;
  onHandAfter: number | null;
  shortage: boolean;
}

export interface LoLineDiffResult {
  createdLineIds: string[];
  updatedLineIds: string[];
  removedLineIds: string[];
  /** Every movement posted, in write order (returns first, then consumes). */
  movements: LoDiffMovement[];
}

/**
 * Editing a PROCESSED LO auto-posts the stock delta (spec 5 / 14 M5). Statuses gate the
 * deduction EVENT, not editability.
 *
 *   qty increase                    -> consume the delta
 *   qty decrease                    -> return the delta
 *   remove line                     -> return the full qty, then delete the row
 *   add line                        -> create the row, then consume the full qty
 *   location change                 -> return to the old location, consume from the new
 *   item swap on an existing line   -> 400 LoItemSwapError (delete + re-add instead)
 *
 * ORDER IS DELIBERATE — returns post first, then the block-mode gate runs, then consumes.
 * Reversing that would make a net-neutral edit (drop 4 at Main, add 4 at Main) false-trip the
 * shortage gate on a location that ends the edit exactly where it started.
 *
 * Movement FK ordering is equally deliberate: the return for a removed line is written BEFORE
 * deleteMany (the FK must exist at insert; SetNull preserves the ledger row after), and a new
 * line's row is created BEFORE its consume.
 *
 * Caller supplies tx; every query here uses it. Item resolution is a tx query, not a global
 * one — that is the pool-safe form when you are already inside a transaction.
 *
 * @throws LoItemSwapError 400 · LoLineValidationError 422 · AggregateShortageError 409
 */
export async function applyProcessedLineDiff(
  tx: Prisma.TransactionClient,
  lo: ProcessedLoForDiff,
  incomingLines: IncomingLoLine[],
  actor: LoActorContext,
): Promise<LoLineDiffResult> {
  const existingById = new Map(lo.lines.map((l) => [l.id, l]));

  // -- Reject a payload that names the same existing line id twice ------------
  // The diff keys each existing line's qty delta off its ORIGINAL persisted qty, so a repeated
  // id computes and posts that delta once per occurrence — two stock movements against a row
  // written once, silently desyncing the ledger. Each id must appear at most once. This is a
  // pure in-memory scan at the very top: it throws before item resolution or any tx write, so a
  // duplicate never moves stock. (The HTTP path also rejects this at the zod schema; this is the
  // engine-level backstop for every direct caller.)
  const seenLineIds = new Set<string>();
  const duplicateIssues: LoLineValidationDetail[] = [];
  const reportedDuplicateIds = new Set<string>();
  for (const incoming of incomingLines) {
    if (!incoming.id) continue;
    if (seenLineIds.has(incoming.id)) {
      if (!reportedDuplicateIds.has(incoming.id)) {
        const existing = existingById.get(incoming.id);
        duplicateIssues.push({
          lineId: incoming.id,
          itemSku: existing?.item_sku ?? null,
          itemName: existing?.item_name ?? null,
          reason: 'DUPLICATE_LINE',
          message: `Line ${incoming.id} appears more than once in this edit`,
        });
        reportedDuplicateIds.add(incoming.id);
      }
    } else {
      seenLineIds.add(incoming.id);
    }
  }
  if (duplicateIssues.length > 0) throw new LoLineValidationError(duplicateIssues);

  // -- Validate the whole payload before touching anything --------------------
  const issues: LoLineValidationDetail[] = [];
  for (const incoming of incomingLines) {
    if (!incoming.id) continue;
    const existing = existingById.get(incoming.id);
    if (!existing) {
      issues.push({
        lineId: incoming.id,
        itemSku: null,
        itemName: null,
        reason: 'UNKNOWN_LINE',
        message: `Line ${incoming.id} does not belong to ${lo.number}`,
      });
      continue;
    }
    if (existing.item_id !== incoming.item_id) throw new LoItemSwapError(incoming.id);
  }
  if (issues.length > 0) throw new LoLineValidationError(issues);

  const items = await resolveItemsById(tx, actor.orgId, [
    ...(lo.lines.map((l) => l.item_id).filter(Boolean) as string[]),
    ...incomingLines.map((l) => l.item_id),
  ]);

  const incomingIds = new Set(incomingLines.map((l) => l.id).filter(Boolean) as string[]);
  const removed = lo.lines.filter((l) => !incomingIds.has(l.id));

  interface ReturnOp {
    line: LoLineRow;
    qty: number;
    toLocationId: string | null;
  }
  interface ConsumeOp {
    lineId: string | null;
    incoming: IncomingLoLine;
    qty: number;
  }

  const returns: ReturnOp[] = [];
  const consumes: ConsumeOp[] = [];
  const updatedLineIds: string[] = [];

  for (const line of removed) {
    returns.push({ line, qty: Number(line.qty), toLocationId: line.from_location_id });
  }

  for (const incoming of incomingLines) {
    if (!incoming.id) {
      const item = items.get(incoming.item_id);
      if (!item) {
        issues.push({
          lineId: null,
          itemSku: null,
          itemName: null,
          reason: 'ITEM_UNAVAILABLE',
          message: `Item ${incoming.item_id} is not in this organization's catalog`,
        });
        continue;
      }
      if (!incoming.from_location_id) {
        issues.push({
          lineId: null,
          itemSku: item.sku,
          itemName: item.name,
          reason: 'MISSING_LOCATION',
          message: `${item.sku} has no source location`,
        });
        continue;
      }
      consumes.push({ lineId: null, incoming, qty: incoming.qty });
      continue;
    }

    const existing = existingById.get(incoming.id)!;
    const prevQty = Number(existing.qty);
    const locationChanged =
      (existing.from_location_id ?? null) !== (incoming.from_location_id ?? null);

    if (locationChanged) {
      if (!incoming.from_location_id) {
        issues.push({
          lineId: incoming.id,
          itemSku: existing.item_sku,
          itemName: existing.item_name,
          reason: 'MISSING_LOCATION',
          message: `${existing.item_sku} has no source location`,
        });
        continue;
      }
      // Full unwind at the old location, full re-issue at the new one — a partial delta
      // across two locations would leave both balances wrong.
      returns.push({ line: existing, qty: prevQty, toLocationId: existing.from_location_id });
      consumes.push({ lineId: existing.id, incoming, qty: incoming.qty });
      updatedLineIds.push(existing.id);
      continue;
    }

    const delta = incoming.qty - prevQty;
    if (delta > 0) consumes.push({ lineId: existing.id, incoming, qty: delta });
    else if (delta < 0) {
      returns.push({ line: existing, qty: -delta, toLocationId: existing.from_location_id });
    }
    if (delta !== 0) updatedLineIds.push(existing.id);
  }
  if (issues.length > 0) throw new LoLineValidationError(issues);

  const movements: LoDiffMovement[] = [];
  let fallback: string | null | undefined;

  // -- 1. Returns first (see ORDER IS DELIBERATE above) -----------------------
  for (const op of returns) {
    const item = op.line.item_id ? items.get(op.line.item_id) : undefined;
    if (!item) continue; // hard-deleted catalog ref: nothing to credit

    let toLocationId = op.toLocationId;
    let reference = `${lo.number} edited`;
    if (!toLocationId) {
      if (fallback === undefined) {
        fallback = (await resolveLineStockLocation(tx, actor.orgId, null)).locationId;
      }
      toLocationId = fallback;
      reference = `${reference} (original location deleted)`;
    }

    const moved = await applyStockMovement(tx, {
      orgId: actor.orgId,
      type: 'return',
      itemSku: item.sku,
      itemName: item.name,
      qty: op.qty,
      itemId: item.id,
      jobId: lo.job_id ?? null,
      logisticOrderId: lo.id,
      logisticOrderLineId: op.line.id,
      unitCost: item.unitCost,
      actorUserId: actor.actorUserId,
      toLocationId,
      reference,
      actor: actor.actor,
    });
    movements.push({
      lineId: op.line.id,
      type: 'return',
      itemId: item.id,
      locationId: toLocationId ?? '',
      qty: op.qty,
      onHandAfter: moved.onHandAfter,
      shortage: moved.shortage,
    });
  }

  // -- 2. Row writes: removals (after their returns), updates, then creations -
  const removedLineIds = removed.map((l) => l.id);
  if (removedLineIds.length > 0) {
    await tx.logisticOrderLine.deleteMany({
      where: { id: { in: removedLineIds }, logistic_order_id: lo.id },
    });
  }

  for (let i = 0; i < incomingLines.length; i++) {
    const incoming = incomingLines[i];
    if (!incoming.id) continue;
    await tx.logisticOrderLine.update({
      where: { id: incoming.id },
      data: {
        qty: incoming.qty,
        from_location_id: incoming.from_location_id,
        sequence: incoming.sequence ?? i,
      },
    });
  }

  const createdLineIds: string[] = [];
  for (const op of consumes) {
    if (op.lineId) continue;
    const item = items.get(op.incoming.item_id)!;
    const created = await tx.logisticOrderLine.create({
      data: {
        logistic_order_id: lo.id,
        organization_id: actor.orgId,
        item_id: item.id,
        item_sku: item.sku,
        item_name: item.name,
        qty: op.incoming.qty,
        from_location_id: op.incoming.from_location_id,
        sequence: op.incoming.sequence ?? incomingLines.indexOf(op.incoming),
      },
      select: { id: true },
    });
    op.lineId = created.id;
    createdLineIds.push(created.id);
  }

  // -- 3. Block-mode gate, reading balances that ALREADY include the returns --
  if (actor.blockNegative && consumes.length > 0) {
    const locationIds = [
      ...new Set(consumes.map((op) => op.incoming.from_location_id).filter(Boolean) as string[]),
    ];
    const locations = locationIds.length
      ? await tx.inventoryLocation.findMany({
          where: { id: { in: locationIds }, organization_id: actor.orgId },
          select: { id: true, name: true },
        })
      : [];
    await assertAggregateAvailability(
      tx,
      actor.orgId,
      consumes.map((op) => {
        const item = items.get(op.incoming.item_id)!;
        return {
          itemId: item.id,
          itemSku: item.sku,
          itemName: item.name,
          locationId: op.incoming.from_location_id!,
          requested: op.qty,
        };
      }),
      new Map(locations.map((l) => [l.id, l.name as string | null])),
    );
  }

  // -- 4. Consumes ------------------------------------------------------------
  for (const op of consumes) {
    const item = items.get(op.incoming.item_id)!;
    const moved = await applyStockMovement(tx, {
      orgId: actor.orgId,
      type: 'consume',
      itemSku: item.sku,
      itemName: item.name,
      qty: op.qty,
      itemId: item.id,
      jobId: lo.job_id ?? null,
      logisticOrderId: lo.id,
      logisticOrderLineId: op.lineId,
      unitCost: item.unitCost,
      actorUserId: actor.actorUserId,
      fromLocationId: op.incoming.from_location_id,
      blockNegative: actor.blockNegative,
      reference: `${lo.number} edited`,
      actor: actor.actor,
    });
    movements.push({
      lineId: op.lineId!,
      type: 'consume',
      itemId: item.id,
      locationId: op.incoming.from_location_id!,
      qty: op.qty,
      onHandAfter: moved.onHandAfter,
      shortage: moved.shortage,
    });
  }

  return { createdLineIds, updatedLineIds, removedLineIds, movements };
}

// --- Service-plan materials instantiation (spec §15 / plan §5) ---------------

/**
 * A service_plan_material_lines row as instantiatePlanMaterials needs it. qty is unknown because
 * Prisma hands back a Decimal — normalise with Number() at the boundary, never before. item_sku /
 * item_name are the template snapshots; they outlive a SetNull'd item and name the dead line in the
 * LO's notes.
 */
export interface PlanMaterialLineRow {
  item_id: string | null;
  item_sku: string;
  item_name: string;
  qty: unknown;
}

/** The plan as instantiatePlanMaterials needs it: its number + org + material template. */
export interface PlanForMaterials {
  id: string;
  service_plan_number: string;
  organization_id: string;
  material_lines: PlanMaterialLineRow[];
}

/** The visit job the materials LO anchors to. Only id is needed to mint + link; job_number is read
 *  off the locked jobs row by the allocator itself. */
export interface JobForMaterials {
  id: string;
  job_number?: string;
}

/**
 * Mint the DRAFT LogisticOrder a plan visit inherits from its materials template (spec §15).
 *
 * No template lines → no-op (returns null), NO LO minted. Otherwise ONE DRAFT LO, anchored to BOTH
 * the visit job and the plan: the job wins the number via pickAnchor → `LO-J…-n`, and the
 * service_plan anchor is a plain link enabling per-plan materials reporting later. Lines carry the
 * sku/name snapshot + qty with from_location_id NULL (the editor fills it from the default chain at
 * process time). Never auto-processed — DRAFT only; stock moves at Process, not when a visit lands
 * on the calendar (deduct-at-issue doctrine).
 *
 * DEAD CATALOG REFS: a template line whose item_id was SetNull'd, or no longer resolves to a tracked
 * in-org item, is SKIPPED and its snapshot sku named in the LO's notes. This function never throws —
 * a bad template line must not abort visit scheduling.
 *
 * Runs INSIDE the caller's scheduleVisit transaction: every query uses `tx`, and the anchored number
 * is minted with allocateAnchoredNumber as part of the same tx (the anchor row-lock is held to
 * commit, so a scheduleVisit failure rolls the LO back with the job + visit). The future
 * auto-generation cron calls this same function.
 */
export async function instantiatePlanMaterials(
  tx: Prisma.TransactionClient,
  plan: PlanForMaterials,
  job: JobForMaterials,
  actorUserId: string,
): Promise<{ id: string; number: string } | null> {
  if (plan.material_lines.length === 0) return null;

  // Liveness: resolve every non-null template item to a tracked in-org catalog item. A line whose
  // item_id is null (SetNull'd) or absent from this set is a dead reference (mirrors the LO
  // add-time rule — item must exist AND be track_inventory: true, validateAndSnapshotLines).
  const itemIds = [...new Set(plan.material_lines.map((l) => l.item_id).filter(Boolean) as string[])];
  const liveItems = itemIds.length
    ? await tx.priceBookItem.findMany({
        where: { id: { in: itemIds }, organization_id: plan.organization_id, track_inventory: true },
        select: { id: true, sku: true, name: true },
      })
    : [];
  const liveById = new Map(liveItems.map((i) => [i.id, i]));

  const lines: {
    organization_id: string;
    item_id: string;
    item_sku: string;
    item_name: string;
    qty: number;
    from_location_id: null;
    sequence: number;
  }[] = [];
  const deadSkus: string[] = [];
  for (const ml of plan.material_lines) {
    const live = ml.item_id ? liveById.get(ml.item_id) : undefined;
    if (!live) {
      deadSkus.push(ml.item_sku);
      continue;
    }
    lines.push({
      organization_id: plan.organization_id,
      item_id: live.id,
      item_sku: live.sku ?? ml.item_sku,
      item_name: live.name,
      qty: Number(ml.qty),
      from_location_id: null,
      sequence: lines.length,
    });
  }

  let notes = `Materials from service plan ${plan.service_plan_number}`;
  if (deadSkus.length > 0) {
    notes +=
      `\nSkipped ${deadSkus.length} line${deadSkus.length === 1 ? '' : 's'} ` +
      `whose item is no longer in the catalog: ${deadSkus.join(', ')}`;
  }

  // Anchored numbering — job wins precedence even though service_plan is also anchored. pickAnchor
  // never returns null here (the job is always present); the non-null assertion documents that.
  const picked = pickAnchor({ job_id: job.id, service_plan_id: plan.id })!;
  const { number, seq } = await allocateAnchoredNumber(tx, {
    organizationId: plan.organization_id,
    anchorTable: picked.table,
    anchorColumn: picked.column,
    anchorId: picked.id,
  });

  const created = await tx.logisticOrder.create({
    data: {
      number,
      seq,
      status: 'DRAFT',
      job_id: job.id,
      service_plan_id: plan.id,
      notes,
      created_by: actorUserId,
      organization_id: plan.organization_id,
      lines: { create: lines },
    },
    select: { id: true, number: true },
  });
  return created;
}

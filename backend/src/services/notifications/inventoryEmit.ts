/**
 * inventoryEmit.ts — thin emit helpers for inventory notification verbs
 *
 * Each function is a fire-and-forget wrapper over `emit` from notificationService.
 * NEVER throws — emit() itself swallows all errors. Callers must NOT wrap these
 * in try/catch.
 *
 * Verbs:
 *   inventory.stock_approval_requested  — stock approval pending admin review
 *   inventory.low_stock                 — on_hand crosses below min (per location, daily dedupKey)
 *   inventory.po_partial                — PO partially received
 *   inventory.backorder                 — item status flipped TO on_backorder
 *   inventory.staging_ready             — job stage set to ready_for_pickup
 *   inventory.staging_no_area           — stage is complete/ready_for_pickup with no staged_area
 */

import { emit } from './notificationService';

// ─── shared ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD in UTC — used for the daily low_stock dedupKey. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── verb helpers ─────────────────────────────────────────────────────────────

/**
 * inventory.stock_approval_requested
 * Fire after the StockApproval row is persisted.
 * Recipients: Admin INTERRUPT + needs_action (APPROVE_STOCK).
 * data.approval_id is needed by the inline action button on the notification.
 */
export function emitStockApprovalRequested(
  organizationId: string,
  actorId: string,
  approvalId: string,
  itemName: string,
): void {
  emit({
    verb: 'inventory.stock_approval_requested',
    organizationId,
    actorId,
    object: { type: 'STOCK_APPROVAL', id: approvalId, label: itemName },
    entity: {},
    data: { item_name: itemName, approval_id: approvalId },
    dedupKey: `inventory.stock_approval_requested:${approvalId}`,
  });
}

/**
 * inventory.low_stock
 * Fire only on a DOWNWARD CROSSING: prevOnHand >= min AND newOnHand < min.
 * actorId is null (system-detected).
 * dedupKey is daily — re-fires each new calendar day (UTC).
 */
export function emitLowStockIfCrossing(
  organizationId: string,
  itemId: string,
  itemName: string,
  locationId: string,
  newOnHand: number,
  delta: number,   // the signed increment applied; negative = consumption (subtract from stock)
  min: number | null | undefined,
): void {
  if (min == null) return;
  // A downward crossing only happens on consumption (negative delta). A restock/no-op
  // (delta >= 0) can never cross from >= min to < min, and guards against a caller
  // passing the wrong sign.
  if (delta >= 0) return;
  const prevOnHand = newOnHand - delta;
  const crossed = prevOnHand >= min && newOnHand < min;
  if (!crossed) return;

  emit({
    verb: 'inventory.low_stock',
    organizationId,
    actorId: null,
    object: { type: 'INVENTORY_ITEM', id: itemId, label: itemName },
    entity: {},
    data: { item_name: itemName, location_id: locationId, on_hand: newOnHand, min },
    dedupKey: `inventory.low_stock:${itemId}:${locationId}:${todayUtc()}`,
  });
}

/**
 * inventory.po_partial
 * Fire when the PO status resolves to 'partial' after a receipt.
 * Recipients: Admin + Dispatcher FEED.
 */
export function emitPoPartial(
  organizationId: string,
  actorId: string,
  poId: string,
  poNumber: string,
): void {
  emit({
    verb: 'inventory.po_partial',
    organizationId,
    actorId,
    object: { type: 'PURCHASE_ORDER', id: poId, label: poNumber },
    entity: {},
    data: { object_label: poNumber },
    dedupKey: `inventory.po_partial:${poId}`,
  });
}

/**
 * inventory.backorder
 * Fire when an item's status flips TO 'on_backorder'.
 * On create-with-backorder, prevStatus is undefined/null — also a flip.
 * Recipients: Admin + Dispatcher FEED.
 */
export function emitBackorderIfFlipped(
  organizationId: string,
  actorId: string,
  itemId: string,
  itemName: string,
  prevStatus: string | null | undefined,
  newStatus: string | null | undefined,
): void {
  const wasBackorder = prevStatus === 'on_backorder';
  const isBackorder = newStatus === 'on_backorder';
  if (!isBackorder || wasBackorder) return;

  emit({
    verb: 'inventory.backorder',
    organizationId,
    actorId,
    object: { type: 'INVENTORY_ITEM', id: itemId, label: itemName },
    entity: {},
    data: { item_name: itemName },
    dedupKey: `inventory.backorder:${itemId}`,
  });
}

/**
 * inventory.staging_ready
 * Fire after notifyTechReady sets status to ready_for_pickup.
 * Recipients: Admin + Dispatcher FEED, plus the assigned tech INTERRUPT (if any).
 */
export function emitStagingReady(
  organizationId: string,
  actorId: string,
  stageId: string,
  jobNumber: string,
  assigneeUserId?: string | null,
): void {
  emit({
    verb: 'inventory.staging_ready',
    organizationId,
    actorId,
    object: { type: 'JOB_STAGE', id: stageId, label: jobNumber },
    // The assigned tech (if any) is added as a recipient in resolveRecipients so
    // they get the in-app alert too — not just Admin + Dispatcher.
    entity: assigneeUserId ? { assignee_ids: [assigneeUserId] } : {},
    data: { object_label: jobNumber },
    dedupKey: `inventory.staging_ready:${stageId}`,
  });
}

/**
 * inventory.staging_no_area
 * Fire when a stage write sets status to complete or ready_for_pickup AND staged_area is null.
 * Dismissible; no auto-clear v1.
 * Recipients: Admin + Dispatcher FEED.
 */
export function emitStagingNoAreaIfNeeded(
  organizationId: string,
  actorId: string,
  stageId: string,
  jobNumber: string,
  status: string,
  stagedArea: string | null | undefined,
): void {
  const triggerStatuses = new Set(['complete', 'ready_for_pickup']);
  if (!triggerStatuses.has(status)) return;
  if (stagedArea != null && stagedArea !== '') return;

  emit({
    verb: 'inventory.staging_no_area',
    organizationId,
    actorId,
    object: { type: 'JOB_STAGE', id: stageId, label: jobNumber },
    entity: {},
    data: { object_label: jobNumber },
    dedupKey: `inventory.staging_no_area:${stageId}`,
  });
}

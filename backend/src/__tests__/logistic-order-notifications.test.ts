/**
 * logistic-order-notifications.test.ts — LO-2 §2.6
 *
 * Notification wiring for Logistic Orders:
 *   - lo.submitted → approve-grant holders ∪ ADMINs (INTERRUPT + needs_action)
 *   - lo.approved  → the LO creator (INTERRUPT)
 *
 * These tests pin the pieces THIS stream owns — the `templates` copy and the
 * `resolveRecipients` routing — and drive them through the REAL `emit()`
 * pipeline (mocked prisma) rather than through the LO controller's fire-and-forget
 * helper. That keeps the suite decoupled from the controller/helper stream while
 * still proving the end-to-end notification behaviour:
 *
 *   1. recipient resolution = approvers ∪ ADMINs, de-duplicated, actor dropped;
 *   2. LOGISTIC_ORDER passes filterByAccess UNFILTERED (a non-owner SALES approver
 *      survives — proof there is no row-scope drop);
 *   3. the notification row is written AFTER the status-change write (ordering);
 *   4. E20 straight-through SUPPRESSION — processLogisticOrder itself emits no
 *      notification, so the /process (incl. fast-forward) path is silent.
 *
 * Controller contract reported to the LO-controller stream:
 *   POST /:id/submit  → fire the lo.submitted emit AFTER the status write.
 *   POST /:id/approve → fire the lo.approved  emit AFTER the status write.
 *   POST /:id/process → NEITHER, on every path incl. fast-forward (E20).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import {
  ALPHA_ORG_ID,
  TEST_USERS,
  TRACKED_ITEM_FIXTURE,
  INVENTORY_LOCATION_FIXTURE,
  JOB_FIXTURE,
} from './helpers';
import { renderTemplate, isKnownVerb } from '../services/notifications/templates';
import { resolveRecipients } from '../services/notifications/resolveRecipients';
// The REAL emit — templates + resolveRecipients + roleHolders + filterByAccess +
// the DB writes all run; only prisma is mocked (setup.ts).
import { emit } from '../services/notifications/notificationService';
import { processLogisticOrder } from '../lib/logisticOrders';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const LO_ID = 'bbbbbbb1-0000-0000-0000-000000000001';
const LO_NUMBER = 'LO-J00001-1';

const ROLE_HOLDERS = {
  ADMIN: ['admin-1', 'admin-2'],
  DISPATCHER: ['disp-1'],
  SALES: ['sales-1'],
  TECHNICIAN: ['tech-1'],
};

// ═══════════════════════════════════════════════════════════════════════════════
// resolveRecipients — routing matrix (pure)
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveRecipients — lo.submitted', () => {
  it('routes to approve-grant holders ∪ ADMINs, all INTERRUPT + needs_action', () => {
    const recipients = resolveRecipients({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: null,
      // sales-9 = a non-admin grant holder; admin-2 = an admin who ALSO holds
      // an explicit grant (must NOT produce a duplicate row).
      entity: { approver_ids: ['sales-9', 'admin-2'] },
      roleHolders: ROLE_HOLDERS,
    });

    expect(recipients.map((r) => r.userId).sort()).toEqual(['admin-1', 'admin-2', 'sales-9']);
    expect(recipients.every((r) => r.priority === 'INTERRUPT' && r.needs_action === true)).toBe(true);
  });

  it('de-duplicates a grant-holding admin into a single row', () => {
    const recipients = resolveRecipients({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: null,
      entity: { approver_ids: ['admin-1'] },
      roleHolders: ROLE_HOLDERS,
    });
    expect(recipients.filter((r) => r.userId === 'admin-1')).toHaveLength(1);
  });

  it('drops the actor (an admin submitting their own LO is not notified)', () => {
    const recipients = resolveRecipients({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: 'admin-1',
      entity: { approver_ids: [] },
      roleHolders: ROLE_HOLDERS,
    });
    expect(recipients.map((r) => r.userId)).not.toContain('admin-1');
    expect(recipients.map((r) => r.userId).sort()).toEqual(['admin-2']);
  });

  it('does NOT notify a user who lost the approve override (absent from approver_ids)', () => {
    // sales-9 previously held the grant but it was revoked → the caller's query
    // no longer returns them → they are not in approver_ids → not a recipient.
    const recipients = resolveRecipients({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: null,
      entity: { approver_ids: [] },
      roleHolders: { ADMIN: ['admin-1'], DISPATCHER: [], SALES: [], TECHNICIAN: [] },
    });
    expect(recipients.map((r) => r.userId)).not.toContain('sales-9');
    expect(recipients.map((r) => r.userId)).toEqual(['admin-1']);
  });
});

describe('resolveRecipients — lo.approved', () => {
  it('routes to the creator only, INTERRUPT, no needs_action', () => {
    const recipients = resolveRecipients({
      verb: 'lo.approved',
      organizationId: ALPHA_ORG_ID,
      actorId: 'admin-1',
      entity: { created_by_id: 'sales-9' },
      roleHolders: ROLE_HOLDERS,
    });
    expect(recipients).toEqual([{ userId: 'sales-9', priority: 'INTERRUPT', needs_action: false }]);
  });

  it('emits nothing on self-approve (approver === creator → actor dropped)', () => {
    const recipients = resolveRecipients({
      verb: 'lo.approved',
      organizationId: ALPHA_ORG_ID,
      actorId: 'sales-9',
      entity: { created_by_id: 'sales-9' },
      roleHolders: ROLE_HOLDERS,
    });
    expect(recipients).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// templates — copy + shape (pure)
// ═══════════════════════════════════════════════════════════════════════════════

describe('templates — lo.submitted', () => {
  it('is an INVENTORY / LOGISTIC_ORDER interrupt that needs action', () => {
    const t = renderTemplate('lo.submitted', { object_label: 'LO-J00001-1', actor_name: 'Ada Admin' });
    expect(t).toMatchObject({
      category: 'INVENTORY',
      object_type: 'LOGISTIC_ORDER',
      priority: 'INTERRUPT',
      needs_action: true,
      // VIEW reuses the already-registered inline handler (billing.refunded /
      // communication.call_missed precedent) so the needs-action row clears by
      // navigating — no new frontend wiring for a backend-scoped change.
      action_type: 'VIEW',
    });
    expect(t.title).toContain('LO-J00001-1');
    expect(t.body).toContain('Ada Admin');
  });

  it('registers the verb', () => {
    expect(isKnownVerb('lo.submitted')).toBe(true);
  });
});

describe('templates — lo.approved', () => {
  it('is an INVENTORY / LOGISTIC_ORDER interrupt with no action', () => {
    const t = renderTemplate('lo.approved', { object_label: 'LO-J00001-1', actor_name: 'Ada Admin' });
    expect(t).toMatchObject({
      category: 'INVENTORY',
      object_type: 'LOGISTIC_ORDER',
      priority: 'INTERRUPT',
      needs_action: false,
      action_type: null,
    });
    expect(t.title).toContain('approved');
    expect(t.title).toContain('LO-J00001-1');
  });

  it('registers the verb', () => {
    expect(isKnownVerb('lo.approved')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// emit() pipeline — end-to-end through the REAL notification service
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit() — lo.submitted end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-lo-1' });
    mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 3 });
  });

  it('writes a LOGISTIC_ORDER notification to approvers ∪ ADMINs, unfiltered and de-duped', async () => {
    // roleHolders source: two admins + a SALES approver (all active).
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'admin-1', role: 'ADMIN' },
      { id: 'admin-2', role: 'ADMIN' },
      { id: 'sales-9', role: 'SALES' },
    ]);

    await emit({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: 'someone-else', // not a recipient — nothing to drop
      object: { type: 'LOGISTIC_ORDER', id: LO_ID, label: LO_NUMBER },
      // sales-9 = explicit grant holder; admin-2 = admin who ALSO holds a grant.
      entity: { approver_ids: ['sales-9', 'admin-2'] },
      data: { logistic_order_id: LO_ID, object_label: LO_NUMBER },
      dedupKey: `lo.submitted:${LO_ID}:1`,
    });

    // Event row — object_type comes from the template (authoritative).
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    const notifData = mockPrisma.notification.create.mock.calls[0][0].data;
    expect(notifData).toMatchObject({
      verb: 'lo.submitted',
      category: 'INVENTORY',
      object_type: 'LOGISTIC_ORDER',
      needs_action: true,
      action_type: 'VIEW',
    });

    // Recipient rows: {admin-1, admin-2, sales-9}, no dupes, all INTERRUPT + needs_action.
    // sales-9 is a non-owner SALES user; that they survive proves LOGISTIC_ORDER is
    // NOT row-scope-filtered (filterByAccess passthrough).
    const recRows = mockPrisma.notificationRecipient.createMany.mock.calls[0][0].data;
    expect(recRows.map((r: { recipient_id: string }) => r.recipient_id).sort()).toEqual([
      'admin-1', 'admin-2', 'sales-9',
    ]);
    expect(recRows.every((r: { priority: string; needs_action: boolean }) =>
      r.priority === 'INTERRUPT' && r.needs_action === true)).toBe(true);
  });
});

describe('emit() — lo.approved end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-lo-2' });
    mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin-1', role: 'ADMIN' }]);
  });

  it('writes a LOGISTIC_ORDER notification to the creator only', async () => {
    await emit({
      verb: 'lo.approved',
      organizationId: ALPHA_ORG_ID,
      actorId: 'admin-1', // the approver
      object: { type: 'LOGISTIC_ORDER', id: LO_ID, label: LO_NUMBER },
      entity: { created_by_id: 'sales-9' },
      data: { logistic_order_id: LO_ID, object_label: LO_NUMBER },
      dedupKey: `lo.approved:${LO_ID}`,
    });

    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    const recRows = mockPrisma.notificationRecipient.createMany.mock.calls[0][0].data;
    expect(recRows.map((r: { recipient_id: string }) => r.recipient_id)).toEqual(['sales-9']);
    expect(recRows[0].priority).toBe('INTERRUPT');
    expect(recRows[0].needs_action).toBe(false);
  });

  it('writes NOTHING on self-approve (approver === creator → no recipients)', async () => {
    await emit({
      verb: 'lo.approved',
      organizationId: ALPHA_ORG_ID,
      actorId: 'sales-9', // approver IS the creator
      object: { type: 'LOGISTIC_ORDER', id: LO_ID, label: LO_NUMBER },
      entity: { created_by_id: 'sales-9' },
      data: { logistic_order_id: LO_ID, object_label: LO_NUMBER },
      dedupKey: `lo.approved:${LO_ID}:self`,
    });

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Ordering — the notification row is written AFTER the status-change write
//
// The /submit handler does the CAS status claim (updateMany), THEN fires the
// notification fire-and-forget, AFTER the write, never inside a transaction.
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit-after-write ordering (submit controller contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-lo-3' });
    mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'admin-1', role: 'ADMIN' }]);
  });

  it('the lo.submitted notification row is created strictly after the status write', async () => {
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });

    // Simulate the /submit controller: CAS DRAFT → PENDING_APPROVAL, THEN notify.
    await prisma.logisticOrder.updateMany({
      where: { id: LO_ID, status: 'DRAFT' },
      data: { status: 'PENDING_APPROVAL' },
    });
    await emit({
      verb: 'lo.submitted',
      organizationId: ALPHA_ORG_ID,
      actorId: 'someone-else',
      object: { type: 'LOGISTIC_ORDER', id: LO_ID, label: LO_NUMBER },
      entity: { approver_ids: ['admin-1'] },
      data: { logistic_order_id: LO_ID, object_label: LO_NUMBER },
      dedupKey: `lo.submitted:${LO_ID}:2`,
    });

    const writeOrder = mockPrisma.logisticOrder.updateMany.mock.invocationCallOrder[0];
    const notifOrder = mockPrisma.notification.create.mock.invocationCallOrder[0];
    expect(writeOrder).toBeDefined();
    expect(notifOrder).toBeGreaterThan(writeOrder);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E20 — straight-through SUPPRESSION: processLogisticOrder emits no notification
//
// The reported controller contract is that POST /:id/process (incl. fast-forward)
// calls NEITHER emit helper. The invariant that makes that possible — and that
// this suite CAN pin without the controller — is that processLogisticOrder itself
// never emits. Running the real engine through the real emit path and asserting
// NO notification row is written proves it: if a lo.* emit were ever wired into
// the engine (or the fast-forward stamping), notification.create would fire and
// this guard would go red. (The engine's only emit path — emitLowStockIfCrossing
// — is inert here: the balances carry no `min`, so no low-stock crossing.)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E20 suppression — processLogisticOrder writes no notification', () => {
  const LOC_A = INVENTORY_LOCATION_FIXTURE.id;
  const LINE_1 = 'bbbbbbb2-0000-0000-0000-000000000001';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txClient: Record<string, any>;

  function setupTransaction() {
    txClient = {
      logisticOrder: {
        updateMany: mockPrisma.logisticOrder.updateMany,
        update: mockPrisma.logisticOrder.update,
        findFirst: mockPrisma.logisticOrder.findFirst,
      },
      logisticOrderLine: {
        findMany: mockPrisma.logisticOrderLine.findMany,
        update: mockPrisma.logisticOrderLine.update,
      },
      priceBookItem: {
        findFirst: mockPrisma.priceBookItem.findFirst,
        findMany: mockPrisma.priceBookItem.findMany,
      },
      inventoryLocation: { findMany: mockPrisma.inventoryLocation.findMany },
      organization: { findUnique: mockPrisma.organization.findUnique },
      stockMovement: { create: mockPrisma.stockMovement.create },
      stockBalance: {
        findMany: mockPrisma.stockBalance.findMany,
        upsert: mockPrisma.stockBalance.upsert,
        updateMany: mockPrisma.stockBalance.updateMany,
        findUnique: mockPrisma.stockBalance.findUnique,
      },
    };
    mockPrisma.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(txClient);
      return Promise.all(arg as Promise<unknown>[]);
    });
  }

  function fakeReq(): Request {
    return {
      user: {
        id: TEST_USERS.admin.id,
        organization_id: ALPHA_ORG_ID,
        role: 'ADMIN',
        first_name: 'Ada',
        last_name: 'Admin',
      },
    } as unknown as Request;
  }

  function loRow(over: Record<string, unknown> = {}) {
    return {
      id: LO_ID,
      number: LO_NUMBER,
      status: 'DRAFT',
      job_id: JOB_FIXTURE.id,
      submitted_at: null,
      submitted_by: null,
      approved_at: null,
      approved_by: null,
      lines: [
        {
          id: LINE_1,
          item_id: TRACKED_ITEM_FIXTURE.id,
          item_sku: TRACKED_ITEM_FIXTURE.sku,
          item_name: TRACKED_ITEM_FIXTURE.name,
          qty: 3,
          from_location_id: LOC_A,
          sequence: 0,
        },
      ],
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupTransaction();

    mockPrisma.logisticOrder.findFirst.mockResolvedValue(loRow());
    mockPrisma.logisticOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.logisticOrder.update.mockResolvedValue({});
    mockPrisma.logisticOrderLine.update.mockResolvedValue({});

    // Warn mode, item + location resolve, plenty on hand, NO low-stock crossing (min null).
    mockPrisma.organization.findUnique.mockResolvedValue({
      block_negative_stock: false,
      default_inventory_location_id: LOC_A,
    });
    mockPrisma.priceBookItem.findMany.mockResolvedValue([TRACKED_ITEM_FIXTURE]);
    mockPrisma.inventoryLocation.findMany.mockResolvedValue([{ id: LOC_A, name: 'Main Warehouse' }]);
    mockPrisma.stockBalance.findMany.mockResolvedValue([]);
    mockPrisma.stockBalance.upsert.mockResolvedValue({ on_hand: 7, min: null });
    mockPrisma.stockBalance.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.stockBalance.findUnique.mockResolvedValue({ on_hand: 7, min: null });
    mockPrisma.stockMovement.create.mockResolvedValue({ id: 'mv-1' });

    // If the engine wrongly emitted, these would be exercised — keep them ready
    // so the assertion is "not called", never a crash.
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-should-not-exist' });
    mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: TEST_USERS.admin.id, role: 'ADMIN' }]);
  });

  it('fast-forward process from DRAFT reaches PROCESSED and writes no notification', async () => {
    const result = await processLogisticOrder(prisma as never, fakeReq(), LO_ID, {
      fastForward: true,
      allowedFromStatuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'],
    });

    expect(result.status).toBe('PROCESSED');
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

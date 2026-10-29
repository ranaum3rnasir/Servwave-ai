/**
 * The rep-side LINE tick records nothing.
 *
 * Originally `repro-2088.test.ts`, the frozen reproduction for #2088 ("a new timeline event on the
 * estimate for every selection change"). The 2026-09-18 optional-add-ons revision REVERSED that
 * decision (decision 5: the per-tick record is redundant, the rep loses it entirely), so the case
 * below is kept at the same anchor but inverted: the rep tick must now write NOTHING. A file that
 * gets rewritten when product changes its mind is not frozen, hence the rename.
 *
 * This is the ONLY coverage of the line-side write absence; its scope-side twin lives in
 * `estimate-selection-no-timeline.test.ts`.
 *
 * What survives unchanged is the other half of the original acceptance, which was never in
 * dispute: a rep tick after Sent triggers no estimate-updated notification. It is asserted on the
 * dispatcher, not on an inbox.
 *
 * Harness mirrors estimate-optional-items.test.ts: supertest against `app`, prisma fully mocked
 * (setup.ts), a $transaction shim handing the callback the same top-level mocks as `tx` - still
 * extended with `timelineEvent`, deliberately. Nothing writes through that key any more, and the
 * point of keeping it is that a future write WOULD be observable here: a shim without the key
 * would let one pass silently, or throw for the wrong reason, instead of failing this assertion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function (mirrors estimate-notifications.test.ts) ──────────
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id; // 'f0000000-0000-0000-0000-000000000002' — a SENT estimate
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';

// estimate-lines.controller's `tx` proxy — mirrors estimate-optional-items.test.ts's
// setupLinesTransaction(), extended with `timelineEvent` so the fix's write is observable.
function setupLinesTransactionWithTimeline() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          update: mockPrisma.estimateLineItem.update,
        },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

// estimate-lines.controller's loadGuardedEstimate select shape — mirrors estimate-optional-items
// .test.ts's guardRow() verbatim, defaulted to SENT (the status the PRD's rep-tick scenario names).
function guardRow({
  status = 'SENT' as string,
  lineItems = [] as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  lockOnSend = false as boolean,
} = {}) {
  return {
    id: ESTIMATE_ID,
    status,
    version: 1,
    tax_rate: 0.1,
    discount_type: null,
    discount_value: null,
    subtotal: 1000,
    tax_amount: 100,
    total_amount: 1100,
    discount_amount: 0,
    scopes: null,
    organization: { lock_on_send: lockOnSend },
    invoices: [],
    line_items: lineItems,
  };
}

function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    is_optional: true,
    is_selected: false,
    ...over,
  };
}

function respondingEstimate() {
  return { ...ESTIMATE_SENT_FIXTURE, id: ESTIMATE_ID, line_items: [], scopes: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin'); // the rep ticking the box on the customer's behalf (issue §3)
});

describe('2026-09-18 revision: the rep-side line tick records nothing, and still notifies nobody', () => {
  it('PATCH /api/estimates/:id/line-items/:lineId on a SENT estimate writes no timeline event and never calls the notification dispatcher', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'SENT', lineItems: [line({ is_optional: true, is_selected: false })] }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ is_optional: true, is_selected: true })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: true }); // rep ticks the row on the customer's behalf

    expect(res.status).toBe(200);

    // The tick itself still lands - on `rep_selected`, the rep's recommendation, which is what a
    // staff tick means once the estimate has left DRAFT (slice A3, `routeSelectionWrite`). This
    // read `data.is_selected).toBe(true)` until A3, back when the tick wrote the CUSTOMER's live
    // answer; that write is the one A3 removed, because it moved the totals and so nulled
    // `public_token` under a customer who had the page open. Their answer is asserted here too,
    // at the value the row was stored with: leaving it alone is the whole point.
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimateLineItem.update.mock.calls[0][0].data.rep_selected).toBe(true);
    expect(mockPrisma.estimateLineItem.update.mock.calls[0][0].data.is_selected).toBe(false);
    // ...and leaves no record behind it. The `tx` shim above DOES carry `timelineEvent`, so a
    // write would be seen here rather than skipped by the controller's optional-call guard.
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();

    // Unchanged from the original acceptance: no estimate-updated notification on a SENT tick.
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

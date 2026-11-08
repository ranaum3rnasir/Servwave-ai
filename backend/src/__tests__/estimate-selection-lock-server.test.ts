/**
 * #2090 (slice 3a) - the selection lock, enforced SERVER-side.
 *
 * `areSelectionsLocked` is a verbatim transcription of the frontend predicate
 * (`frontend/src/lib/estimates/selectionLock.ts`, pinned by `estimate-selection-lock.test.tsx`);
 * the unit block below re-pins it here so the two cannot drift.
 *
 * The route blocks prove the rule the six staff write paths share: on a selection-LOCKED
 * estimate a request that would CHANGE `is_optional`/`is_selected` is refused
 * `409 OPTIONS_LOCKED`, and a request that does not is left to the pre-existing guards
 * untouched. The lock is not a second blanket edit lock.
 *
 * Harness mirrors `estimate-selection-timeline.test.ts`'s `setupLinesTransactionWithTimeline()`
 * (itself mirroring `estimate-optional-items.test.ts`) - one request per `it`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { areSelectionsLocked, changesSelectionFlags, changesSelectionFlagsInList } from '../lib/estimates/selectionLock';

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000003';

const PAID_DEPOSIT = [{ kind: 'DEPOSIT', status: 'PAID' }];
const UNPAID_DEPOSIT = [{ kind: 'DEPOSIT', status: 'SENT' }];

function setupLinesTransactionWithTimeline() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          create: mockPrisma.estimateLineItem.create,
          update: mockPrisma.estimateLineItem.update,
        },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
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
    is_selected: true,
    ...over,
  };
}

function scope(over: Record<string, unknown> = {}) {
  return {
    id: SCOPE_ID,
    title: 'Permit fee',
    body: '',
    flat_price: 200,
    is_taxable: true,
    internal_cost: null,
    is_optional: true,
    is_selected: true,
    ...over,
  };
}

function guardRow({
  status = 'SENT',
  invoices = [] as { kind: string; status: string }[],
  scopes = null as unknown[] | null,
  lineItems = [] as ReturnType<typeof line>[],
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
    scopes,
    organization: { lock_on_send: false },
    invoices,
    line_items: lineItems,
  };
}

function respondingEstimate() {
  return { ...ESTIMATE_SENT_FIXTURE, id: ESTIMATE_ID, line_items: [], scopes: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
});

/**
 * The two deposit-driven cases this block used to open with ("a PAID deposit locks whatever the
 * status says", "an unpaid deposit does NOT lock even on a WON estimate") were deleted by the
 * 2026-09-18 revision, which makes signature the only thing that locks. Their successors are the
 * first three cases of "signing is what locks an estimate's optional selections" at the foot of
 * this file, which assert the opposite of each.
 */
describe('#2090 areSelectionsLocked - the backend twin, transcribed from the frontend', () => {
  it('locked exactly when the estimate is WON', () => {
    expect(areSelectionsLocked({ status: 'WON', invoices: [] })).toBe(true);
    expect(areSelectionsLocked({ status: 'SENT', invoices: [] })).toBe(false);
    expect(areSelectionsLocked({ status: 'WON', invoices: null })).toBe(true);
  });

  it('no invoice of any kind changes the answer - a WON estimate carrying a STANDARD one still locks', () => {
    expect(areSelectionsLocked({ status: 'WON', invoices: [{ kind: 'STANDARD', status: 'DRAFT' }] })).toBe(true);
  });

  // POST /api/estimates carries no lock CHECK on purpose: the row it writes is DRAFT (the
  // schema default, backend/prisma/schema.prisma Estimate.status) with no invoices at all, so
  // both arms of the predicate are false by construction. Asserted here rather than guarded by
  // a branch that could never be taken.
  it('a brand-new estimate (DRAFT, no invoices) can never be locked', () => {
    expect(areSelectionsLocked({ status: 'DRAFT', invoices: [] })).toBe(false);
  });
});

describe('#2090 changesSelectionFlags - the lock refuses a CHANGE, not every request', () => {
  it('an omitted flag changes nothing', () => {
    expect(changesSelectionFlags({}, { is_optional: true, is_selected: false })).toBe(false);
  });

  it('a flag sent at the value already stored changes nothing', () => {
    expect(changesSelectionFlags({ is_selected: false }, { is_optional: true, is_selected: false })).toBe(false);
  });

  it('flipping is_selected on an optional row is a change', () => {
    expect(changesSelectionFlags({ is_selected: true }, { is_optional: true, is_selected: false })).toBe(true);
  });

  it('normalises both sides: is_selected:false on a non-optional row is the no-op it really is', () => {
    expect(changesSelectionFlags({ is_selected: false }, { is_optional: false, is_selected: true })).toBe(false);
  });

  it('a list of a different length is a change (an optional line was added or dropped)', () => {
    expect(changesSelectionFlagsInList([{}], [])).toBe(true);
    expect(changesSelectionFlagsInList(undefined, [{ is_optional: true, is_selected: false }])).toBe(false);
    expect(
      changesSelectionFlagsInList(
        [{ is_optional: true, is_selected: true }],
        [{ is_optional: true, is_selected: false }],
      ),
    ).toBe(true);
  });
});

describe('#2090 PATCH /api/estimates/:id/line-items/:lineId - the lock', () => {
  /**
   * Superseded by the 2026-09-18 revision, and kept rather than deleted because the question it
   * asks is still worth an answer: what happens to a rep's flip on an UNSIGNED estimate whose
   * deposit has been paid? It used to be an OPTIONS_LOCKED refusal. It is now the pre-existing
   * EDIT lock's 400, because a paid deposit is exactly what `isEstimateLocked` keys off. The
   * write is still refused; it is refused by the guard that actually owns that situation.
   */
  it('a paid deposit on an unsigned estimate is the EDIT lock\'s business, not the selection lock\'s', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ invoices: PAID_DEPOSIT, lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(400);
    expect(res.body.error).not.toBe('OPTIONS_LOCKED');
  });

  it('409 names ACCEPTANCE, not a deposit, on a WON estimate that never had one', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', invoices: [], lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Selections are locked because this estimate has been accepted.');
  });

  it('a price edit on a locked estimate is NOT turned into an OPTIONS_LOCKED refusal', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ unit_price: 99 });

    expect(res.body.error).not.toBe('OPTIONS_LOCKED');
    expect(res.status).not.toBe(409);
  });

  it('re-sending the flag at its stored value is not a change, so not a 409', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: true });

    expect(res.status).not.toBe(409);
  });

  it('an UNSIGNED estimate carrying an unpaid deposit still takes the tick (AC "second change before the deposit is paid")', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ invoices: UNPAID_DEPOSIT, lineItems: [line({ is_optional: true, is_selected: true })] }),
    );
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ is_optional: true, is_selected: false })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(200);
  });
});

describe('#2090 PATCH /api/estimates/:id/scopes/:idx - the lock', () => {
  it('409 OPTIONS_LOCKED when the estimate is signed and the request flips a scope selection', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', scopes: [scope({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
  });

  it('a title edit on a locked estimate is not an OPTIONS_LOCKED refusal', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', scopes: [scope({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee (revised)' });

    expect(res.status).not.toBe(409);
  });
});

describe('#2090 the two CREATE paths - an added OPTION is a selection change', () => {
  it('POST /api/estimates/:id/line-items 409s when a locked estimate is handed a new optional line', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'WON' }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra vent', quantity: 1, unit_price: 250, is_optional: true, is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
  });

  it('POST /api/estimates/:id/line-items with an ordinary line is left to the pre-existing edit lock', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'WON' }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'Extra vent', quantity: 1, unit_price: 250 });

    expect(res.status).not.toBe(409);
  });

  it('POST /api/estimates/:id/scopes 409s when a locked estimate is handed a new optional scope', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ status: 'WON', invoices: [] }));

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Extra permit', flat_price: 120, is_optional: true, is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
  });
});

describe('#2090 PATCH /api/estimates/:id - the whole-document replace', () => {
  function updateExisting(over: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_ID,
      status: 'WON',
      tax_rate: 0.1,
      discount_type: null,
      discount_value: null,
      version: 1,
      scopes: null,
      subtotal: 1000,
      tax_amount: 100,
      total_amount: 1100,
      discount_amount: 0,
      deposit_type: null,
      deposit_value: null,
      discount_name: null,
      created_by: null,
      job_id: null,
      organization: { lock_on_send: false },
      invoices: [],
      lead: { lead_assignees: [] },
      customer: { tax_exempt: false },
      line_items: [{ is_optional: true, is_selected: false }],
      ...over,
    };
  }

  it('409 OPTIONS_LOCKED when a locked estimate is re-sent with a different selection state', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(updateExisting());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}`)
      .set(authHeader('admin'))
      .send({
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_optional: true, is_selected: true },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
  });

  it('a locked estimate re-sent with the SAME selection state falls through to the pre-existing 400', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(updateExisting());

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}`)
      .set(authHeader('admin'))
      .send({
        line_items: [
          { description: 'AC Unit', quantity: 1, unit_price: 1000, is_optional: true, is_selected: false },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only draft or sent estimates can be edited');
  });
});

/**
 * Revision, 2026-09-18 (PRD section 5, slice 5). Ran's decision 6: "A customer cannot tick after
 * signing. Once they sign, it is locked."
 *
 * The superseded rule handed the whole question to the deposit invoice whenever one existed:
 * locked iff that deposit was PAID. A signed estimate with an unpaid deposit therefore stayed
 * open, and the customer could go on changing what they were buying after they had put their name
 * to it. The deposit no longer has any say; signature does.
 *
 * The other half of the rule matters just as much and is asserted alongside: BEFORE signature the
 * document is still negotiable, so a paid deposit must not lock it early.
 */
describe('signing is what locks an estimate\'s optional selections', () => {
  it('locks a signed estimate whose deposit has not been paid', () => {
    expect(areSelectionsLocked({ status: 'WON', invoices: UNPAID_DEPOSIT })).toBe(true);
  });

  it('locks a signed estimate whose deposit is only part-paid', () => {
    expect(areSelectionsLocked({ status: 'WON', invoices: [{ kind: 'DEPOSIT', status: 'PARTIAL' }] })).toBe(true);
  });

  it('leaves an unsigned estimate open even when its deposit has already been paid', () => {
    expect(areSelectionsLocked({ status: 'SENT', invoices: PAID_DEPOSIT })).toBe(false);
  });

  it('refuses a rep\'s selection write on a signed estimate that still carries an unpaid deposit', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', invoices: UNPAID_DEPOSIT, lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
  });

  it('tells the reader the estimate has been accepted, never that a deposit was paid', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(
      guardRow({ status: 'WON', invoices: PAID_DEPOSIT, lineItems: [line({ is_optional: true, is_selected: true })] }),
    );

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: false });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Selections are locked because this estimate has been accepted.');
  });
});

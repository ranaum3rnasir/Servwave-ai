/**
 * #2090 (slice 3b) - the customer's own selection, through the public token door.
 *
 * This is an UNAUTHENTICATED write path, so the security half is the bulk of the file: the token
 * comparison, the lock, the optional-only rule, the cross-estimate 404, the fact that
 * `is_optional` cannot be written at all, and the fact that the response carries no cost field.
 *
 * One request per `it`. The `$transaction` shim mirrors `estimate-selection-no-timeline.test.ts`'s,
 * extended with the `invoice` client the deposit re-price reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ESTIMATE_SENT_FIXTURE } from './helpers';
import { rejectCustomerSelections, estimatePublicSelect } from '../controllers/estimate.controller';
import { areSelectionsLocked } from '../lib/estimates/selectionLock';

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateSendConfig: { updateMany: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const TOKEN = ESTIMATE_SENT_FIXTURE.public_token;
const OPTIONAL_LINE = 'aa000000-0000-0000-0000-000000000011';
const REQUIRED_LINE = 'aa000000-0000-0000-0000-000000000012';
const OPTIONAL_SCOPE = 'cc000000-0000-0000-0000-000000000011';
const FOREIGN_ID = 'ff000000-0000-0000-0000-0000000000ff';

const SELECTIONS_URL = `/api/estimates/${ESTIMATE_ID}/public/selections?token=${TOKEN}`;

function targetEstimate(over: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    organization_id: 'org-test-1',
    estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
    status: 'SENT',
    valid_until: new Date('2099-12-31'),
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    deposit_type: null,
    deposit_value: null,
    total_amount: 1000,
    scopes: [
      {
        id: OPTIONAL_SCOPE,
        title: 'Permit fee',
        body: '',
        flat_price: 200,
        is_taxable: true,
        internal_cost: 100,
        is_optional: true,
        is_selected: false,
      },
    ],
    line_items: [
      { id: REQUIRED_LINE, description: 'AC Unit', is_optional: false, is_selected: true },
      { id: OPTIONAL_LINE, description: 'Smart thermostat\nwifi enabled', is_optional: true, is_selected: false },
    ],
    invoices: [],
    ...over,
  };
}

/** The `estimatePublicSelect`-shaped row the endpoint reads back for its response. */
function publicResponseRow() {
  return {
    ...ESTIMATE_SENT_FIXTURE,
    id: ESTIMATE_ID,
    scopes: null,
    line_items: [
      { id: OPTIONAL_LINE, sequence: 1, description: 'Smart thermostat', quantity: 1, unit_price: 300, is_optional: true, is_selected: true },
    ],
  };
}

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          update: mockPrisma.estimateLineItem.update,
        },
        invoice: { findFirst: mockPrisma.invoice.findFirst, update: mockPrisma.invoice.update },
        estimateSendConfig: { updateMany: mockPrisma.estimateSendConfig.updateMany },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

/**
 * The happy-path wiring: the token lookup, then the target read, then the in-transaction reads,
 * then the response read. `estimate.findFirst` serves the two token-gated reads (the status gate
 * and the response), `estimate.findUnique` the target + the in-transaction scope re-reads.
 */
function mockHappyPath(target = targetEstimate()) {
  setupTransaction();
  mockPrisma.estimate.findFirst
    .mockResolvedValueOnce({ id: ESTIMATE_ID, status: target.status, valid_until: target.valid_until })
    .mockResolvedValue(publicResponseRow());
  mockPrisma.estimate.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
    if (args?.select?.scopes && !args.select.line_items) return { scopes: target.scopes };
    if (args?.select?.invoices && !args.select.line_items) return { invoices: target.invoices };
    return target;
  });
  mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });
  mockPrisma.estimateLineItem.update.mockResolvedValue({});
  mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-test-1', deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2090 rejectCustomerSelections - the payload rules, as a unit', () => {
  const estimate = targetEstimate();

  it('accepts a payload naming only optional rows of this estimate', () => {
    expect(rejectCustomerSelections(estimate, [
      { kind: 'line', id: OPTIONAL_LINE, is_selected: true },
      { kind: 'scope', id: OPTIONAL_SCOPE, is_selected: true },
    ])).toBeNull();
  });

  it('404s an id this estimate does not have, rather than leaking that it exists elsewhere', () => {
    const rejection = rejectCustomerSelections(estimate, [{ kind: 'line', id: FOREIGN_ID, is_selected: true }]);
    expect(rejection?.status).toBe(404);
    expect(rejection?.body.error).toBe('Estimate not found');
  });

  it('a scope id sent as a line id is a different row, so it 404s too', () => {
    expect(rejectCustomerSelections(estimate, [{ kind: 'line', id: OPTIONAL_SCOPE, is_selected: true }])?.status).toBe(404);
  });

  it('REFUSES a required line rather than silently ignoring it', () => {
    const rejection = rejectCustomerSelections(estimate, [{ kind: 'line', id: REQUIRED_LINE, is_selected: false }]);
    expect(rejection?.status).toBe(400);
    expect(rejection?.body.error).toBe('NOT_OPTIONAL');
  });
});

describe('#2090 PATCH /api/estimates/:id/public/selections - the token door', () => {
  it('400s with no token at all', async () => {
    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/public/selections`)
      .send({ selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Token is required');
  });

  it('404s on a wrong token, without saying whether the estimate exists', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/public/selections?token=not-the-token`)
      .send({ selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }] });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Estimate not found');
  });
});

describe('#2090 PATCH /api/estimates/:id/public/selections - the write', () => {
  it('ticks an optional line on and writes is_selected, nothing else', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(1);
    const call = mockPrisma.estimateLineItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: OPTIONAL_LINE, estimate_id: ESTIMATE_ID });
    expect(call.data).toEqual({ is_selected: true });
    expect(call.data).not.toHaveProperty('is_optional');
  });

  it('unticks a rep-preselected option before lock (AC: the customer may untick)', async () => {
    mockHappyPath(targetEstimate({
      line_items: [
        { id: REQUIRED_LINE, description: 'AC Unit', is_optional: false, is_selected: true },
        { id: OPTIONAL_LINE, description: 'Smart thermostat', is_optional: true, is_selected: true },
      ],
    }));

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: false }],
    });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update.mock.calls[0][0].data).toEqual({ is_selected: false });
  });

  it('records nothing: the customer selections PATCH writes no timeline event at all', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    // 2026-09-18 revision, decision 5: the click is not recorded. This used to assert exactly one
    // SELECTION_CHANGED row with `actor_kind: 'customer'` and a null created_by.
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('addresses a scope by its uuid and writes the flag back onto the JSONB array', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'scope', id: OPTIONAL_SCOPE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    const scopeWrite = mockPrisma.estimate.update.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => 'scopes' in c.data);
    expect(scopeWrite).toBeDefined();
    expect((scopeWrite!.data.scopes as { id: string; is_selected: boolean }[])[0]).toMatchObject({
      id: OPTIONAL_SCOPE,
      is_selected: true,
    });
    // 2026-09-18 revision: the scope tick used to also write a timeline event carrying the scope
    // uuid in its metadata. The JSONB write above is now the only thing this door leaves behind.
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('persists the recomputed totals in the same transaction that wrote the tick', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    const totalsWrite = mockPrisma.estimate.update.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => 'total_amount' in c.data);
    expect(totalsWrite).toBeDefined();
    expect(totalsWrite!.data).toHaveProperty('subtotal');
    expect(totalsWrite!.data).toHaveProperty('tax_amount');
    expect(totalsWrite!.data).toHaveProperty('discount_amount');
  });

  it('never applies the material-change ceremony: the customer keeps the link they are holding', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    for (const call of mockPrisma.estimate.update.mock.calls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data).not.toHaveProperty('public_token');
      expect(data).not.toHaveProperty('modified_after_send');
      expect(data).not.toHaveProperty('version');
    }
  });

  it('the response carries no cost field', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('unit_cost');
    expect(body).not.toContain('internal_cost');
    expect(body).not.toContain('markup_percent');
  });
});

describe('#2090 PATCH /api/estimates/:id/public/selections - the refusals', () => {
  /**
   * Superseded by the 2026-09-18 revision: a paid deposit no longer locks selections, signature
   * does, so this estimate (SENT, never signed) is open as far as the lock is concerned. The
   * customer's money is not left unguarded, though - the deposit has payments against it, the
   * re-price refuses to write over them, and the selection write rolls back with it. That is the
   * guard the revision deliberately keeps, and this is the case that still reaches it.
   */
  it('still refuses the tick when the deposit already has the customer\'s money against it', async () => {
    mockHappyPath(targetEstimate({ invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'PAID', total_amount: 500, amount_due: 0 }] }));
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: 'dep-1', invoice_number: 'INV-D1', status: 'PAID', total_amount: 500, _count: { payments: 1 },
    });
    mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
    expect(res.body.message).toBe('Selections are locked because part of the deposit has already been paid.');
    // The deposit figure is untouched, which is the half that can be asserted here. The SELECTION
    // write cannot: the line write happens inside `$transaction` before the throw, and a mocked
    // Prisma has no rollback to model, so `estimateLineItem.update` HAS been called by this point
    // even though the real database discards it. That the customer's tick is rolled back rests on
    // the real transaction, not on this test, and nothing in this suite proves it.
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('409 OPTIONS_LOCKED on a WON estimate that needs no deposit', async () => {
    mockHappyPath(targetEstimate({ status: 'WON', invoices: [] }));

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Selections are locked because this estimate has been accepted.');
  });

  it('allows a change while the estimate is unsigned and the deposit is still outstanding', async () => {
    mockHappyPath(targetEstimate({
      status: 'SENT',
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500 }],
    }));

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
  });

  /**
   * Revision, 2026-09-18 (PRD section 5, slice 5). Ran's decision 6: signing locks, full stop.
   * The superseded rule left this exact estimate open - signed, but not yet paid for - which is
   * the window a customer could still change what they had just agreed to buy.
   */
  it('409 OPTIONS_LOCKED on a signed estimate whose deposit is still unpaid', async () => {
    mockHappyPath(targetEstimate({
      status: 'WON',
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500 }],
    }));

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
    expect(res.body.message).toBe('Selections are locked because this estimate has been accepted.');
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });

  it('400s a payload naming a required line, and writes nothing', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: REQUIRED_LINE, is_selected: false }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_OPTIONAL');
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });

  it('404s an id belonging to another estimate, and writes nothing', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: FOREIGN_ID, is_selected: true }],
    });

    expect(res.status).toBe(404);
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });

  it('strips is_optional out of the payload entirely - it never reaches the write', async () => {
    mockHappyPath();

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: REQUIRED_LINE, is_selected: true, is_optional: true }],
    });

    // The schema drops the key, so the row is still the REQUIRED one the estimate stores and the
    // optional-only rule refuses it. A payload cannot promote a line into an option.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_OPTIONAL');
  });

  it('400s a DECLINED estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID, status: 'DECLINED', valid_until: null });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/declined/i);
  });

  it('400s an expired estimate', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID, status: 'SENT', valid_until: new Date('2020-01-01') });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Estimate has expired');
  });

  it('400s an empty selections array (the schema requires at least one)', async () => {
    const res = await request(app).patch(SELECTIONS_URL).send({ selections: [] });

    expect(res.status).toBe(400);
  });
});

describe('#2090 POST /api/estimates/:id/approve - the `selections` rider', () => {
  /** approvePublic's own `existing` select, minus the parts this block does not exercise. */
  function approveExisting(over: Record<string, unknown> = {}) {
    return {
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: null,
      lead: null,
      organization_id: 'org-test-1',
      total_amount: 1000,
      valid_until: new Date('2099-12-31'),
      signature_data: null,
      snapshot_terms: null,
      invoices: [],
      send_config: { deposit_required: false, payment_methods: [] },
      organization: {
        id: 'org-test-1',
        stripe_account_id: 'acct_test',
        stripe_charges_enabled: true,
        accepted_payment_methods: ['CARD', 'CHECK'],
      },
      ...over,
    };
  }

  function mockApprove(existing = approveExisting(), target = targetEstimate()) {
    setupTransaction();
    mockPrisma.estimate.findFirst.mockResolvedValue(existing);
    mockPrisma.estimate.findUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) => {
      if (args?.select?.scopes && !args.select.line_items) return { scopes: target.scopes };
      if (args?.select?.invoices && !args.select.line_items) return { invoices: target.invoices };
      if (args?.select?.line_items) return target;
      return null; // the fire-and-forget approval email read
    });
    mockPrisma.estimate.update.mockResolvedValue({ ...publicResponseRow(), total_amount: 1300 });
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-test-1', deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 });
    mockPrisma.timelineEvent.create.mockResolvedValue({});
  }

  it('applies the tick and only then writes the status (AC: accept with an option chosen)', async () => {
    mockApprove();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`)
      .send({
        signature_data: 'data:image/png;base64,AAA',
        payment_method: null,
        selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
      });

    expect(res.status).toBe(200);
    // The tick landed...
    expect(mockPrisma.estimateLineItem.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimateLineItem.update.mock.calls[0][0].data).toEqual({ is_selected: true });
    // ...and the status write went out AFTER it, so the estimate is won at the accepted total.
    const statusWrite = mockPrisma.estimate.update.mock.calls
      .map((c: unknown[]) => c[0] as { data: Record<string, unknown> })
      .find((c) => c.data.status !== undefined);
    expect(statusWrite!.data.status).toBe('WON');
  });

  it('records nothing at accept time either, while the ceremony events still go out', async () => {
    mockApprove();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`)
      .send({
        signature_data: 'data:image/png;base64,AAA',
        payment_method: null,
        selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
      });

    expect(res.status).toBe(200);
    // The approve path writes its OWN ceremony events (APPROVED and friends); only the per-tick
    // selection record is gone, so this asserts on the event type rather than on the call count.
    const selectionEvent = mockPrisma.timelineEvent.create.mock.calls
      .map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.event_type === 'SELECTION_CHANGED');
    expect(selectionEvent).toBeUndefined();
  });

  /**
   * Superseded by the 2026-09-18 revision. This used to prove the SELECTION LOCK refusing the
   * rider on an estimate whose deposit was paid. The lock now keys off signature alone, and
   * `approvePublic` already turns away anything that is not SENT or PENDING before the rider is
   * read, so the lock is no longer reachable from this door at all. What still is, and what this
   * case is really for, is the refusal that protects money already taken.
   */
  it('409 rather than approving, when the rider would re-price a deposit the customer has paid into', async () => {
    const paid = [{ id: 'dep-1', kind: 'DEPOSIT', status: 'PAID', total_amount: 500, amount_due: 0 }];
    mockApprove(
      approveExisting({ status: 'PENDING', signature_data: 'data:image/png;base64,AAA', invoices: paid, send_config: { deposit_required: true, payment_methods: ['CHECK'] } }),
      targetEstimate({ deposit_type: 'PERCENTAGE', deposit_value: 50, invoices: paid }),
    );
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: 'dep-1', invoice_number: 'INV-D1', status: 'PAID', total_amount: 500, _count: { payments: 1 },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`)
      .send({
        payment_method: 'CHECK',
        selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
    expect(res.body.message).toBe('Selections are locked because part of the deposit has already been paid.');
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('a required line in the rider refuses the whole approval', async () => {
    mockApprove();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`)
      .send({
        signature_data: 'data:image/png;base64,AAA',
        payment_method: null,
        selections: [{ kind: 'line', id: REQUIRED_LINE, is_selected: false }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_OPTIONAL');
  });

  it('an approval with no rider is byte-for-byte the old flow: nothing is written to any line', async () => {
    mockApprove();

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${TOKEN}`)
      .send({ signature_data: 'data:image/png;base64,AAA', payment_method: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.estimateLineItem.update).not.toHaveBeenCalled();
  });
});

describe('#2090 the deposit follows the customer\'s choice (AC4)', () => {
  const UNPAID_DEPOSIT = { id: 'dep-1', invoice_number: 'INV-D1', status: 'SENT', total_amount: 500, _count: { payments: 0 } };

  it('re-prices the unpaid deposit invoice AND the send-time snapshot the page reads', async () => {
    mockHappyPath(targetEstimate({
      deposit_type: 'PERCENTAGE',
      deposit_value: 50,
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500 }],
    }));
    mockPrisma.invoice.findFirst.mockResolvedValue(UNPAID_DEPOSIT);
    mockPrisma.invoice.update.mockResolvedValue({});
    mockPrisma.estimateSendConfig.updateMany.mockResolvedValue({ count: 1 });
    // The recompute lands a 1300 total, so a 50% deposit is 650, not the 500 on file.
    mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.invoice.update.mock.calls[0][0].data.total_amount).toBe(650);
    // The surfaces read the deposit off send_config, the card branch charges the invoice: both
    // must move together or the page shows one figure and the checkout takes another.
    expect(mockPrisma.estimateSendConfig.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimateSendConfig.updateMany.mock.calls[0][0].data.deposit_amount).toBe(650);
  });

  /**
   * #2090 - the refusal that closes the other half of AC4. The re-price correctly declines a
   * deposit with money against it, so the SELECTION has to decline too: letting the write through
   * left the estimate's total moved and the deposit priced off the total before it.
   */
  it('REFUSES the whole selection write when the deposit is already part-paid', async () => {
    mockHappyPath(targetEstimate({
      deposit_type: 'PERCENTAGE',
      deposit_value: 50,
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'PARTIAL', total_amount: 500, amount_due: 200 }],
    }));
    mockPrisma.invoice.findFirst.mockResolvedValue({ ...UNPAID_DEPOSIT, status: 'PARTIAL', _count: { payments: 1 } });
    mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OPTIONS_LOCKED');
    expect(res.body.message).toBe('Selections are locked because part of the deposit has already been paid.');
  });

  it('a deposit whose figure is ALREADY right is not a refusal: the write goes through', async () => {
    mockHappyPath(targetEstimate({
      deposit_type: 'FIXED',
      deposit_value: 500,
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500 }],
    }));
    // A FIXED $500 deposit under a changed total still asks for exactly $500, so the re-price
    // answers ALREADY_CURRENT. That is not money against the row and must not refuse anything.
    mockPrisma.invoice.findFirst.mockResolvedValue(UNPAID_DEPOSIT);
    mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    expect(res.status).toBe(200);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
  });

  it('never touches a deposit that already has money against it', async () => {
    mockHappyPath(targetEstimate({
      deposit_type: 'PERCENTAGE',
      deposit_value: 50,
      invoices: [{ id: 'dep-1', kind: 'DEPOSIT', status: 'PARTIAL', total_amount: 500, amount_due: 200 }],
    }));
    mockPrisma.invoice.findFirst.mockResolvedValue({ ...UNPAID_DEPOSIT, status: 'PARTIAL', _count: { payments: 1 } });
    mockPrisma.estimate.update.mockResolvedValue({ total_amount: 1300 });

    const res = await request(app).patch(SELECTIONS_URL).send({
      selections: [{ kind: 'line', id: OPTIONAL_LINE, is_selected: true }],
    });

    // Refused, and nothing written: not the invoice, not the send-time snapshot. The line write
    // and the timeline event that ran before the throw are rolled back with the transaction.
    expect(res.status).toBe(409);
    expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    expect(mockPrisma.estimateSendConfig.updateMany).not.toHaveBeenCalled();
  });
});

describe("#2090 the public projection carries everything the customer's page locks on", () => {
  /**
   * The lock that matters most runs in the BROWSER, over the payload this select produces. A
   * mocked-Prisma route test cannot catch a missing field (the mock returns whatever the fixture
   * holds, whatever the select asks for), so the select is asserted directly.
   *
   * This went wrong once already, on the deposit row: `invoices` pinned `kind: 'DEPOSIT'` in its
   * `where` but never SELECTED it, so the predicate read "this estimate has no deposit". The
   * 2026-09-18 revision took the deposit out of the predicate entirely, so the field at risk is
   * now the estimate's own `status`, and that is what these two guard. The `invoices` projection
   * still matters to the page's deposit block, it simply no longer decides the lock.
   */
  it('projects the field areSelectionsLocked reads', () => {
    expect(estimatePublicSelect).toMatchObject({ status: true });
  });

  it('and the predicate agrees: a signed row shaped by that select locks', () => {
    // Built from the select's OWN key list, not from a hand-written object - if `status` were
    // dropped from the projection it would disappear from this row too, and the assertion below
    // would go red.
    const projected = Object.fromEntries(
      Object.keys(estimatePublicSelect).map((k) => [k, k === 'status' ? 'WON' : null]),
    ) as { status?: string | null };
    expect(areSelectionsLocked(projected)).toBe(true);
  });
});

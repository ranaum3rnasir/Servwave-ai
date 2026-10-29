/**
 * A6 (#2090, rulings 17 + 18) — a superseded estimate has no live URL, and cannot be sent.
 *
 * Every assertion here goes through a PUBLIC DOOR: `POST /:id/revise`, `POST /:id/send`, and the
 * unauthenticated `GET /:id/public?token=…`. Nothing asserts on the arguments handed to prisma,
 * because the thing under test is "does the customer's old link still serve", not "was a column
 * written".
 *
 * To make that possible the prisma mock is backed by a tiny in-memory estimate table: the routes
 * write to it and read back from it exactly as they would against a database, so a revise in one
 * request is visible to a public GET in the next. `findFirst` enforces the token match the real
 * `where: { id, public_token }` does — a nulled token therefore genuinely stops matching.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { isStripeConfigured, createCheckoutSession, getStripeForOrg } from '../lib/stripe';
import { ESTIMATE_FIXTURE, CUSTOMER_FIXTURE, LOCATION_FIXTURE, TEST_USERS, mockAuthAs, authHeader } from './helpers';

// Staff still render the superseded estimate's PDF, so the pdf lib is stubbed rather than run.
const generateEstimatePdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: (...args: unknown[]) => generateEstimatePdf(...args),
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
};

const ORG_ID = 'org-test-1';
const OLD_ID = 'f0000000-0000-0000-0000-0000000000a1';
const OLD_TOKEN = 'token-old-a1';
const SIBLING_ID = 'f0000000-0000-0000-0000-0000000000a2';
const SIBLING_TOKEN = 'token-sibling-a2';
const NEW_ID = 'f0000000-0000-0000-0000-0000000000a9';
const DEP_INV_ID = 'd0000000-0000-0000-0000-0000000000a1';
const DEP_TOKEN = 'token-deposit-a1';

const PUBLIC_ORG = {
  id: ORG_ID, name: 'Org', logo_url: null, brand_color: null, email: null, phone: null,
  phone_ext: null, website: null, timezone: null, estimate_terms: 'TERMS', estimate_notes: 'NOTES',
  estimate_payment_terms: 'PAY', stripe_charges_enabled: true, stripe_account_id: 'acct_test',
  accepted_payment_methods: ['CARD'], deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
};

/**
 * The deposit invoice revise() re-points. It is its OWN document with its OWN public_token; the
 * only thing revise touches is which estimate it hangs off, so `estimate_id` is mutable here and
 * the `estimate` relation is resolved live out of `rows`.
 */
let depositInvoice: { estimate_id: string };

function depositInvoiceRow() {
  const estimate = rows[depositInvoice.estimate_id];
  return {
    id: DEP_INV_ID,
    invoice_number: 'I00009',
    organization_id: ORG_ID,
    organization: PUBLIC_ORG,
    status: 'SENT',
    kind: 'DEPOSIT',
    subtotal: 531.25,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 531.25,
    amount_due: 531.25,
    due_date: null,
    sent_at: new Date('2026-07-28'),
    paid_at: null,
    created_at: new Date('2026-07-28'),
    public_token: DEP_TOKEN,
    customer: { first_name: 'John', last_name: 'Doe', company_name: null },
    line_items: [],
    job: null,
    payments: [],
    estimate: {
      status: estimate.status,
      modified_after_send: estimate.modified_after_send,
      deposit_type: estimate.deposit_type ?? null,
      deposit_value: estimate.deposit_value ?? null,
      total_amount: estimate.total_amount,
    },
  };
}

type Row = Record<string, unknown>;

/** The in-memory estimate table every request in this file reads and writes. */
let rows: Record<string, Row>;

function seedRow(over: Row): Row {
  return {
    ...ESTIMATE_FIXTURE,
    organization_id: ORG_ID,
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    created_by: TEST_USERS.admin.id,
    lead_id: 'lead-1',
    status: 'SENT',
    valid_until: new Date('2099-12-31'),
    superseded_by_id: null,
    snapshot_terms: null,
    scopes: null,
    scope_photos: [],
    invoices: [],
    send_config: null,
    subtotal: 1000,
    tax_amount: 62.5,
    total_amount: 1062.5,
    _count: { line_items: 2 },
    lead: {
      lead_assignees: [{ user_id: TEST_USERS.sales.id }],
      status: 'QUOTED',
      customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: null, email: CUSTOMER_FIXTURE.email },
    },
    customer: { id: CUSTOMER_FIXTURE.id, first_name: 'John', last_name: 'Doe', company_name: null, email: CUSTOMER_FIXTURE.email },
    job_id: null,
    job: null,
    job_link: null,
    modified_after_send: false,
    version: 1,
    ...over,
  };
}

function matches(where: Row, row: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND' || k === 'OR' || k === 'organization_id') continue;
    if ((row as Row)[k] !== v) return false;
  }
  return true;
}

/**
 * One transaction client covering every shape these routes open: revise's clone-create +
 * freeze-update + deposit re-point, and send's mint-committing update. Both write through to
 * `rows`, so the next request in the test sees what the last one stored.
 */
function makeTx() {
  return {
    estimate: {
      create: vi.fn().mockImplementation(({ data }: { data: Row }) => {
        rows[NEW_ID] = seedRow({ ...data, id: NEW_ID, public_token: null, valid_until: null, line_items: ESTIMATE_FIXTURE.line_items });
        return Promise.resolve(rows[NEW_ID]);
      }),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(rows[where.id], data);
        return Promise.resolve(rows[where.id]);
      }),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(rows[where.id] ?? null)),
    },
    estimateSendConfig: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) },
    deposit: { create: vi.fn().mockResolvedValue({}) },
    invoice: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'dep-inv' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockImplementation(({ data }: { data: { estimate_id?: string } }) => {
        if (data.estimate_id) depositInvoice.estimate_id = data.estimate_id;
        return Promise.resolve({ count: 1 });
      }),
    },
    timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue(null) },
    estimateVersionSnapshot: { create: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    [OLD_ID]: seedRow({ id: OLD_ID, estimate_number: 'E00002', public_token: OLD_TOKEN, line_items: ESTIMATE_FIXTURE.line_items }),
    [SIBLING_ID]: seedRow({ id: SIBLING_ID, estimate_number: 'E00003', public_token: SIBLING_TOKEN, line_items: ESTIMATE_FIXTURE.line_items }),
  };

  mockPrisma.estimate.findUnique.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(rows[where.id as string] ?? null));
  mockPrisma.estimate.findFirst.mockImplementation(({ where }: { where: Row }) => {
    const row = rows[where.id as string];
    return Promise.resolve(row && matches(where, row) ? row : null);
  });
  mockPrisma.estimate.update.mockImplementation(({ where, data }: { where: { id: string }; data: Row }) => {
    Object.assign(rows[where.id], data);
    return Promise.resolve(rows[where.id]);
  });
  depositInvoice = { estimate_id: OLD_ID };
  mockPrisma.invoice.findFirst.mockImplementation(({ where }: { where: Row }) =>
    Promise.resolve(where.id === DEP_INV_ID && where.public_token === DEP_TOKEN ? depositInvoiceRow() : null));
  (isStripeConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (getStripeForOrg as ReturnType<typeof vi.fn>).mockReturnValue({ stripe: {}, stripeAccount: 'acct_test' });
  (createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.test/cs_test_1' });
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(PUBLIC_ORG);
  mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(makeTx()) : Promise.resolve([]));
});

const publicUrl = (id: string, token: string) => `/api/estimates/${id}/public?token=${token}`;

describe('revise() revokes the superseded estimate\'s public link (ruling 17)', () => {
  it('the old link opens BEFORE the revise, and 404s after it', async () => {
    mockAuthAs('admin');

    const before = await request(app).get(publicUrl(OLD_ID, OLD_TOKEN));
    expect(before.status).toBe(200);

    const revised = await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));
    expect(revised.status).toBe(200);

    const after = await request(app).get(publicUrl(OLD_ID, OLD_TOKEN));
    expect(after.status).toBe(404);
  });
});

describe('a SUPERSEDED estimate cannot be sent (ruling 18)', () => {
  it('POST /:id/send is refused with a 400 and mints no token', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));
    expect(rows[OLD_ID].status).toBe('SUPERSEDED');

    const res = await request(app)
      .post(`/api/estimates/${OLD_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(res.status).toBe(400);
    // The refusal has to sit BEFORE the mint, not after it: re-read the row.
    expect(rows[OLD_ID].public_token).toBeNull();
  });
});

describe('the bulk reminder does not tell a rep to use a control that is gone', () => {
  it('refuses a SUPERSEDED id without pointing at "Send a copy", and keeps the closed-status copy for WON', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));
    rows[SIBLING_ID].status = 'WON';

    const res = await request(app)
      .post('/api/estimates/bulk-send-reminder')
      .set(authHeader('admin'))
      .send({ ids: [OLD_ID, SIBLING_ID] });

    expect(res.status).toBe(200);
    const superseded = res.body.failed.find((f: { id: string }) => f.id === OLD_ID);
    expect(superseded.error).not.toContain('Send a copy');
    expect(superseded.error).toContain('current revision');
    // The other closed statuses keep the advice that is still true for them.
    const won = res.body.failed.find((f: { id: string }) => f.id === SIBLING_ID);
    expect(won.error).toContain('Send a copy');
  });
});

describe('the revocation is narrow: one row, access only', () => {
  it('leaves a SIBLING estimate\'s link live through a revise', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    const sibling = await request(app).get(publicUrl(SIBLING_ID, SIBLING_TOKEN));
    expect(sibling.status).toBe(200);
  });

  it('gives the NEW revision its own live link at its own first send, while the old one stays dead', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    const sent = await request(app)
      .post(`/api/estimates/${NEW_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });
    expect(sent.status).toBe(200);

    const newToken = rows[NEW_ID].public_token as string;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(OLD_TOKEN);
    expect((await request(app).get(publicUrl(NEW_ID, newToken))).status).toBe(200);
    expect((await request(app).get(publicUrl(OLD_ID, OLD_TOKEN))).status).toBe(404);
  });

  it('keeps the superseded row\'s history and priced content - staff still read it in the app', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    const res = await request(app).get(`/api/estimates/${OLD_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate.status).toBe('SUPERSEDED');
    expect(res.body.estimate.superseded_by_id).toBe(NEW_ID);
    expect(res.body.estimate.estimate_number).toBe('E00002');
    expect(res.body.estimate.total_amount).toBe(1062.5);
    expect(res.body.estimate.line_items).toHaveLength(2);
  });

  it('still renders the superseded estimate\'s PDF for staff', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    const res = await request(app).get(`/api/estimates/${OLD_ID}/pdf`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(generateEstimatePdf).toHaveBeenCalled();
  });
});

describe('the deposit invoice revise() re-points is a separate document', () => {
  it('keeps its own public link, and still takes money once the new revision has gone out', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));
    // The re-point happened: the deposit now hangs off the new revision, not the superseded row.
    expect(depositInvoice.estimate_id).toBe(NEW_ID);

    // Its OWN token is untouched by the estimate's revocation.
    const page = await request(app).get(`/api/invoices/${DEP_INV_ID}/public?token=${DEP_TOKEN}`);
    expect(page.status).toBe(200);

    // And it pays, through that same unrotated link, once the revision it now belongs to is sent.
    await request(app)
      .post(`/api/estimates/${NEW_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    const checkout = await request(app)
      .post(`/api/invoices/${DEP_INV_ID}/public/checkout?token=${DEP_TOKEN}`)
      .send({});
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkout_url).toBe('https://checkout.test/cs_test_1');
  });
});

/**
 * The known, deliberately UNGUARDED way back to a live link. It gets no new gate in this slice
 * (it is narrow, pre-existing and needs a staff member to act twice), but the behaviour is pinned
 * here so the next reader knows it was considered rather than missed.
 *
 * Re-measured on this base: the free status setter builds its data through
 * `buildStatusChangeData`, which mints NO token on the way into WON - so the "markWon mints a
 * public_token if missing (archival)" resurrection lives on `recordEstimatePayment`, and that
 * door refuses SUPERSEDED outright. The single remaining route is status → SENT, then a send.
 */
describe('resurrecting a superseded estimate\'s link takes two deliberate staff actions', () => {
  it('moving SUPERSEDED → WON does NOT hand the link back', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    const res = await request(app)
      .patch(`/api/estimates/${OLD_ID}/status`)
      .set(authHeader('admin'))
      .send({ status: 'WON' });

    expect(res.status).toBe(200);
    expect(rows[OLD_ID].public_token).toBeNull();
    expect((await request(app).get(publicUrl(OLD_ID, OLD_TOKEN))).status).toBe(404);
  });

  it('moving SUPERSEDED → SENT and then sending DOES mint a fresh link - by design, unguarded', async () => {
    mockAuthAs('admin');
    await request(app).post(`/api/estimates/${OLD_ID}/revise`).set(authHeader('admin'));

    await request(app)
      .patch(`/api/estimates/${OLD_ID}/status`)
      .set(authHeader('admin'))
      .send({ status: 'SENT' });
    const sent = await request(app)
      .post(`/api/estimates/${OLD_ID}/send`)
      .set(authHeader('admin'))
      .send({ deposit_required: false, payment_methods: [] });

    expect(sent.status).toBe(200);
    const revived = rows[OLD_ID].public_token as string;
    expect(revived).toBeTruthy();
    // A FRESH token - the customer's original URL stays dead either way.
    expect(revived).not.toBe(OLD_TOKEN);
    expect((await request(app).get(publicUrl(OLD_ID, OLD_TOKEN))).status).toBe(404);
  });
});

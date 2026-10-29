/**
 * estimate-notifications.test.ts
 *
 * TDD for Task 3.3: emit() hooks on estimate lifecycle events.
 *
 * Verbs covered:
 *   1. estimate.approved  — THREE paths that must share dedupKey 'estimate.approved:<id>'
 *      (a) approvePublic no-deposit branch
 *      (b) recordEstimatePayment (fully paid)
 *      (c) Stripe webhook checkout.session.completed (kind=DEPOSIT)
 *   2. estimate.deposit_paid  — recordEstimatePayment + Stripe webhook (separate dedupKey)
 *   3. estimate.declined  — declinePublic (actorId null, data.lost_reason)
 *   4. estimate.cancelled — cancel() (staff actor)
 *   5. estimate.deposit_waived — waiveDeposit (staff actor, action=waive)
 *
 * Strategy: vi.mock captures emit calls. Each test hits the real Express route
 * via supertest. Prisma is fully mocked (vi.mock in setup.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ESTIMATE_FIXTURE,
  ESTIMATE_SENT_FIXTURE,
  ALPHA_ORG_ID,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id; // 'f0000000-0000-0000-0000-000000000002'
const ESTIMATE_NUM = ESTIMATE_SENT_FIXTURE.estimate_number; // 'E00002'
const COMMISSION_OWNER_ID = TEST_USERS.sales.id;
const EXPECTED_DEDUP_KEY = `estimate.approved:${ESTIMATE_ID}`;
const EXPECTED_DEPOSIT_DEDUP_KEY = `estimate.deposit_paid:${ESTIMATE_ID}`;
const LEAD_ID = ESTIMATE_FIXTURE.lead_id; // 'e0000000-0000-0000-0000-000000000001'

/** Shared: the estimate returned by findFirst/findUnique for approvePublic */
const SENT_NO_DEPOSIT = {
  id: ESTIMATE_ID,
  status: 'SENT',
  estimate_number: ESTIMATE_NUM,
  lead_id: ESTIMATE_FIXTURE.lead_id,
  organization_id: ALPHA_ORG_ID,
  total_amount: 1062.5,
  valid_until: new Date('2027-12-31'),
  snapshot_terms: null,
  signature_data: null,
  invoices: [],
  send_config: { deposit_required: false, payment_methods: [] },
  organization: {
    id: ALPHA_ORG_ID,
    stripe_account_id: null,
    accepted_payment_methods: ['CHECK'],
  },
  lead: {
    commission_owner_id: COMMISSION_OWNER_ID,
  },
};

/** For recordEstimatePayment: existing estimate row */
const DRAFT_ESTIMATE_EXISTING = {
  id: ESTIMATE_ID,
  status: 'DRAFT',
  estimate_number: ESTIMATE_NUM,
  total_amount: 1000,
  public_token: null,
  valid_until: null,
  lead_id: ESTIMATE_FIXTURE.lead_id,
  lead: {
    lead_assignees: [{ user_id: COMMISSION_OWNER_ID }],
    customer: { id: 'c0000000-0000-0000-0000-0000000000aa' },
    commission_owner_id: COMMISSION_OWNER_ID,
  },
  send_config: null,
};

/** Approved estimate returned from the tx.estimate.findUnique */
const APPROVED_ESTIMATE = {
  id: ESTIMATE_ID,
  estimate_number: ESTIMATE_NUM,
  status: 'WON',
  lead_id: ESTIMATE_FIXTURE.lead_id,
  lead: {
    commission_owner_id: COMMISSION_OWNER_ID,
  },
};

/** The kind=DEPOSIT Invoice for Stripe webhook tests */
const ORG_STRIPE = {
  id: 'org_stripe_1',
  stripe_account_id: 'acct_test',
  accepted_payment_methods: ['CARD', 'CHECK'],
};

const DEPOSIT_ESTIMATE_WEBHOOK = {
  id: ESTIMATE_ID,
  lead_id: 'e0000000-0000-0000-0000-000000000001',
  estimate_number: ESTIMATE_NUM,
  total_amount: 1062.5,
  status: 'SENT',
  creator: { email: 'creator@example.com' },
  organization: { name: 'ACME Corp', logo_url: null, brand_color: null },
  lead: {
    commission_owner_id: COMMISSION_OWNER_ID,
    customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Smith', company_name: null, email: 'jane@example.com' },
  },
};

const DEPOSIT_INVOICE_FIXTURE = {
  id: 'd1000000-0000-0000-0000-000000000001',
  invoice_number: 'I00009',
  status: 'SENT',
  kind: 'DEPOSIT',
  amount_due: 500,
  total_amount: 500,
  organization_id: ORG_STRIPE.id,
  organization: ORG_STRIPE,
  customer: null,
  job: null,
  estimate: DEPOSIT_ESTIMATE_WEBHOOK,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  // canAccessRow and row-scope checks.
  mockPrisma.estimate.findFirst.mockResolvedValue(null);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.estimate.findUnique.mockResolvedValue(null);

  // loadGrantsFor() used by the canDo middleware.
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // Default: no stripeEvent duplicate.
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);
  mockPrisma.stripeEvent.create.mockResolvedValue({});

  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.appSetting.findUnique.mockResolvedValue({ value: '50' });
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: ALPHA_ORG_ID,
    deposit_default_type: 'PERCENTAGE',
    deposit_default_percentage: 50,
    deposit_default_fixed_amount: null,
  });

  // Safe default $transaction — passthrough to avoid stale implementations
  // Each test that uses $transaction overrides this with its own mock.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      estimate: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null) },
      lead: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      invoice: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      payment: { create: vi.fn().mockResolvedValue({}) },
      stripeEvent: { create: vi.fn().mockResolvedValue({}) },
      estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
});

// ── Regression guard for #271 ────────────────────────────────────────────────
// Notification emits MUST fire post-commit, never inside a $transaction. Passing a
// tx client to emit() silently drops the notification in prod (filterByAccess reads
// on the global prisma connection while the caller's txn holds the row). Fail loudly
// if any emit in any test carries a tx.
afterEach(() => {
  for (const call of mockEmit.mock.calls) {
    expect(
      (call[0] as { tx?: unknown }).tx,
      `emit('${(call[0] as { verb?: string }).verb}') must be called post-commit, without a tx client (#271)`,
    ).toBeUndefined();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. approvePublic — no-deposit branch (Path A)
// ─────────────────────────────────────────────────────────────────────────────

describe('approvePublic (no-deposit) — estimate.approved with dedupKey (path A)', () => {
  it('emits estimate.approved with actorId:null and the correct dedupKey', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(SENT_NO_DEPOSIT);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...SENT_NO_DEPOSIT, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );
    // fire-and-forget email path
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.approved');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBeNull(); // public path → no actor
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.object.label).toBe(ESTIMATE_NUM);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(args.dedupKey).toBe(EXPECTED_DEDUP_KEY);
    expect(args.data).toMatchObject({ lead_id: LEAD_ID });
  });

  // #2090 slice 3d - the approval notification names what the customer bought and what they
  // turned down, derived from the document's own rows.
  it('carries the chosen and declined add-ons in the data bag', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue(SENT_NO_DEPOSIT);
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ ...SENT_NO_DEPOSIT, status: 'WON' }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );
    // The option-summary read, then the fire-and-forget email read.
    mockPrisma.estimate.findUnique
      .mockResolvedValueOnce({
        scopes: [{ id: 's1', title: 'Permit filing', flat_price: 150, is_taxable: true, is_optional: true, is_selected: false }],
        line_items: [
          { description: 'Door install', is_optional: false, is_selected: true },
          { description: 'Smart keypad\nBluetooth unlock', is_optional: true, is_selected: true },
        ],
      })
      .mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/approve?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ signature_data: 'data:image/png;base64,abc123' });

    expect(res.status).toBe(200);
    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.approved');
    expect(call![0].data).toMatchObject({
      options_chosen: 'Smart keypad',
      options_declined: 'Permit filing',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. recordEstimatePayment — estimate.approved + estimate.deposit_paid (Path B)
// ─────────────────────────────────────────────────────────────────────────────

describe('recordEstimatePayment — estimate.approved + estimate.deposit_paid (path B)', () => {
  it('emits estimate.approved with same dedupKey and estimate.deposit_paid on full payment', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(DRAFT_ESTIMATE_EXISTING);
    // canAccessRow uses findFirst; return a truthy row for all calls in this test.
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: {
          findFirst: vi.fn().mockResolvedValue({ id: 'dep-inv-1', amount_due: 500, total_amount: 500 }),
          update: vi.fn().mockResolvedValue({}),
        },
        payment: { create: vi.fn().mockResolvedValue({}) },
        estimate: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue(APPROVED_ESTIMATE),
        },
        estimateSendConfig: { create: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/record-payment`)
      .set(authHeader('admin'))
      .send({ amount: 500, deposit_percentage: 50, payment_method: 'CHECK' });

    expect(res.status).toBe(200);

    // estimate.approved must carry the same dedupKey as path A
    const approvedCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.approved');
    expect(approvedCall).toBeDefined();
    const approvedArgs = approvedCall![0];
    expect(approvedArgs.actorId).toBe(TEST_USERS.admin.id); // staff path → actor present
    expect(approvedArgs.object.type).toBe('ESTIMATE');
    expect(approvedArgs.object.id).toBe(ESTIMATE_ID);
    expect(approvedArgs.object.label).toBe(ESTIMATE_NUM);
    expect(approvedArgs.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(approvedArgs.dedupKey).toBe(EXPECTED_DEDUP_KEY); // SAME key as path A
    expect(approvedArgs.data).toMatchObject({ lead_id: LEAD_ID });

    // estimate.deposit_paid must also be emitted with its own dedupKey
    const depositCall = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_paid');
    expect(depositCall).toBeDefined();
    const depositArgs = depositCall![0];
    expect(depositArgs.actorId).toBe(TEST_USERS.admin.id);
    expect(depositArgs.object.type).toBe('ESTIMATE');
    expect(depositArgs.object.id).toBe(ESTIMATE_ID);
    expect(depositArgs.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(depositArgs.dedupKey).toBe(EXPECTED_DEPOSIT_DEDUP_KEY);
    expect(depositArgs.data).toMatchObject({ lead_id: LEAD_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stripe webhook — estimate.approved + estimate.deposit_paid (Path C)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post a webhook as a Buffer (matches how the real Stripe SDK + express raw parser work).
 * In test env the signature check is skipped; the body is parsed as-is.
 */
function postWebhook(body: object, sig = 'test_sig') {
  return request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', sig)
    .send(Buffer.from(JSON.stringify(body)));
}

describe('Stripe webhook checkout.session.completed (kind=DEPOSIT) — path C', () => {
  // amount_due=500, face value.
  // expectedCents = Math.round(500 * 100) = 50000
  const EXPECTED_CENTS = 50000;

  const webhookEvent = {
    id: 'evt_001',
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { invoiceId: DEPOSIT_INVOICE_FIXTURE.id },
        payment_intent: 'pi_test_001',
        amount_total: EXPECTED_CENTS,
      },
    },
  };

  beforeEach(() => {
    mockPrisma.invoice.findUnique.mockResolvedValue(DEPOSIT_INVOICE_FIXTURE);
    mockPrisma.organization.findFirst.mockResolvedValue(ORG_STRIPE);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        stripeEvent: { create: vi.fn().mockResolvedValue({}) },
        payment: { create: vi.fn().mockResolvedValue({ id: 'pay-1' }) },
        invoice: { update: vi.fn().mockResolvedValue({}) },
        estimate: { update: vi.fn().mockResolvedValue({}) },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('emits estimate.approved (actorId:null) with the SAME dedupKey as paths A+B', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.approved');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.actorId).toBeNull(); // webhook → no actor
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.object.label).toBe(ESTIMATE_NUM);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(args.dedupKey).toBe(EXPECTED_DEDUP_KEY); // SAME key as paths A + B
    expect(args.data).toMatchObject({ lead_id: LEAD_ID });
  });

  it('also emits estimate.deposit_paid (actorId:null) with its own dedupKey', async () => {
    const res = await postWebhook(webhookEvent);

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_paid');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.actorId).toBeNull();
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(args.dedupKey).toBe(EXPECTED_DEPOSIT_DEDUP_KEY);
    expect(args.data).toMatchObject({ lead_id: LEAD_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. declinePublic — estimate.declined (actorId null, includes lost_reason)
// ─────────────────────────────────────────────────────────────────────────────

describe('declinePublic — estimate.declined', () => {
  it('emits estimate.declined with actorId:null and data.lost_reason', async () => {
    // declinePublic uses findFirst (public_token guard). Return the estimate WITH
    // commission_owner_id so once the hook is implemented, it can source it.
    mockPrisma.estimate.findFirst.mockResolvedValue({
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_NUM,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      organization_id: ALPHA_ORG_ID,
      lead: {
        commission_owner_id: COMMISSION_OWNER_ID,
      },
    });

    // declinePublic runs inside a $transaction: estimate.update → timelineEvent.create → invoice.updateMany.
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: ESTIMATE_ID, estimate_number: ESTIMATE_NUM, status: 'DECLINED' }),
        },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    // fire-and-forget email path — findUnique resolves null (no side effects)
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/decline?token=${ESTIMATE_SENT_FIXTURE.public_token}`)
      .send({ lost_reason: 'PRICE' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.declined');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBeNull(); // public path
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.object.label).toBe(ESTIMATE_NUM);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
    expect(args.data?.lost_reason).toBe('PRICE');
    // no dedupKey for declined
    expect(args.dedupKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. setStatus (free setter, Spec B1) — emits the BUSINESS verb, not a bland correction
// ─────────────────────────────────────────────────────────────────────────────
// Estimate status is unordered now, so WON/DECLINED/ARCHIVED are reachable straight from the
// status pill. That is the same business event as approve-internal/decline-internal/cancel and
// must raise the same verb - otherwise the feed reports which control the user happened to press.

describe('setStatus (unordered) — emits the business verb per target', () => {
  it.each([
    ['WON', 'estimate.approved', {}],
    ['DECLINED', 'estimate.declined', { lost_reason: 'PRICE' }],
    ['ARCHIVED', 'estimate.cancelled', {}],
  ])('a move to %s emits %s', async (target, verb, extra) => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_NUM,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      public_token: 'live-token',
      job: null,
      invoices: [],
      lead: { lead_assignees: [], commission_owner_id: COMMISSION_OWNER_ID, status: 'ESTIMATED' },
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: ESTIMATE_ID, estimate_number: ESTIMATE_NUM }),
          count: vi.fn().mockResolvedValue(0),
          findUnique: vi.fn().mockResolvedValue(null),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue({ id: 'res-1' }), create: vi.fn() },
      }),
    );
    mockEmit.mockClear();

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/status`)
      .set(authHeader('admin'))
      .send({ status: target, ...extra });

    expect(res.status).toBe(200);
    expect(mockEmit.mock.calls.find((c: unknown[]) => (c[0] as { verb: string }).verb === verb)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. cancel — estimate.cancelled (staff actor)
// ─────────────────────────────────────────────────────────────────────────────

describe('cancel — estimate.cancelled', () => {
  it('emits estimate.cancelled with the staff actorId', async () => {
    mockAuthAs('admin');

    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_NUM,
      lead: {
        lead_assignees: [{ user_id: COMMISSION_OWNER_ID }],
        commission_owner_id: COMMISSION_OWNER_ID,
      },
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({
            id: ESTIMATE_ID,
            estimate_number: ESTIMATE_NUM,
            status: 'ARCHIVED',
            lead: { commission_owner_id: COMMISSION_OWNER_ID },
          }),
        },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/cancel`)
      .set(authHeader('admin'))
      .send({ cancelled_reason: 'Customer changed mind' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.cancelled');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.object.label).toBe(ESTIMATE_NUM);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. waiveDeposit — estimate.deposit_waived (staff actor, action=waive)
// ─────────────────────────────────────────────────────────────────────────────

describe('waiveDeposit — estimate.deposit_waived', () => {
  it('emits estimate.deposit_waived with the staff actorId when action=waive', async () => {
    mockAuthAs('admin');

    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_NUM,
      lead_id: ESTIMATE_FIXTURE.lead_id,
      lead: {
        commission_owner_id: COMMISSION_OWNER_ID,
      },
      invoices: [{ id: 'dep-inv-1', status: 'SENT' }],
    });

    mockPrisma.estimate.count.mockResolvedValue(0);

    // canAccessRow uses findFirst
    mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        invoice: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
        estimate: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({
            id: ESTIMATE_ID,
            estimate_number: ESTIMATE_NUM,
            status: 'WON',
            lead: { commission_owner_id: COMMISSION_OWNER_ID },
          }),
        },
        lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_ID}/waive-deposit`)
      .set(authHeader('admin'))
      .send({ action: 'waive' });

    expect(res.status).toBe(200);

    const call = mockEmit.mock.calls.find((c: any[]) => c[0].verb === 'estimate.deposit_waived');
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.object.type).toBe('ESTIMATE');
    expect(args.object.id).toBe(ESTIMATE_ID);
    expect(args.object.label).toBe(ESTIMATE_NUM);
    expect(args.entity.commission_owner_id).toBe(COMMISSION_OWNER_ID);
  });
});

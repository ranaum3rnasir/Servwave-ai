/* =============================================================================
   Payments go-live, slice 15 - the deposit checkout charges what is left on the deposit, and only
   while the deposit can still take money.

   Before this slice the estimate's approve door (POST /api/estimates/:id/approve) built the
   deposit's checkout at the deposit invoice's TOTAL. After staff record part of a deposit by hand,
   the customer was asked for the whole deposit again: a $500 deposit with $200 recorded opened a
   $500 checkout, an overcharge the reconciler could only write down as unapplied money.

   This suite drives the real public routes against a real, migrated database. Only the processor
   SDK is replaced, by a recorder: the assertions are on the amount handed to it and on what the
   customer is told when the door refuses.

   Skips when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

// The suite-wide setup mocks the app's client; here it is a real one, built by the one factory.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const clientAt = (url: string) => new PrismaClient({ datasources: { db: { url } } });
  const url = process.env.TEST_DATABASE_URL;
  return { prisma: url ? clientAt(url) : undefined };
});

// The real session builder runs; only the processor SDK underneath it records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = {
      sessions: {
        create: sessionsCreate,
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        expire: vi.fn().mockResolvedValue({}),
      },
    };
  },
}));

import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

suite('deposit checkout charges the amount due, only while the deposit is open (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_deposit_amount_due_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    sessionsCreate.mockReset();
    sessionsCreate.mockResolvedValue({ id: `cs_${randomUUID().slice(0, 8)}`, url: 'https://checkout.example/deposit' });
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /**
   * A sent $1,000 estimate asking for a $500 card deposit, its deposit invoice minted at send, and
   * $`recordedByHand` already recorded against that deposit by staff.
   */
  async function sentEstimateWithDeposit(opts: {
    recordedByHand?: number;
    depositStatus?: 'SENT' | 'PARTIAL' | 'PAID' | 'VOIDED';
    estimateStatus?: 'SENT' | 'PENDING';
  } = {}) {
    const recorded = opts.recordedByHand ?? 0;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const estimate = randomUUID();
    const deposit = randomUUID();
    const estimateToken = `est-${tag}`;
    const depositToken = `dep-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay15-${tag}`, email: `pay15-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay15_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const retry = opts.estimateStatus === 'PENDING';
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: opts.estimateStatus ?? 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000,
        public_token: estimateToken, deposit_type: 'FIXED', deposit_value: 500,
        ...(retry ? { signature_data: SIGNATURE, signature_at: new Date() } : {}),
        send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'CHECK'] } },
      },
    });
    const depositStatus = opts.depositStatus ?? (recorded > 0 ? 'PARTIAL' : 'SENT');
    await db.invoice.create({
      data: {
        id: deposit, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
        invoice_number: `D-${tag}`, status: depositStatus, subtotal: 500, tax_amount: 0, total_amount: 500,
        amount_due: depositStatus === 'PAID' ? 0 : 500 - recorded, public_token: depositToken,
        ...(depositStatus === 'VOIDED' ? { voided_at: new Date() } : {}),
      },
    });
    if (recorded > 0) {
      await db.payment.create({
        data: { invoice_id: deposit, amount: recorded, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED', created_by_source: 'USER' },
      });
    }
    const approve = () => request(app)
      .post(`/api/estimates/${estimate}/approve?token=${estimateToken}`)
      .send({ payment_method: 'CARD', ...(retry ? {} : { signature_data: SIGNATURE }) });
    const readEstimate = () => db.estimate.findUniqueOrThrow({ where: { id: estimate } });
    return { org, estimate, deposit, depositToken, approve, readEstimate };
  }

  /** The amounts, in cents, on the one checkout session the processor was asked for. */
  function chargedCents(): number[] {
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0];
    return params.line_items.map((li: { price_data: { unit_amount: number } }) => li.price_data.unit_amount);
  }

  it('a $500 deposit with $200 recorded by hand opens a $300 checkout when the customer approves', async () => {
    const f = await sentEstimateWithDeposit({ recordedByHand: 200 });

    const res = await f.approve();

    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toBe('https://checkout.example/deposit');
    expect(chargedCents()).toEqual([30000]);
    expect(sessionsCreate.mock.calls[0][0].metadata).toMatchObject({ invoiceId: f.deposit, kind: 'deposit', payableNowCents: '30000' });
  });

  // V7-12a pin (no overpaid invoices, BE-14 row 2): the deposit door never lets the caller pick the
  // amount. It prices at payable-now, so a body that asks for more cannot make it charge more
  // (the door passes no requestedCents to the pricing module).
  it('ignores an amount or tip in the body: the deposit is charged at exactly what is left', async () => {
    const f = await sentEstimateWithDeposit({ recordedByHand: 200 });

    const res = await request(app)
      .post(`/api/estimates/${f.estimate}/approve?token=est-${f.org.slice(0, 8)}`)
      .send({ payment_method: 'CARD', signature_data: SIGNATURE, amount: 900, requested_amount: 900, tip: 50 });

    expect(res.status).toBe(200);
    expect(chargedCents()).toEqual([30000]);
  });

  // The retry door: the customer signed, abandoned the checkout, staff then recorded part of the
  // deposit (which closes the open link), and the customer comes back to pay the rest.
  it('a signed estimate coming back to pay after $200 was recorded by hand is asked for $300', async () => {
    const f = await sentEstimateWithDeposit({ recordedByHand: 200, estimateStatus: 'PENDING' });

    const res = await f.approve();

    expect(res.status).toBe(200);
    expect(chargedCents()).toEqual([30000]);
  });

  // The refusals. Each one carries a code the public page can explain, opens no checkout and
  // leaves the estimate exactly as it was (no signature taken, still SENT).
  it.each([
    { depositStatus: 'PAID' as const, code: 'DEPOSIT_ALREADY_PAID' },
    { depositStatus: 'VOIDED' as const, code: 'DEPOSIT_VOIDED' },
  ])('a $depositStatus deposit is refused with $code and nothing is written', async ({ depositStatus, code }) => {
    const f = await sentEstimateWithDeposit({ depositStatus });

    const res = await f.approve();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toEqual(expect.any(String));
    expect(sessionsCreate).not.toHaveBeenCalled();
    const after = await f.readEstimate();
    expect(after.status).toBe('SENT');
    expect(after.signature_data).toBeNull();
  });

  it('a deposit on hold (the estimate changed and its deposit figure no longer agrees) is refused with the hold code', async () => {
    const f = await sentEstimateWithDeposit();
    // A material edit after send: the estimate now asks for a $600 deposit, the link still for $500.
    await db.estimate.update({ where: { id: f.estimate }, data: { modified_after_send: true, deposit_value: 600 } });

    const res = await f.approve();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DEPOSIT_SUPERSEDED');
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect((await f.readEstimate()).status).toBe('SENT');
  });

  // The deposit invoice's own public link is the other door into the same checkout.
  describe('the deposit link', () => {
    const pay = (f: { deposit: string; depositToken: string }) =>
      request(app).post(`/api/invoices/${f.deposit}/public/checkout?token=${f.depositToken}`).send({ method: 'card' });

    it('opens a $300 checkout for a $500 deposit with $200 recorded by hand', async () => {
      const f = await sentEstimateWithDeposit({ recordedByHand: 200 });

      const res = await pay(f);

      expect(res.status).toBe(200);
      expect(chargedCents()).toEqual([30000]);
    });

    it.each([
      { depositStatus: 'PAID' as const, code: 'DEPOSIT_ALREADY_PAID' },
      { depositStatus: 'VOIDED' as const, code: 'DEPOSIT_VOIDED' },
    ])('refuses a $depositStatus deposit with $code', async ({ depositStatus, code }) => {
      const f = await sentEstimateWithDeposit({ depositStatus });

      const res = await pay(f);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(sessionsCreate).not.toHaveBeenCalled();
    });
  });
});

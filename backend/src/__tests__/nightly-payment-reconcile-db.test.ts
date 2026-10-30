/* =============================================================================
   Payments go-live, slice 37 - the nightly reconcile against the processor.

   Each night, per org with a connected account, the job lists the processor's charges, refunds and
   disputes since the last run and compares them with Payment, Refund and Dispute rows. Every kind
   of drift is alerted once (a log line per finding, one ops email per run) and counted on the org's
   run summary row, so "zero drift for seven nights" can be measured.

   The processor's lists are recorded fixtures handed to the mocked list calls (lib/stripe is mocked
   suite-wide); the ledger is a real migrated database (TEST_DATABASE_URL, skips when unset). Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import {
  listAccountCharges, listAccountCheckoutSessions, listAccountDisputes, listAccountRefunds, listPaymentIntentRefunds,
  listChargeRefunds, retrieveAccountPaymentIntent,
} from '../lib/stripe';
import { sendOpsAlertEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { reconcileOrg, runNightlyReconcile } from '../services/payment-reconcile';

const charges = listAccountCharges as unknown as ReturnType<typeof vi.fn>;
const refunds = listAccountRefunds as unknown as ReturnType<typeof vi.fn>;
const disputes = listAccountDisputes as unknown as ReturnType<typeof vi.fn>;
const sessions = listAccountCheckoutSessions as unknown as ReturnType<typeof vi.fn>;
const refundsOnIntent = listPaymentIntentRefunds as unknown as ReturnType<typeof vi.fn>;
const refundsOnCharge = listChargeRefunds as unknown as ReturnType<typeof vi.fn>;
const intentAtProcessor = retrieveAccountPaymentIntent as unknown as ReturnType<typeof vi.fn>;
const opsEmail = sendOpsAlertEmail as unknown as ReturnType<typeof vi.fn>;

const suite = realClient ? describe : describe.skip;

/** What the processor holds, per connected account (recorded list fixtures). */
interface ProcessorFixture {
  charges: Record<string, unknown>[];
  refunds: Record<string, unknown>[];
  disputes: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
}
const processor = new Map<string, ProcessorFixture>();
const held = (account: string): ProcessorFixture => processor.get(account) ?? { charges: [], refunds: [], disputes: [], sessions: [] };

const NOW = new Date('2026-10-11T03:00:00.000Z');
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
/** An hour before the run: inside the window, past the settling delay. */
const EARLIER = new Date(NOW.getTime() - 60 * 60 * 1000);

const charge = (o: { id: string; pi: string; cents: number; status?: string; created?: Date; refunded?: boolean }) => ({
  id: o.id, object: 'charge', amount: o.cents, amount_captured: o.cents, status: o.status ?? 'succeeded',
  payment_intent: o.pi, created: unix(o.created ?? EARLIER), metadata: {},
  ...(o.refunded ? { refunded: true, amount_refunded: o.cents } : {}),
});
const processorRefund = (o: { id: string; chargeId: string; pi: string; cents: number; status?: string; metadata?: Record<string, string> }) => ({
  id: o.id, object: 'refund', charge: o.chargeId, payment_intent: o.pi, amount: o.cents,
  status: o.status ?? 'succeeded', created: unix(EARLIER), metadata: o.metadata ?? {},
});
const processorDispute = (o: { id: string; chargeId: string; pi: string; cents: number; status: string }) => ({
  id: o.id, object: 'dispute', charge: o.chargeId, payment_intent: o.pi, amount: o.cents, status: o.status,
  reason: 'fraudulent', created: unix(EARLIER),
});

suite('nightly payment reconcile (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];

  /** An org with a connected account and one SENT invoice of `total` dollars. */
  async function seedOrg(opts: { total?: number } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay37_${tag}`;
    const total = opts.total ?? 100;
    await db.organization.create({
      data: {
        id: org, name: `pay37-${tag}`, email: `pay37-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, status: 'PAID', amount_due: 0, paid_at: EARLIER,
      },
    });
    return { org, tag, user, customer, invoice, account };
  }
  type Seeded = Awaited<ReturnType<typeof seedOrg>>;

  /** A booked card payment with its charge, the way the checkout door leaves it. */
  async function addPayment(o: Seeded, p: { n: string; dollars: number; extraDollars?: number; state?: 'SUCCEEDED' | 'PROCESSING' | 'FAILED'; voided?: boolean; createdAt?: Date }) {
    return db.payment.create({
      data: {
        invoice_id: o.invoice, amount: p.dollars, method: 'CARD', paid_at: p.createdAt ?? EARLIER,
        created_at: p.createdAt ?? EARLIER,
        stripe_account_id: o.account, stripe_payment_intent_id: `pi_${p.n}_${o.tag}`, stripe_charge_id: `ch_${p.n}_${o.tag}`,
        state: p.state ?? 'SUCCEEDED', ...(p.extraDollars ? { tip_amount: p.extraDollars } : {}),
        ...(p.voided ? { voided_at: EARLIER } : {}),
      } as never,
    });
  }
  const chargeFor = (o: Seeded, n: string, cents: number) => charge({ id: `ch_${n}_${o.tag}`, pi: `pi_${n}_${o.tag}`, cents });

  function onProcessor(o: Seeded, f: Partial<ProcessorFixture>) {
    processor.set(o.account, { charges: [], refunds: [], disputes: [], sessions: [], ...f });
  }

  beforeEach(() => {
    processor.clear();
    for (const m of [charges, refunds, disputes, sessions, refundsOnIntent, refundsOnCharge, intentAtProcessor, opsEmail]) m.mockClear();
    charges.mockImplementation(async (acct: string) => held(acct).charges);
    refunds.mockImplementation(async (acct: string) => held(acct).refunds);
    disputes.mockImplementation(async (acct: string) => held(acct).disputes);
    sessions.mockImplementation(async (acct: string) => held(acct).sessions);
    refundsOnIntent.mockResolvedValue([]);
    refundsOnCharge.mockResolvedValue([]);
    intentAtProcessor.mockResolvedValue(null);
  });

  afterAll(async () => {
    // Children before parents; a failed delete fails the cleanup (no swallowed errors).
    for (const org of orgs) {
      for (const table of ['payment_reconcile_runs', 'unapplied_captures', 'disputes', 'refunds']) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'::uuid`);
      }
      await db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}'::uuid)`);
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'::uuid`);
      }
      await db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'::uuid`);
      await db.organization.delete({ where: { id: org } });
    }
    await db.$disconnect();
  });

  it('a clean org reports zero drift and writes its summary row', async () => {
    const o = await seedOrg();
    await addPayment(o, { n: 'a', dollars: 100 });
    onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings).toEqual([]);
    const runs = await db.paymentReconcileRun.findMany({ where: { organization_id: o.org } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'CLEAN', drift_count: 0 });
    expect(runs[0].window_end.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('a charge with no Payment row is one alert', async () => {
    const o = await seedOrg();
    onProcessor(o, { charges: [chargeFor(o, 'orphan', 12345)] });
    const warn = vi.spyOn(logger, 'warn');

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['CHARGE_NO_PAYMENT', `ch_orphan_${o.tag}`]]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CHARGE_NO_PAYMENT') && String(c[0]).includes(`ch_orphan_${o.tag}`))).toBe(true);
    const run = await db.paymentReconcileRun.findFirstOrThrow({ where: { organization_id: o.org } });
    expect(run).toMatchObject({ status: 'DRIFT', drift_count: 1, counts: { CHARGE_NO_PAYMENT: 1 } });
    warn.mockRestore();
  });

  it('a Payment whose charge the processor does not hold is one alert', async () => {
    const o = await seedOrg();
    const p = await addPayment(o, { n: 'ghost', dollars: 80 });
    onProcessor(o, { charges: [] });

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['PAYMENT_NO_CHARGE', p.id]]);
  });

  it('a payment recorded by hand (no processor charge) is not drift', async () => {
    const o = await seedOrg();
    await db.payment.create({ data: { invoice_id: o.invoice, amount: 40, method: 'CASH', paid_at: EARLIER, created_at: EARLIER } });
    onProcessor(o, {});

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings).toEqual([]);
  });

  it('an amount that differs between the charge and the Payment is one alert; tip and fee ride on top', async () => {
    const o = await seedOrg();
    const off = await addPayment(o, { n: 'off', dollars: 100 });
    await addPayment(o, { n: 'tipped', dollars: 50, extraDollars: 7.5 });
    onProcessor(o, { charges: [chargeFor(o, 'off', 9900), chargeFor(o, 'tipped', 5750)] });

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['AMOUNT_MISMATCH', off.id]]);
  });

  describe('a charge nothing recorded', () => {
    const LATER = new Date(NOW.getTime() + 4 * 24 * 3600_000);
    const recordsFor = (o: Seeded, n: string) => db.unappliedCapture.findMany({ where: { organization_id: o.org, stripe_payment_intent_id: `pi_${n}_${o.tag}` } });

    it('is alerted the first night but not written down while the processor may still retry its event', async () => {
      const o = await seedOrg();
      onProcessor(o, { charges: [chargeFor(o, 'lost', 3000)] });

      const first = await reconcileOrg(o.org, { now: NOW });

      expect(first.findings.map((f) => [f.kind, f.ref])).toEqual([['CHARGE_NO_PAYMENT', `ch_lost_${o.tag}`]]);
      expect(await recordsFor(o, 'lost')).toHaveLength(0);
    });

    it('is written down once, after the retry horizon, and a charge already on "needing attention" is not drift', async () => {
      const o = await seedOrg();
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'INVOICE_NOT_PAYABLE', amount: 20, stripe_payment_intent_id: `pi_known_${o.tag}`,
          stripe_account_id: o.account, source_key: `session:cs_known_${o.tag}`,
        },
      });
      onProcessor(o, { charges: [chargeFor(o, 'known', 2000), chargeFor(o, 'lost', 3000)] });

      const first = await reconcileOrg(o.org, { now: NOW });
      await reconcileOrg(o.org, { now: LATER });
      await reconcileOrg(o.org, { now: new Date(LATER.getTime() + 60_000) });

      expect(first.findings.map((f) => [f.kind, f.ref])).toEqual([['CHARGE_NO_PAYMENT', `ch_lost_${o.tag}`]]);
      const records = await recordsFor(o, 'lost');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: 'OPEN', stripe_account_id: o.account });
      expect(Number(records[0].amount)).toBe(30);
      expect(await recordsFor(o, 'known')).toHaveLength(1);
    });

    it('is never written down when the event retried in the meantime and booked its Payment', async () => {
      const o = await seedOrg();
      onProcessor(o, { charges: [chargeFor(o, 'late', 3000)] });
      await reconcileOrg(o.org, { now: NOW });
      await addPayment(o, { n: 'late', dollars: 30 });

      await reconcileOrg(o.org, { now: LATER });

      expect(await recordsFor(o, 'late')).toHaveLength(0);
    });
  });

  // Slice 37b
  describe('follow-ups (slice 37b)', () => {
    const DAY = 24 * 3600_000;

    it('item 1: an OPEN "charge with no payment" record whose charge now has a Payment is resolved, and counted as repaired, not drift', async () => {
      const o = await seedOrg();
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'INVOICE_NOT_FOUND', amount: 30, stripe_payment_intent_id: `pi_late_${o.tag}`,
          stripe_account_id: o.account, source_key: `charge:ch_late_${o.tag}`,
        },
      });
      await addPayment(o, { n: 'late', dollars: 30 });
      onProcessor(o, { charges: [chargeFor(o, 'late', 3000)] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings).toEqual([]);
      expect(result.repaired).toMatchObject({ charge_record_resolved: 1 });
      const record = await db.unappliedCapture.findFirstOrThrow({ where: { organization_id: o.org } });
      expect(record.status).toBe('RESOLVED');
      expect(await db.payment.count({ where: { invoice_id: o.invoice } })).toBe(1);
    });

    it('item 1: a record a person already refunded is left as they left it', async () => {
      const o = await seedOrg();
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'INVOICE_NOT_FOUND', amount: 30, stripe_payment_intent_id: `pi_late_${o.tag}`,
          stripe_account_id: o.account, source_key: `charge:ch_late_${o.tag}`, status: 'REFUNDED', refunded_at: EARLIER,
        },
      });
      await addPayment(o, { n: 'late', dollars: 30 });
      onProcessor(o, { charges: [chargeFor(o, 'late', 3000)] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toEqual({});
      expect((await db.unappliedCapture.findFirstOrThrow({ where: { organization_id: o.org } })).status).toBe('REFUNDED');
    });

    it('item 3: closing a stray-refund record never overwrites one a person resolved in the meantime', async () => {
      const o = await seedOrg();
      const rec = await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'REFUND_UNMATCHED', amount: 15, stripe_refund_id: `re_g_${o.tag}`,
          stripe_payment_intent_id: `pi_g_${o.tag}`, stripe_account_id: o.account, source_key: `refund:re_g_${o.tag}`,
          status: 'REFUNDED', refunded_at: EARLIER,
        },
      });
      onProcessor(o, {
        refunds: [processorRefund({ id: `re_g_${o.tag}`, chargeId: `ch_g_${o.tag}`, pi: `pi_g_${o.tag}`, cents: 1500, status: 'failed' })],
      });
      // The reconcile reads the record as OPEN; by the time it writes, a person has changed it.
      const spy = vi.spyOn(db.unappliedCapture, 'findFirst').mockResolvedValueOnce({ ...rec, status: 'OPEN' } as never);

      const result = await reconcileOrg(o.org, { now: NOW });
      spy.mockRestore();

      expect(result.repaired).toEqual({});
      expect((await db.unappliedCapture.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('REFUNDED');
    });

    it('item 4: an item created on the boundary second is looked at in one run only', async () => {
      const o = await seedOrg();
      const boundary = new Date(NOW.getTime() - 10 * 60_000); // the first run's window end
      onProcessor(o, { charges: [charge({ id: `ch_edge_${o.tag}`, pi: `pi_edge_${o.tag}`, cents: 2500, created: boundary })] });

      const first = await reconcileOrg(o.org, { now: NOW });
      const second = await reconcileOrg(o.org, { now: new Date(NOW.getTime() + DAY) });

      expect(first.findings).toEqual([]);
      expect(second.findings.map((f) => [f.kind, f.ref])).toEqual([['CHARGE_NO_PAYMENT', `ch_edge_${o.tag}`]]);
    });

    it('item 7: charges written down on an org\'s first-ever run raise a finding that night, once', async () => {
      const o = await seedOrg();
      const old = new Date(NOW.getTime() - 5 * DAY);
      onProcessor(o, {
        charges: [1, 2, 3, 4, 5].map((n) => charge({ id: `ch_old${n}_${o.tag}`, pi: `pi_old${n}_${o.tag}`, cents: 1000 * n, created: old })),
      });

      const first = await reconcileOrg(o.org, { now: NOW });
      const again = await reconcileOrg(o.org, { now: new Date(NOW.getTime() + 60_000) });

      expect(first.findings.map((f) => f.kind)).toEqual(Array(5).fill('CHARGE_NO_PAYMENT'));
      expect(await db.unappliedCapture.count({ where: { organization_id: o.org } })).toBe(5);
      expect(again.findings).toEqual([]);
    });
  });

  describe('follow-ups (slice 37b, holds and bank payments)', () => {
    const DAY = 24 * 3600_000;
    const HOUR = 3600_000;
    async function addHold(o: Seeded, paymentId: string, cents: number, createdAt: Date) {
      return db.refund.create({
        data: {
          organization_id: o.org, invoice_id: o.invoice, payment_id: paymentId, amount: cents / 100, method: 'CARD',
          reason_category: 'CUSTOMER_REQUEST', stripe_refund_id: null, state: 'PENDING', refunded_by: o.user, created_at: createdAt,
        },
      });
    }

    it('item 2: a hold whose payment has a charge id but no payment intent id is looked up by charge and completed', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      await db.payment.update({ where: { id: p.id }, data: { stripe_payment_intent_id: null } });
      const hold = await addHold(o, p.id, 4000, new Date(NOW.getTime() - 2 * HOUR));
      refundsOnCharge.mockResolvedValue([
        processorRefund({ id: `re_c_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 4000, metadata: { refund_row_id: hold.id } }),
      ]);
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(refundsOnCharge).toHaveBeenCalledTimes(1);
      expect(refundsOnCharge.mock.calls[0][0]).toBe(`ch_a_${o.tag}`);
      expect(result.repaired).toMatchObject({ refund_hold_completed: 1 });
      const row = await db.refund.findUniqueOrThrow({ where: { id: hold.id } });
      expect(row).toMatchObject({ stripe_refund_id: `re_c_${o.tag}`, state: 'SUCCEEDED' });
    });

    it('item 2: a hold that cannot be looked up at all (no charge id, no payment intent id) is a finding, not silence', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      await db.payment.update({ where: { id: p.id }, data: { stripe_payment_intent_id: null, stripe_charge_id: null } });
      const hold = await addHold(o, p.id, 4000, new Date(NOW.getTime() - 2 * HOUR));
      onProcessor(o, {});

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.filter((f) => f.kind === 'REFUND_HOLD_UNCHECKABLE').map((f) => f.ref)).toEqual([hold.id]);
      expect((await db.refund.findUniqueOrThrow({ where: { id: hold.id } })).state).toBe('PENDING');
    });

    it('item 5: a hold the refund\'s own event completed while the sweep was looking is not counted as a repair', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const hold = await addHold(o, p.id, 4000, new Date(NOW.getTime() - 2 * HOUR));
      const refund = processorRefund({ id: `re_e_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 4000, metadata: { refund_row_id: hold.id } });
      refundsOnIntent.mockImplementation(async () => {
        await db.refund.update({ where: { id: hold.id }, data: { stripe_refund_id: refund.id, state: 'SUCCEEDED' } });
        return [refund];
      });
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)], refunds: [refund] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toEqual({});
    });

    it('item 8: a bank payment waiting on the customer (intent held, not final, no charge yet) is not "names a charge the processor does not hold"', async () => {
      const o = await seedOrg();
      await addPayment(o, { n: 'bank', dollars: 100, state: 'PROCESSING' });
      intentAtProcessor.mockResolvedValue({ id: `pi_bank_${o.tag}`, status: 'requires_action', latest_charge: null });
      onProcessor(o, { charges: [] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(intentAtProcessor).toHaveBeenCalledWith(o.account, `pi_bank_${o.tag}`);
      expect(result.findings).toEqual([]);
    });

    it('item 8: a PROCESSING payment whose intent the processor does not hold is still the old finding', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'bank', dollars: 100, state: 'PROCESSING' });
      intentAtProcessor.mockResolvedValue(null);
      onProcessor(o, { charges: [] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['PAYMENT_NO_CHARGE', p.id]]);
    });

    it('slice 39: a THROWN intent lookup raises nothing for that payment and is counted as could_not_check', async () => {
      const o = await seedOrg();
      await addPayment(o, { n: 'bank', dollars: 100, state: 'PROCESSING' });
      intentAtProcessor.mockRejectedValue(new Error('processor unavailable'));
      onProcessor(o, { charges: [] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings).toEqual([]);
      expect(result.status).toBe('CLEAN');
      expect(result.couldNotCheck).toBe(1);
      const run = await db.paymentReconcileRun.findFirstOrThrow({ where: { organization_id: o.org } });
      expect(run.counts).toMatchObject({ could_not_check: 1 });
      expect(run.drift_count).toBe(0);
    });

    it('slice 39: a lookup that works and finds nothing is still the old finding, with could_not_check at 0', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'bank', dollars: 100, state: 'PROCESSING' });
      intentAtProcessor.mockResolvedValue(null);
      onProcessor(o, { charges: [] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['PAYMENT_NO_CHARGE', p.id]]);
      expect(result.couldNotCheck).toBe(0);
    });

    it('item 8: still waiting after 7 days raises one honest finding, once', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'bank', dollars: 100, state: 'PROCESSING', createdAt: new Date(NOW.getTime() - 8 * DAY) });
      intentAtProcessor.mockResolvedValue({ id: `pi_bank_${o.tag}`, status: 'requires_action', latest_charge: null });
      onProcessor(o, { charges: [] });

      const first = await reconcileOrg(o.org, { now: NOW });
      const second = await reconcileOrg(o.org, { now: new Date(NOW.getTime() + 60_000) });

      expect(first.findings).toHaveLength(1);
      expect(first.findings[0]).toMatchObject({ kind: 'BANK_PAYMENT_STILL_WAITING', ref: p.id });
      expect(first.findings[0].detail).toContain('bank payment still waiting on the customer after 7 days');
      expect(second.findings).toEqual([]);
    });
  });

  describe('payment state against the charge', () => {
    const DAY = 24 * 3600_000;
    const run = async (o: Seeded) => (await reconcileOrg(o.org, { now: NOW })).findings.map((f) => [f.kind, f.ref]);

    it('a Payment recorded FAILED whose charge succeeded is one alert (money taken, no paid row)', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100, state: 'FAILED' });
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });
      expect(await run(o)).toEqual([['PAYMENT_STATE_MISMATCH', p.id]]);
    });

    it('a Payment still PROCESSING whose charge succeeded is an alert, however old the Payment is', async () => {
      const o = await seedOrg();
      const old = new Date(NOW.getTime() - 5 * DAY);
      const p = await addPayment(o, { n: 'a', dollars: 100, state: 'PROCESSING', createdAt: old });
      onProcessor(o, { charges: [charge({ id: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 10000, created: old })] });
      expect(await run(o)).toEqual([['PAYMENT_STATE_MISMATCH', p.id]]);
    });

    it('a voided Payment whose charge succeeded (and was neither refunded nor disputed) is an alert', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100, voided: true });
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });
      expect(await run(o)).toEqual([['PAYMENT_STATE_MISMATCH', p.id]]);
    });

    it('a Payment recorded SUCCEEDED whose charge failed or is still pending is an alert; PROCESSING with a pending charge is not', async () => {
      const o = await seedOrg();
      const failed = await addPayment(o, { n: 'f', dollars: 10 });
      const pending = await addPayment(o, { n: 'p', dollars: 20 });
      await addPayment(o, { n: 'ok', dollars: 30, state: 'PROCESSING' });
      onProcessor(o, {
        charges: [
          charge({ id: `ch_f_${o.tag}`, pi: `pi_f_${o.tag}`, cents: 1000, status: 'failed' }),
          charge({ id: `ch_p_${o.tag}`, pi: `pi_p_${o.tag}`, cents: 2000, status: 'pending' }),
          charge({ id: `ch_ok_${o.tag}`, pi: `pi_ok_${o.tag}`, cents: 3000, status: 'pending' }),
        ],
      });
      expect((await run(o)).sort()).toEqual([['PAYMENT_STATE_MISMATCH', failed.id], ['PAYMENT_STATE_MISMATCH', pending.id]].sort());
    });

    it('a Payment recorded SUCCEEDED whose charge is fully refunded is an alert unless refund rows account for it', async () => {
      const o = await seedOrg();
      const bare = await addPayment(o, { n: 'bare', dollars: 10 });
      const covered = await addPayment(o, { n: 'cov', dollars: 20 });
      await db.refund.create({
        data: {
          organization_id: o.org, invoice_id: o.invoice, payment_id: covered.id, amount: 20, method: 'CARD',
          reason_category: 'CUSTOMER_REQUEST', stripe_refund_id: `re_cov_${o.tag}`, state: 'SUCCEEDED', refunded_by: o.user, created_at: EARLIER,
        },
      });
      onProcessor(o, {
        charges: [
          charge({ id: `ch_bare_${o.tag}`, pi: `pi_bare_${o.tag}`, cents: 1000, refunded: true }),
          charge({ id: `ch_cov_${o.tag}`, pi: `pi_cov_${o.tag}`, cents: 2000, refunded: true }),
        ],
        refunds: [processorRefund({ id: `re_cov_${o.tag}`, chargeId: `ch_cov_${o.tag}`, pi: `pi_cov_${o.tag}`, cents: 2000 })],
      });
      expect(await run(o)).toEqual([['PAYMENT_STATE_MISMATCH', bare.id]]);
    });
  });

  describe('a charge that was still pending when first looked at', () => {
    const DAY = 24 * 3600_000;
    it('is written down, and alerted, once it has succeeded without ever being booked', async () => {
      const o = await seedOrg();
      const created = new Date(NOW.getTime() - 6 * DAY);
      onProcessor(o, { charges: [charge({ id: `ch_slow_${o.tag}`, pi: `pi_slow_${o.tag}`, cents: 4000, created })] });

      const first = await reconcileOrg(o.org, { now: NOW });
      const again = await reconcileOrg(o.org, { now: new Date(NOW.getTime() + 60_000) });

      expect(first.findings.map((f) => [f.kind, f.ref])).toEqual([['CHARGE_NO_PAYMENT', `ch_slow_${o.tag}`]]);
      expect(again.findings).toEqual([]);
      const records = await db.unappliedCapture.findMany({ where: { organization_id: o.org, stripe_payment_intent_id: `pi_slow_${o.tag}` } });
      expect(records).toHaveLength(1);
      expect(Number(records[0].amount)).toBe(40);
    });
  });

  describe('refunds', () => {
    /** A refund row in the ledger for `payment`. */
    async function addRefundRow(o: Seeded, paymentId: string, r: { cents: number; id: string | null; state?: 'SUCCEEDED' | 'PENDING' | 'FAILED'; createdAt?: Date; reason?: string }) {
      return db.refund.create({
        data: {
          organization_id: o.org, invoice_id: o.invoice, payment_id: paymentId, amount: r.cents / 100, method: 'CARD',
          reason_category: 'CUSTOMER_REQUEST', reason: r.reason ?? null, stripe_refund_id: r.id, state: r.state ?? 'SUCCEEDED',
          refunded_by: o.user, created_at: r.createdAt ?? EARLIER,
        },
      });
    }

    it('a refund the processor made that ServWave has no row for, on a payment ServWave knows, is one alert (nothing is invented)', async () => {
      const o = await seedOrg();
      await addPayment(o, { n: 'a', dollars: 100 });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [processorRefund({ id: `re_missing_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 2500 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['REFUND_NOT_RECORDED', `re_missing_${o.tag}`]]);
      expect(await db.refund.count({ where: { organization_id: o.org } })).toBe(0);
      expect(await db.unappliedCapture.count({ where: { organization_id: o.org } })).toBe(0);
    });

    it('a refund for a payment ServWave never recorded is one alert and is written down once', async () => {
      const o = await seedOrg();
      onProcessor(o, {
        refunds: [processorRefund({ id: `re_stray_${o.tag}`, chargeId: `ch_x_${o.tag}`, pi: `pi_x_${o.tag}`, cents: 1500 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });
      await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['REFUND_NOT_RECORDED', `re_stray_${o.tag}`]]);
      const records = await db.unappliedCapture.findMany({ where: { organization_id: o.org } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ reason: 'REFUND_UNMATCHED', stripe_refund_id: `re_stray_${o.tag}` });
    });

    it('a refund row the processor does not hold is one alert', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const row = await addRefundRow(o, p.id, { cents: 2500, id: `re_gone_${o.tag}` });
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)], refunds: [] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['REFUND_NOT_AT_PROCESSOR', row.id]]);
    });

    it('a refund both sides hold in the same state is clean; a state that differs is one alert', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      await addRefundRow(o, p.id, { cents: 1000, id: `re_ok_${o.tag}` });
      const bad = await addRefundRow(o, p.id, { cents: 2000, id: `re_bad_${o.tag}`, state: 'SUCCEEDED' });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [
          processorRefund({ id: `re_ok_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 1000 }),
          processorRefund({ id: `re_bad_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 2000, status: 'failed' }),
        ],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['REFUND_STATE_MISMATCH', bad.id]]);
    });

    it('a legacy refund row with no processor id is matched by charge and amount and gets the id, not a second row', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const legacy = await addRefundRow(o, p.id, { cents: 2500, id: null, reason: 'Refunded outside ServWave', createdAt: new Date(EARLIER.getTime() - 5 * 3600_000) });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [processorRefund({ id: `re_legacy_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 2500 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings).toEqual([]);
      expect(result.repaired).toMatchObject({ refund_id_backfilled: 1 });
      const rows = await db.refund.findMany({ where: { organization_id: o.org } });
      expect(rows.map((r) => [r.id, r.stripe_refund_id])).toEqual([[legacy.id, `re_legacy_${o.tag}`]]);
    });

    it('a pending refund reservation is never claimed as the legacy row of a same-amount processor refund', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const hold = await addRefundRow(o, p.id, { cents: 2500, id: null, state: 'PENDING', createdAt: new Date(NOW.getTime() - 5 * 60_000) });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [processorRefund({ id: `re_other_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 2500 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toEqual({});
      expect(result.findings.map((f) => f.kind)).toEqual(['REFUND_NOT_RECORDED']);
      const row = await db.refund.findUniqueOrThrow({ where: { id: hold.id } });
      expect(row).toMatchObject({ stripe_refund_id: null, state: 'PENDING' });
    });

    it('a refund event that lands while the backfill is deciding is treated as recorded, and the run carries on', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const legacy = await addRefundRow(o, p.id, { cents: 2500, id: null, createdAt: new Date(EARLIER.getTime() - 5 * 3600_000) });
      const refundId = `re_race_${o.tag}`;
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [processorRefund({ id: refundId, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 2500 })],
      });
      // The refund's own event inserts its row just after the job first looked.
      const realFind = db.unappliedCapture.findFirst.bind(db.unappliedCapture);
      const spy = vi.spyOn(db.unappliedCapture, 'findFirst').mockImplementationOnce((async (args: never) => {
        await addRefundRow(o, p.id, { cents: 2500, id: refundId });
        return realFind(args);
      }) as never);

      const result = await reconcileOrg(o.org, { now: NOW });
      spy.mockRestore();

      expect(result.status).not.toBe('ERROR');
      const rows = await db.refund.findMany({ where: { organization_id: o.org, stripe_refund_id: refundId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(legacy.id);
      expect((await db.refund.findUniqueOrThrow({ where: { id: legacy.id } })).stripe_refund_id).toBeNull();
    });

    it('a stray-refund record whose refund failed is closed, not left open', async () => {
      const o = await seedOrg();
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'REFUND_UNMATCHED', amount: 15, stripe_refund_id: `re_f_${o.tag}`,
          stripe_payment_intent_id: `pi_f_${o.tag}`, stripe_account_id: o.account, source_key: `refund:re_f_${o.tag}`,
        },
      });
      onProcessor(o, {
        refunds: [processorRefund({ id: `re_f_${o.tag}`, chargeId: `ch_f_${o.tag}`, pi: `pi_f_${o.tag}`, cents: 1500, status: 'failed' })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toMatchObject({ stray_refund_record_closed: 1 });
      const record = await db.unappliedCapture.findFirstOrThrow({ where: { organization_id: o.org } });
      expect(record.status).toBe('RESOLVED');
    });

    it('a stray-refund record written before its payment was booked is flagged once the payment exists (tied back, not left silent)', async () => {
      const o = await seedOrg();
      await addPayment(o, { n: 'late', dollars: 100 });
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'REFUND_UNMATCHED', amount: 25, stripe_refund_id: `re_late_${o.tag}`,
          stripe_payment_intent_id: `pi_late_${o.tag}`, stripe_account_id: o.account, source_key: `refund:re_late_${o.tag}`,
        },
      });
      onProcessor(o, {
        charges: [chargeFor(o, 'late', 10000)],
        refunds: [processorRefund({ id: `re_late_${o.tag}`, chargeId: `ch_late_${o.tag}`, pi: `pi_late_${o.tag}`, cents: 2500 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['REFUND_RECORD_PAYMENT_KNOWN', `re_late_${o.tag}`]]);
      expect(await db.refund.count({ where: { organization_id: o.org } })).toBe(0);
    });

    it('a refund made outside the list on a payment still open on "needing attention" is flagged', async () => {
      const o = await seedOrg();
      const rec = await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'INVOICE_NOT_PAYABLE', amount: 60, stripe_payment_intent_id: `pi_o_${o.tag}`,
          stripe_account_id: o.account, source_key: `session:cs_o_${o.tag}`,
        },
      });
      // The refund ServWave sees as a stray row (recorded) on the same payment intent.
      await db.unappliedCapture.create({
        data: {
          organization_id: o.org, reason: 'REFUND_UNMATCHED', amount: 60, stripe_refund_id: `re_o_${o.tag}`,
          stripe_payment_intent_id: `pi_o_${o.tag}`, stripe_account_id: o.account, source_key: `refund:re_o_${o.tag}`,
        },
      });
      onProcessor(o, {
        charges: [chargeFor(o, 'o', 6000)],
        refunds: [processorRefund({ id: `re_o_${o.tag}`, chargeId: `ch_o_${o.tag}`, pi: `pi_o_${o.tag}`, cents: 6000 })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['CAPTURE_REFUNDED_OUTSIDE', rec.id]]);
    });
  });

  describe('disputes', () => {
    async function addDisputeRow(o: Seeded, paymentId: string, d: { id: string; dollars: number; status: 'NEEDS_RESPONSE' | 'UNDER_REVIEW' | 'WON' | 'LOST' | 'CLOSED'; updatedAt?: Date }) {
      return db.dispute.create({
        data: {
          organization_id: o.org, invoice_id: o.invoice, payment_id: paymentId, stripe_dispute_id: d.id, status: d.status, amount: d.dollars,
          updated_at: d.updatedAt ?? EARLIER,
        },
      });
    }

    it('a dispute the processor holds that ServWave has no row for is one alert', async () => {
      const o = await seedOrg();
      await addPayment(o, { n: 'a', dollars: 100 });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        disputes: [processorDispute({ id: `dp_new_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 10000, status: 'needs_response' })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['DISPUTE_NOT_RECORDED', `dp_new_${o.tag}`]]);
    });

    it('a dispute in a different state at the processor is one alert; the same state is clean', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      await addDisputeRow(o, p.id, { id: `dp_same_${o.tag}`, dollars: 100, status: 'UNDER_REVIEW' });
      const stale = await addDisputeRow(o, p.id, { id: `dp_stale_${o.tag}`, dollars: 100, status: 'NEEDS_RESPONSE' });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        disputes: [
          processorDispute({ id: `dp_same_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 10000, status: 'under_review' }),
          processorDispute({ id: `dp_stale_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 10000, status: 'won' }),
        ],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['DISPUTE_STATE_MISMATCH', stale.id]]);
    });

    it('a lost dispute for less than the payment is flagged for manual review', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const lost = await addDisputeRow(o, p.id, { id: `dp_part_${o.tag}`, dollars: 40, status: 'LOST' });
      await addDisputeRow(o, p.id, { id: `dp_full_${o.tag}`, dollars: 100, status: 'LOST' });
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        disputes: [
          processorDispute({ id: `dp_part_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 4000, status: 'lost' }),
          processorDispute({ id: `dp_full_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 10000, status: 'lost' }),
        ],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['DISPUTE_PARTIAL_LOSS', lost.id]]);
    });
  });

  describe('the nightly run across orgs', () => {
    it("reads only each org's own connected account and never another org's data", async () => {
      const a = await seedOrg();
      const b = await seedOrg();
      // B holds a payment whose ids A's account also lists: tenancy, not the id, decides.
      await db.payment.create({
        data: { invoice_id: b.invoice, amount: 10, method: 'CARD', paid_at: EARLIER, created_at: EARLIER, stripe_account_id: b.account, stripe_charge_id: `ch_shared_${a.tag}`, stripe_payment_intent_id: `pi_shared_${a.tag}` },
      });
      onProcessor(a, { charges: [charge({ id: `ch_shared_${a.tag}`, pi: `pi_shared_${a.tag}`, cents: 1000 })] });
      onProcessor(b, { charges: [] });

      const summary = await runNightlyReconcile({ now: NOW });

      const mine = summary.orgs.filter((r) => r.orgId === a.org || r.orgId === b.org);
      const byOrg = Object.fromEntries(mine.map((r) => [r.orgId, r.findings.map((f) => f.kind)]));
      expect(byOrg[a.org]).toEqual(['CHARGE_NO_PAYMENT']);
      // B's payment has a charge B's account does not hold: B's own drift, found from B's account only.
      expect(byOrg[b.org]).toEqual(['PAYMENT_NO_CHARGE']);
      for (const list of [charges, refunds, disputes, sessions]) {
        const accounts = list.mock.calls.map((c) => c[0] as string);
        expect(accounts).toContain(a.account);
        expect(accounts).toContain(b.account);
        expect(accounts.every((acct) => acct.startsWith('acct_'))).toBe(true);
      }
      expect(await db.paymentReconcileRun.count({ where: { organization_id: { in: [a.org, b.org] } } })).toBe(2);
    }, 60000); // seeds two orgs and runs a nightly pass; a loaded shared machine starves the default 20s

    it('sends one ops email for the run that names every finding, and none when everything is clean', async () => {
      const a = await seedOrg();
      onProcessor(a, { charges: [chargeFor(a, 'orphan', 500)] });

      await runNightlyReconcile({ now: NOW, orgIds: [a.org] });
      expect(opsEmail).toHaveBeenCalledTimes(1);
      const { subject, text } = opsEmail.mock.calls[0][0] as { subject: string; text: string };
      expect(subject).toContain('1 difference');
      expect(text).toContain('CHARGE_NO_PAYMENT');
      expect(text).toContain(`ch_orphan_${a.tag}`);

      opsEmail.mockClear();
      const clean = await seedOrg();
      onProcessor(clean, {});
      await runNightlyReconcile({ now: NOW, orgIds: [clean.org] });
      expect(opsEmail).not.toHaveBeenCalled();
    });

    it('an org the processor cannot be read for is recorded as an error and the other orgs still run', async () => {
      const broken = await seedOrg();
      const fine = await seedOrg();
      onProcessor(fine, {});
      charges.mockImplementation(async (acct: string) => {
        if (acct === broken.account) throw new Error('processor unavailable');
        return held(acct).charges;
      });

      const summary = await runNightlyReconcile({ now: NOW, orgIds: [broken.org, fine.org] });

      const statusOf = Object.fromEntries(summary.orgs.map((r) => [r.orgId, r.status]));
      expect([statusOf[broken.org], statusOf[fine.org]]).toEqual(['ERROR', 'CLEAN']);
      const run = await db.paymentReconcileRun.findFirstOrThrow({ where: { organization_id: broken.org } });
      expect(run).toMatchObject({ status: 'ERROR' });
      expect(run.error).toContain('processor unavailable');
      // The failed night does not advance the window: the next run covers it again.
      const next = await reconcileOrg(broken.org, { now: NOW });
      expect(next.windowStart.getTime()).toBe(NOW.getTime() - 10 * 60_000 - 48 * 3600_000);
    });
  });

  describe('an org whose run failed outside the comparison (summary row could not be written)', () => {
    /** Makes the summary-row write throw `times` times for `org` (a pool timeout), recording every attempt. */
    function summaryWriteFails(org: string, times: number) {
      const original = db.paymentReconcileRun.create.bind(db.paymentReconcileRun);
      const attempts: string[] = [];
      let failed = 0;
      const spy = vi.spyOn(db.paymentReconcileRun, 'create').mockImplementation(((args: { data: { organization_id: string } }) => {
        attempts.push(args.data.organization_id);
        if (args.data.organization_id === org && failed < times) {
          failed += 1;
          return Promise.reject(new Error('Timed out fetching a new connection from the connection pool'));
        }
        return original(args as never);
      }) as never);
      return { attempts, spy };
    }
    afterEach(() => vi.restoreAllMocks());

    it('is tried once more, and a second try that works leaves one clean entry, no error count and no digest', async () => {
      const a = await seedOrg();
      onProcessor(a, {});
      const { attempts } = summaryWriteFails(a.org, 1);

      const summary = await runNightlyReconcile({ now: NOW, orgIds: [a.org], retryPauseMs: 0 });

      expect(attempts).toEqual([a.org, a.org]);
      expect(summary.orgs.map((r) => [r.orgId, r.status])).toEqual([[a.org, 'CLEAN']]);
      expect(summary.errorCount).toBe(0);
      expect(opsEmail).not.toHaveBeenCalled();
      expect(await db.paymentReconcileRun.count({ where: { organization_id: a.org } })).toBe(1);
    });

    it('is one ERROR entry, counted and in the digest, when the second try fails too', async () => {
      const a = await seedOrg();
      onProcessor(a, {});
      summaryWriteFails(a.org, 2);

      const summary = await runNightlyReconcile({ now: NOW, orgIds: [a.org], retryPauseMs: 0 });

      expect(summary.orgs).toHaveLength(1);
      expect(summary.orgs[0]).toMatchObject({ orgId: a.org, status: 'ERROR' });
      expect(summary.errorCount).toBe(1);
      expect(opsEmail).toHaveBeenCalledTimes(1);
      expect((opsEmail.mock.calls[0][0] as { text: string }).text).toContain(`org ${a.org}: NOT CHECKED`);
    });

    it('is not retried when its comparison failed and an ERROR row was written', async () => {
      const broken = await seedOrg();
      charges.mockImplementation(async (acct: string) => {
        if (acct === broken.account) throw new Error('processor refused the account');
        return held(acct).charges;
      });

      const summary = await runNightlyReconcile({ now: NOW, orgIds: [broken.org], retryPauseMs: 0 });

      expect(charges.mock.calls.filter((c) => c[0] === broken.account)).toHaveLength(1);
      expect(summary.orgs.map((r) => r.status)).toEqual(['ERROR']);
      expect(summary.errorCount).toBe(1);
      expect(await db.paymentReconcileRun.count({ where: { organization_id: broken.org } })).toBe(1);
    });

    it('is retried only after every other org has run', async () => {
      const orgsInOrder = [await seedOrg(), await seedOrg(), await seedOrg()].sort((x, y) => (x.org < y.org ? -1 : 1));
      for (const o of orgsInOrder) onProcessor(o, {});
      const [first, second, third] = orgsInOrder;
      const { attempts } = summaryWriteFails(first.org, 1);

      const summary = await runNightlyReconcile({ now: NOW, orgIds: orgsInOrder.map((o) => o.org), retryPauseMs: 0 });

      expect(attempts).toEqual([first.org, second.org, third.org, first.org]);
      expect(summary.orgs).toHaveLength(3);
      expect(new Set(summary.orgs.map((r) => r.orgId)).size).toBe(3);
    });
  });

  it('a paid checkout missing the metadata ServWave puts on every session is one alert', async () => {
    const o = await seedOrg();
    const full = { organizationId: o.org, kind: 'invoice', payableNowCents: '1000', invoiceId: o.invoice };
    onProcessor(o, {
      sessions: [
        { id: `cs_ok_${o.tag}`, payment_status: 'paid', created: unix(EARLIER), metadata: full },
        { id: `cs_bare_${o.tag}`, payment_status: 'paid', created: unix(EARLIER), metadata: { invoiceId: o.invoice } },
        { id: `cs_open_${o.tag}`, payment_status: 'unpaid', created: unix(EARLIER), metadata: {} },
      ],
    });

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.findings.map((f) => [f.kind, f.ref])).toEqual([['SESSION_METADATA_MISSING', `cs_bare_${o.tag}`]]);
  });

  describe('stuck refund holds', () => {
    /** A refund reservation: PENDING, no processor id, as reserveRefund leaves it. */
    async function addHold(o: Seeded, paymentId: string, cents: number, createdAt: Date) {
      return db.refund.create({
        data: {
          organization_id: o.org, invoice_id: o.invoice, payment_id: paymentId, amount: cents / 100, method: 'CARD',
          reason_category: 'CUSTOMER_REQUEST', stripe_refund_id: null, state: 'PENDING', refunded_by: o.user, created_at: createdAt,
        },
      });
    }
    const HOUR = 3600_000;

    it('a hold the processor did complete is completed from its refund', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const hold = await addHold(o, p.id, 4000, new Date(NOW.getTime() - 2 * HOUR));
      refundsOnIntent.mockResolvedValue([
        processorRefund({ id: `re_held_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 4000, metadata: { refund_row_id: hold.id } }),
      ]);
      onProcessor(o, {
        charges: [chargeFor(o, 'a', 10000)],
        refunds: [processorRefund({ id: `re_held_${o.tag}`, chargeId: `ch_a_${o.tag}`, pi: `pi_a_${o.tag}`, cents: 4000, metadata: { refund_row_id: hold.id } })],
      });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toMatchObject({ refund_hold_completed: 1 });
      expect(result.findings).toEqual([]);
      const rows = await db.refund.findMany({ where: { organization_id: o.org } });
      expect(rows.map((r) => [r.id, r.stripe_refund_id, r.state])).toEqual([[hold.id, `re_held_${o.tag}`, 'SUCCEEDED']]);
      const invoice = await db.invoice.findUniqueOrThrow({ where: { id: o.invoice } });
      expect(Number(invoice.total_refunded)).toBe(40);
    });

    it('a hold the processor never saw is failed, which frees the money, and leaves an audit row', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const hold = await addHold(o, p.id, 4000, new Date(NOW.getTime() - 2 * HOUR));
      refundsOnIntent.mockResolvedValue([]);
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toMatchObject({ refund_hold_released: 1 });
      const row = await db.refund.findUniqueOrThrow({ where: { id: hold.id } });
      expect(row).toMatchObject({ state: 'FAILED', stripe_refund_id: null });
      const audit = await db.auditLog.findMany({ where: { org_id: o.org, action: 'refund.hold_released' } });
      expect(audit).toHaveLength(1);
      expect(audit[0].resource_id).toBe(hold.id);
    });

    it('a hold younger than the threshold is left alone, and so is one the processor cannot be asked about', async () => {
      const o = await seedOrg();
      const p = await addPayment(o, { n: 'a', dollars: 100 });
      const young = await addHold(o, p.id, 1000, new Date(NOW.getTime() - 5 * 60_000));
      const unreachable = await addHold(o, p.id, 2000, new Date(NOW.getTime() - 3 * HOUR));
      refundsOnIntent.mockRejectedValue(new Error('processor unavailable'));
      onProcessor(o, { charges: [chargeFor(o, 'a', 10000)] });

      const result = await reconcileOrg(o.org, { now: NOW });

      expect(result.repaired).toEqual({});
      expect(refundsOnIntent).toHaveBeenCalledTimes(1);
      const rows = await db.refund.findMany({ where: { id: { in: [young.id, unreachable.id] } } });
      expect(rows.every((r) => r.state === 'PENDING' && r.stripe_refund_id === null)).toBe(true);
    });
  });
});

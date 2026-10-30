/* =============================================================================
   Payments go-live, slice P2 - the nightly reconcile keeps the payouts table whole.

   A payouts pass lists the org's recent payouts, upserts missing or changed rows, and links payments
   whose balance transaction was captured late (after the payout was first synced). It repairs
   ServWave's own bookkeeping only: no payout ever becomes a drift finding, and a payouts pass that
   cannot read the processor never turns the run into an error.

   The processor's lists are recorded fixtures handed to the mocked calls (lib/stripe is mocked
   suite-wide); the ledger is a real migrated database (TEST_DATABASE_URL, skips when unset).
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
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

import { listAccountPayouts, listPayoutBalanceTransactions } from '../lib/stripe';
import { reconcileOrg } from '../services/payment-reconcile';

const payoutsList = listAccountPayouts as unknown as ReturnType<typeof vi.fn>;
const balanceTransactions = listPayoutBalanceTransactions as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

const NOW = new Date('2026-10-11T03:00:00.000Z');
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

suite('nightly payouts pass (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let processorPayouts: Record<string, unknown>[] = [];
  let payoutContents = new Map<string, string[]>();

  async function seedOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_p2n_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `p2n-${tag}`, email: `p2n-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: { id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, subtotal: 100, tax_amount: 0, total_amount: 100, status: 'PAID', amount_due: 0 },
    });
    // A card payment whose fee has not been captured yet, so it holds no balance transaction id.
    const payment = await db.payment.create({
      data: {
        invoice_id: invoice, amount: 100, method: 'CARD', paid_at: new Date(NOW.getTime() - 3 * 86400_000), state: 'SUCCEEDED',
        created_at: new Date(NOW.getTime() - 3 * 86400_000),
        stripe_account_id: account, stripe_payment_intent_id: `pi_late_${tag}`, stripe_charge_id: `ch_late_${tag}`,
      },
    });
    return { org, tag, account, payment };
  }
  type Seeded = Awaited<ReturnType<typeof seedOrg>>;

  const payoutFixture = (o: Seeded, over: Record<string, unknown> = {}) => ({
    id: `po_p2n_${o.tag}`, object: 'payout', amount: 9700, status: 'paid', automatic: true,
    arrival_date: unix(new Date(NOW.getTime() - 86400_000)), created: unix(new Date(NOW.getTime() - 2 * 86400_000)), failure_code: null,
    destination: { object: 'bank_account', bank_name: 'Test Bank', last4: '6789' }, ...over,
  });

  beforeEach(() => {
    processorPayouts = [];
    payoutContents = new Map();
    payoutsList.mockReset().mockImplementation(async () => processorPayouts);
    balanceTransactions.mockReset().mockImplementation(async (_acct: string, payoutId: string) =>
      (payoutContents.get(payoutId) ?? []).map((id) => ({ id, object: 'balance_transaction' })));
  });

  afterAll(async () => {
    for (const org of orgs) {
      await db.$executeRawUnsafe(`DELETE FROM payment_reconcile_runs WHERE organization_id = '${org}'::uuid`);
      await db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}'::uuid)`);
      await db.$executeRawUnsafe(`DELETE FROM payouts WHERE organization_id = '${org}'::uuid`);
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers']) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'::uuid`);
      }
      await db.organization.delete({ where: { id: org } });
    }
    await db.$disconnect();
  });

  it('writes a payout the events never delivered, with its bank label', async () => {
    const o = await seedOrg();
    processorPayouts = [payoutFixture(o)];

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.status).toBe('CLEAN');
    expect(result.findings).toEqual([]);
    const rows = await db.payout.findMany({ where: { organization_id: o.org } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripe_payout_id: `po_p2n_${o.tag}`, status: 'PAID', destination_label: 'Test Bank ••6789' });
    expect(payoutsList).toHaveBeenCalledWith(o.account, expect.any(Number));
  });

  it('a payment captured after its payout was synced gets linked on the next run', async () => {
    const o = await seedOrg();
    const bt = `txn_late_${o.tag}`;
    processorPayouts = [payoutFixture(o)];
    payoutContents.set(`po_p2n_${o.tag}`, [bt]);

    await reconcileOrg(o.org, { now: NOW });
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.payment.id } })).payout_id).toBeNull();

    // the fee sweep captures the balance transaction afterwards
    await db.payment.update({ where: { id: o.payment.id }, data: { stripe_balance_transaction_id: bt } });
    await reconcileOrg(o.org, { now: new Date(NOW.getTime() + 86400_000) });

    const payout = await db.payout.findFirstOrThrow({ where: { organization_id: o.org } });
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.payment.id } })).payout_id).toBe(payout.id);
  });

  it('a second run changes nothing', async () => {
    const o = await seedOrg();
    processorPayouts = [payoutFixture(o)];
    await reconcileOrg(o.org, { now: NOW });
    const first = await db.payout.findFirstOrThrow({ where: { organization_id: o.org } });

    await reconcileOrg(o.org, { now: new Date(NOW.getTime() + 86400_000) });

    expect(await db.payout.count({ where: { organization_id: o.org } })).toBe(1);
    const second = await db.payout.findFirstOrThrow({ where: { organization_id: o.org } });
    expect(second).toEqual(first);
  });

  it('a payouts pass that cannot read the processor does not make the run an error', async () => {
    const o = await seedOrg();
    payoutsList.mockRejectedValue(new Error('processor unreachable'));

    const result = await reconcileOrg(o.org, { now: NOW });

    expect(result.status).toBe('CLEAN');
    expect(await db.payout.count({ where: { organization_id: o.org } })).toBe(0);
  });
});

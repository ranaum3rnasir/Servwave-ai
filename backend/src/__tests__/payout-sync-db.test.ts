/* =============================================================================
   Payments go-live, slice P2 - ServWave keeps its own record of every payout.

   Through the real webhook route (processStripeEvent), with a real migrated database
   (TEST_DATABASE_URL; skips when unset). A payout event is claimed once, upserts the payouts row for
   the company that owns the connected account, and links exactly the payments whose balance
   transaction is in the payout. It never writes a payment's money fields. An event for an account
   ServWave does not know is acknowledged and writes nothing.

   The processor's balance-transaction list is a recorded fixture handed to the mocked call
   (lib/stripe is mocked suite-wide). Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
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

import { listPayoutBalanceTransactions, retrieveAccountPayout } from '../lib/stripe';

const retrievePayout = retrieveAccountPayout as unknown as ReturnType<typeof vi.fn>;

const balanceTransactions = listPayoutBalanceTransactions as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

/** What the processor holds, per payout id (recorded list fixture). */
const inPayout = new Map<string, string[]>();

suite('payout sync (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 180_000);

  beforeEach(() => {
    inPayout.clear();
    retrievePayout.mockReset().mockResolvedValue(null);
    balanceTransactions.mockReset().mockImplementation(async (_acct: string, payoutId: string) =>
      (inPayout.get(payoutId) ?? []).map((id) => ({ id, object: 'balance_transaction', type: 'charge', source: `ch_${id}` })));
  });

  /** An org with a connected account and one paid invoice holding `payments` card payments, each with a balance transaction. */
  async function fixture(opts: { payments?: number; bankLabel?: string | null } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_p2_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `p2-${tag}`, email: `p2-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
        ...(opts.bankLabel ? { payout_summary: { interval: 'daily', weekly_anchor: null, delay_days: 2, bank_label: opts.bankLabel } } : {}),
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const n = opts.payments ?? 3;
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: 100 * n, tax_amount: 0, total_amount: 100 * n, status: 'PAID', amount_due: 0,
      },
    });
    const paymentIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      paymentIds.push(id);
      await db.payment.create({
        data: {
          id, invoice_id: invoice, amount: 100, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED',
          stripe_account_id: account, stripe_payment_intent_id: `pi_${i}_${tag}`, stripe_charge_id: `ch_${i}_${tag}`,
          stripe_balance_transaction_id: `txn_${i}_${tag}`, net_amount: 97, stripe_fee_amount: 3,
        },
      });
    }
    let seq = 0;
    const payout = (over: Record<string, unknown> = {}) => ({
      id: `po_${tag}`, object: 'payout', amount: 30000, currency: 'usd', status: 'pending', automatic: true,
      arrival_date: 1790121600, created: 1790000000, failure_code: null, destination: `ba_${tag}`, ...over,
    });
    const deliver = async (type: string, object: object, over: { id?: string; account?: string } = {}) => {
      const event = {
        id: over.id ?? `evt_p2_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia', type, created: 1790000000,
        account: over.account ?? account, data: { object },
      };
      const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(200);
      return res.body as { received: boolean; duplicate?: boolean };
    };
    const payouts = () => db.payout.findMany({ where: { organization_id: org } });
    const linked = async () => (await db.payment.findMany({ where: { invoice_id: invoice, NOT: { payout_id: null } }, select: { id: true } })).map((p) => p.id).sort();
    return { org, tag, account, invoice, paymentIds, bt: (i: number) => `txn_${i}_${tag}`, payout, deliver, payouts, linked };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payouts WHERE organization_id = '${org}'`));
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_p2_%'`));
    await db.$disconnect();
  });

  it('payout.created inserts the payout for the company that owns the account', async () => {
    const f = await fixture();

    await f.deliver('payout.created', f.payout());

    const [row] = await f.payouts();
    expect(row).toMatchObject({
      stripe_payout_id: `po_${f.tag}`, status: 'PENDING', is_automatic: true, failure_code: null, destination_label: null,
    });
    expect(Number(row.amount)).toBe(300);
    expect(row.arrival_date?.toISOString().slice(0, 10)).toBe('2026-09-23');
    expect(row.processor_created_at?.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('names the destination with the company bank label when it has one', async () => {
    const f = await fixture({ bankLabel: 'Test Bank ••6789' });

    await f.deliver('payout.created', f.payout());

    expect((await f.payouts())[0].destination_label).toBe('Test Bank ••6789');
  });

  it('payout.paid marks it PAID and links exactly the payments whose balance transaction is in the payout', async () => {
    const f = await fixture({ payments: 3 });
    inPayout.set(`po_${f.tag}`, [f.bt(0), f.bt(1), 'txn_somewhere_else']);

    await f.deliver('payout.created', f.payout());
    await f.deliver('payout.paid', f.payout({ status: 'paid' }));

    const rows = await f.payouts();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PAID');
    expect(await f.linked()).toEqual([f.paymentIds[0], f.paymentIds[1]].sort());
    const third = await db.payment.findUnique({ where: { id: f.paymentIds[2] } });
    expect(third?.payout_id).toBeNull();
    // the payment's money fields are untouched
    const first = await db.payment.findUnique({ where: { id: f.paymentIds[0] } });
    expect(first).toMatchObject({ state: 'SUCCEEDED' });
    expect(Number(first?.amount)).toBe(100);
    expect(Number(first?.net_amount)).toBe(97);
    expect(Number(first?.stripe_fee_amount)).toBe(3);
  });

  it('a duplicate event id is a no-op', async () => {
    const f = await fixture();
    inPayout.set(`po_${f.tag}`, [f.bt(0)]);
    await f.deliver('payout.paid', f.payout({ status: 'paid' }), { id: `evt_p2_${f.tag}_dup` });
    const calls = balanceTransactions.mock.calls.length;

    const again = await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }), { id: `evt_p2_${f.tag}_dup` });

    expect(again.duplicate).toBe(true);
    expect(await f.payouts()).toHaveLength(1);
    expect((await f.payouts())[0]).toMatchObject({ status: 'PAID', failure_code: null });
    expect(balanceTransactions.mock.calls.length).toBe(calls);
  });

  it('payout.failed stores the code, and the same payout failing under two event ids is still one row', async () => {
    const f = await fixture();

    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));
    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));

    const rows = await f.payouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'FAILED', failure_code: 'account_closed' });
  });

  it('a late "in transit" update never moves a paid payout back', async () => {
    const f = await fixture();
    await f.deliver('payout.paid', f.payout({ status: 'paid' }));

    await f.deliver('payout.updated', f.payout({ status: 'in_transit' }));

    expect((await f.payouts())[0].status).toBe('PAID');
  });

  it('a late "paid" event never turns a failed payout into a paid one: the processor is asked for the current state', async () => {
    const f = await fixture();
    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));
    retrievePayout.mockResolvedValue(f.payout({ status: 'failed', failure_code: 'account_closed' }));

    await f.deliver('payout.paid', f.payout({ status: 'paid' }));

    expect((await f.payouts())[0]).toMatchObject({ status: 'FAILED', failure_code: 'account_closed' });
  });

  it('a late "failed" event never turns a paid payout into a failed one', async () => {
    const f = await fixture();
    await f.deliver('payout.paid', f.payout({ status: 'paid' }));
    retrievePayout.mockResolvedValue(f.payout({ status: 'paid' }));

    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));

    expect((await f.payouts())[0]).toMatchObject({ status: 'PAID', failure_code: null });
  });

  it('when the current state cannot be read, a different end state in an event is not trusted', async () => {
    const f = await fixture();
    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));
    retrievePayout.mockRejectedValue(new Error('processor down'));

    await f.deliver('payout.paid', f.payout({ status: 'paid' }));

    expect((await f.payouts())[0].status).toBe('FAILED');
  });

  it('a payout that really went from failed to paid is corrected by the current state', async () => {
    const f = await fixture();
    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));
    retrievePayout.mockResolvedValue(f.payout({ status: 'paid' }));

    await f.deliver('payout.paid', f.payout({ status: 'paid' }));

    expect((await f.payouts())[0]).toMatchObject({ status: 'PAID', failure_code: null });
  });

  it('maps a canceled payout', async () => {
    const f = await fixture();
    await f.deliver('payout.canceled', f.payout({ status: 'canceled' }));
    expect((await f.payouts())[0].status).toBe('CANCELED');
  });

  it('an event for an account ServWave does not know is acknowledged and writes nothing', async () => {
    const f = await fixture();
    const before = await db.payout.count();

    const body = await f.deliver('payout.paid', f.payout({ status: 'paid', id: 'po_stranger' }), { account: 'acct_unknown_p2' });

    expect(body.received).toBe(true);
    expect(await db.payout.count()).toBe(before);
    expect(await db.payout.findUnique({ where: { stripe_payout_id: 'po_stranger' } })).toBeNull();
  });

  it("one company's payout never links another company's payment", async () => {
    const a = await fixture({ payments: 1 });
    const b = await fixture({ payments: 1 });
    // the processor (wrongly or by accident) lists company B's balance transaction inside company A's payout
    inPayout.set(`po_${a.tag}`, [a.bt(0), b.bt(0)]);

    await a.deliver('payout.paid', a.payout({ status: 'paid' }));

    expect(await a.linked()).toEqual([a.paymentIds[0]]);
    expect(await b.linked()).toEqual([]);
    expect(await b.payouts()).toEqual([]);
  });
  // ---- conductor fix round: races, links of a dead payout, label, duplicate cost ----

  it('payout.created and payout.paid delivered together both succeed and leave one PAID row', async () => {
    for (let round = 0; round < 5; round++) {
      const f = await fixture();
      inPayout.set(`po_${f.tag}`, [f.bt(0)]);
      retrievePayout.mockResolvedValue(f.payout({ status: 'paid' }));

      await Promise.all([
        f.deliver('payout.created', f.payout({ status: 'pending' })),
        f.deliver('payout.paid', f.payout({ status: 'paid' })),
      ]);

      const rows = await f.payouts();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('PAID');
    }
  });

  it('a stale read of the row never moves a paid payout back to in transit', async () => {
    const f = await fixture();
    await f.deliver('payout.paid', f.payout({ status: 'paid' }));
    const row = (await f.payouts())[0];
    // another delivery read the row before the payment of the payout was written: it still sees "pending"
    const stale = { ...db, payout: { ...db.payout, findUnique: async () => ({ ...row, status: 'PENDING' }), update: db.payout.update.bind(db.payout), updateMany: db.payout.updateMany.bind(db.payout), create: db.payout.create.bind(db.payout), createMany: db.payout.createMany.bind(db.payout) } };
    const { syncPayout } = await import('../lib/payout-sync.js');

    await syncPayout(stale as never, f.org, f.payout({ status: 'in_transit' }) as never);

    expect((await f.payouts())[0].status).toBe('PAID');
  });

  it('an older "pending" never moves an in-transit payout back', async () => {
    const f = await fixture();
    await f.deliver('payout.updated', f.payout({ status: 'in_transit' }));

    await f.deliver('payout.created', f.payout({ status: 'pending' }));

    expect((await f.payouts())[0].status).toBe('IN_TRANSIT');
  });

  it('a payout that failed releases the payments it had been linked to', async () => {
    const f = await fixture();
    inPayout.set(`po_${f.tag}`, [f.bt(0), f.bt(1)]);
    await f.deliver('payout.paid', f.payout({ status: 'paid' }));
    expect(await f.linked()).toHaveLength(2);
    retrievePayout.mockResolvedValue(f.payout({ status: 'failed', failure_code: 'account_closed' }));

    await f.deliver('payout.failed', f.payout({ status: 'failed', failure_code: 'account_closed' }));

    expect(await f.linked()).toEqual([]);
  });

  it('a canceled payout releases its payments, and never another company\'s', async () => {
    const a = await fixture({ payments: 1 });
    const b = await fixture({ payments: 1 });
    inPayout.set(`po_${a.tag}`, [a.bt(0)]);
    inPayout.set(`po_${b.tag}`, [b.bt(0)]);
    await a.deliver('payout.paid', a.payout({ status: 'paid' }));
    await b.deliver('payout.paid', b.payout({ status: 'paid' }));
    retrievePayout.mockResolvedValue(a.payout({ status: 'canceled' }));

    await a.deliver('payout.canceled', a.payout({ status: 'canceled' }));

    expect(await a.linked()).toEqual([]);
    expect(await b.linked()).toEqual([b.paymentIds[0]]);
  });

  it('a later event that names the destination only by id keeps the bank label already stored', async () => {
    const f = await fixture();
    await f.deliver('payout.created', f.payout({ destination: { object: 'bank_account', bank_name: 'Test Bank', last4: '6789' } }));
    expect((await f.payouts())[0].destination_label).toBe('Test Bank ••6789');

    await f.deliver('payout.updated', f.payout({ status: 'in_transit', destination: `ba_${f.tag}` }));

    expect((await f.payouts())[0].destination_label).toBe('Test Bank ••6789');
  });

  it('a duplicate event id makes no call to the processor at all', async () => {
    const f = await fixture();
    inPayout.set(`po_${f.tag}`, [f.bt(0)]);
    await f.deliver('payout.paid', f.payout({ status: 'paid' }), { id: `evt_p2_${f.tag}_dup2` });
    balanceTransactions.mockClear();
    retrievePayout.mockClear();

    const again = await f.deliver('payout.paid', f.payout({ status: 'paid' }), { id: `evt_p2_${f.tag}_dup2` });

    expect(again.duplicate).toBe(true);
    expect(balanceTransactions).not.toHaveBeenCalled();
    expect(retrievePayout).not.toHaveBeenCalled();
  });

  it('reconcilePayout on an event id already claimed is a no-op before any processor call', async () => {
    const f = await fixture();
    await db.stripeEvent.create({ data: { stripe_event_id: `evt_p2_${f.tag}_claimed`, event_type: 'payout.paid' } });
    const { reconcilePayout } = await import('../services/payment-reconciler/index.js');
    balanceTransactions.mockClear();
    retrievePayout.mockClear();

    const outcome = await reconcilePayout({ id: `evt_p2_${f.tag}_claimed`, type: 'payout.paid', account: f.account, data: { object: f.payout({ status: 'paid' }) } } as never, f.org);

    expect(outcome).toBe('duplicate');
    expect(balanceTransactions).not.toHaveBeenCalled();
    expect(retrievePayout).not.toHaveBeenCalled();
    expect(await f.payouts()).toEqual([]);
  });
});

/* =============================================================================
   Payments go-live, slice 15 (from the slice 09 review) - when a deposit's payment is taken back,
   only THAT deposit's credit comes off the job invoices it was drawn onto.

   A job invoice can carry credit from two deposits. Before this slice, a lost dispute (the
   reconciler's chargeback void) or a staff void of one deposit's payment voided EVERY live
   deposit-credit row on each job invoice, the other deposit's included, while raising the balance
   by this deposit's share only. It also stamped the job invoice SENT/PARTIAL whatever it was: a
   DISPUTED job invoice lost its dispute flag, and a VOIDED one was reopened for payment.

   Driven through the real doors (the processor's webhook for the lost dispute, the staff
   void-payment route) against a real, migrated database. Skips when TEST_DATABASE_URL is unset.
   Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

import { getStripeForOrg, expireOpenCheckoutSessionsForInvoice } from '../lib/stripe';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('a taken-back deposit payment reverses only its own credit (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    vi.mocked(expireOpenCheckoutSessionsForInvoice).mockClear();
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }), expire: vi.fn() } },
        paymentIntents: { retrieve: vi.fn().mockResolvedValue({ latest_charge: null }) },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM deposit_credit_applications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay15_%'`));
    await db.$disconnect();
  });

  /**
   * Two paid deposits, A ($200, paid by `paidBy`) and B ($150, by check), both drawn onto one
   * $1,000 job invoice: $650 left on it, with one deposit-credit row per deposit.
   */
  async function twoDepositsOnOneJobInvoice(opts: { paidBy: 'CARD' | 'CHECK'; jobStatus?: 'PARTIAL' | 'DISPUTED' | 'VOIDED' }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const depositA = randomUUID();
    const depositB = randomUUID();
    const paymentA = randomUUID();
    const job = randomUUID();
    const account = `acct_pay15_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay15c-${tag}`, email: `pay15c-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'CHECK'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const paidDeposit = (id: string, n: string, total: number) => db.invoice.create({
      data: {
        id, organization_id: org, customer_id: customer, kind: 'DEPOSIT', invoice_number: `D${n}-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: 0, net_collected: total, status: 'PAID', paid_at: new Date(),
      },
    });
    await paidDeposit(depositA, 'A', 200);
    await paidDeposit(depositB, 'B', 150);
    await db.payment.create({
      data: {
        id: paymentA, invoice_id: depositA, amount: 200, method: opts.paidBy, state: 'SUCCEEDED', paid_at: new Date(),
        ...(opts.paidBy === 'CARD'
          ? { stripe_payment_intent_id: `pi_pay15_${tag}`, stripe_charge_id: `ch_pay15_${tag}`, stripe_account_id: account, created_by_source: 'CLIENT' as const }
          : { created_by_source: 'USER' as const }),
      },
    });
    await db.payment.create({
      data: { invoice_id: depositB, amount: 150, method: 'CHECK', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
    });
    await db.invoice.create({
      data: {
        id: job, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 650, status: opts.jobStatus ?? 'PARTIAL',
        ...(opts.jobStatus === 'VOIDED' ? { voided_at: new Date() } : {}),
      },
    });
    for (const [deposit, amount] of [[depositA, 200], [depositB, 150]] as const) {
      await db.payment.create({
        data: { invoice_id: job, amount, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(), reference_number: 'DEPOSIT-CREDIT', created_by_source: 'SYSTEM' },
      });
      await db.depositCreditApplication.create({
        data: { deposit_invoice_id: deposit, target_invoice_id: job, amount, organization_id: org },
      });
    }

    /** The lost dispute on deposit A's card payment, delivered the way the processor sends it. */
    const loseDisputeOnA = async () => {
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify({
          id: `evt_pay15_${tag}`, object: 'event', api_version: '2025-02-24.acacia',
          type: 'charge.dispute.closed', created: 1790000000, account,
          data: {
            object: {
              id: `dp_pay15_${tag}`, object: 'dispute', amount: 20000, currency: 'usd', status: 'lost',
              reason: 'fraudulent', charge: `ch_pay15_${tag}`, payment_intent: `pi_pay15_${tag}`,
              evidence_details: { due_by: 1791000000, has_evidence: false, past_due: false, submission_count: 0 },
              is_charge_refundable: false, livemode: false, metadata: {},
            },
          },
        })));
      expect(res.status).toBe(200);
    };
    /** Staff void deposit A's check payment (it bounced). */
    const staffVoidA = async () => {
      (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { user: { id: user, email: `admin-${tag}@example.test` } },
        error: null,
      });
      const res = await request(app)
        .post(`/api/invoices/${depositA}/void-payment`)
        .set('Authorization', `Bearer pay15c-${tag}`)
        .send({ payment_id: paymentA, void_category: 'BOUNCED', reason: 'Check bounced' });
      expect(res.status).toBe(200);
    };
    const readJob = () => db.invoice.findUniqueOrThrow({ where: { id: job } });
    /** The job invoice's deposit-credit rows, as [amount, voided?]. */
    const credits = async () => (await db.payment.findMany({
      where: { invoice_id: job, reference_number: 'DEPOSIT-CREDIT' }, orderBy: { amount: 'desc' },
    })).map((p) => [Number(p.amount), p.voided_at != null] as const);
    const applications = async () => (await db.depositCreditApplication.findMany({
      where: { target_invoice_id: job }, orderBy: { amount: 'desc' },
    })).map((a) => [Number(a.amount), a.reversed_at != null] as const);
    return { depositA, job, loseDisputeOnA, staffVoidA, readJob, credits, applications };
  }

  /**
   * Fix round 1 (review:money): one $500 deposit paid by two payments, $200 by check and $300 by
   * card, its whole $500 credit drawn onto the job's invoices (`draws`, oldest first). Taking back
   * one payment must take back only the credit that payment stood behind: the other payment's money
   * is still on the deposit, and the credit it covers stays applied.
   */
  async function oneDepositPaidTwice(draws: number[]) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const deposit = randomUUID();
    const check = randomUUID();
    const account = `acct_pay15_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay15s-${tag}`, email: `pay15s-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD', 'CHECK'],
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
        id: deposit, organization_id: org, customer_id: customer, kind: 'DEPOSIT', invoice_number: `D-${tag}`,
        subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 0, net_collected: 500, status: 'PAID', paid_at: new Date(),
      },
    });
    await db.payment.create({
      data: { id: check, invoice_id: deposit, amount: 200, method: 'CHECK', state: 'SUCCEEDED', paid_at: new Date(), created_by_source: 'USER' },
    });
    await db.payment.create({
      data: {
        invoice_id: deposit, amount: 300, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
        stripe_payment_intent_id: `pi_pay15_${tag}`, stripe_charge_id: `ch_pay15_${tag}`, stripe_account_id: account, created_by_source: 'CLIENT',
      },
    });
    const jobs: string[] = [];
    for (const [i, credit] of draws.entries()) {
      const job = randomUUID();
      jobs.push(job);
      // Each drawdown a minute after the last, so "newest" is unambiguous.
      const at = new Date(Date.now() - (draws.length - i) * 60_000);
      await db.invoice.create({
        data: {
          id: job, organization_id: org, customer_id: customer, invoice_number: `INV${i}-${tag}`,
          subtotal: 1000, tax_amount: 0, total_amount: 1000, amount_due: 1000 - credit, status: 'PARTIAL',
        },
      });
      await db.payment.create({
        data: { invoice_id: job, amount: credit, method: 'CARD', state: 'SUCCEEDED', paid_at: at, created_at: at, reference_number: 'DEPOSIT-CREDIT', created_by_source: 'SYSTEM' },
      });
      await db.depositCreditApplication.create({
        data: { deposit_invoice_id: deposit, target_invoice_id: job, amount: credit, organization_id: org, created_at: at },
      });
    }

    /** The bank lost the dispute on the $300 card payment. */
    const loseDisputeOnCard = async () => {
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify({
          id: `evt_pay15_${tag}`, object: 'event', api_version: '2025-02-24.acacia',
          type: 'charge.dispute.closed', created: 1790000000, account,
          data: {
            object: {
              id: `dp_pay15_${tag}`, object: 'dispute', amount: 30000, currency: 'usd', status: 'lost',
              reason: 'fraudulent', charge: `ch_pay15_${tag}`, payment_intent: `pi_pay15_${tag}`,
              evidence_details: { due_by: 1791000000, has_evidence: false, past_due: false, submission_count: 0 },
              is_charge_refundable: false, livemode: false, metadata: {},
            },
          },
        })));
      expect(res.status).toBe(200);
    };
    /** Staff void the $200 check (it bounced). */
    const staffVoidCheck = async () => {
      (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { user: { id: user, email: `admin-${tag}@example.test` } },
        error: null,
      });
      const res = await request(app)
        .post(`/api/invoices/${deposit}/void-payment`)
        .set('Authorization', `Bearer pay15s-${tag}`)
        .send({ payment_id: check, void_category: 'BOUNCED', reason: 'Check bounced' });
      expect(res.status).toBe(200);
    };
    /** Per job invoice: [amount due, live deposit credit on it, credit still applied to it from the ledger]. */
    const jobMoney = async () => Promise.all(jobs.map(async (job) => {
      const inv = await db.invoice.findUniqueOrThrow({ where: { id: job } });
      const live = await db.payment.findMany({ where: { invoice_id: job, reference_number: 'DEPOSIT-CREDIT', voided_at: null } });
      const apps = await db.depositCreditApplication.findMany({ where: { target_invoice_id: job, reversed_at: null } });
      return [
        Number(inv.amount_due),
        live.reduce((s, p) => s + Number(p.amount), 0),
        apps.reduce((s, a) => s + Number(a.amount), 0),
      ];
    }));
    return { loseDisputeOnCard, staffVoidCheck, jobMoney };
  }

  describe.each([
    { door: 'a staff void of the $200 check', takeBack: 'staffVoidCheck' as const, takenBack: 200 },
    { door: 'a lost dispute on the $300 card payment', takeBack: 'loseDisputeOnCard' as const, takenBack: 300 },
  ])('$door, on a deposit of 500 dollars paid by check and card', ({ takeBack, takenBack }) => {
    it('takes back only that payment’s share of the credit; the share the other payment covers stays applied', async () => {
      const f = await oneDepositPaidTwice([500]);

      await f[takeBack]();

      // $500 of credit on a $1,000 invoice: only the taken-back payment's share comes off.
      expect(await f.jobMoney()).toEqual([[500 + takenBack, 500 - takenBack, 500 - takenBack]]);
    });

    it('takes the credit back from the newest drawdown first', async () => {
      // $300 drawn onto an older invoice, then $200 onto a newer one.
      const f = await oneDepositPaidTwice([300, 200]);

      await f[takeBack]();

      expect(await f.jobMoney()).toEqual(takenBack === 200
        ? [[700, 300, 300], [1000, 0, 0]]
        // $300: all $200 of the newer one, then $100 of the older one.
        : [[800, 200, 200], [1000, 0, 0]]);
    });
  });

  describe.each([
    { door: 'a lost dispute', paidBy: 'CARD' as const, takeBack: 'loseDisputeOnA' as const },
    { door: 'a staff void', paidBy: 'CHECK' as const, takeBack: 'staffVoidA' as const },
  ])('$door on deposit A', ({ paidBy, takeBack }) => {
    it("voids only A's $200 credit on the job invoice; B's $150 stands and the balance rises by $200", async () => {
      const f = await twoDepositsOnOneJobInvoice({ paidBy });

      await f[takeBack]();

      expect(await f.credits()).toEqual([[200, true], [150, false]]);
      expect(await f.applications()).toEqual([[200, true], [150, false]]);
      const job = await f.readJob();
      expect(Number(job.amount_due)).toBe(850);
      expect(job.status).toBe('PARTIAL');
    });

    it('a DISPUTED job invoice stays DISPUTED while its balance rises', async () => {
      const f = await twoDepositsOnOneJobInvoice({ paidBy, jobStatus: 'DISPUTED' });

      await f[takeBack]();

      const job = await f.readJob();
      expect(job.status).toBe('DISPUTED');
      expect(Number(job.amount_due)).toBe(850);
    });

    // From the slice 14 review: every balance the take-back raises asks for more than a link
    // opened before it, so the links still open for those invoices are closed after the commit.
    it('closes the checkout links still open for the deposit and the job invoice whose balances rose', async () => {
      const f = await twoDepositsOnOneJobInvoice({ paidBy });

      await f[takeBack]();

      await vi.waitFor(() => {
        const swept = vi.mocked(expireOpenCheckoutSessionsForInvoice).mock.calls.map(([id]) => id);
        expect(swept).toEqual(expect.arrayContaining([f.depositA, f.job]));
      });
    });

    it('a VOIDED job invoice is left VOIDED with its balance untouched', async () => {
      const f = await twoDepositsOnOneJobInvoice({ paidBy, jobStatus: 'VOIDED' });

      await f[takeBack]();

      const job = await f.readJob();
      expect(job.status).toBe('VOIDED');
      expect(Number(job.amount_due)).toBe(650);
    });
  });
});

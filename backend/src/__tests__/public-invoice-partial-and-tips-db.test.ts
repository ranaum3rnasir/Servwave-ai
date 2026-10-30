/* =============================================================================
   Payments go-live, slice 26 - the public invoice takes a partial amount and a tip, and its
   checkout door re-validates both on the server even when the page is bypassed.

   GET  /api/invoices/:id/public            says whether this invoice takes a partial amount and a
                                            tip (slice 21's check, moved here), with the tip each
                                            preset stands for.
   POST /api/invoices/:id/public/checkout   prices amount + tip through the pricing module and
                                            refuses anything out of bounds with a code.

   Driven through the real routes against a real migrated database (TEST_DATABASE_URL). Only the
   processor SDK is replaced, by a recorder: the assertions are on the exact params it receives.
   Skips when TEST_DATABASE_URL is unset, like every other *-db suite.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

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

import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

suite('public invoice partial amount and tips (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_pay26_db';
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  beforeEach(() => {
    sessionsCreate.mockReset().mockResolvedValue({ id: 'cs_pay26', url: 'https://checkout.example/pay26' });
  });

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A sent $100 invoice with a public link on an org whose account takes cards and bank payments. */
  async function invoiceWith(opts: {
    partial?: boolean | null;
    tips?: boolean;
    total?: number;
    tax?: number;
    methods?: string[] | null;
    status?: 'SENT' | 'PARTIAL';
    due?: number;
    kind?: 'STANDARD' | 'DEPOSIT';
  } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay26-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay26-${tag}`, email: `pay26-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay26_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
        tips_enabled: opts.tips ?? true, tip_presets: [10, 15, 20],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const total = opts.total ?? 100;
    const tax = opts.tax ?? 0;
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        status: opts.status ?? 'SENT', ...(opts.kind ? { kind: opts.kind } : {}), subtotal: total - tax, tax_amount: tax, total_amount: total,
        amount_due: opts.due ?? total, public_token: token,
        allow_partial_payment: opts.partial === undefined ? true : opts.partial,
        ...(opts.methods ? { payment_methods_override: opts.methods } : {}),
      },
    });
    return { org, invoice, token };
  }

  const view = (inv: { invoice: string; token: string }) => request(app).get(`/api/invoices/${inv.invoice}/public?token=${inv.token}`);
  const checkout = (inv: { invoice: string; token: string }, body: Record<string, unknown>) =>
    request(app).post(`/api/invoices/${inv.invoice}/public/checkout?token=${inv.token}`).send(body);

  describe('what the page is told', () => {
    // Slice 21's acceptance, moved here: an invoice with partial payments allowed through the
    // staff Payment options card shows the partial-amount field; its sibling does not.
    it('an invoice allowed to take partial payments says so; its sibling does not', async () => {
      const allowed = await invoiceWith({ partial: true });
      const sibling = await invoiceWith({ partial: null });

      expect((await view(allowed)).body.payment_options.allow_partial).toBe(true);
      expect((await view(sibling)).body.payment_options.allow_partial).toBe(false);
    });

    it('carries the tip each preset stands for, on the pre-tax share of what is due', async () => {
      // $108.75 with $8.75 tax: pre-tax $100, so 10/15/20% tip $10/$15/$20.
      const inv = await invoiceWith({ total: 108.75, tax: 8.75 });

      const { tips } = (await view(inv)).body.payment_options;

      expect(tips.enabled).toBe(true);
      expect(tips.preset_amounts).toEqual([10, 15, 20]);
    });
  });

  describe('a deposit invoice never takes a part payment', () => {
    it('reports no partial option on the page whatever the stored flag says', async () => {
      const deposit = await invoiceWith({ kind: 'DEPOSIT', partial: true });

      expect((await view(deposit)).body.payment_options.allow_partial).toBe(false);
    });

    it('refuses an amount at checkout with the options-changed code', async () => {
      const deposit = await invoiceWith({ kind: 'DEPOSIT', partial: true });

      const res = await checkout(deposit, { method: 'card', amount: 40 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYMENT_OPTIONS_CHANGED');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('still charges the full amount due when no amount is sent', async () => {
      const deposit = await invoiceWith({ kind: 'DEPOSIT', partial: true });

      const res = await checkout(deposit, { method: 'card' });

      expect(res.status).toBe(200);
      expect(sessionsCreate.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(10000);
    });
  });

  describe('a partial amount', () => {
    it('pays $40 of $100 with a $6 tip: the session charges $46 in two lines and names the partial amount', async () => {
      const inv = await invoiceWith();

      const res = await checkout(inv, { method: 'card', amount: 40, tip: 6, expected_amount: 100 });

      expect(res.status).toBe(200);
      const [params] = sessionsCreate.mock.calls[0];
      expect(params.line_items.map((l: { price_data: { unit_amount: number } }) => l.price_data.unit_amount)).toEqual([4000, 600]);
      expect(params.metadata).toMatchObject({ payableNowCents: '10000', amountCents: '4000', tipCents: '600' });
    });

    it('a full payment names no partial amount', async () => {
      const inv = await invoiceWith();

      await checkout(inv, { method: 'card', tip: 10 });

      expect(sessionsCreate.mock.calls[0][0].metadata.amountCents).toBeUndefined();
    });

    it('refuses a partial amount on an invoice that does not allow one, even if the page was bypassed', async () => {
      const inv = await invoiceWith({ partial: null });

      const res = await checkout(inv, { method: 'card', amount: 40 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYMENT_OPTIONS_CHANGED');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['below $1', 0.5, 'AMOUNT_BELOW_MINIMUM'],
      ['above what is payable now', 100.01, 'AMOUNT_ABOVE_PAYABLE_NOW'],
    ])('refuses a partial amount %s', async (_label, amount, code) => {
      const inv = await invoiceWith();

      const res = await checkout(inv, { method: 'card', amount });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('refuses a negative or non-numeric amount', async () => {
      const inv = await invoiceWith();

      expect((await checkout(inv, { method: 'card', amount: -5 })).status).toBe(400);
      expect((await checkout(inv, { method: 'card', amount: 'forty' })).status).toBe(400);
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('refuses an amount or a tip with a fraction of a cent instead of rounding it', async () => {
      const inv = await invoiceWith();

      const amount = await checkout(inv, { method: 'card', amount: 40.005 });
      const tip = await checkout(inv, { method: 'card', tip: 1.005 });

      expect(amount.status).toBe(400);
      expect(amount.body.code).toBe('AMOUNT_NOT_WHOLE_CENTS');
      expect(tip.status).toBe(400);
      expect(tip.body.code).toBe('TIP_OUT_OF_BOUNDS');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('bounds the partial amount by payable-now, not by the total: money still processing is not offered again', async () => {
      const inv = await invoiceWith({ status: 'PARTIAL', due: 70 });

      const tooMuch = await checkout(inv, { method: 'card', amount: 80 });
      const fine = await checkout(inv, { method: 'card', amount: 70 });

      expect(tooMuch.body.code).toBe('AMOUNT_ABOVE_PAYABLE_NOW');
      expect(fine.status).toBe(200);
    });
  });

  describe('a tip', () => {
    it('refuses a tip above the invoice total, with a code the page shows inline', async () => {
      const inv = await invoiceWith();

      const res = await checkout(inv, { method: 'card', tip: 100.01 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TIP_OUT_OF_BOUNDS');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('refuses a negative tip', async () => {
      const inv = await invoiceWith();

      const res = await checkout(inv, { method: 'card', tip: -1 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TIP_OUT_OF_BOUNDS');
      expect(sessionsCreate).not.toHaveBeenCalled();
    });

    it('accepts a tip of exactly the invoice total', async () => {
      const inv = await invoiceWith();

      expect((await checkout(inv, { method: 'card', tip: 100 })).status).toBe(200);
    });
  });

  describe('refusals the page can act on', () => {
    // The page keeps offering what it was told at load; a refusal that says the OPTIONS changed
    // must make it re-read the invoice (code, never wording).
    it('a tip on an org that switched tips off answers with the options-changed code', async () => {
      const inv = await invoiceWith({ tips: false });

      const res = await checkout(inv, { method: 'card', tip: 5 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYMENT_OPTIONS_CHANGED');
    });

    it('card refused on a bank-only invoice, and bank on a card-only one, both carry the options-changed code', async () => {
      const bankOnly = await invoiceWith({ methods: ['ACH'] });
      const cardOnly = await invoiceWith({ methods: ['CARD'] });

      const card = await checkout(bankOnly, { method: 'card' });
      const bank = await checkout(cardOnly, { method: 'bank' });

      expect(card.status).toBe(400);
      expect(card.body.code).toBe('PAYMENT_OPTIONS_CHANGED');
      expect(bank.status).toBe(400);
      expect(bank.body.code).toBe('PAYMENT_OPTIONS_CHANGED');
    });
  });
});

/* =============================================================================
   Payments go-live F1: POST /api/customers/:id/purge and GET /api/customers/:id/purge-preview,
   through the real routes against a real migrated database (TEST_DATABASE_URL; skipped when
   unset). The processor client is the only mock. Dates are far from any window edge (the exact
   edges are pinned in purge-policy-db.test.ts with a fixed clock).
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, fakeStripe } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  const fakeStripe = {
    checkout: { sessions: { list: vi.fn(), expire: vi.fn(), retrieve: vi.fn() } },
  };
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, fakeStripe };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('../lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../lib/stripe')>()),
  isStripeConfigured: () => true,
  getStripeForOrg: (org: { stripe_account_id: string | null }) => ({
    stripe: fakeStripe as never,
    stripeAccount: org.stripe_account_id ?? undefined,
  }),
}));

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
// Stored session ids are unique in the table and rows of a failed earlier run may linger: tag each run.
const RUN = randomUUID().slice(0, 8);
const VENDOR = /stripe|supabase|render|ctm|calltracking/i;

suite('force purge guard (real database)', { timeout: 60_000 }, () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    fakeStripe.checkout.sessions.list.mockReset().mockResolvedValue({ data: [], has_more: false });
    fakeStripe.checkout.sessions.expire.mockReset().mockResolvedValue({});
    fakeStripe.checkout.sessions.retrieve.mockReset().mockRejectedValue(new Error('unexpected retrieve'));
  });

  async function world() {
    const { org, customer, admin } = await fx.newOrg();
    const row = await db.customer.findUniqueOrThrow({ where: { id: customer } });
    let n = 0;
    async function invoice(status: 'DRAFT' | 'SENT' | 'PAID' | 'VOIDED', at: Date) {
      const id = randomUUID();
      n += 1;
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `INV-${id.slice(0, 8)}-${n}`,
          subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 100, status, created_at: at,
        },
      });
      return id;
    }
    async function payment(invoiceId: string, at: Date, method: 'CARD' | 'CASH' = 'CASH') {
      const id = randomUUID();
      await db.payment.create({
        data: { id, invoice_id: invoiceId, amount: 100, method, paid_at: at, created_at: at, ...(method === 'CARD' ? { stripe_payment_intent_id: `pi_${id.slice(0, 8)}` } : {}) },
      });
      return id;
    }
    async function dispute(invoiceId: string, paymentId: string, at: Date) {
      await db.dispute.create({
        data: { organization_id: org, invoice_id: invoiceId, payment_id: paymentId, stripe_dispute_id: `dp_${randomUUID()}`, status: 'NEEDS_RESPONSE', amount: 100, created_at: at },
      });
    }
    const rows = async () => ({
      customers: await db.customer.count({ where: { id: customer } }),
      invoices: await db.invoice.count({ where: { organization_id: org } }),
      payments: await db.payment.count({ where: { invoice: { organization_id: org } } }),
    });
    const purge = async (who = admin) => (await fx.signedInAs(who)).post(`/api/customers/${customer}/purge`, { confirm: row.customer_number });
    const preview = async (who = admin) => (await fx.signedInAs(who)).get(`/api/customers/${customer}/purge-preview`);
    const audits = () => db.auditLog.findMany({ where: { org_id: org, action: 'customer.purged' } });
    return { org, customer, admin, row, invoice, payment, dispute, rows, purge, preview, audits };
  }

  describe('the guard', () => {
    it.each([
      ['a sent invoice in the window', async (w: Awaited<ReturnType<typeof world>>) => { await w.invoice('SENT', daysAgo(30)); }],
      ['a payment in the window', async (w: Awaited<ReturnType<typeof world>>) => { const i = await w.invoice('DRAFT', daysAgo(30)); await w.payment(i, daysAgo(30)); }],
      ['a card payment', async (w: Awaited<ReturnType<typeof world>>) => { const i = await w.invoice('VOIDED', daysAgo(500)); await w.payment(i, daysAgo(10), 'CARD'); }],
    ])('refuses with 409 and deletes nothing: %s', async (_name, seed) => {
      const w = await world();
      await seed(w);
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURGE_BLOCKED_FINANCIAL_RECORDS');
      expect(res.body.error).toMatch(/Archive the client instead/);
      expect(JSON.stringify(res.body)).not.toMatch(VENDOR);
      expect(res.body.blockers.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('invoice_count');
      expect(res.body).toHaveProperty('payment_count');
      expect(res.body).toHaveProperty('open_disputes');
      expect(res.body).toHaveProperty('newest_financial_date');
      expect(await w.rows()).toEqual(before);
      expect(await w.audits()).toHaveLength(0);
    });

    it('an open dispute older than 7 years still blocks', async () => {
      const w = await world();
      const i = await w.invoice('VOIDED', daysAgo(4000));
      const p = await w.payment(i, daysAgo(4000));
      await w.dispute(i, p, daysAgo(4000));
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(409);
      expect(res.body.blockers).toEqual(['OPEN_DISPUTES']);
      expect(res.body.open_disputes).toBe(1);
      expect(await w.rows()).toEqual(before);
    });

    it('purges a customer with only drafts and writes exactly one audit row with the invoice ids and no personal details', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      const b = await w.invoice('DRAFT', daysAgo(2));
      const res = await w.purge();
      expect(res.status).toBe(200);
      expect(res.body.purged).toBe(true);
      expect(await w.rows()).toEqual({ customers: 0, invoices: 0, payments: 0 });

      const audits = await w.audits();
      expect(audits).toHaveLength(1);
      const meta = audits[0].metadata as Record<string, unknown>;
      expect(audits[0].actor_id).toBe(w.admin.id);
      expect(audits[0].resource_id).toBe(w.customer);
      expect(meta.customer_number).toBe(w.row.customer_number);
      expect((meta.invoice_ids as string[]).sort()).toEqual([a, b].sort());
      expect(meta.invoice_numbers).toHaveLength(2);
      expect(meta.draft_invoice_count).toBe(2);
      expect(meta.payment_count).toBe(0);
      expect(meta.payment_total).toBe(0);
      const text = JSON.stringify(audits[0]);
      expect(text).not.toMatch(/Pat|Payer/);
    });

    it('purges when the only records are older than every window', async () => {
      const w = await world();
      const i = await w.invoice('PAID', daysAgo(4000));
      await w.payment(i, daysAgo(4000));
      const res = await w.purge();
      expect(res.status).toBe(200);
      const meta = (await w.audits())[0].metadata as Record<string, unknown>;
      expect(meta.payment_count).toBe(1);
      expect(meta.payment_total).toBe(100);
    });

    it('still refuses a non-admin with 403 and the purge never reaches the guard', async () => {
      const w = await world();
      await w.invoice('DRAFT', daysAgo(3));
      const tech = await fx.addUser(w.org, 'tech', 'TECHNICIAN');
      expect((await w.purge(tech)).status).toBe(403);
      expect((await w.preview(tech)).status).toBe(403);
      expect((await w.rows()).customers).toBe(1);
    });
  });

  describe('the preview', () => {
    it('says allowed with zero counts when a purge would go through', async () => {
      const w = await world();
      await w.invoice('DRAFT', daysAgo(3));
      const res = await w.preview();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        allowed: true, blockers: [], invoice_count: 0, payment_count: 0, payment_total: 0,
        open_disputes: 0, newest_financial_date: null, has_card_payments: false,
      });
      expect((await w.rows()).customers).toBe(1);
    });

    it('matches the guard for the same fixtures', async () => {
      const w = await world();
      const i = await w.invoice('SENT', daysAgo(30));
      const p = await w.payment(i, daysAgo(10), 'CARD');
      await w.dispute(i, p, daysAgo(9));
      const preview = await w.preview();
      const purge = await w.purge();
      expect(preview.body.allowed).toBe(false);
      expect(purge.status).toBe(409);
      expect(preview.body.blockers).toEqual(purge.body.blockers);
      for (const key of ['invoice_count', 'payment_count', 'payment_total', 'open_disputes', 'newest_financial_date', 'has_card_payments']) {
        expect(preview.body[key]).toEqual(purge.body[key]);
      }
      expect(preview.body).toMatchObject({ invoice_count: 1, payment_count: 1, payment_total: 100, open_disputes: 1, has_card_payments: true });
    });

    it('does not show another organisation\'s customer', async () => {
      const mine = await world();
      const other = await world();
      const res = await (await fx.signedInAs(mine.admin)).get(`/api/customers/${other.customer}/purge-preview`);
      expect(res.status).toBe(404);
    });
  });

  describe('what the audit row and the preview count', () => {
    it('count and total only SUCCEEDED payments, in whole cents', async () => {
      const w = await world();
      const i = await w.invoice('PAID', daysAgo(4000));
      for (const [amount, state] of [[10.1, 'SUCCEEDED'], [20.2, 'SUCCEEDED'], [5, 'FAILED'], [7, 'PROCESSING']] as const) {
        await db.payment.create({ data: { invoice_id: i, amount, method: 'CASH', paid_at: daysAgo(4000), created_at: daysAgo(4000), state } });
      }
      const preview = await w.preview();
      expect(preview.body.payment_count).toBe(2);
      expect(preview.body.payment_total).toBe(30.3);
      // A processing payment is not settled: it blocks through the guard rather than through the total.
      expect(preview.body.allowed).toBe(true);
    });

    it('the audit row carries the same count and total', async () => {
      const w = await world();
      const i = await w.invoice('PAID', daysAgo(4000));
      for (const [amount, state] of [[10.1, 'SUCCEEDED'], [20.2, 'SUCCEEDED'], [5, 'FAILED']] as const) {
        await db.payment.create({ data: { invoice_id: i, amount, method: 'CASH', paid_at: daysAgo(4000), created_at: daysAgo(4000), state } });
      }
      expect((await w.purge()).status).toBe(200);
      const meta = (await w.audits())[0].metadata as Record<string, unknown>;
      expect(meta.payment_count).toBe(2);
      expect(meta.payment_total).toBe(30.3);
    });
  });

  describe('payment links', () => {
    const nowUnix = () => Math.floor(Date.now() / 1000);
    const open = (invoiceId: string, id: string, status = 'open') => ({ id, status, metadata: { invoiceId }, created: nowUnix() });
    // The processor filters a list by status; the fake does the same, so a session only shows up in the list
    // the purge asked for.
    const listing = (sessions: { id: string; status?: string }[]) =>
      fakeStripe.checkout.sessions.list.mockImplementation(async (params: { status?: string }) => ({
        data: sessions.filter((x) => x.status === params.status), has_more: false,
      }));

    it('closes each open session once at the processor before deleting, on the org account', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      const b = await w.invoice('DRAFT', daysAgo(2));
      const account = `acct_f1_${randomUUID().slice(0, 8)}`;
      await db.organization.update({ where: { id: w.org }, data: { stripe_account_id: account } });
      listing([open(a, 'cs_a'), open(b, 'cs_b'), open(randomUUID(), 'cs_not_ours')]);
      const res = await w.purge();
      expect(res.status).toBe(200);
      const expired = fakeStripe.checkout.sessions.expire.mock.calls.map((c) => c[0]).sort();
      expect(expired).toEqual(['cs_a', 'cs_b']);
      expect(fakeStripe.checkout.sessions.expire.mock.calls[0][2]).toEqual({ stripeAccount: account });
      expect(await w.rows()).toEqual({ customers: 0, invoices: 0, payments: 0 });
    });

    it('answers 502 and deletes nothing when a link cannot be closed', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      listing([open(a, 'cs_a')]);
      fakeStripe.checkout.sessions.expire.mockRejectedValue(new Error('network down'));
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("Could not close this client's payment links. Nothing was deleted. Try again.");
      expect(JSON.stringify(res.body)).not.toMatch(VENDOR);
      expect(await w.rows()).toEqual(before);
      expect(await w.audits()).toHaveLength(0);
    });

    it('an already expired session is fine: the purge goes through and nothing is expired again', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      listing([open(a, 'cs_a', 'expired')]);
      expect((await w.purge()).status).toBe(200);
      expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalled();
    });

    it('an open session is expired exactly once', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      listing([open(a, 'cs_a', 'open')]);
      expect((await w.purge()).status).toBe(200);
      expect(fakeStripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    });

    it('a completed session whose payment is not recorded yet refuses with 409 and deletes nothing', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      listing([open(a, 'cs_paid', 'complete')]);
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURGE_BLOCKED_PAYMENT_IN_FLIGHT');
      expect(res.body.error).toBe('This client has a payment that is still being recorded. Try again in a few minutes.');
      expect(JSON.stringify(res.body)).not.toMatch(VENDOR);
      expect(await w.rows()).toEqual(before);
      expect(await w.audits()).toHaveLength(0);
    });

    it('a completed session whose payment is already recorded does not block a purge that is otherwise allowed', async () => {
      const w = await world();
      const a = await w.invoice('PAID', daysAgo(4000));
      const p = await w.payment(a, daysAgo(4000));
      await db.payment.update({ where: { id: p }, data: { stripe_checkout_session_id: `cs_done_${RUN}` } });
      fakeStripe.checkout.sessions.retrieve.mockResolvedValue({ id: `cs_done_${RUN}`, status: 'complete' });
      expect((await w.purge()).status).toBe(200);
      expect(fakeStripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
    });

    it('a stored session whose status cannot be read counts as a failure: 502, nothing deleted', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      const p = await w.payment(a, daysAgo(3000));
      await db.payment.update({ where: { id: p }, data: { stripe_checkout_session_id: `cs_x_${RUN}`, voided_at: daysAgo(3000) } });
      fakeStripe.checkout.sessions.retrieve.mockResolvedValue({ id: `cs_x_${RUN}` });
      const before = await w.rows();
      expect((await w.purge()).status).toBe(502);
      expect(await w.rows()).toEqual(before);
    });

    it('a stored session the processor cannot return counts as a failure: 502, nothing deleted', async () => {
      const w = await world();
      const a = await w.invoice('DRAFT', daysAgo(3));
      await db.unappliedCapture.create({ data: { organization_id: w.org, invoice_id: a, reason: 'INVOICE_NOT_PAYABLE', stripe_checkout_session_id: `cs_gone_${RUN}`, source_key: `k_${randomUUID()}` } });
      fakeStripe.checkout.sessions.retrieve.mockRejectedValue(new Error('network down'));
      const before = await w.rows();
      expect((await w.purge()).status).toBe(502);
      expect(await w.rows()).toEqual(before);
    });

    it('an org with many unrelated sessions retrieves exactly the stored sessions of the subtree and never lists them all', async () => {
      const w = await world();
      const a = await w.invoice('PAID', daysAgo(4000));
      const p = await w.payment(a, daysAgo(4000));
      await db.payment.update({ where: { id: p }, data: { stripe_checkout_session_id: `cs_mine_1_${RUN}` } });
      const b = await w.invoice('DRAFT', daysAgo(3));
      await db.unappliedCapture.create({ data: { organization_id: w.org, invoice_id: b, reason: 'INVOICE_NOT_PAYABLE', stripe_checkout_session_id: `cs_mine_2_${RUN}`, source_key: `k_${randomUUID()}` } });
      // Another customer of the same org, with its own stored session: never retrieved.
      const other = randomUUID();
      await db.customer.create({ data: { id: other, organization_id: w.org, customer_number: `C-${other.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Sam', last_name: 'Other' } });
      const oi = randomUUID();
      await db.invoice.create({ data: { id: oi, organization_id: w.org, customer_id: other, invoice_number: `INV-${oi.slice(0, 8)}`, subtotal: 1, tax_amount: 0, total_amount: 1, amount_due: 1, status: 'DRAFT' } });
      const op = await db.payment.create({ data: { invoice_id: oi, amount: 1, method: 'CASH', paid_at: daysAgo(1), stripe_checkout_session_id: `cs_other_customer_${RUN}` } });
      expect(op.id).toBeTruthy();
      fakeStripe.checkout.sessions.retrieve.mockImplementation(async (id: string) => ({ id, status: 'complete' }));
      const unrelated = Array.from({ length: 300 }, (_, i) => open(randomUUID(), `cs_noise_${i}`, 'open'));
      listing(unrelated);
      const res = await w.purge();
      expect(res.status).toBe(200);
      expect(fakeStripe.checkout.sessions.retrieve.mock.calls.map((c) => c[0]).sort()).toEqual([`cs_mine_1_${RUN}`, `cs_mine_2_${RUN}`]);
      expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalled();
      // Only windowed lists (open, or recently completed): never "every session ever created".
      for (const [params] of fakeStripe.checkout.sessions.list.mock.calls) {
        expect(['open', 'complete']).toContain(params.status);
        if (params.status === 'complete') expect(params.created?.gte).toBeGreaterThan(0);
      }
    });

    it('does not touch the processor when the purge is refused', async () => {
      const w = await world();
      const a = await w.invoice('SENT', daysAgo(3));
      listing([open(a, 'cs_a')]);
      expect((await w.purge()).status).toBe(409);
      expect(fakeStripe.checkout.sessions.expire).not.toHaveBeenCalled();
    });
  });

  describe('the check inside the purge transaction', () => {
    it('a payment written after the first look and before the delete is seen: 409 and nothing deleted', async () => {
      const w = await world();
      const inv = await w.invoice('DRAFT', daysAgo(3));
      // The processor call sits between the first look and the transaction: a payment is being written
      // there and commits a moment later. The purge transaction locks the invoice, so it waits for that
      // payment and then sees it.
      let writing: Promise<unknown> = Promise.resolve();
      let started = false;
      fakeStripe.checkout.sessions.list.mockImplementation(async () => {
        if (started) return { data: [], has_more: false };
        started = true;
        writing = db.$transaction(async (tx) => {
          await tx.payment.create({ data: { invoice_id: inv, amount: 100, method: 'CASH', paid_at: daysAgo(1), created_at: daysAgo(1) } });
          await new Promise((r) => setTimeout(r, 1500));
        });
        await new Promise((r) => setTimeout(r, 400));
        return { data: [], has_more: false };
      });
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURGE_BLOCKED_FINANCIAL_RECORDS');
      expect(res.body.blockers).toContain('PAYMENTS_IN_RETENTION_WINDOW');
      expect(await w.rows()).toEqual({ ...before, payments: 1 });
      await writing;
      expect(await w.audits()).toHaveLength(0);
    });

    it('an invoice created after the links were closed refuses with 409 PURGE_BLOCKED_PAYMENT_IN_FLIGHT and deletes nothing', async () => {
      const w = await world();
      await w.invoice('DRAFT', daysAgo(3));
      // The sweep is the window between the first look and the transaction: a new draft lands there.
      let landed = false;
      fakeStripe.checkout.sessions.list.mockImplementation(async () => {
        if (!landed) { landed = true; await w.invoice('DRAFT', daysAgo(0)); }
        return { data: [], has_more: false };
      });
      const before = await w.rows();
      const res = await w.purge();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURGE_BLOCKED_PAYMENT_IN_FLIGHT');
      expect(res.body.error).toBe('This client has a payment that is still being recorded. Try again in a few minutes.');
      expect(await w.rows()).toEqual({ ...before, invoices: before.invoices + 1 });
      expect(await w.audits()).toHaveLength(0);
    });
  });
});

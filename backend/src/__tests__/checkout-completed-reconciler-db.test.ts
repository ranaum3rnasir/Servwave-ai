/* =============================================================================
   Payments go-live, slice 08 - completed card checkouts go through the reconciler, and money the
   processor captured is never only logged.

   Before: the checkout-completed branch of the webhook controller wrote a log line and nothing
   else when the invoice was not found, belonged to another org, or was no longer payable (voided)
   when the session arrived; the event was then marked processed, so the processor never re-sent
   it and nobody heard about the customer's money. It stamped paid-at with the processing time and
   kept no charge id, session id or card details, and an org that had since turned card off had
   the payment it already took silently dropped.

   Events are posted to the real webhook route in the processor's payload shape for the pinned
   version (a checkout session carries the payment intent id, not the charge; the charge is read
   back from the processor). Real migrated database (TEST_DATABASE_URL); skips when unset. Every
   org it creates is removed again.
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

import { getStripeForOrg } from '../lib/stripe';

const suite = realClient ? describe : describe.skip;

/** The charge the processor returns for a payment intent (latest_charge expanded). */
const retrievePaymentIntent = vi.fn();
/** The disputes the processor holds on a charge. */
const listDisputes = vi.fn();
/** The checkout sessions the processor holds for a payment intent (an unmatched dispute asks). */
const listSessions = vi.fn();

suite('completed card checkouts through the reconciler (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  beforeEach(() => {
    retrievePaymentIntent.mockReset();
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_x', latest_charge: null });
    listDisputes.mockReset();
    listDisputes.mockResolvedValue({ data: [], has_more: false });
    listSessions.mockReset();
    listSessions.mockResolvedValue({ data: [], has_more: false });
    vi.mocked(getStripeForOrg).mockReturnValue({
      stripe: {
        paymentIntents: { retrieve: retrievePaymentIntent },
        disputes: { list: listDisputes },
        checkout: { sessions: { list: listSessions } },
        applicationFees: { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() },
      },
      stripeAccount: undefined,
    } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  /** An org with a connected account, an admin, a customer and one invoice of $total. */
  async function orgWithInvoice(opts: { total?: number; status?: 'SENT' | 'PARTIAL' | 'VOIDED' | 'PAID'; accepts?: ('CARD' | 'ACH')[] } = {}) {
    const total = opts.total ?? 500;
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_pay08_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay08-${tag}`, email: `pay08-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: opts.accepts ?? ['CARD'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, status: opts.status ?? 'SENT',
      },
    });
    let seq = 0;
    /** A paid card checkout session, as checkout.session.completed carries it. */
    const session = (over: Record<string, unknown> = {}) => ({
      id: `cs_pay08_${tag}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
      payment_intent: `pi_pay08_${tag}`, amount_total: total * 100, currency: 'usd',
      metadata: { invoiceId: invoice },
      ...over,
    });
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (object: object, opts2: { account?: string | null; id?: string; type?: string; status?: number } = {}) => {
      const event = {
        id: opts2.id ?? `evt_pay08_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia',
        type: opts2.type ?? 'checkout.session.completed', created: 1790000000,
        ...(opts2.account === null ? {} : { account: opts2.account ?? account }),
        data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(opts2.status ?? 200);
      return res;
    };
    const payments = () => db.payment.findMany({ where: { invoice_id: invoice } });
    const readInvoice = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    /** The "payment not recorded" history rows written for this org. */
    const unrecorded = () => db.timelineEvent.findMany({ where: { organization_id: org, event_type: 'PAYMENT_UNRECORDED' } });
    return { org, tag, invoice, account, user, customer, session, deliver, payments, readInvoice, unrecorded };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['estimates', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay08_%'`));
    await db.$disconnect();
  });

  /**
   * Hold the invoice the way a staff write does: lock its row, make `write` inside that transaction,
   * start the webhook delivery, and commit only once the webhook is waiting for the same lock. The
   * webhook has then read the invoice (before the lock) and must judge the payment by what it reads
   * under the lock, after the staff write committed.
   */
  async function whileTheWebhookWaitsForTheLock(
    invoiceId: string,
    write: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>,
    deliver: () => Promise<unknown>,
  ) {
    let delivered: Promise<unknown> = Promise.resolve();
    await db.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      await write(tx);
      delivered = deliver();
      for (let i = 0; ; i++) {
        const [{ waiting }] = await db.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
        if (waiting > 0) break;
        if (i > 400) throw new Error('the webhook never waited for the invoice lock');
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20000 });
    await delivered;
  }

  it('a paid checkout books one SUCCEEDED card payment: paid at the charge time, with charge id, session id, wallet, brand and last four', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const chargeCreated = 1789990000; // earlier than the event: the customer paid, then the event was processed
    retrievePaymentIntent.mockResolvedValue({
      id: `pi_pay08_${f.tag}`,
      latest_charge: {
        id: `ch_pay08_${f.tag}`, object: 'charge', created: chargeCreated, amount: 50000,
        payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', wallet: { type: 'apple_pay' } } },
      },
    });

    await f.deliver(f.session());

    const [payment, ...others] = await f.payments();
    expect(others).toHaveLength(0);
    expect(payment).toMatchObject({
      method: 'CARD', state: 'SUCCEEDED',
      stripe_payment_intent_id: `pi_pay08_${f.tag}`,
      stripe_charge_id: `ch_pay08_${f.tag}`,
      stripe_checkout_session_id: `cs_pay08_${f.tag}`,
      stripe_account_id: f.account,
      wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242',
    });
    expect(Number(payment.amount)).toBe(500);
    expect(payment.paid_at.toISOString()).toBe(new Date(chargeCreated * 1000).toISOString());
    // The charge was read on the account the event arrived on.
    expect(retrievePaymentIntent).toHaveBeenCalledWith(
      `pi_pay08_${f.tag}`, expect.objectContaining({ expand: expect.arrayContaining(['latest_charge']) }), { stripeAccount: f.account },
    );
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
    expect(Number((await f.readInvoice()).amount_due)).toBe(0);
    expect(await f.unrecorded()).toHaveLength(0);
  });

  // Payments go-live slice 28: the invoice timeline names the service, never "online" and never the
  // processor, and it is the same service whichever way the customer paid.
  it('the timeline line for an online payment reads "received via ServWave Payments"', async () => {
    const f = await orgWithInvoice({ total: 500 });
    await f.deliver(f.session());

    const lines = await db.timelineEvent.findMany({
      where: { organization_id: f.org, entity_type: 'INVOICE', entity_id: f.invoice, event_type: 'PAYMENT_RECEIVED' },
    });

    expect(lines.map((l) => l.description)).toEqual(['Card payment received via ServWave Payments']);
  });

  // Payments go-live slice 28 follow-up: the job's own history line is worded the same way, and never
  // prints the method code.
  it('the JOB history line for an online card payment reads "received via ServWave Payments"', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const location = await db.serviceLocation.create({
      data: { customer_id: f.customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const job = randomUUID();
    await db.job.create({
      data: { id: job, organization_id: f.org, customer_id: f.customer, service_location_id: location.id, job_number: `J-${f.tag}` },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { job_id: job } });

    await f.deliver(f.session());

    const lines = await db.timelineEvent.findMany({
      where: { organization_id: f.org, entity_type: 'JOB', entity_id: job, event_type: 'JOB_PAYMENT_RECORDED' },
    });
    expect(lines.map((l) => l.description)).toEqual([`Invoice INV-${f.tag} payment recorded via ServWave Payments`]);
  });

  // Payments go-live slice 09 (conductor note from slice 08 acceptance): SQL and reports read the
  // stored column, so the card booking writes it under the lock, as the refund paths do.
  it('a booked card payment writes the stored net collected: every payment that landed, cash included', async () => {
    const full = await orgWithInvoice({ total: 500 });
    await full.deliver(full.session());
    expect(Number((await full.readInvoice()).net_collected)).toBe(500);

    // $200 in cash first, then the card pays the $300 balance.
    const rest = await orgWithInvoice({ total: 500 });
    await db.payment.create({ data: { invoice_id: rest.invoice, amount: 200, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' } });
    await db.invoice.update({ where: { id: rest.invoice }, data: { amount_due: 300, status: 'PARTIAL' } });
    await rest.deliver(rest.session({ amount_total: 30000 }));
    expect(await rest.readInvoice()).toMatchObject({ status: 'PAID' });
    expect(Number((await rest.readInvoice()).net_collected)).toBe(500);
  });

  // Behaviour that predates slice 08 (the old controller also matched a booked payment by its
  // payment intent): kept as a guard that it survived the move into the reconciler.
  // Slice 37b item 1: the nightly reconcile writes a charge nothing recorded onto "Payments needing
  // attention" once it is past the retry horizon. If the charge's event then books the Payment, the
  // record must close in the same transaction, or staff could refund it (the customer refunded, the
  // invoice still paid) or apply it (the money booked twice).
  it('a late event that books the Payment closes the nightly "charge with no payment" record for that charge', async () => {
    const f = await orgWithInvoice({ total: 500 });
    retrievePaymentIntent.mockResolvedValue({
      id: `pi_pay08_${f.tag}`,
      latest_charge: { id: `ch_pay08_${f.tag}`, object: 'charge', created: 1789990000, amount: 50000, payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } } },
    });
    await db.unappliedCapture.create({
      data: {
        organization_id: f.org, reason: 'INVOICE_NOT_FOUND', amount: 500, stripe_payment_intent_id: `pi_pay08_${f.tag}`,
        stripe_account_id: f.account, source_key: `charge:ch_pay08_${f.tag}`,
      },
    });

    await f.deliver(f.session());

    const records = await db.unappliedCapture.findMany({ where: { organization_id: f.org } });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('RESOLVED');
    expect(await f.payments()).toHaveLength(1);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    const audit = await db.auditLog.findMany({ where: { org_id: f.org, action: 'payment_attention.resolved' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].resource_id).toBe(records[0].id);
  });

  it('the same session delivered again under another event id books nothing more', async () => {
    const f = await orgWithInvoice();
    await f.deliver(f.session());
    await f.deliver(f.session());
    expect(await f.payments()).toHaveLength(1);
    expect(await f.unrecorded()).toHaveLength(0);
  });

  it('a session naming an invoice that does not exist is recorded as a payment not recorded, on the org', async () => {
    const f = await orgWithInvoice();
    await f.deliver(f.session({ metadata: { invoiceId: randomUUID() } }));

    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'ORGANIZATION', entity_id: f.org });
    expect(rows[0].metadata).toMatchObject({ reason: 'INVOICE_NOT_FOUND', charged_cents: 50000, payment_intent: `pi_pay08_${f.tag}` });
    expect(rows[0].description).not.toMatch(/stripe/i);
    expect(await f.payments()).toHaveLength(0);
    // The owner is told, not only the history.
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'billing.payment_unrecorded' } })).toBe(1);
  });

  it('a session completing on a voided invoice is recorded as a payment not recorded, on that invoice', async () => {
    const f = await orgWithInvoice({ status: 'VOIDED' });
    await f.deliver(f.session());

    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'INVOICE', entity_id: f.invoice });
    expect(rows[0].metadata).toMatchObject({ reason: 'INVOICE_NOT_PAYABLE' });
    expect(await f.payments()).toHaveLength(0);
    expect(await f.readInvoice()).toMatchObject({ status: 'VOIDED' });
  });

  // Payments go-live slice 09 (conductor note from slice 08 acceptance).
  it('a checkout completing on an invoice already paid records the invoice total as expected, and says it was already paid', async () => {
    const f = await orgWithInvoice({ total: 123.45, status: 'PAID' });
    await db.invoice.update({ where: { id: f.invoice }, data: { amount_due: 0 } });
    await f.deliver(f.session());

    const [row] = await f.unrecorded();
    expect(row.metadata).toMatchObject({ reason: 'INVOICE_NOT_PAYABLE', expected_cents: 12345, charged_cents: 12345, invoice_status: 'PAID' });
    expect(row.description).toMatch(/already paid in full/);
    expect(row.description).not.toMatch(/voided/);
  });

  it("an event on one org's account naming another org's invoice never touches that invoice; the money is recorded on the org it landed in", async () => {
    const victim = await orgWithInvoice();
    const payer = await orgWithInvoice();
    await payer.deliver(victim.session());

    expect(await victim.payments()).toHaveLength(0);
    expect(await victim.readInvoice()).toMatchObject({ status: 'SENT' });
    expect(await victim.unrecorded()).toHaveLength(0);
    const rows = await payer.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'ORGANIZATION', entity_id: payer.org });
    expect(rows[0].metadata).toMatchObject({ reason: 'WRONG_ORG' });
    // The other org's invoice is not named in this org's record.
    expect(JSON.stringify(rows[0])).not.toContain(victim.invoice);
  });

  it('money not applied is written down once per checkout session, however many event ids deliver it', async () => {
    const onInvoice = await orgWithInvoice({ status: 'VOIDED' });
    await onInvoice.deliver(onInvoice.session());
    await onInvoice.deliver(onInvoice.session());
    expect(await onInvoice.unrecorded()).toHaveLength(1);
    expect(await db.notification.count({ where: { organization_id: onInvoice.org, verb: 'billing.payment_unrecorded' } })).toBe(1);

    // The same on the org, when no invoice of the org can carry the money.
    const onOrg = await orgWithInvoice();
    const missing = randomUUID();
    await onOrg.deliver(onOrg.session({ metadata: { invoiceId: missing } }));
    await onOrg.deliver(onOrg.session({ metadata: { invoiceId: missing } }));
    expect(await onOrg.unrecorded()).toHaveLength(1);
    expect(await db.notification.count({ where: { organization_id: onOrg.org, verb: 'billing.payment_unrecorded' } })).toBe(1);
  });

  it('an org that has since stopped accepting card still gets the card payment it already took', async () => {
    const f = await orgWithInvoice({ accepts: [] });
    await f.deliver(f.session());
    expect(await f.payments()).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  it('slice 39: an org that lost the online_payments plan AND card after the session opened still gets the payment recorded', async () => {
    const f = await orgWithInvoice();
    await db.organization.update({ where: { id: f.org }, data: { accepted_payment_methods: [], feature_overrides: { online_payments: false } } });
    await f.deliver(f.session());
    expect(await f.payments()).toHaveLength(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'PAID' });
  });

  it('a staff payment that commits while the webhook waits for the invoice lock: the charge is judged against the balance after it', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await whileTheWebhookWaitsForTheLock(f.invoice, async (tx) => {
      await tx.payment.create({ data: { invoice_id: f.invoice, amount: 200, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' } });
      await tx.invoice.update({ where: { id: f.invoice }, data: { amount_due: 300, status: 'PARTIAL' } });
    }, () => f.deliver(f.session({ amount_total: 50000 })));

    // Not booked over the balance, and the invoice is not marked paid off the stale read.
    expect((await f.payments()).filter((p) => p.method === 'CARD')).toHaveLength(0);
    const invoice = await f.readInvoice();
    expect(invoice).toMatchObject({ status: 'PARTIAL' });
    expect(Number(invoice.amount_due)).toBe(300);
    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ reason: 'AMOUNT_MISMATCH', expected_cents: 30000, charged_cents: 50000 });
  });

  it('a deposit whose estimate is recalled to draft while the webhook waits for the invoice lock is recorded as on hold, not booked', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const estimate = randomUUID();
    await db.estimate.create({
      data: {
        id: estimate, organization_id: f.org, customer_id: f.customer, created_by: f.user, estimate_number: `E-${f.tag}`,
        status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000,
      },
    });
    await db.invoice.update({ where: { id: f.invoice }, data: { kind: 'DEPOSIT', estimate_id: estimate } });

    await whileTheWebhookWaitsForTheLock(f.invoice, async (tx) => {
      await tx.estimate.update({ where: { id: estimate }, data: { status: 'DRAFT' } });
    }, () => f.deliver(f.session({ metadata: { invoiceId: f.invoice, kind: 'deposit' } })));

    expect(await f.payments()).toHaveLength(0);
    expect(await f.readInvoice()).toMatchObject({ status: 'SENT' });
    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'INVOICE', entity_id: f.invoice });
    expect(rows[0].metadata).toMatchObject({ reason: 'DEPOSIT_ON_HOLD' });
  });

  // Behaviour that predates slice 08 (the route resolves no org for the account): kept as a guard.
  // decide-checkout.test.ts shows the reconciler's own guard.
  it('an event for a connected account ServWave does not know is not ours: 200, nothing recorded', async () => {
    const f = await orgWithInvoice();
    await f.deliver(f.session(), { account: 'acct_pay08_unknown_elsewhere' });
    expect(await f.payments()).toHaveLength(0);
    expect(await f.unrecorded()).toHaveLength(0);
  });

  // The processor's dispute test card raises the dispute with the charge, and sends
  // charge.dispute.created about half a second BEFORE checkout.session.completed. That first event
  // finds no payment; the booking must then pick the dispute up itself.
  it('a dispute raised before the checkout is booked is picked up by the booking: the invoice reads DISPUTED and the owner is told once', async () => {
    const f = await orgWithInvoice({ total: 500 });
    const dispute = {
      id: `dp_pay08_${f.tag}`, object: 'dispute', amount: 50000, currency: 'usd', status: 'needs_response',
      reason: 'fraudulent', charge: `ch_pay08_${f.tag}`, payment_intent: `pi_pay08_${f.tag}`,
      evidence_details: { due_by: 1791000000, has_evidence: false, past_due: false, submission_count: 0 },
      is_charge_refundable: false, livemode: false, metadata: {},
    };
    // The charge came from this ServWave checkout, so the early dispute is refused for a retry.
    listSessions.mockResolvedValue({ data: [f.session()], has_more: false });
    await f.deliver(dispute, { type: 'charge.dispute.created', status: 503 });
    expect(await db.dispute.count({ where: { organization_id: f.org } })).toBe(0);

    retrievePaymentIntent.mockResolvedValue({
      id: `pi_pay08_${f.tag}`,
      latest_charge: {
        id: `ch_pay08_${f.tag}`, object: 'charge', created: 1789990000, amount: 50000, disputed: true,
        payment_method_details: { type: 'card', card: { brand: 'visa', last4: '0259' } },
      },
    });
    listDisputes.mockResolvedValue({ data: [dispute], has_more: false });
    await f.deliver(f.session());

    const [payment] = await f.payments();
    const [row, ...others] = await db.dispute.findMany({ where: { organization_id: f.org } });
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({ stripe_dispute_id: `dp_pay08_${f.tag}`, payment_id: payment.id, invoice_id: f.invoice, status: 'NEEDS_RESPONSE' });
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
    // The disputes were read on the account the event arrived on.
    expect(listDisputes).toHaveBeenCalledWith(expect.objectContaining({ charge: `ch_pay08_${f.tag}` }), { stripeAccount: f.account });
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'billing.disputed' } })).toBe(1);

    // The same checkout delivered again, and the dispute's own event again, change nothing more.
    await f.deliver(f.session());
    await f.deliver(dispute, { type: 'charge.dispute.created' });
    expect(await db.dispute.count({ where: { organization_id: f.org } })).toBe(1);
    expect(await db.notification.count({ where: { organization_id: f.org, verb: 'billing.disputed' } })).toBe(1);
    expect(await f.readInvoice()).toMatchObject({ status: 'DISPUTED' });
  });

  // V7-12a pins (no overpaid invoices, BE-14 rows 3 and 4): money that is more than what is owed, or
  // that arrives for an invoice already paid, never lands on the invoice. It is written down as a
  // payment not recorded, for the office to refund or attach.
  it('a capture larger than the balance books nothing: the invoice is unchanged and the whole charge is recorded as not applied', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await f.deliver(f.session({ amount_total: 60000 }));

    expect(await f.payments()).toHaveLength(0);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('SENT');
    expect(Number(invoice.amount_due)).toBe(500);
    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ reason: 'AMOUNT_MISMATCH', expected_cents: 50000, charged_cents: 60000 });
  });

  it('paid twice: the first checkout books and pays the invoice, the second one is recorded as not applied and books no second payment', async () => {
    const f = await orgWithInvoice({ total: 500 });

    await f.deliver(f.session());
    await f.deliver(f.session({ id: `cs_second_${f.tag}`, payment_intent: `pi_second_${f.tag}` }));

    const card = (await f.payments()).filter((p) => p.method === 'CARD');
    expect(card).toHaveLength(1);
    const invoice = await f.readInvoice();
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amount_due)).toBe(0);
    const rows = await f.unrecorded();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ reason: 'INVOICE_NOT_PAYABLE', charged_cents: 50000 });
  });
});

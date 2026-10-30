/**
 * Payments go-live slice 09 - sandbox check that a dispute is recorded ONCE and settles the invoice.
 *
 * Real money flow on the sandbox: two real charges with the processor's dispute test card
 * (pm_card_createDispute), whose disputes the processor opens by itself. The processor's OWN
 * charge.dispute.* events (fetched back from the events API, so the payload shape is whatever the
 * processor really sends at the pinned version) are posted signed to the running backend's webhook
 * route, the created one twice. Then: one dispute row per dispute, the invoice reads DISPUTED. The
 * sandbox's evidence values then close one dispute as won and the other as lost: the won invoice
 * goes back to PAID with its payment standing; the lost one has its payment voided and its balance
 * reopened.
 *
 * Self-contained: it writes its own org, user, customer, invoices and payments (prefixed
 * qa-39-VERIFY-DISPUTE-) and removes them again. Point DATABASE_URL at the same database the backend
 * under test uses (never production).
 */
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';
import { postWebhook } from './sign';
import { removeFixtures } from './harness';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** The processor's sandbox evidence text that closes a dispute with that outcome. */
const OUTCOME_EVIDENCE = { won: 'winning_evidence', lost: 'losing_evidence' } as const;

export async function disputesRecordedOnceAndSettled(input: { stripe: Stripe; verbose: boolean }): Promise<number> {
  const { stripe, verbose } = input;
  let count = 0;
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const tag = `qa-39-VERIFY-DISPUTE-${Date.now()}`;
  const shortTag = `VD${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const totalCents = 32150;
  const total = totalCents / 100;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', accepted_payment_methods: ['CARD'],
    },
  });
  try {
    await seedStarterTaskCategories(prisma, orgId);
    await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });

    // Two real, succeeded charges with the dispute test card, each paying its own invoice in full.
    const cases: Array<{ outcome: 'won' | 'lost'; invoiceId: string; paymentId: string; pi: Stripe.PaymentIntent; chargeId: string }> = [];
    for (const outcome of ['won', 'lost'] as const) {
      const invoiceId = randomUUID();
      // The payment row is booked BEFORE the charge is made. The processor delivers the dispute event
      // to the backend by itself, in parallel with this suite's own post; the backend finds the
      // owning organization from the payment row, so the row must already name the payment intent.
      const created = await stripe.paymentIntents.create({
        amount: totalCents, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_createDispute',
        metadata: { invoiceId },
      });
      await prisma.invoice.create({
        data: {
          id: invoiceId, organization_id: orgId, customer_id: customer.id, invoice_number: `I-${shortTag}-${outcome}`, status: 'PAID',
          subtotal: total, tax_amount: 0, total_amount: total, amount_due: 0, net_collected: total, paid_at: new Date(), created_by_source: 'SYSTEM',
        },
      });
      const payment = await prisma.payment.create({
        data: {
          invoice_id: invoiceId, amount: total, method: 'CARD', state: 'SUCCEEDED', paid_at: new Date(),
          stripe_payment_intent_id: created.id, created_by_source: 'CLIENT',
        },
      });
      const pi = await stripe.paymentIntents.confirm(created.id);
      assert(pi.status === 'succeeded', `charge succeeded (got ${pi.status})`);
      const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
      assert(chargeId, 'the payment intent names its charge');
      await prisma.payment.update({ where: { id: payment.id }, data: { stripe_charge_id: chargeId } });
      cases.push({ outcome, invoiceId, paymentId: payment.id, pi, chargeId });
    }
    count++;

    // The processor opens the disputes by itself; fetch its own created events and deliver them,
    // the first one twice.
    const chargeIds = cases.map((c) => c.chargeId);
    const ofOurCharges = (o: unknown) => chargeIds.includes((o as Stripe.Dispute).charge as string);
    const created = await waitForEvents(stripe, 'charge.dispute.created', startedAt, ofOurCharges, cases.length);
    if (verbose) console.log(`  ${created.length} charge.dispute.created events fetched`);
    for (const e of [...created, created[0]]) {
      const res = await postWebhook(e);
      assert(res.status === 200, `${e.type} ${e.id} answered 200 (got ${res.status})`);
    }
    for (const c of cases) {
      const rows = await prisma.dispute.findMany({ where: { invoice_id: c.invoiceId } });
      assert(rows.length === 1, `one dispute row for ${c.chargeId} (got ${rows.length})`);
      assert(rows[0].status === 'NEEDS_RESPONSE', `dispute reads NEEDS_RESPONSE (got ${rows[0].status})`);
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: c.invoiceId } });
      assert(invoice.status === 'DISPUTED', `invoice reads DISPUTED (got ${invoice.status})`);
    }
    count++;

    // Close them through the sandbox's evidence values, then deliver the processor's own update
    // and close events in the order it sent them.
    for (const c of cases) {
      const dispute = created.find((e) => (e.data.object as Stripe.Dispute).charge === c.chargeId)!.data.object as Stripe.Dispute;
      await stripe.disputes.update(dispute.id, { evidence: { uncategorized_text: OUTCOME_EVIDENCE[c.outcome] }, submit: true });
    }
    const closed = await waitForEvents(stripe, 'charge.dispute.closed', startedAt, ofOurCharges, cases.length, 180);
    const updated = (await stripe.events.list({ type: 'charge.dispute.updated', created: { gte: startedAt }, limit: 100 })).data
      .filter((e) => ofOurCharges(e.data.object)).reverse();
    if (verbose) console.log(`  ${updated.length} charge.dispute.updated + ${closed.length} charge.dispute.closed events fetched`);
    for (const e of [...updated, ...closed]) {
      const res = await postWebhook(e);
      assert(res.status === 200, `${e.type} ${e.id} answered 200 (got ${res.status})`);
    }
    count++;

    for (const c of cases) {
      const [row, ...others] = await prisma.dispute.findMany({ where: { invoice_id: c.invoiceId } });
      assert(others.length === 0, `still one dispute row for ${c.chargeId}`);
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: c.invoiceId } });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
      if (c.outcome === 'won') {
        assert(row.status === 'WON', `won dispute reads WON (got ${row.status})`);
        assert(invoice.status === 'PAID', `won: invoice back to PAID (got ${invoice.status})`);
        assert(payment.voided_at === null, 'won: the payment stands');
      } else {
        assert(row.status === 'LOST', `lost dispute reads LOST (got ${row.status})`);
        assert(payment.voided_at !== null && payment.void_category === 'CHARGEBACK', 'lost: the payment is voided as a chargeback');
        assert(Number(invoice.amount_due) === total, `lost: the balance reopens to ${total} (got ${invoice.amount_due})`);
        assert(invoice.status === 'SENT', `lost: invoice reads SENT (got ${invoice.status})`);
      }
    }
    count++;
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${orgId}'`);
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${orgId}')`);
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
  }
}

/**
 * The ordering the processor really uses with its dispute test card: charge.dispute.created is sent
 * BEFORE checkout.session.completed, so the dispute event finds no payment yet. A real dispute-card
 * charge; the processor's own created event is posted first, then the completed session naming the
 * charge. The booking must pick the dispute up: one payment, one dispute row on it, the invoice
 * reads DISPUTED, and the dispute event delivered again changes nothing.
 */
export async function disputeBeforeTheBookingIsPickedUp(input: { stripe: Stripe; verbose: boolean }): Promise<number> {
  const { stripe, verbose } = input;
  let count = 0;
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  const tag = `qa-39-VERIFY-DISPUTE-EARLY-${Date.now()}`;
  const shortTag = `VE${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const invoiceId = randomUUID();
  const totalCents = 23456;
  const total = totalCents / 100;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', accepted_payment_methods: ['CARD'],
    },
  });
  try {
    await seedStarterTaskCategories(prisma, orgId);
    await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });
    await prisma.invoice.create({
      data: {
        id: invoiceId, organization_id: orgId, customer_id: customer.id, invoice_number: `I-${shortTag}`, status: 'SENT',
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, created_by_source: 'SYSTEM',
      },
    });

    // A real charge with the dispute test card, as the hosted checkout would make it.
    const pi = await stripe.paymentIntents.create({
      amount: totalCents, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_createDispute',
      confirm: true, metadata: { invoiceId },
    });
    assert(pi.status === 'succeeded', `charge succeeded (got ${pi.status})`);
    const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
    assert(chargeId, 'the payment intent names its charge');
    count++;

    // The processor's own dispute event arrives first: no payment names the charge yet.
    const ofThisCharge = (o: unknown) => (o as Stripe.Dispute).charge === chargeId;
    const [created] = await waitForEvents(stripe, 'charge.dispute.created', startedAt, ofThisCharge, 1);
    const early = await postWebhook(created);
    assert(early.status === 200, `early ${created.type} answered 200 (got ${early.status})`);
    const before = await prisma.dispute.count({ where: { organization_id: orgId } });
    assert(before === 0, `no dispute recorded before the payment exists (got ${before})`);
    if (verbose) console.log(`  ${created.id} delivered before the booking`);
    count++;

    // Then the completed session, in the payload shape of the pinned version.
    const checkout = {
      id: `evt_verify_dispute_early_${shortTag}`, object: 'event', api_version: '2025-02-24.acacia',
      type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_verify_${shortTag}`, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
          payment_intent: pi.id, amount_total: totalCents, currency: 'usd',
          metadata: { invoiceId, organizationId: orgId, kind: 'invoice', payableNowCents: String(totalCents) },
        },
      },
    };
    const booked = await postWebhook(checkout);
    assert(booked.status === 200, `checkout.session.completed answered 200 (got ${booked.status})`);
    const payments = await prisma.payment.findMany({ where: { invoice_id: invoiceId } });
    assert(payments.length === 1, `one payment booked (got ${payments.length})`);
    const rows = await prisma.dispute.findMany({ where: { organization_id: orgId } });
    assert(rows.length === 1, `the booking picked up the dispute: one row (got ${rows.length})`);
    assert(rows[0].payment_id === payments[0].id, 'the dispute names the booked payment');
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert(invoice.status === 'DISPUTED', `invoice reads DISPUTED (got ${invoice.status})`);
    count++;

    // The dispute event delivered again changes nothing.
    await postWebhook(created);
    const after = await prisma.dispute.count({ where: { organization_id: orgId } });
    assert(after === 1, `still one dispute row (got ${after})`);
    const alerts = await prisma.notification.count({ where: { organization_id: orgId, verb: 'billing.disputed' } });
    assert(alerts <= 1, `the owner is told at most once (got ${alerts})`);
    count++;
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${orgId}'`);
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${orgId}')`);
      for (const table of ['timeline_events', 'notifications', 'invoices', 'customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.organization.deleteMany({ where: { id: orgId } });
    });
  }
}

/** Poll the events API until `want` matching events of `type` exist. */
async function waitForEvents(
  stripe: Stripe, type: string, since: number, match: (obj: unknown) => boolean, want: number, seconds = 60,
): Promise<Stripe.Event[]> {
  for (let i = 0; i < seconds; i++) {
    const page = await stripe.events.list({ type, created: { gte: since }, limit: 100 });
    const found = page.data.filter((e) => match(e.data.object)).reverse();
    if (found.length >= want) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${want} ${type} event(s)`);
}

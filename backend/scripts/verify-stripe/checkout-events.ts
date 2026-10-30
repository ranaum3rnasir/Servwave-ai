/**
 * Payments go-live slice 08 - sandbox check that a completed card checkout books one SUCCEEDED
 * payment, paid at the CHARGE's creation time, with the charge id, session id, card brand and
 * last four read back from the processor's charge.
 *
 * Real money flow on the sandbox: a real, succeeded card charge (test card 4242), then a
 * checkout.session.completed event naming it, posted signed to the running backend's webhook
 * route, then the same event again. The webhook reads the charge back from the processor, so
 * paid-at and the card details can only be right if that read happened.
 *
 * Self-contained: it writes its own org, user, customer, invoice (and, for a deposit, lead and
 * estimate), tagged qa-39-VERIFY-CHECKOUT-, and removes them again. Point DATABASE_URL at the same
 * database the backend under test uses (never production).
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

export interface CheckoutFlowInput {
  stripe: Stripe;
  /** STANDARD = an invoice paid online (flow B); DEPOSIT = a deposit invoice that approves its estimate (flow A). */
  kind: 'STANDARD' | 'DEPOSIT';
  /** The amount owed and charged, in cents. */
  amountCents: number;
  verbose: boolean;
}

export async function completedCheckoutBooksTheCharge(input: CheckoutFlowInput): Promise<number> {
  const { stripe, kind, amountCents, verbose } = input;
  let count = 0;
  const tag = `qa-39-VERIFY-CHECKOUT-${Date.now()}`;
  const shortTag = `VC${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const invoiceId = randomUUID();
  const total = amountCents / 100;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', accepted_payment_methods: ['CARD'],
    },
  });
  let leadId: string | null = null;
  let estimateId: string | null = null;
  try {
    await seedStarterTaskCategories(prisma, orgId);
    const user = await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });
    if (kind === 'DEPOSIT') {
      const lead = await prisma.lead.create({
        data: { organization_id: orgId, lead_number: `L-${shortTag}`, customer_id: customer.id, service_request: 'Verify deposit', status: 'ESTIMATED' },
      });
      leadId = lead.id;
      const estimate = await prisma.estimate.create({
        data: {
          organization_id: orgId, lead_id: lead.id, customer_id: customer.id, estimate_number: `E-${shortTag}`,
          status: 'SENT', created_by: user.id, subtotal: total * 2, tax_amount: 0, total_amount: total * 2,
        },
      });
      estimateId = estimate.id;
    }
    await prisma.invoice.create({
      data: {
        id: invoiceId, organization_id: orgId, customer_id: customer.id, kind, invoice_number: `I-${shortTag}`, status: 'SENT',
        subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, created_by_source: 'SYSTEM',
        ...(estimateId ? { estimate_id: estimateId } : {}),
      },
    });

    // A real, succeeded card charge on the sandbox, as the hosted checkout would make it.
    const pi = await stripe.paymentIntents.create({
      amount: amountCents, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_visa',
      confirm: true, metadata: { invoiceId }, expand: ['latest_charge'],
    });
    assert(pi.status === 'succeeded', `charge succeeded (got ${pi.status})`);
    const charge = typeof pi.latest_charge === 'string' ? await stripe.charges.retrieve(pi.latest_charge) : pi.latest_charge;
    assert(charge, 'the charge exists');
    count++;

    // The completed session for it, in the payload shape of the pinned version: the payment
    // intent id, not the charge. Created a little later than the charge, as the real event is.
    const sessionId = `cs_verify_${shortTag}`;
    const event = {
      id: `evt_verify_checkout_${shortTag}`, object: 'event', api_version: '2025-02-24.acacia',
      type: 'checkout.session.completed', created: charge.created + 120,
      data: {
        object: {
          id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
          payment_intent: pi.id, amount_total: amountCents, currency: 'usd',
          metadata: { invoiceId, organizationId: orgId, kind: kind === 'DEPOSIT' ? 'deposit' : 'invoice', payableNowCents: String(amountCents) },
        },
      },
    };
    const res = await postWebhook(event);
    assert(res.status === 200, `checkout.session.completed answered 200 (got ${res.status})`);
    assert(!res.body.duplicate, 'first delivery is not a duplicate');
    count++;

    const payments = await prisma.payment.findMany({ where: { invoice_id: invoiceId } });
    assert(payments.length === 1, `exactly one payment booked (got ${payments.length})`);
    const [payment] = payments;
    assert(payment.state === 'SUCCEEDED' && payment.method === 'CARD', `a SUCCEEDED card payment (got ${payment.state} ${payment.method})`);
    assert(Number(payment.amount) === total, `payment amount ${total} (got ${payment.amount})`);
    count++;
    assert(payment.paid_at.getTime() === charge.created * 1000,
      `paid-at is the charge's created time ${new Date(charge.created * 1000).toISOString()} (got ${payment.paid_at.toISOString()})`);
    count++;
    assert(payment.stripe_charge_id === charge.id, `charge id stored (got ${payment.stripe_charge_id})`);
    assert(payment.stripe_checkout_session_id === sessionId, `session id stored (got ${payment.stripe_checkout_session_id})`);
    assert(payment.stripe_payment_intent_id === pi.id, 'payment intent id stored');
    count++;
    assert(payment.card_brand === 'visa' && payment.card_last4 === '4242', `card brand and last four filled (got ${payment.card_brand} ${payment.card_last4})`);
    count++;

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert(invoice.status === 'PAID' && Number(invoice.amount_due) === 0, `invoice PAID with nothing due (got ${invoice.status} ${invoice.amount_due})`);
    count++;
    if (kind === 'DEPOSIT') {
      const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId! } });
      assert(estimate.status === 'WON', `paying the deposit approved the estimate (got ${estimate.status})`);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId! } });
      assert(lead.status === 'WON', `and won the lead (got ${lead.status})`);
      const paid = await prisma.timelineEvent.count({ where: { entity_type: 'ESTIMATE', entity_id: estimateId!, event_type: 'DEPOSIT_PAID' } });
      assert(paid === 1, `one DEPOSIT_PAID history entry (got ${paid})`);
      count++;
    }

    // The same event again: a duplicate, and still one payment.
    const replay = await postWebhook(event);
    assert(replay.status === 200 && replay.body.duplicate === true, `replay answered 200 duplicate (got ${replay.status} ${JSON.stringify(replay.body)})`);
    assert((await prisma.payment.count({ where: { invoice_id: invoiceId } })) === 1, 'still one payment after the replay');
    count++;

    if (verbose) console.log(`  ${kind}: ${pi.id} / ${charge.id} booked, paid at ${payment.paid_at.toISOString()}, ${payment.card_brand} ${payment.card_last4}`);
    return count;
  } finally {
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id = '${invoiceId}'`);
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      if (estimateId) await prisma.$executeRawUnsafe(`DELETE FROM estimates WHERE id = '${estimateId}'`).catch(() => undefined);
      if (leadId) await prisma.$executeRawUnsafe(`DELETE FROM leads WHERE id = '${leadId}'`).catch(() => undefined);
      for (const table of ['customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_verify_checkout_${shortTag}%'`).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    });
  }
}

/**
 * Payments go-live slice 15 - flow A with a partial manual payment first. A $500 card deposit has
 * $200 recorded against it by hand; the customer then approves the estimate and is sent to a
 * checkout for what is left, $300, never the whole deposit again. The deposit link's own checkout
 * asks for the same $300. Paying it (a real sandbox charge for $300 and its completed-checkout
 * event, posted signed) books once and settles the deposit: PAID, nothing due, estimate approved.
 *
 * Self-contained like the flow above (tagged qa-39-VERIFY-PARTIAL-DEPOSIT-); every session it opens is
 * expired and every row it writes removed. The org has no connected account, so its sessions open
 * on the platform's sandbox account.
 */
export async function partlyPaidDepositChargesTheRest(input: { stripe: Stripe; apiUrl: string; verbose: boolean }): Promise<number> {
  const { stripe, apiUrl, verbose } = input;
  let count = 0;
  const tag = `qa-39-VERIFY-PARTIAL-DEPOSIT-${Date.now()}`;
  const shortTag = `VP${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const estimateId = randomUUID();
  const depositId = randomUUID();
  const estimateToken = `est-${shortTag}-${randomUUID()}`;
  const depositToken = `dep-${shortTag}-${randomUUID()}`;
  const opened: string[] = [];
  let leadId: string | null = null;

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      accepted_payment_methods: ['CARD', 'CHECK'], stripe_charges_enabled: true,
    },
  });
  try {
    await seedStarterTaskCategories(prisma, orgId);
    const user = await prisma.user.create({
      data: { organization_id: orgId, email: `${tag}-admin@test.invalid`, first_name: 'Verify', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    const customer = await prisma.customer.create({
      data: { organization_id: orgId, customer_number: `C-${shortTag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Verify', last_name: 'Customer', created_by_source: 'SYSTEM' },
    });
    const lead = await prisma.lead.create({
      data: { organization_id: orgId, lead_number: `L-${shortTag}`, customer_id: customer.id, service_request: 'Verify partial deposit', status: 'ESTIMATED' },
    });
    leadId = lead.id;
    await prisma.estimate.create({
      data: {
        id: estimateId, organization_id: orgId, lead_id: lead.id, customer_id: customer.id, estimate_number: `E-${shortTag}`,
        status: 'SENT', created_by: user.id, subtotal: 1000, tax_amount: 0, total_amount: 1000,
        public_token: estimateToken, deposit_type: 'FIXED', deposit_value: 500,
        send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'CHECK'] } },
      },
    });
    // The deposit as staff left it after recording $200 of it by hand: PARTIAL, $300 due.
    await prisma.invoice.create({
      data: {
        id: depositId, organization_id: orgId, customer_id: customer.id, estimate_id: estimateId, kind: 'DEPOSIT',
        invoice_number: `D-${shortTag}`, status: 'PARTIAL', subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 300,
        public_token: depositToken, created_by_source: 'SYSTEM',
      },
    });
    await prisma.payment.create({
      data: { invoice_id: depositId, amount: 200, method: 'CHECK', state: 'SUCCEEDED', paid_at: new Date(), created_by_id: user.id, created_by_source: 'USER' },
    });

    // The customer approves and picks card: the checkout asks for $300.
    const approve = await fetch(`${apiUrl}/api/estimates/${estimateId}/approve?token=${estimateToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_method: 'CARD', signature_data: 'data:image/png;base64,iVBORw0KGgo=' }),
    });
    const approved = await approve.json() as { checkout_url?: string; error?: string };
    assert(approve.status === 200 && approved.checkout_url, `approve opened a checkout (got ${approve.status} ${JSON.stringify(approved)})`);
    const [approveSession] = (await stripe.checkout.sessions.list({ limit: 10 })).data.filter((s) => s.metadata?.invoiceId === depositId);
    assert(approveSession, 'the processor holds the approve checkout');
    opened.push(approveSession.id);
    assert(approveSession.amount_total === 30000, `the approve checkout asks for $300.00, not the $500.00 deposit (got ${approveSession.amount_total})`);
    assert(approveSession.metadata?.kind === 'deposit' && approveSession.metadata?.payableNowCents === '30000', 'the approve checkout names the deposit and payable-now $300.00');
    count++;

    // The deposit link's own checkout asks for the same $300.
    const link = await fetch(`${apiUrl}/api/invoices/${depositId}/public/checkout?token=${depositToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'card' }),
    });
    assert(link.status === 200, `the deposit link opened a checkout (got ${link.status} ${JSON.stringify(await link.clone().json())})`);
    const linkSessions = (await stripe.checkout.sessions.list({ limit: 10 })).data.filter((s) => s.metadata?.invoiceId === depositId && s.id !== approveSession.id);
    assert(linkSessions.length === 1, `one deposit-link checkout (got ${linkSessions.length})`);
    opened.push(linkSessions[0].id);
    assert(linkSessions[0].amount_total === 30000, `the deposit link asks for $300.00 (got ${linkSessions[0].amount_total})`);
    count++;

    // The customer pays the $300: a real sandbox charge, and the completed event for the approve checkout.
    const pi = await stripe.paymentIntents.create({
      amount: 30000, currency: 'usd', payment_method_types: ['card'], payment_method: 'pm_card_visa',
      confirm: true, metadata: { invoiceId: depositId }, expand: ['latest_charge'],
    });
    assert(pi.status === 'succeeded', `the $300.00 charge succeeded (got ${pi.status})`);
    const charge = typeof pi.latest_charge === 'string' ? await stripe.charges.retrieve(pi.latest_charge) : pi.latest_charge;
    assert(charge, 'the charge exists');
    const res = await postWebhook({
      id: `evt_verify_partial_${shortTag}`, object: 'event', api_version: '2025-02-24.acacia',
      type: 'checkout.session.completed', created: charge.created + 120,
      data: {
        object: {
          id: approveSession.id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
          payment_intent: pi.id, amount_total: 30000, currency: 'usd', metadata: approveSession.metadata,
        },
      },
    });
    assert(res.status === 200, `checkout.session.completed answered 200 (got ${res.status} ${JSON.stringify(res.body)})`);
    count++;

    const payments = await prisma.payment.findMany({ where: { invoice_id: depositId, voided_at: null }, orderBy: { amount: 'asc' } });
    assert(payments.length === 2 && Number(payments[0].amount) === 200 && Number(payments[1].amount) === 300,
      `the deposit holds the $200 by hand and the $300 by card (got ${payments.map((p) => `${p.method} ${p.amount}`).join(', ')})`);
    const deposit = await prisma.invoice.findUniqueOrThrow({ where: { id: depositId } });
    assert(deposit.status === 'PAID' && Number(deposit.amount_due) === 0, `deposit PAID with nothing due (got ${deposit.status} ${deposit.amount_due})`);
    count++;
    const unapplied = await prisma.timelineEvent.count({ where: { organization_id: orgId, event_type: 'PAYMENT_UNRECORDED' } });
    assert(unapplied === 0, `no money written down as unapplied (got ${unapplied})`);
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    assert(estimate.status === 'WON', `paying the rest approved the estimate (got ${estimate.status})`);
    count++;

    if (verbose) console.log(`  partial deposit: sessions ${opened.join(', ')} at $300.00; ${pi.id} booked, deposit PAID`);
    return count;
  } finally {
    for (const id of opened) {
      try {
        const s = await stripe.checkout.sessions.retrieve(id);
        if (s.status === 'open') await stripe.checkout.sessions.expire(id);
      } catch (err: any) {
        console.log(`  [WARN] could not expire sandbox session ${id}: ${err.message}`);
      }
    }
    await removeFixtures(`${tag} (org ${orgId})`, async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id = '${depositId}'`).catch(() => undefined);
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      await prisma.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id = '${estimateId}'`).catch(() => undefined);
      await prisma.$executeRawUnsafe(`DELETE FROM estimates WHERE id = '${estimateId}'`).catch(() => undefined);
      if (leadId) await prisma.$executeRawUnsafe(`DELETE FROM leads WHERE id = '${leadId}'`).catch(() => undefined);
      for (const table of ['customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_verify_partial_${shortTag}%'`).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    });
  }
}

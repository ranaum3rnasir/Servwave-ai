/**
 * Payments go-live slice 27 - sandbox check of the public estimate's deposit flows, through the
 * running backend's real routes and the processor's sandbox.
 *
 * - Deposit required, card: approving opens a card-only hosted checkout for the deposit; the
 *   estimate waits at PENDING.
 * - Deposit required, bank: approving opens a bank-only checkout. A real test bank debit is entered
 *   and verified, the completed-unpaid event is posted signed: the estimate goes WON while the
 *   debit clears and the deposit stays open (call 3). The processor then fails the debit: the
 *   deposit is open and payable again, the estimate stays WON, and the public page's payload says so.
 * - Pay later: signing approves (WON) with no payment method; the deposit stays SENT and payable,
 *   and its own link opens a card checkout and a bank checkout.
 *
 * Self-contained (tagged qa-39-VERIFY-ESTDEP-): every session it opens is expired and every row removed.
 * Point DATABASE_URL at the database the backend under test uses (never production).
 */
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';
import { postWebhook } from './sign';
import { removeFixtures } from './harness';
import { TEST_BANK, awaitOutcome, enterBankAccount, verifyMicrodeposits } from './bank-events';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

export async function estimateDepositFlows(input: { stripe: Stripe; apiUrl: string; verbose: boolean }): Promise<number> {
  const { stripe, apiUrl, verbose } = input;
  let count = 0;
  const tag = `qa-39-VERIFY-ESTDEP-${Date.now()}`;
  const shortTag = `VE${Date.now() % 1e8}`;
  const orgId = randomUUID();
  const opened: string[] = [];
  const estimateIds: string[] = [];
  const leadIds: string[] = [];

  await prisma.organization.create({
    data: { is_demo: true,
      id: orgId, name: `${tag}-Org`, email: `${tag}-org@test.invalid`,
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      accepted_payment_methods: ['CARD', 'ACH', 'CHECK'], stripe_charges_enabled: true,
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

    /** One sent $1000 estimate with a $500 deposit invoice, under the given policy. */
    async function sentEstimate(key: string, policy: 'REQUIRED_BEFORE_APPROVAL' | 'PAY_LATER') {
      const estimateId = randomUUID();
      const depositId = randomUUID();
      const estimateToken = `est-${shortTag}-${key}-${randomUUID()}`;
      const depositToken = `dep-${shortTag}-${key}-${randomUUID()}`;
      const lead = await prisma.lead.create({
        data: { organization_id: orgId, lead_number: `L-${shortTag}-${key}`, customer_id: customer.id, service_request: `Verify ${key}`, status: 'ESTIMATED' },
      });
      leadIds.push(lead.id);
      await prisma.estimate.create({
        data: {
          id: estimateId, organization_id: orgId, lead_id: lead.id, customer_id: customer.id, estimate_number: `E-${shortTag}-${key}`,
          status: 'SENT', created_by: user.id, subtotal: 1000, tax_amount: 0, total_amount: 1000,
          public_token: estimateToken, deposit_type: 'FIXED', deposit_value: 500, deposit_policy: policy,
          send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'ACH', 'CHECK'] } },
        },
      });
      estimateIds.push(estimateId);
      await prisma.invoice.create({
        data: {
          id: depositId, organization_id: orgId, customer_id: customer.id, estimate_id: estimateId, kind: 'DEPOSIT',
          invoice_number: `D-${shortTag}-${key}`, status: 'SENT', subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500,
          public_token: depositToken, created_by_source: 'SYSTEM',
        },
      });
      return { estimateId, depositId, estimateToken, depositToken };
    }

    const approve = (e: { estimateId: string; estimateToken: string }, body: object) =>
      fetch(`${apiUrl}/api/estimates/${e.estimateId}/approve?token=${e.estimateToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature_data: SIGNATURE, ...body }),
      });
    const publicPayload = async (e: { estimateId: string; estimateToken: string }) =>
      (await fetch(`${apiUrl}/api/estimates/${e.estimateId}/public?token=${e.estimateToken}`)).json() as Promise<{
        estimate: { status: string }; deposit: { pay_state: string; payable_now: number } | null; payment_options: { deposit_policy: string };
      }>;
    const sessionFor = async (depositId: string, exclude: string[]) => {
      const found = (await stripe.checkout.sessions.list({ limit: 20 })).data.find((s) => s.metadata?.invoiceId === depositId && !exclude.includes(s.id));
      assert(found, `the processor holds a checkout for deposit ${depositId}`);
      opened.push(found.id);
      return found;
    };

    // ── Deposit required, card ──
    const card = await sentEstimate('card', 'REQUIRED_BEFORE_APPROVAL');
    const cardRes = await approve(card, { payment_method: 'CARD' });
    const cardBody = await cardRes.json() as { checkout_url?: string };
    assert(cardRes.status === 200 && cardBody.checkout_url, `approving with CARD opened a checkout (got ${cardRes.status} ${JSON.stringify(cardBody)})`);
    const cardSession = await sessionFor(card.depositId, []);
    assert(JSON.stringify(cardSession.payment_method_types) === JSON.stringify(['card']), `the deposit checkout is card-only (got ${cardSession.payment_method_types.join(',')})`);
    assert(cardSession.amount_total === 50000, `the deposit checkout asks for $500.00 (got ${cardSession.amount_total})`);
    count++;
    const cardEstimate = await prisma.estimate.findUniqueOrThrow({ where: { id: card.estimateId } });
    assert(cardEstimate.status === 'PENDING', `the estimate waits at PENDING for the card (got ${cardEstimate.status})`);
    count++;

    // ── Deposit required, bank: WON when the debit starts, deposit reopens when it fails ──
    const bank = await sentEstimate('bank', 'REQUIRED_BEFORE_APPROVAL');
    const bankRes = await approve(bank, { payment_method: 'ACH' });
    const bankBody = await bankRes.json() as { checkout_url?: string };
    assert(bankRes.status === 200 && bankBody.checkout_url, `approving with ACH opened a checkout (got ${bankRes.status} ${JSON.stringify(bankBody)})`);
    const bankSession = await sessionFor(bank.depositId, [cardSession.id]);
    assert(JSON.stringify(bankSession.payment_method_types) === JSON.stringify(['us_bank_account']), `the deposit checkout is bank-only (got ${bankSession.payment_method_types.join(',')})`);
    assert(bankSession.amount_total === 50000, `the bank checkout asks for $500.00 (got ${bankSession.amount_total})`);
    count++;

    const entered = await enterBankAccount(stripe, 50000, TEST_BANK.fails, bank.depositId);
    const verified = await verifyMicrodeposits(stripe, entered.id);
    const completed = await postWebhook({
      id: `evt_verify_estdep_${shortTag}_started`, object: 'event', api_version: '2025-02-24.acacia',
      type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: bankSession.id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'unpaid',
          payment_intent: verified.id, amount_total: 50000, currency: 'usd', payment_method_types: ['us_bank_account'],
          metadata: bankSession.metadata,
        },
      },
    });
    assert(completed.status === 200, `checkout.session.completed (unpaid) answered 200 (got ${completed.status})`);
    const started = await prisma.estimate.findUniqueOrThrow({ where: { id: bank.estimateId } });
    assert(started.status === 'WON', `the estimate is WON as soon as the debit starts (got ${started.status})`);
    const startedDeposit = await prisma.invoice.findUniqueOrThrow({ where: { id: bank.depositId } });
    assert(startedDeposit.status === 'SENT', `the deposit is not PAID while the debit clears (got ${startedDeposit.status})`);
    const clearing = await publicPayload(bank);
    assert(clearing.deposit?.pay_state === 'PROCESSING', `the public page says the bank payment is processing (got ${clearing.deposit?.pay_state})`);
    count++;

    const outcome = await awaitOutcome(stripe, entered.id);
    assert(outcome === 'failed', `the sandbox failure account fails the debit (got ${outcome})`);
    const failed = await postWebhook({
      id: `evt_verify_estdep_${shortTag}_failed`, object: 'event', api_version: '2025-02-24.acacia',
      type: 'checkout.session.async_payment_failed', created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: bankSession.id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'unpaid',
          payment_intent: verified.id, amount_total: 50000, currency: 'usd', payment_method_types: ['us_bank_account'],
          metadata: bankSession.metadata,
        },
      },
    });
    assert(failed.status === 200, `checkout.session.async_payment_failed answered 200 (got ${failed.status})`);
    const afterFail = await publicPayload(bank);
    assert(afterFail.estimate.status === 'WON', `a failed debit does not un-win the estimate (got ${afterFail.estimate.status})`);
    assert(afterFail.deposit?.pay_state === 'PAYABLE' && afterFail.deposit.payable_now === 500,
      `the deposit is open and payable again for $500.00 (got ${JSON.stringify(afterFail.deposit)})`);
    count++;

    // ── Pay later ──
    const later = await sentEstimate('later', 'PAY_LATER');
    const before = await publicPayload(later);
    assert(before.payment_options.deposit_policy === 'PAY_LATER', `the public payload resolves the pay-later policy (got ${before.payment_options.deposit_policy})`);
    const laterRes = await approve(later, {});
    const laterBody = await laterRes.json() as { checkout_url?: string };
    assert(laterRes.status === 200 && !laterBody.checkout_url, `signing approves with no checkout (got ${laterRes.status} ${JSON.stringify(laterBody)})`);
    const approved = await prisma.estimate.findUniqueOrThrow({ where: { id: later.estimateId } });
    assert(approved.status === 'WON' && approved.approved_at, `a pay-later estimate is WON at signing (got ${approved.status})`);
    const approvedLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadIds[leadIds.length - 1] } });
    assert(approvedLead.status === 'WON', `its lead is won (got ${approvedLead.status})`);
    const stillOpen = await prisma.invoice.findUniqueOrThrow({ where: { id: later.depositId } });
    assert(stillOpen.status === 'SENT' && Number(stillOpen.amount_due) === 500, `the deposit stays open (got ${stillOpen.status} ${stillOpen.amount_due})`);
    const afterApprove = await publicPayload(later);
    assert(afterApprove.deposit?.pay_state === 'PAYABLE' && afterApprove.deposit.payable_now === 500, `the page offers the deposit (got ${JSON.stringify(afterApprove.deposit)})`);
    count++;

    for (const method of ['card', 'bank'] as const) {
      // The app closes links made BEFORE the new one, judged on the processor's whole-second
      // timestamp, so two sessions opened inside the same second would not close each other.
      if (method === 'bank') await new Promise((r) => setTimeout(r, 1500));
      const pay = await fetch(`${apiUrl}/api/invoices/${later.depositId}/public/checkout?token=${later.depositToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, expected_amount: 500 }),
      });
      const payBody = await pay.json() as { checkout_url?: string };
      assert(pay.status === 200 && payBody.checkout_url, `the deposit link opened a ${method} checkout (got ${pay.status} ${JSON.stringify(payBody)})`);
    }
    const laterSessions = (await stripe.checkout.sessions.list({ limit: 20 })).data.filter((s) => s.metadata?.invoiceId === later.depositId);
    laterSessions.forEach((s) => opened.push(s.id));
    // Slice 27 (slice 15 acceptance 3): minting the bank checkout closed the card one, so the deposit
    // holds ONE live link - the newest.
    const byType = (t: string) => laterSessions.find((s) => s.payment_method_types.join(',') === t);
    assert(laterSessions.length === 2 && byType('card') && byType('us_bank_account'), `a card-only and a bank-only deposit checkout were minted (got ${laterSessions.map((s) => s.payment_method_types.join(',')).join(' | ')})`);
    assert(byType('card')!.status === 'expired', `the older card checkout was expired (got ${byType('card')!.status})`);
    assert(byType('us_bank_account')!.status === 'open', `the newest bank checkout is the live one (got ${byType('us_bank_account')!.status})`);
    assert(laterSessions.every((s) => s.amount_total === 50000), 'both ask for $500.00');
    count++;

    if (verbose) console.log(`  estimate deposit flows: card ${cardSession.id}, bank ${bankSession.id} / ${entered.id}, pay later ${laterSessions.map((s) => s.id).join(', ')}`);
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
      await prisma.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${orgId}')`).catch(() => undefined);
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      for (const id of estimateIds) {
        await prisma.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id = '${id}'`).catch(() => undefined);
        await prisma.$executeRawUnsafe(`DELETE FROM estimates WHERE id = '${id}'`).catch(() => undefined);
      }
      for (const id of leadIds) await prisma.$executeRawUnsafe(`DELETE FROM leads WHERE id = '${id}'`).catch(() => undefined);
      for (const table of ['customers', 'users']) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${orgId}'`).catch(() => undefined);
      }
      // audit_logs is append-only (the database refuses a delete) and has no foreign key to the company: its rows stay.
      await prisma.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_verify_estdep_${shortTag}%'`).catch(() => undefined);
      await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    });
  }
}

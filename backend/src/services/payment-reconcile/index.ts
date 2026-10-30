/**
 * Payments go-live slice 37 (PRD Module 10): the nightly reconcile against the processor.
 *
 * Per org with a connected account, in that org's tenant context, the job reads ONLY that org's
 * account: its charges, refunds and disputes since the last run. It compares them with the
 * Payment, Refund and Dispute rows and reports every difference once: a log line per finding, one
 * ops email per run, and a summary row per org (payment_reconcile_runs) so "zero drift for seven
 * nights" can be measured.
 *
 * What it does NOT do is move customer money: a person refunds, never the system. It only
 * repairs ServWave's own bookkeeping where the processor's answer is unambiguous (a refund id
 * backfilled, a stuck refund hold completed or released) and writes down money nothing recorded.
 */
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { runWithOrg } from '../../lib/tenant-context';

import type { RefundState } from '@prisma/client';
import { getStripeForOrg, listAccountCharges, listPaymentIntentRefunds, listChargeRefunds, retrieveAccountPaymentIntent, listAccountCheckoutSessions, listAccountDisputes, listAccountRefunds } from '../../lib/stripe';
import { sendOpsAlertEmail } from '../../lib/email';
import { completeReservedRefund, REFUND_ROW_METADATA_KEY } from '../../lib/in-app-refund';
import { logAudit } from '../../lib/audit';
import { resolveChargeRecordsForBookedPayment } from '../../lib/unapplied-capture';
import { rederiveRefundTotals, toCents } from '../../lib/payment-ledger';
import { disputeStatusFor } from '../payment-reconciler/decide';
import { syncOrgPayouts } from '../../lib/payout-sync';

export type DriftKind =
  | 'CHARGE_NO_PAYMENT'
  | 'PAYMENT_NO_CHARGE'
  | 'AMOUNT_MISMATCH'
  | 'PAYMENT_STATE_MISMATCH'
  | 'REFUND_NOT_RECORDED'
  | 'REFUND_RECORD_PAYMENT_KNOWN'
  | 'REFUND_NOT_AT_PROCESSOR'
  | 'REFUND_STATE_MISMATCH'
  | 'DISPUTE_NOT_RECORDED'
  | 'DISPUTE_STATE_MISMATCH'
  | 'DISPUTE_PARTIAL_LOSS'
  | 'CAPTURE_REFUNDED_OUTSIDE'
  | 'SESSION_METADATA_MISSING'
  | 'REFUND_HOLD_UNCHECKABLE'
  | 'BANK_PAYMENT_STILL_WAITING';

export interface DriftFinding {
  kind: DriftKind;
  /** The processor or ServWave id the finding is about (never a customer detail). */
  ref: string;
  detail: string;
}

export type RunStatus = 'CLEAN' | 'DRIFT' | 'ERROR';

export interface OrgReconcileResult {
  orgId: string;
  status: RunStatus;
  findings: DriftFinding[];
  /** Self-repairs made, by kind (a refund id backfilled, a stuck hold completed or released). */
  repaired: Record<string, number>;
  /** Payments whose processor lookup threw (a transient error): not evidence either way, looked at again next night. */
  couldNotCheck: number;
  windowStart: Date;
  windowEnd: Date;
  error?: string;
}

/** Events take a moment to land; anything newer than this is left for the next night. */
const SETTLE_MS = 10 * 60 * 1000;
/** The first run for an org looks back this far. */
const FIRST_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** Lists reach this far before the window, so a payment booked just after its charge still finds it. */
const LIST_PAD_MS = 24 * 60 * 60 * 1000;

/**
 * The processor retries a failed event delivery for up to three days (one hour of margin). A
 * charge with no Payment is alerted the night it is found but only written down once it is older
 * than this: before that the event can still book it, and a record beside a Payment would be the
 * same money twice.
 */
const EVENT_RETRY_HORIZON_MS = 73 * 60 * 60 * 1000;
/**
 * A bank debit can stay pending for about four business days, so a charge is listed this far back
 * (at least) to be looked at again once it settles.
 */
const PENDING_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Disputes run for weeks: their state is compared this far back. */
const DISPUTE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** A refund reservation older than this with no processor id is looked up at the processor. */
const HOLD_MIN_AGE_MS = 30 * 60 * 1000;

const unix = (d: Date): number => Math.floor(d.getTime() / 1000);

export async function reconcileOrg(orgId: string, opts: { now?: Date } = {}): Promise<OrgReconcileResult> {
  const now = opts.now ?? new Date();
  const windowEnd = new Date(now.getTime() - SETTLE_MS);
  const last = await prisma.paymentReconcileRun.findFirst({
    where: { organization_id: orgId, status: { not: 'ERROR' } },
    orderBy: { window_end: 'desc' },
    select: { window_end: true },
  });
  const windowStart = last?.window_end ?? new Date(windowEnd.getTime() - FIRST_RUN_LOOKBACK_MS);
  const result: OrgReconcileResult = { orgId, status: 'CLEAN', findings: [], repaired: {}, couldNotCheck: 0, windowStart, windowEnd };

  try {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { stripe_account_id: true } });
    if (!org?.stripe_account_id) throw new Error('no connected account');
    const account = org.stripe_account_id;
    const inWindow = (createdUnix: number) => createdUnix * 1000 >= windowStart.getTime() && createdUnix * 1000 < windowEnd.getTime();

    const charges = await listAccountCharges(account, unix(new Date(windowStart.getTime() - Math.max(EVENT_RETRY_HORIZON_MS, PENDING_RECHECK_MS) - LIST_PAD_MS)));
    const chargeIds = charges.map((c) => c.id);
    const intentIds = charges.map((c) => paymentIntentOf(c.payment_intent)).filter((x): x is string => !!x);
    // This org's payments on this account that either fall in the window or match a listed charge.
    const payments = await prisma.payment.findMany({
      where: {
        invoice: { organization_id: orgId },
        stripe_account_id: account,
        OR: [
          { created_at: { gte: windowStart, lt: windowEnd }, OR: [{ stripe_charge_id: { not: null } }, { stripe_payment_intent_id: { not: null } }] },
          { stripe_charge_id: { in: chargeIds } },
          { stripe_payment_intent_id: { in: intentIds } },
        ],
      },
      select: {
        id: true, amount: true, tip_amount: true, service_fee_amount: true, state: true, created_at: true, voided_at: true,
        refunds: { where: { state: { not: 'FAILED' } }, select: { amount: true } },
        stripe_charge_id: true, stripe_payment_intent_id: true,
      },
    });
    const paymentByCharge = new Map<string, (typeof payments)[number]>();
    for (const p of payments) {
      if (p.stripe_charge_id) paymentByCharge.set(p.stripe_charge_id, p);
      if (p.stripe_payment_intent_id) paymentByCharge.set(p.stripe_payment_intent_id, p);
    }
    const chargeKeys = new Set([...chargeIds, ...intentIds]);
    const recordedIntents = new Set(
      (await prisma.unappliedCapture.findMany({
        where: { organization_id: orgId, stripe_payment_intent_id: { in: intentIds } },
        select: { stripe_payment_intent_id: true },
      })).map((r) => r.stripe_payment_intent_id!),
    );

    for (const c of charges) {
      const pi = paymentIntentOf(c.payment_intent);
      const payment = paymentByCharge.get(c.id) ?? (pi ? paymentByCharge.get(pi) : undefined);
      if (!payment) {
        if (c.status !== 'succeeded' || !inWindow(c.created)) continue;
        // A charge on "Payments needing attention" is written down already: not drift.
        if (pi && recordedIntents.has(pi)) continue;
        result.findings.push({ kind: 'CHARGE_NO_PAYMENT', ref: c.id, detail: `charge ${c.id} of ${c.amount} cents has no payment row and no record` });
        continue;
      }
      const stateProblem = paymentStateProblem(payment, c);
      // A charge settling days after it was made reaches its Payment in a later window: it is
      // compared when either is new, and a Payment stuck PROCESSING is reported until it moves.
      const stuck = payment.state === 'PROCESSING' && c.status !== 'pending';
      const fresh = inWindow(c.created) || (payment.created_at >= windowStart && payment.created_at < windowEnd);
      if (!fresh && !stuck) continue;
      if (stateProblem) {
        result.findings.push({ kind: 'PAYMENT_STATE_MISMATCH', ref: payment.id, detail: `payment ${payment.id} is ${payment.state}${payment.voided_at ? ' (voided)' : ''}, but charge ${c.id} is ${stateProblem}` });
        continue;
      }
      if (c.status !== 'succeeded' || !fresh) continue;
      // The card was charged the payment's face value plus the customer's service fee and tip.
      const expected = toCents(payment.amount) + toCents(payment.service_fee_amount ?? 0) + toCents(payment.tip_amount ?? 0);
      if (c.amount !== expected) {
        result.findings.push({ kind: 'AMOUNT_MISMATCH', ref: payment.id, detail: `charge ${c.id} is ${c.amount} cents, payment ${payment.id} is ${expected} cents` });
      }
    }

    // Charges that have outlived the processor's event retries and still have no Payment: written
    // down once (the source key makes a repeat a no-op), and the Payment is looked for again right
    // before the write. A charge that was pending when it was made and settled later is picked up
    // here too, whatever night it was created: it is alerted when it is written down.
    for (const c of charges) {
      if (c.status !== 'succeeded') continue;
      const createdMs = c.created * 1000;
      if (createdMs > windowEnd.getTime() - EVENT_RETRY_HORIZON_MS) continue;
      const pi = paymentIntentOf(c.payment_intent);
      if (paymentByCharge.has(c.id) || (pi && (paymentByCharge.has(pi) || recordedIntents.has(pi)))) continue;
      const booked = await prisma.payment.findFirst({
        where: {
          invoice: { organization_id: orgId },
          OR: [{ stripe_charge_id: c.id }, ...(pi ? [{ stripe_payment_intent_id: pi }] : [])],
        },
        select: { id: true },
      });
      if (booked) continue;
      const wrote = await writeDown(orgId, account, { reason: 'INVOICE_NOT_FOUND', sourceKey: `charge:${c.id}`, cents: c.amount, paymentIntentId: pi });
      // Every write-down is alerted the night it happens (the insert says whether it did, so once),
      // unless this same run already reported the charge in the pass above.
      if (wrote && !result.findings.some((f) => f.kind === 'CHARGE_NO_PAYMENT' && f.ref === c.id)) {
        result.findings.push({ kind: 'CHARGE_NO_PAYMENT', ref: c.id, detail: `charge ${c.id} of ${c.amount} cents settled with no payment row and no record; written down` });
      }
    }

    await resolveBookedChargeRecords(orgId, result);

    for (const p of payments) {
      if (p.state === 'FAILED') continue;
      if (p.created_at < windowStart || p.created_at >= windowEnd) continue;
      const known = (p.stripe_charge_id && chargeKeys.has(p.stripe_charge_id)) || (p.stripe_payment_intent_id && chargeKeys.has(p.stripe_payment_intent_id));
      if (known) continue;
      // A bank debit waiting on the customer has a payment intent and no charge yet: not drift.
      if (p.state === 'PROCESSING' && p.stripe_payment_intent_id) {
        const wait = await bankIntentWait(account, p.stripe_payment_intent_id);
        if (wait === 'waiting') continue;
        // A failed lookup is not evidence: raise nothing tonight, count it, look again tomorrow.
        if (wait === 'unknown') { result.couldNotCheck++; continue; }
      }
      result.findings.push({ kind: 'PAYMENT_NO_CHARGE', ref: p.id, detail: `payment ${p.id} names a charge the processor does not hold` });
    }
    await flagLongWaitingBankPayments({ orgId, account, windowStart, windowEnd, result });

    await sweepRefundHolds({ orgId, account, windowStart, windowEnd, result }, now);
    await reconcileRefunds({ orgId, account, windowStart, windowEnd, result });
    await reconcileDisputes({ orgId, account, windowStart, windowEnd, result }, now);
    await reconcileSessions({ orgId, account, windowStart, windowEnd, result });
    await reconcilePayouts({ orgId, account, windowEnd, result });
  } catch (err) {
    result.status = 'ERROR';
    result.error = err instanceof Error ? err.message : String(err);
    logger.error(`[payment-reconcile] org ${orgId} could not be reconciled: ${result.error}`);
  }

  return finish(result);
}

/**
 * Payouts reach this far back each night. A payment's balance transaction is captured after its payout
 * may already have been synced (the fee sweep runs nightly), so recent payouts are looked at again
 * and any payment that has gained its balance transaction since is linked.
 */
const PAYOUT_RELINK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Payouts slice P2: bring ServWave's payouts table up to date from the processor's list. It repairs
 * ServWave's own bookkeeping only and reports no drift finding for payouts; a processor that cannot be
 * read is logged and leaves the run's verdict alone.
 */
async function reconcilePayouts(ctx: { orgId: string; account: string; windowEnd: Date; result: OrgReconcileResult }): Promise<void> {
  const { orgId, account, windowEnd, result } = ctx;
  try {
    const synced = await syncOrgPayouts(orgId, account, unix(new Date(windowEnd.getTime() - PAYOUT_RELINK_LOOKBACK_MS)));
    if (synced.missing > 0) result.repaired.payout_recorded = (result.repaired.payout_recorded ?? 0) + synced.missing;
    if (synced.linked > 0) result.repaired.payment_linked_to_payout = (result.repaired.payment_linked_to_payout ?? 0) + synced.linked;
  } catch (err) {
    logger.warn(`[payment-reconcile] org ${orgId} payouts could not be synced: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const BANK_WAIT_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 'waiting' = the processor holds this intent, it is not final, and it has no charge yet.
 * 'unknown' = the lookup THREW (a transient error), which proves nothing either way.
 */
async function bankIntentWait(account: string, paymentIntentId: string): Promise<'waiting' | 'not_waiting' | 'unknown'> {
  try {
    const pi = await retrieveAccountPaymentIntent(account, paymentIntentId);
    return !!pi && !['succeeded', 'canceled'].includes(pi.status) && !pi.latest_charge ? 'waiting' : 'not_waiting';
  } catch (err) {
    logger.warn(`[payment-reconcile] payment intent ${paymentIntentId} could not be looked up: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  }
}

/**
 * A bank payment still PROCESSING whose intent is still waiting on the customer after 7 days is
 * one finding. The payments looked at are those that turned 7 days old inside this window
 * (`[windowStart - 7d, windowEnd - 7d)`), so consecutive windows report each payment once.
 */
async function flagLongWaitingBankPayments(ctx: StepContext): Promise<void> {
  const { orgId, account, windowStart, windowEnd, result } = ctx;
  const old = await prisma.payment.findMany({
    where: {
      invoice: { organization_id: orgId },
      stripe_account_id: account,
      state: 'PROCESSING',
      stripe_payment_intent_id: { not: null },
      created_at: { gte: new Date(windowStart.getTime() - BANK_WAIT_LIMIT_MS), lt: new Date(windowEnd.getTime() - BANK_WAIT_LIMIT_MS) },
    },
    select: { id: true, stripe_payment_intent_id: true },
  });
  for (const p of old) {
    const wait = await bankIntentWait(account, p.stripe_payment_intent_id!);
    if (wait === 'unknown') result.couldNotCheck++;
    if (wait === 'waiting') {
      result.findings.push({ kind: 'BANK_PAYMENT_STILL_WAITING', ref: p.id, detail: `payment ${p.id}: bank payment still waiting on the customer after 7 days` });
    }
  }
}

/**
 * An OPEN "charge with no payment" record (source key `charge:<id>`) whose charge now has a Payment
 * is closed: the event booked it late. Counted as repaired, not drift. Normally the booking itself
 * closes the record; this is the nightly backstop.
 */
async function resolveBookedChargeRecords(orgId: string, result: OrgReconcileResult): Promise<void> {
  const open = await prisma.unappliedCapture.findMany({
    where: { organization_id: orgId, status: 'OPEN', source_key: { startsWith: 'charge:' } },
    select: { source_key: true, stripe_payment_intent_id: true },
  });
  for (const rec of open) {
    const chargeId = rec.source_key.slice('charge:'.length);
    const payment = await prisma.payment.findFirst({
      where: {
        invoice: { organization_id: orgId },
        state: { not: 'FAILED' },
        OR: [{ stripe_charge_id: chargeId }, ...(rec.stripe_payment_intent_id ? [{ stripe_payment_intent_id: rec.stripe_payment_intent_id }] : [])],
      },
      select: { id: true },
    });
    if (!payment) continue;
    const closed = await prisma.$transaction((tx) => resolveChargeRecordsForBookedPayment(tx, {
      organizationId: orgId, chargeId, paymentIntentId: rec.stripe_payment_intent_id, paymentId: payment.id,
    }));
    for (let i = 0; i < closed; i++) bump(result.repaired, 'charge_record_resolved');
  }
}

/**
 * What the processor's charge says that the Payment's state does not, or null when they agree.
 * Money taken must be a paid row; a paid row must be money taken (a voided one is expected only
 * when the charge was refunded or disputed).
 */
function paymentStateProblem(
  p: { state: string; voided_at: Date | null; amount: unknown; refunds: { amount: unknown }[] },
  c: { status: string; refunded?: boolean; disputed?: boolean; amount: number; amount_refunded?: number },
): string | null {
  const live = p.state === 'SUCCEEDED' && !p.voided_at;
  if (c.status === 'succeeded') {
    if (p.state !== 'SUCCEEDED') return 'succeeded';
    if (p.voided_at && !c.refunded && !c.disputed) return 'succeeded and not refunded';
    if (live && c.refunded) {
      const recorded = p.refunds.reduce((n, r) => n + toCents(r.amount as never), 0);
      if (recorded < (c.amount_refunded ?? c.amount)) return 'fully refunded with no refund recorded';
    }
    return null;
  }
  if (live) return c.status === 'failed' ? 'failed' : 'still pending';
  if (p.state === 'PROCESSING' && c.status === 'failed') return 'failed';
  return null;
}

function paymentIntentOf(pi: unknown): string | null {
  if (typeof pi === 'string') return pi;
  if (pi && typeof pi === 'object' && typeof (pi as { id?: unknown }).id === 'string') return (pi as { id: string }).id;
  return null;
}

/** Write money the ledger holds no trace of onto "Payments needing attention", once (source key). */
async function writeDown(
  orgId: string,
  account: string,
  m: { reason: string; sourceKey: string; cents: number | null; paymentIntentId: string | null; refundId?: string | null },
): Promise<boolean> {
  const { count } = await prisma.unappliedCapture.createMany({
    data: [{
      organization_id: orgId,
      invoice_id: null,
      reason: m.reason,
      amount: m.cents != null ? m.cents / 100 : null,
      stripe_payment_intent_id: m.paymentIntentId,
      stripe_account_id: account,
      stripe_refund_id: m.refundId ?? null,
      source_key: m.sourceKey,
    }],
    skipDuplicates: true,
  });
  return count > 0;
}

/** The ledger state a processor refund is in. */
function refundStateOf(status: string | null): RefundState {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed' || status === 'canceled') return 'FAILED';
  return 'PENDING';
}

interface StepContext {
  orgId: string;
  account: string;
  windowStart: Date;
  windowEnd: Date;
  result: OrgReconcileResult;
}

const bump = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

/**
 * A refund reservation (PENDING, no processor id) is kept on an ambiguous answer from the
 * processor and left behind if the process died mid-refund; every cap counts it, so that money can
 * be neither refunded nor drawn down. Each one old enough is looked up at the processor by the
 * reservation's id carried in the refund's metadata: found, it is completed from the refund;
 * not found, it is marked FAILED, which frees the money, with an audit row. A lookup that fails
 * leaves the hold for the next night.
 */
async function sweepRefundHolds(ctx: StepContext, now: Date): Promise<void> {
  const { orgId, account, result } = ctx;
  const holds = await prisma.refund.findMany({
    where: {
      organization_id: orgId,
      state: 'PENDING',
      stripe_refund_id: null,
      created_at: { lt: new Date(now.getTime() - HOLD_MIN_AGE_MS) },
      payment: { stripe_account_id: account },
    },
    select: { id: true, invoice_id: true, payment: { select: { stripe_payment_intent_id: true, stripe_charge_id: true } } },
    orderBy: { created_at: 'asc' },
  });
  for (const hold of holds) {
    const intentId = hold.payment?.stripe_payment_intent_id ?? null;
    const chargeId = hold.payment?.stripe_charge_id ?? null;
    if (!intentId && !chargeId) {
      // Nothing to ask the processor with: a person looks, never silence.
      result.findings.push({ kind: 'REFUND_HOLD_UNCHECKABLE', ref: hold.id, detail: `refund hold ${hold.id} is stuck and its payment has no processor id to look it up with` });
      continue;
    }
    let found: { id: string; status: string | null } | undefined;
    try {
      const ctxStripe = getStripeForOrg({ stripe_account_id: account });
      const onPayment = intentId ? await listPaymentIntentRefunds(intentId, ctxStripe) : await listChargeRefunds(chargeId!, ctxStripe);
      found = onPayment.find((r) => r.metadata?.[REFUND_ROW_METADATA_KEY] === hold.id);
    } catch (err) {
      logger.warn(`[payment-reconcile] org ${orgId}: refund hold ${hold.id} could not be looked up; kept for the next run: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${hold.invoice_id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      if (found) {
        // Only a hold still without the processor's id was completed by this sweep: the refund's own
        // event may have got there while this waited, and that is not a repair.
        const untouched = await tx.refund.findFirst({ where: { id: hold.id, organization_id: orgId, stripe_refund_id: null }, select: { id: true } });
        await completeReservedRefund(tx, { refundRowId: hold.id, organizationId: orgId, stripeRefundId: found.id, state: refundStateOf(found.status) });
        await rederiveRefundTotals(tx, { invoiceId: hold.invoice_id, organizationId: orgId });
        return untouched ? 'completed' as const : 'none' as const;
      }
      // Only a hold still untouched: the refund's own event may have completed it meanwhile.
      const { count } = await tx.refund.updateMany({ where: { id: hold.id, organization_id: orgId, state: 'PENDING', stripe_refund_id: null }, data: { state: 'FAILED' } });
      if (count === 0) return 'none' as const;
      await rederiveRefundTotals(tx, { invoiceId: hold.invoice_id, organizationId: orgId });
      return 'released' as const;
    });
    if (outcome === 'completed') {
      bump(result.repaired, 'refund_hold_completed');
    } else if (outcome === 'released') {
      bump(result.repaired, 'refund_hold_released');
      await logAudit({
        action: 'refund.hold_released',
        resourceType: 'Refund',
        resourceId: hold.id,
        orgId,
        actorId: null,
        metadata: { reason: 'no refund at the processor for this reservation' },
      });
    }
  }
}

type ListedRefund = Awaited<ReturnType<typeof listAccountRefunds>>[number];

/** The org's Payment a processor refund belongs to, by charge or payment intent. */
async function findPaymentOfRefund(orgId: string, r: ListedRefund): Promise<{ id: string } | null> {
  const chargeId = typeof r.charge === 'string' ? r.charge : r.charge?.id ?? null;
  const pi = paymentIntentOf(r.payment_intent);
  if (!chargeId && !pi) return null;
  return prisma.payment.findFirst({
    where: {
      invoice: { organization_id: orgId },
      OR: [...(chargeId ? [{ stripe_charge_id: chargeId }] : []), ...(pi ? [{ stripe_payment_intent_id: pi }] : [])],
    },
    select: { id: true },
  });
}

async function reconcileRefunds(ctx: StepContext): Promise<void> {
  const { orgId, account, windowStart, windowEnd, result } = ctx;
  const listed = await listAccountRefunds(account, unix(new Date(windowStart.getTime() - LIST_PAD_MS)));
  const inWindow = (createdUnix: number) => createdUnix * 1000 >= windowStart.getTime() && createdUnix * 1000 < windowEnd.getTime();
  const processorIds = new Set(listed.map((r) => r.id));

  const rows = await prisma.refund.findMany({
    where: { organization_id: orgId, stripe_refund_id: { in: [...processorIds] } },
    select: { id: true, stripe_refund_id: true, state: true },
  });
  const rowByProcessorId = new Map(rows.map((r) => [r.stripe_refund_id!, r]));

  for (const r of listed) {
    const state = refundStateOf(r.status);
    const existing = rowByProcessorId.get(r.id);
    if (existing) {
      if (existing.state !== state) {
        result.findings.push({ kind: 'REFUND_STATE_MISMATCH', ref: existing.id, detail: `refund ${r.id} is ${state} at the processor, ${existing.state} here` });
      }
      continue;
    }
    // A stray refund already written down on "Payments needing attention".
    const record = await prisma.unappliedCapture.findFirst({ where: { organization_id: orgId, stripe_refund_id: r.id } });
    if (record) {
      // The record was written from the refund's first event whatever its state: a refund that
      // failed sent nothing back, so its record is closed with the final state.
      if (state === 'FAILED' && record.status === 'OPEN') {
        // Conditional: a record a person resolved or refunded since it was read is left alone.
        const { count } = await prisma.unappliedCapture.updateMany({
          where: { id: record.id, organization_id: orgId, status: 'OPEN', reason: 'REFUND_UNMATCHED' },
          data: { status: 'RESOLVED' },
        });
        if (count > 0) bump(result.repaired, 'stray_refund_record_closed');
      } else if (state !== 'FAILED' && record.status === 'OPEN' && record.reason === 'REFUND_UNMATCHED') {
        // Written down before its payment's checkout was booked: the payment is known now, so the
        // record no longer explains the refund. Nothing is invented; a person ties it back.
        const known = await findPaymentOfRefund(orgId, r);
        if (known) {
          result.findings.push({ kind: 'REFUND_RECORD_PAYMENT_KNOWN', ref: r.id, detail: `refund ${r.id} is still open on needing attention, but its payment ${known.id} is now recorded; tie it back by hand` });
        }
      }
      continue;
    }
    if (state === 'FAILED') continue;

    const pi = paymentIntentOf(r.payment_intent);
    const payment = await findPaymentOfRefund(orgId, r);

    // A row written before refunds were keyed on the processor's id: same payment, same amount.
    // A reservation (PENDING) is never one: it belongs to an in-app refund still in flight, and the
    // hold sweep owns it.
    if (payment) {
      const claimed = await prisma.$transaction(async (tx) => {
        const legacy = await tx.refund.findFirst({
          where: { organization_id: orgId, payment_id: payment.id, stripe_refund_id: null, amount: r.amount / 100, state: { notIn: ['FAILED', 'PENDING'] } },
          orderBy: { created_at: 'asc' },
          select: { id: true, state: true, invoice_id: true },
        });
        if (!legacy) return false;
        await tx.$executeRaw`SELECT id FROM invoices WHERE id = ${legacy.invoice_id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
        // The refund's own event may have recorded it while this waited.
        if (await tx.refund.findFirst({ where: { organization_id: orgId, stripe_refund_id: r.id }, select: { id: true } })) return 'recorded' as const;
        const { count } = await tx.refund.updateMany({ where: { id: legacy.id, organization_id: orgId, stripe_refund_id: null }, data: { stripe_refund_id: r.id, state } });
        if (count === 0) return false;
        // The processor's word on the state may differ from the legacy row's: the invoice follows it.
        if (legacy.state !== state) await rederiveRefundTotals(tx, { invoiceId: legacy.invoice_id, organizationId: orgId });
        return true;
      }).catch((err) => {
        // A unique violation on the processor id: the refund's event recorded it first.
        if ((err as { code?: string }).code === 'P2002') return 'recorded' as const;
        throw err;
      });
      if (claimed === 'recorded') continue;
      if (claimed) {
        bump(result.repaired, 'refund_id_backfilled');
        continue;
      }
    }

    if (!inWindow(r.created)) continue;
    result.findings.push({
      kind: 'REFUND_NOT_RECORDED',
      ref: r.id,
      detail: payment ? `refund ${r.id} of ${r.amount} cents has no refund row` : `refund ${r.id} of ${r.amount} cents is for a payment ServWave has no record of`,
    });
    // Nothing is invented for a payment ServWave knows (a person looks). For one it does not know,
    // the refund is written down where a person finds it.
    if (!payment) await writeDown(orgId, account, { reason: 'REFUND_UNMATCHED', sourceKey: `refund:${r.id}`, cents: r.amount, paymentIntentId: pi, refundId: r.id });
  }

  // A refund row the processor does not hold (this account only, inside the window).
  const local = await prisma.refund.findMany({
    where: {
      organization_id: orgId,
      stripe_refund_id: { not: null },
      state: { not: 'FAILED' },
      created_at: { gte: windowStart, lt: windowEnd },
      payment: { stripe_account_id: account },
    },
    select: { id: true, stripe_refund_id: true },
  });
  for (const row of local) {
    if (!processorIds.has(row.stripe_refund_id!)) {
      result.findings.push({ kind: 'REFUND_NOT_AT_PROCESSOR', ref: row.id, detail: `refund row ${row.id} names refund ${row.stripe_refund_id}, which the processor does not hold` });
    }
  }

  // A refund made outside the list on a payment that is still open on "needing attention".
  const open = await prisma.unappliedCapture.findMany({
    where: { organization_id: orgId, status: 'OPEN', reason: { not: 'REFUND_UNMATCHED' }, stripe_payment_intent_id: { not: null } },
    select: { id: true, stripe_payment_intent_id: true, stripe_refund_id: true, failed_refund_ids: true },
  });
  for (const rec of open) {
    const outside = listed.find((r) =>
      paymentIntentOf(r.payment_intent) === rec.stripe_payment_intent_id
      && r.id !== rec.stripe_refund_id && !rec.failed_refund_ids.includes(r.id)
      && refundStateOf(r.status) !== 'FAILED' && inWindow(r.created));
    if (outside) {
      result.findings.push({ kind: 'CAPTURE_REFUNDED_OUTSIDE', ref: rec.id, detail: `refund ${outside.id} went out on payment intent ${rec.stripe_payment_intent_id}, which is still open on needing attention` });
    }
  }
}

async function reconcileDisputes(ctx: StepContext, now: Date): Promise<void> {
  const { orgId, account, windowStart, windowEnd, result } = ctx;
  const listed = await listAccountDisputes(account, unix(new Date(now.getTime() - DISPUTE_LOOKBACK_MS)));
  const rows = await prisma.dispute.findMany({
    where: { organization_id: orgId, stripe_dispute_id: { in: listed.map((d) => d.id) } },
    select: { id: true, stripe_dispute_id: true, status: true },
  });
  const rowByProcessorId = new Map(rows.map((r) => [r.stripe_dispute_id, r]));
  for (const d of listed) {
    const row = rowByProcessorId.get(d.id);
    if (!row) {
      // A dispute that opened before this window and has no row was already reported on its night.
      if (d.created * 1000 >= windowStart.getTime() && d.created * 1000 < windowEnd.getTime()) {
        result.findings.push({ kind: 'DISPUTE_NOT_RECORDED', ref: d.id, detail: `dispute ${d.id} of ${d.amount} cents has no dispute row` });
      }
      continue;
    }
    const status = disputeStatusFor(d.status);
    if (row.status !== status) {
      result.findings.push({ kind: 'DISPUTE_STATE_MISMATCH', ref: row.id, detail: `dispute ${d.id} is ${status} at the processor, ${row.status} here` });
    }
  }

  // A lost dispute for less than the payment's unrefunded amount voids nothing and reopens nothing
  // (conductor ruling, slice 09): it is listed here for a person to look at.
  const lost = await prisma.dispute.findMany({
    where: { organization_id: orgId, status: 'LOST', updated_at: { gte: windowStart, lt: windowEnd } },
    select: { id: true, amount: true, payment: { select: { amount: true, refunds: { where: { state: { not: 'FAILED' } }, select: { amount: true } } } } },
  });
  for (const d of lost) {
    const unrefunded = toCents(d.payment.amount) - d.payment.refunds.reduce((n, r) => n + toCents(r.amount), 0);
    if (toCents(d.amount) < unrefunded) {
      result.findings.push({ kind: 'DISPUTE_PARTIAL_LOSS', ref: d.id, detail: `dispute ${d.id} was lost for less than the payment's unrefunded amount; review by hand` });
    }
  }
}

/** Metadata ServWave puts on every checkout it opens; the event reconciler checks all of it. */
const REQUIRED_SESSION_METADATA = ['organizationId', 'invoiceId', 'kind', 'payableNowCents'] as const;

/**
 * A paid checkout on this org's account without the metadata ServWave builds every session with
 * (or naming another org) skips the event reconciler's cross-checks. That is fine only for a
 * session older than slice 12; any since is a finding.
 */
async function reconcileSessions(ctx: StepContext): Promise<void> {
  const { orgId, account, windowStart, windowEnd, result } = ctx;
  const listed = await listAccountCheckoutSessions(account, unix(windowStart));
  for (const session of listed) {
    if (session.payment_status !== 'paid') continue;
    if (session.created * 1000 < windowStart.getTime() || session.created * 1000 >= windowEnd.getTime()) continue;
    const meta = session.metadata ?? {};
    const missing = REQUIRED_SESSION_METADATA.filter((k) => !meta[k]);
    if (missing.length === 0 && meta.organizationId === orgId) continue;
    result.findings.push({
      kind: 'SESSION_METADATA_MISSING',
      ref: session.id,
      detail: missing.length ? `paid checkout ${session.id} lacks ${missing.join(', ')}` : `paid checkout ${session.id} names another organization`,
    });
  }
}

async function finish(result: OrgReconcileResult): Promise<OrgReconcileResult> {
  if (result.status !== 'ERROR') result.status = result.findings.length ? 'DRIFT' : 'CLEAN';
  const counts: Record<string, number> = {};
  for (const f of result.findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  // Not a finding (drift_count ignores it); kept on the summary row so a lookup that keeps failing is visible.
  if (result.couldNotCheck > 0) counts.could_not_check = result.couldNotCheck;
  for (const f of result.findings) {
    logger.warn(`[payment-reconcile] DRIFT org=${result.orgId} kind=${f.kind} ref=${f.ref}: ${f.detail}`);
  }
  await prisma.paymentReconcileRun.create({
    data: {
      organization_id: result.orgId,
      window_start: result.windowStart,
      window_end: result.windowEnd,
      status: result.status,
      drift_count: result.findings.length,
      counts,
      repaired: result.repaired,
      error: result.error ?? null,
    },
  });
  return result;
}

export interface NightlyReconcileSummary {
  orgs: OrgReconcileResult[];
  driftCount: number;
  errorCount: number;
}

/**
 * Every org with a connected account, each in its own tenant context, then ONE ops email for the
 * run when anything differed or an org could not be read. `orgIds` narrows the run (a manual
 * trigger); the cron passes nothing.
 */
export async function runNightlyReconcile(
  opts: { now?: Date; orgIds?: string[]; retryPauseMs?: number } = {},
): Promise<NightlyReconcileSummary> {
  const rows = await prisma.organization.findMany({
    where: { stripe_account_id: { not: null }, ...(opts.orgIds ? { id: { in: opts.orgIds } } : {}) },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const orgs: OrgReconcileResult[] = [];
  // An org whose run failed OUTSIDE the comparison (its summary row could not be written, e.g. a
  // pool timeout) is tried once more after every other org has run. An org whose comparison failed
  // and whose ERROR row was written comes back from reconcileOrg normally and is never retried.
  const failedOutside: string[] = [];
  for (const { id } of rows) {
    try {
      orgs.push(await runWithOrg(id, () => reconcileOrg(id, opts)));
    } catch (err) {
      logger.error(`[payment-reconcile] org ${id} failed outside the comparison`, err);
      failedOutside.push(id);
    }
  }
  if (failedOutside.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, opts.retryPauseMs ?? 15_000));
    for (const id of failedOutside) {
      try {
        orgs.push(await runWithOrg(id, () => reconcileOrg(id, opts)));
      } catch (err) {
        logger.error(`[payment-reconcile] org ${id} failed outside the comparison again; giving up for tonight`, err);
        orgs.push({ orgId: id, status: 'ERROR', findings: [], repaired: {}, couldNotCheck: 0, windowStart: new Date(0), windowEnd: new Date(0), error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const driftCount = orgs.reduce((n, o) => n + o.findings.length, 0);
  const errorCount = orgs.filter((o) => o.status === 'ERROR').length;
  if (driftCount > 0 || errorCount > 0) await sendOpsDigest(orgs, driftCount, errorCount);
  return { orgs, driftCount, errorCount };
}

async function sendOpsDigest(orgs: OrgReconcileResult[], driftCount: number, errorCount: number): Promise<void> {
  const parts: string[] = [];
  if (driftCount > 0) parts.push(`${driftCount} difference${driftCount === 1 ? '' : 's'}`);
  if (errorCount > 0) parts.push(`${errorCount} org${errorCount === 1 ? '' : 's'} not checked`);
  const lines: string[] = [];
  for (const o of orgs) {
    if (o.status === 'ERROR') lines.push(`org ${o.orgId}: NOT CHECKED (${o.error ?? 'unknown error'})`);
    for (const f of o.findings) lines.push(`org ${o.orgId}: ${f.kind} ${f.ref} - ${f.detail}`);
  }
  await sendOpsAlertEmail({ subject: `Payments nightly check: ${parts.join(', ')}`, text: lines.join('\n') });
}

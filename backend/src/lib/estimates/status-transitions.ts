/**
 * Estimate status transition engine (Spec B1, applied to Estimate).
 *
 * Estimate status is UNORDERED, exactly like Job status: any of the six exposed statuses is
 * reachable from any other, forward or backward. Only integrity rules block a move. This module
 * owns what each status MEANS in terms of stored state - the stamps to write on entering it and
 * the stamps to clear on leaving the previous one - so the controller endpoints stay thin and can
 * never drift from each other.
 *
 * Callers: setStatusInternal() (PATCH /:id/status + POST /bulk-status).
 */
import { ESTIMATE_STATUS, type EstimateStatusValue } from '../../constants/estimateStatus';

/**
 * The statuses the product model exposes and this engine accepts as targets. EXPIRED and
 * SUPERSEDED are legacy enum values with no UI (see constants/estimateStatus.ts) - a row already
 * sitting in one may be moved OUT, but nothing may be moved INTO them.
 */
export const TARGETABLE_ESTIMATE_STATUSES = [
  ESTIMATE_STATUS.DRAFT,
  ESTIMATE_STATUS.SENT,
  ESTIMATE_STATUS.PENDING,
  ESTIMATE_STATUS.WON,
  ESTIMATE_STATUS.DECLINED,
  ESTIMATE_STATUS.ARCHIVED,
] as const;

/** The shape the money guard needs to see. Structural, so both call sites can satisfy it. */
export interface EstimateMoneyTrail {
  status: string;
  job?: { job_number?: string | null; invoices: { status: string; payments: unknown[] }[] } | null;
  /** kind: 'DEPOSIT' invoices only - estimate_id-linked, so invisible to job.invoices above. */
  invoices?: { status: string; payments: unknown[] }[] | null;
}

/**
 * The ONE integrity rule that still blocks a move: a WON estimate whose money trail is already
 * real cannot be unwound, because doing so would orphan invoices or payments that point at it.
 * Ordering rules are gone (Spec B1); this is not an ordering rule.
 *
 * Previously lived inside voidApproval(), where it only ever guarded WON -> SENT. Hoisting it
 * here extends it to every exit from WON - including -> DRAFT and -> ARCHIVED, which had no route
 * at all before and would otherwise have become unguarded back doors to the same unwind.
 *
 * Returns null when the move is allowed, or the refusal message.
 */
export function blockedByMoneyTrail(
  existing: EstimateMoneyTrail,
  to: EstimateStatusValue,
): string | null {
  if (existing.status !== ESTIMATE_STATUS.WON || to === ESTIMATE_STATUS.WON) return null;

  if (existing.job?.invoices.some((inv) => inv.status !== 'DRAFT' || inv.payments.length > 0)) {
    return `Cannot leave won — job ${existing.job.job_number} has already been invoiced or has payments recorded.`;
  }

  if (existing.invoices?.[0]?.payments.length) {
    return 'Cannot leave won — the deposit has payments recorded.';
  }

  return null;
}

/**
 * (needsSendCeremony removed.) SENT is a label, not a delivery receipt: it records where the
 * estimate sits in the pipeline, not that a customer link exists. Sent-ness lives on its own axis -
 * `public_token` is minted by send/resend/mark-sent and by nothing else - and the two are read
 * together where it matters (the public route needs a token; the pill does not).
 *
 * The old helper reported "this SENT move cannot be a bare stamp" so the setter could answer 409
 * SEND_CEREMONY_REQUIRED and send the client to POST /:id/mark-sent. That endpoint only accepts
 * DRAFT, so the redirect landed on a 400 and the two errors bracketed a move with no legal path.
 */

/**
 * True when the move must also drop the estimate's frozen `send_config` row (#2031 slice 4).
 *
 * Entering DRAFT means the document is back in the salesperson's hands, and the send
 * configuration is the record of a send that no longer stands. It is also the gate on deposit
 * editability (EstimateReceiptCard reads `deposit.editable` off it), so leaving it behind meant a
 * recalled estimate's deposit stayed locked for ever and a salesperson who noticed a mismatch had
 * no way to correct it - "back to draft" did not mean what it says.
 *
 * Separate from `buildStatusChangeData` on purpose: `send_config` is an optional 1:1 whose FK
 * lives on the child, so neither a nested `delete` (throws when there is no row - and an estimate
 * moved straight to SENT without a send ceremony has none) nor a `disconnect` (the child's
 * estimate_id is required) can express this safely inside an update payload. The caller issues an
 * idempotent deleteMany instead.
 *
 * The estimate's OWN deposit_type/deposit_value override is deliberately untouched: the
 * salesperson edits the value they had, rather than losing it.
 */
export function clearsSendConfig(to: EstimateStatusValue): boolean {
  return to === ESTIMATE_STATUS.DRAFT;
}

/**
 * True when the move SUSPENDS the estimate's deposit link (#2031 slice 5, Ran's policy call).
 *
 * Back to draft already nulls the estimate's own public token, so the customer's view of the
 * document is gone. The deposit invoice minted at the first send was the one thing that survived a
 * recall still payable - same live token, same old figure, still SENT - and, because the recall
 * also clears `modified_after_send`, the recall UNDID the superseded refusal instead of standing
 * in for it. That reads as an oversight rather than a decision.
 *
 * Suspend, not void: nothing about the deposit document changes. It is not voided, its token is
 * not rotated and its amount is not touched; the money doors simply refuse it (invoice.controller's
 * `depositHoldReason`) while the estimate sits in DRAFT, and the next send re-prices that same
 * invoice behind that same link. Two live payable links for one deposit at two different amounts
 * can never exist, because there is only ever one link.
 *
 * Stated here, next to the rest of what DRAFT means, so the status engine stays the one place that
 * knows it.
 */
export function suspendsDepositLink(to: EstimateStatusValue): boolean {
  return to === ESTIMATE_STATUS.DRAFT;
}

/**
 * The stamp changes for moving `from` -> `to`, as a Prisma update payload.
 *
 * Entering DRAFT invalidates the customer's link and voids any signature/T&C acceptance captured
 * while the document was out: a DRAFT has nothing valid to view at the old token, re-sending mints
 * a fresh one, and a document going back for edits cannot keep an approval attached to it (the
 * same reasoning as D12's pendingRevertOnMaterialChange).
 */
export function buildStatusChangeData(
  from: string,
  to: EstimateStatusValue,
  reason: { lost_reason?: string; cancelled_reason?: string } = {},
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    status: to,
    ...(to === ESTIMATE_STATUS.DRAFT
      ? {
          public_token: null,
          signature_data: null,
          signature_ip: null,
          signature_at: null,
          terms_accepted: false,
          terms_accepted_at: null,
          modified_after_send: false,
        }
      : {}),
    // Entering WON is the same business event as approve-internal and must carry the same stamp,
    // or a won estimate reports no approval date to the conversion reports.
    ...(to === ESTIMATE_STATUS.WON ? { approved_at: now } : {}),
    // Leaving WON clears it again - an estimate that is no longer won must not report an approval
    // date for an approval that no longer exists.
    ...(from === ESTIMATE_STATUS.WON && to !== ESTIMATE_STATUS.WON ? { approved_at: null } : {}),

    // DECLINED and ARCHIVED each carry their own stamps, and each clears them on the way out:
    // reviving a dead estimate is legal now, and a revived row that still reports a decline date
    // or a cancellation reason is lying about its own history.
    ...(to === ESTIMATE_STATUS.DECLINED ? { declined_at: now, lost_reason: reason.lost_reason } : {}),
    ...(from === ESTIMATE_STATUS.DECLINED && to !== ESTIMATE_STATUS.DECLINED
      ? { declined_at: null, lost_reason: null }
      : {}),

    ...(to === ESTIMATE_STATUS.ARCHIVED ? { cancelled_at: now, cancelled_reason: reason.cancelled_reason ?? null } : {}),
    ...(from === ESTIMATE_STATUS.ARCHIVED && to !== ESTIMATE_STATUS.ARCHIVED
      ? { cancelled_at: null, cancelled_reason: null }
      : {}),
  };
}

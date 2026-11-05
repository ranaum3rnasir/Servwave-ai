import type { Request } from 'express';
import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { logAudit } from '../audit';
import { alertEstimate } from '../../services/notifications/leadEstimateAlerts';
import { depositMethodActivityLine, depositMethodPick, isOnlineDepositMethod } from '../deposit-method-labels';

export { depositMethodActivityLine, depositMethodPick, type DepositMethodPick } from '../deposit-method-labels';

/**
 * #2980 (spec #2978, ruling Q17) - the customer's current deposit method on the estimate.
 *
 * Every pick goes through one of two doors: the approval door (at signing, and its retry for a
 * manual method after signing), or the deposit's own checkout (card or bank after signing, or the
 * open deposit of a won estimate). Both doors go through `storeDepositMethodPick`, which writes the
 * pick and only then hands back its announcement, so History and the office learn of it the same
 * way whichever door it came through, and never of a pick that was not stored.
 */

/**
 * The columns a pick writes. Nothing for the same method again: `deposit_method_at` stays the
 * moment that method was chosen.
 */
export function depositMethodWrite(
  previous: string | null | undefined,
  next: PaymentMethod,
  now: Date = new Date(),
): { deposit_method?: PaymentMethod; deposit_method_at?: Date } {
  return depositMethodPick(previous, next) === 'same' ? {} : { deposit_method: next, deposit_method_at: now };
}

type AnnounceParams = {
  req: Request;
  organizationId: string;
  estimateId: string;
  estimateNumber: string;
  via: 'manual_method' | 'stripe_checkout' | 'deposit_checkout';
};

/**
 * Store a pick, then hand back its announcement (History, the activity line, the office's in-app alert).
 *
 * `store` receives the columns the pick writes (none for the same method again) and performs the
 * door's write with them, alongside whatever else that door writes in the same statement. The
 * announcement exists only once `store` has resolved: if the write throws, the error goes to the
 * caller and nobody is told of a method the estimate does not hold (code review cr1 - a status
 * never claims success for a failure).
 */
export async function storeDepositMethodPick<T>(params: {
  previous: string | null | undefined;
  next: PaymentMethod;
  store: (columns: ReturnType<typeof depositMethodWrite>) => Promise<T>;
}): Promise<{ stored: T; announce: (p: AnnounceParams) => Promise<void> }> {
  const { previous, next } = params;
  const stored = await params.store(depositMethodWrite(previous, next));
  return { stored, announce: (p) => announceDepositMethodPick({ ...p, previous, next }) };
}

/**
 * After a pick is stored: History, the activity line and the office's in-app alert.
 * Reached only through `storeDepositMethodPick`.
 *
 * - The same method again: nothing at all.
 * - Any other pick: History names it ("Customer chose Check for the deposit", "... changed the
 *   deposit method from Check to Card by phone"), a first card or bank pick included (beside the
 *   checkout's own "Customer started deposit checkout").
 * - The office (the estimate's people, through the estimate alert chain) gets an in-app alert for
 *   a first manual pick and for every change. A first card or bank pick tells no one: the payment
 *   confirms itself. No email: staff email is only what a company sets up in the Automation Center
 *   (Ran, 2026-11-04). The alert names no amount.
 *
 * History reads the `method` / `previous_method` codes off the audit row and words them itself.
 * Fire-and-forget like every other alert on the public doors: it never throws into the caller.
 * It runs after the door's write committed (#271: never emit inside a transaction).
 */
async function announceDepositMethodPick(params: AnnounceParams & {
  previous: string | null | undefined;
  next: PaymentMethod;
}): Promise<void> {
  const { req, organizationId, estimateId, estimateNumber, previous, next, via } = params;
  const pick = depositMethodPick(previous, next);
  if (pick === 'same') return;
  try {
    void logAudit({
      req, orgId: organizationId, actorId: null, action: 'estimate.deposit_method_selected',
      resourceType: 'Estimate', resourceId: estimateId,
      metadata: { via, method: next, previous_method: previous ?? null },
    });
    await prisma.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: 'ESTIMATE',
        entity_id: estimateId,
        event_type: 'DEPOSIT_PAYMENT_METHOD_SELECTED',
        description: depositMethodActivityLine(previous, next, estimateNumber),
      },
    });
    if (pick === 'first' && isOnlineDepositMethod(next)) return;
    await alertEstimate({
      verb: 'estimate.deposit_method_selected',
      organizationId,
      actorId: null,
      estimateId,
      data: { method: next, previous_method: pick === 'changed' ? previous : null },
    });
  } catch (err) {
    logger.error(`Failed to record the deposit method pick on ${estimateNumber}:`, err);
  }
}

/** The audit action of the claim on a signing's signed copy. Filed under its own resource type, so History never shows it. */
const SIGNED_COPY_ACTION = 'estimate.signed_copy_sent';
const SIGNED_COPY_RESOURCE = 'EstimateSignedCopy';

/**
 * #2980 (ruling Q17, Ran 2026-11-04) - claim the customer's signed-estimate email for the signing on
 * file: true for exactly one caller per signing, who then sends it. Every door that may send the
 * copy asks: the approval door's manual branch (at signing, and at a later manual pick when the
 * signing was by card or bank and nothing was sent yet), and the payment that completes a card or
 * bank deposit.
 *
 * The claim is a row written in its own transaction with the estimate row locked, so two doors at
 * once cannot both win, and it is awaited, never fire-and-forget: if it cannot be written nothing
 * is sent now, and the next door to ask can still claim it. A signing voided and redone has a new
 * signature time, so an older signing's claim does not count.
 *
 * A signing from before this rule (a manual method picked then, which always sent the copy) left a
 * method pick row without a `method` code; that counts as sent.
 *
 * No signature on file (an estimate approved without one): there is no signing to claim against,
 * so the copy goes as it always did.
 */
export async function claimSignedCopy(params: {
  organizationId: string;
  estimateId: string;
  signatureAt: Date | null | undefined;
}): Promise<boolean> {
  const { organizationId, estimateId, signatureAt } = params;
  if (!signatureAt) return true;
  const signedAt = signatureAt.toISOString();
  // A pre-rule pick row was written moments after its signing; a minute covers clock skew.
  const legacyFrom = new Date(signatureAt.getTime() - 60_000);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM estimates WHERE id = ${estimateId}::uuid FOR UPDATE`;
      const sent = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM audit_logs
         WHERE org_id = ${organizationId}::uuid AND resource_id = ${estimateId}
           AND (
             (action = ${SIGNED_COPY_ACTION} AND resource_type = ${SIGNED_COPY_RESOURCE} AND metadata->>'signed_at' = ${signedAt})
             OR (action = 'estimate.deposit_method_selected' AND resource_type = 'Estimate'
                 AND metadata->>'via' = 'manual_method' AND metadata->'method' IS NULL AND created_at >= ${legacyFrom})
           )
         LIMIT 1`;
      if (sent.length > 0) return false;
      await tx.auditLog.create({
        data: {
          org_id: organizationId, actor_id: null, action: SIGNED_COPY_ACTION,
          resource_type: SIGNED_COPY_RESOURCE, resource_id: estimateId, metadata: { signed_at: signedAt },
        },
      });
      return true;
    });
  } catch (err) {
    logger.error(`Failed to claim the signed copy for estimate ${estimateId}; not sent now:`, err);
    return false;
  }
}

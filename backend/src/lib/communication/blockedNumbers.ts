import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeNAPhone } from '../comms-identity';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Blocked-callers matching + the enforcement decision record (SRVW-98).
 *
 * DECISION: blocking is enforced RECORD-SIDE, in ingest, never at the ring.
 *
 * Why it cannot be enforced at the ring. ServWave's inbound model is post-hoc:
 * the browser softphone never answers inbound (frontend
 * lib/communication/ctmSoftphone.ts - `BROWSER_INBOUND_ANSWER_ENABLED = false`),
 * CTM's Smart Router forwards an inbound call straight to the staff cell, and
 * ServWave only learns of the call afterwards from the CTM webhook that drives
 * lib/ctm/ingest.ts. By the time any of our code runs, the phone has already
 * rung. Ring-level blocking is therefore only achievable in CTM configuration,
 * and lib/ctm/client.ts exposes no verified block/blacklist endpoint (the
 * nearest is the SMS opt-out READ, and lib/ctm/routing.ts states outright that
 * it automates only the two live-verified objects: voice_menus + dial_routes).
 * Adding one is a separate spike, not this card.
 *
 * What we do instead, and what the product copy now says: a blocked inbound
 * call or text is still RECORDED - never dropped, never muted at the data layer
 * - but it raises nothing. No missed-call bell, no inbound-SMS bell, no thread
 * unread increment. A blocked call is additionally tagged 'Blocked caller' so a
 * mis-block stays visible and filterable in the Calls log instead of silently
 * going missing.
 */

/**
 * The ONE comparison form for a blocked number, on both the write side (what
 * the controller persists) and the read side (what ingest probes with).
 *
 * Deliberately strict `normalizeNAPhone` with NO digits fallback: ingest's
 * caller key is always +1XXXXXXXXXX and normalizeNAPhone accepts only a 10-digit
 * or a leading-1 11-digit number (lib/comms-identity.ts). A fallback would let a
 * bare 7-digit local number such as '555-0188' persist under the key '5550188',
 * which can never equal any ingest caller key - a durable row that de-dupes
 * nothing and suppresses nothing. Such input is rejected at the schema instead.
 */
export function blockedNumberKey(raw: string): string | null {
  return normalizeNAPhone(raw);
}

/**
 * Upper bound on the per-activity blocked-list scan. The list is a handful of
 * rows for a real org; the cap only stops a pathological one turning every live
 * inbound activity into an unbounded read.
 */
export const BLOCKED_LIST_SCAN_CAP = 1000;

/**
 * Find the org's blocked-list row matching `raw`, or null.
 *
 * The comparison runs in JS rather than in the WHERE clause because
 * `blocked_numbers` has no normalized column (schema.prisma - the only indexes
 * are organization_id and blocked_by_id), so no SQL predicate can match a stored
 * '(347) 555-0188' against an inbound '+13475550188'. Pre-2026-08 rows really do
 * hold display form. A normalized column plus a unique index would collapse this
 * to a single indexed lookup - filed as the follow-up.
 */
export async function findBlockedNumber(
  db: Db,
  orgId: string,
  raw: string,
): Promise<{ id: string; number: string } | null> {
  const key = blockedNumberKey(raw);
  if (!key) return null;

  const rows = await db.blockedNumber.findMany({
    where: { organization_id: orgId },
    select: { id: true, number: true },
    take: BLOCKED_LIST_SCAN_CAP,
  });

  return rows.find((r) => blockedNumberKey(r.number) === key) ?? null;
}

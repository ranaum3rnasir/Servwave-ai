import { prisma } from './prisma';

/**
 * The only suppression category this codebase writes or reads today. There is
 * no marketing/newsletter send feature anywhere in the repo (grepped to
 * confirm) — `EmailSuppression.category` exists purely so a future one could
 * suppress under its own category without a schema change, never so a
 * newsletter unsubscribe could reach a transactional invoice.
 */
export const TRANSACTIONAL_SUPPRESSION_CATEGORY = 'TRANSACTIONAL';

/**
 * Canonical normalization for a suppression-list address: trimmed, lowercased,
 * and with a "Name <email>" wrapper unwrapped down to the bare address.
 *
 * BOTH the writer (resend-webhook.controller.ts, on a hard bounce/complaint)
 * and the reader (dispatchEmail, lib/email.ts, before every business send)
 * MUST go through this exact function — if they ever normalized differently, a
 * suppressed address could silently stop matching its own suppression row.
 */
export function normalizeSuppressionAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/**
 * True if `to` (a single address, or the list a multi-recipient sender like
 * the PO/stage-pickup senders pass) contains at least one address suppressed
 * for TRANSACTIONAL sends — a prior hard bounce or complaint. Checked from
 * dispatchEmail before every business send (lib/email.ts); `hit` may resolve
 * `undefined` under a bare test-double mock with no explicit stub, so this
 * coerces with Boolean() rather than a strict `!== null` compare.
 */
export async function isTransactionalSendSuppressed(to: string | string[]): Promise<boolean> {
  const addresses = (Array.isArray(to) ? to : [to]).map(normalizeSuppressionAddress).filter(Boolean);
  if (addresses.length === 0) return false;
  const hit = await prisma.emailSuppression.findFirst({
    where: { address: { in: addresses }, category: TRANSACTIONAL_SUPPRESSION_CATEGORY },
    select: { id: true },
  });
  return Boolean(hit);
}

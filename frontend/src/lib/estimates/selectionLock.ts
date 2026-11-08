/**
 * #2053 - THE selection lock: has the customer answered this estimate's optional offers yet?
 * The editor reads it to decide what an optional row says - "Optional" while the answer is still
 * open, then "Included" or "Not included" once it is in - and slice 3 ENFORCES from this same
 * predicate (transcribing it verbatim into its backend twin, following the isEstimateLocked /
 * EstimateWorkspacePage.tsx:290-297 mirror convention).
 * Deliberately NOT isEstimateLocked: that is the edit lock (deposit paid OR the org's send-time
 * toggle).
 *
 * The "Declined" caption this doc used to name is gone (2026-09-18 revision, decision 3): that
 * word is already the estimate STATUS for a customer who rejected the whole quote, and the editor
 * no longer reuses it for a single add-on. Nothing below the docblock changed with it, so the
 * backend twin stays byte-identical.
 *
 * Revision, 2026-09-18 (Ran, decision 6: "A customer cannot tick after signing. Once they sign,
 * it is locked."). The arm that handed the question to a DEPOSIT invoice row - locked iff that
 * invoice was PAID - is gone. It left a customer free to keep changing what they were buying
 * between signing the estimate and paying for it. Signature decides, and nothing else does. The
 * input type still carries `invoices` only because the callers pass whole estimate rows.
 *
 * R4b - the predicate's input type below carries no `organization` member (and so no path to that
 * org-level toggle) on purpose: it cannot leak into this predicate even by accident.
 */
export function areSelectionsLocked(estimate: {
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}): boolean {
  return estimate.status === 'WON'; // signing locks, whatever the deposit is doing
}

/**
 * #2053 slice 3 - the BACKEND twin of `frontend/src/lib/estimates/selectionLock.ts`.
 *
 * `areSelectionsLocked` below is a verbatim transcription of that file, as its own docblock
 * instructs (the same mirror convention `isEstimateLocked` / `EstimateWorkspacePage.tsx` already
 * follow). The frontend behaviour is pinned by
 * `frontend/src/__tests__/estimate-selection-lock.test.tsx`; the two must stay identical, so do
 * not "improve" one of them alone.
 *
 * Deliberately NOT `isEstimateLocked` (estimate.controller.ts): that is the EDIT lock (deposit
 * paid OR the org's send-time toggle). This answers the SELECTION question, and since the
 * 2026-09-18 revision it answers it from the estimate's status and nothing else.
 *
 * The revision (Ran, decision 6: "A customer cannot tick after signing. Once they sign, it is
 * locked.") deleted the arm that handed the question to a DEPOSIT invoice row - locked iff that
 * invoice was PAID. That arm left a customer free to keep changing what they were buying in the
 * window between signing the estimate and paying for it, which is the whole point of signing it.
 * Nothing about a deposit belongs in this predicate now; the input type still carries `invoices`
 * only because the callers pass whole estimate rows.
 */
export function areSelectionsLocked(estimate: {
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}): boolean {
  return estimate.status === 'WON'; // signing locks, whatever the deposit is doing
}

// ─── The 409 the six staff write paths and the public selection route share ───────────────────

/** The machine-readable code every locked-selection refusal carries. */
export const OPTIONS_LOCKED = 'OPTIONS_LOCKED';

/**
 * The sentence the customer or the rep actually reads. House style, no vendor names. The
 * predicate above now has one arm, so this has one sentence: the reader is here because the
 * estimate was accepted, and naming the deposit instead would describe a lock that no longer
 * exists. Takes the estimate anyway so its one caller, `optionsLockedBody`, keeps its shape.
 */
export function selectionLockMessage(_estimate: {
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}): string {
  return 'Selections are locked because this estimate has been accepted.';
}

/**
 * #2090 - the third arm, and the only one that is not a state of the ESTIMATE.
 *
 * A change of selection re-prices the outstanding deposit (AC4). A deposit that already has money
 * against it cannot be re-priced: `repriceUnpaidDepositInvoice` refuses it rather than writing
 * over a customer's payment, and it is right to. But the selection write must then refuse too.
 * Letting it through left the estimate's total moved and the deposit priced off the total before
 * it, which is the divergence the re-price exists to prevent, reached from the other side.
 *
 * This used to be a narrow third arm: a fully PAID deposit never reached it, because
 * `areSelectionsLocked` locked on the deposit row first. Since the 2026-09-18 revision the
 * predicate keys off signature alone, so an UNSIGNED estimate whose deposit already has money
 * against it now arrives here instead. Harder to reach in one sense, more load-bearing in
 * another, and the cheapest thing standing between a re-price and a customer's payment.
 */
export const DEPOSIT_PART_PAID_MESSAGE =
  'Selections are locked because part of the deposit has already been paid.';

/** The whole 409 body, assembled once so the seven refusal sites cannot drift in shape. */
export function optionsLockedBody(estimate: {
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}): { error: string; message: string } {
  return { error: OPTIONS_LOCKED, message: selectionLockMessage(estimate) };
}

// ─── "Would this request CHANGE a selection flag?" ────────────────────────────────────────────

export type SelectionFlags = { is_optional?: boolean | null; is_selected?: boolean | null };

/**
 * The flag-blind shape a row that does not exist yet starts from: a brand-new line or scope is
 * an ordinary, included one until the request says otherwise. Passed as `stored` at the two
 * CREATE sites (addLine / addScope), where there is no persisted row to diff against.
 */
export const DEFAULT_SELECTION_FLAGS: SelectionFlags = { is_optional: false, is_selected: true };

/**
 * "Non-optional implies selected" - the same rule as `normalizeLineSelection`
 * (estimate.controller.ts), restated here rather than imported because that controller imports
 * THIS file and the import back would be a cycle. One line, and pinned on both sides by
 * `estimate-optional-items.test.ts` case 4.
 */
function normalize(flags: { is_optional: boolean; is_selected: boolean }): { is_optional: boolean; is_selected: boolean } {
  return flags.is_optional ? flags : { is_optional: false, is_selected: true };
}

function settled(flags: SelectionFlags): { is_optional: boolean; is_selected: boolean } {
  return normalize({ is_optional: flags.is_optional === true, is_selected: flags.is_selected !== false });
}

/**
 * Would applying `requested` to `stored` land a DIFFERENT selection state than the row already
 * holds? A key the request omits (`undefined`) is not part of the request and cannot change
 * anything; a key it sends at the value already stored is a no-op and must NOT be refused - the
 * lock refuses a CHANGE, it is not a second blanket edit lock.
 *
 * Both sides are normalised first, so `{is_optional:false, is_selected:false}` (which the write
 * paths store as selected) reads as the no-op it actually is rather than as a change.
 */
export function changesSelectionFlags(requested: SelectionFlags, stored: SelectionFlags): boolean {
  const before = settled(stored);
  const after = settled({
    is_optional: requested.is_optional !== undefined && requested.is_optional !== null
      ? requested.is_optional
      : before.is_optional,
    is_selected: requested.is_selected !== undefined && requested.is_selected !== null
      ? requested.is_selected
      : before.is_selected,
  });
  return after.is_optional !== before.is_optional || after.is_selected !== before.is_selected;
}

/**
 * The whole-document PATCH replaces every line in one write, so there is no id to pair an
 * incoming line with a stored one: the only stable correspondence is position. Two lists carry
 * the same selection state when they are the same length and agree, position by position, on the
 * normalised pair. A different LENGTH is a change too: dropping or adding an optional line
 * changes what the customer is buying just as surely as re-ticking one.
 */
export function changesSelectionFlagsInList(
  requested: SelectionFlags[] | undefined,
  stored: SelectionFlags[],
): boolean {
  if (requested === undefined) return false;
  if (requested.length !== stored.length) return true;
  return requested.some((line, i) => changesSelectionFlags(line, stored[i] ?? DEFAULT_SELECTION_FLAGS));
}

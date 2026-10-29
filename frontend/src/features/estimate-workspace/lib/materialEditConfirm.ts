/**
 * Confirming the first material edit after a send (#2030 slice 5).
 *
 * Editing a SENT estimate already has consequences: the customer's existing link stops working,
 * and a signature captured while the document was out is voided. The server has always applied
 * them (materialChangeGuardrail / pendingRevertOnMaterialChange). Nothing about them changes here
 * — this makes them VISIBLE, once, to the person about to cause them.
 *
 * ONCE PER VERSION. The first material edit after a send prompts; subsequent edits proceed
 * silently, because the link is already dead and saying so again is noise. The next send bumps
 * the version, and the prompt returns with it.
 *
 * Commit-on-blur stays, and no Save button is introduced: jobs and invoices share this
 * interaction stack, and a Save button here would diverge from both. Edits also stay under the
 * same estimate number — a correction should not become a new tab and a new number the customer
 * has to reconcile. `revise` is still there for offering a genuinely different option.
 */

/** Per-viewer, per-version. sessionStorage so a reload does not re-ask about a link already dead. */
const STORAGE_PREFIX = 'estimate-material-edit-confirmed';

function key(estimateId: string, version: number): string {
  return `${STORAGE_PREFIX}:${estimateId}:${version}`;
}

/** A draft has nothing out with a customer, so editing one has no consequence to warn about. */
export function needsMaterialEditConfirm(
  status: string,
  estimateId: string,
  version: number,
): boolean {
  if (status === 'DRAFT') return false;
  try {
    return window.sessionStorage.getItem(key(estimateId, version)) === null;
  } catch {
    // A browser that refuses session storage gets asked every time. Asking twice is a small
    // annoyance; not asking at all would let a link die unannounced.
    return true;
  }
}

export function rememberMaterialEditConfirmed(estimateId: string, version: number): void {
  try {
    window.sessionStorage.setItem(key(estimateId, version), '1');
  } catch {
    // Nothing to do — the next edit simply asks again.
  }
}

export interface MaterialEditPrompt {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * What the prompt says. It names the consequences the server will actually apply — and only
 * those: the signature clause appears when there IS a signature to void and is omitted when
 * there is not, because warning about something that cannot happen teaches people to dismiss
 * warnings.
 */
export function materialEditPrompt(hasPendingSignature: boolean): MaterialEditPrompt {
  return {
    title: 'Edit this sent estimate?',
    description: hasPendingSignature
      ? "The link you sent the customer will stop working, and the signature they have already given will be voided — they will need to approve the estimate again. The estimate keeps its number."
      : 'The link you sent the customer will stop working. You can send the estimate again once you have finished editing. The estimate keeps its number.',
    confirmLabel: 'Edit anyway',
  };
}

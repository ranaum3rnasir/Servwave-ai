/**
 * Shared ConfirmDialog copy for actions that appear on more than one surface.
 *
 * Attachment delete exists on five surfaces (lead sections, the CRM/estimate/invoice panel, the
 * lightbox, and both job surfaces). They previously each spelled their own `window.confirm` string,
 * which is how the wording drifted - "Delete this attachment?" on some, `Delete "name"? This cannot
 * be undone.` on others. One helper means the prompt cannot diverge again.
 */
import type { ConfirmOptions } from '@/hooks/useConfirm';

/** `name` is optional because two call sites prompt from a context with no display name to hand. */
export function deleteAttachmentPrompt(name?: string | null): ConfirmOptions {
  return {
    title: name ? `Delete "${name}"?` : 'Delete this attachment?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

/**
 * Line item delete - shared by the Job, Estimate and Invoice line-items editors (all three route
 * through the same `<LineItemsTable>`/`<LineItemRow>`, so one prompt covers all three call sites),
 * plus the same three surfaces' AddLineDialog edit-form footer Delete button.
 * `name` is the line's own item name (LineItemRow already splits it out of `description`).
 */
export function deleteLineItemPrompt(name: string): ConfirmOptions {
  return {
    title: `Remove "${name}"?`,
    description: 'This removes it from the total. This cannot be undone.',
    confirmLabel: 'Remove',
    tone: 'danger',
  };
}

/** Subtask delete - the task drawer's per-subtask X button. `text` is the subtask's own label. */
export function deleteSubtaskPrompt(text: string): ConfirmOptions {
  return {
    title: `Delete "${text}"?`,
    description: 'It is removed from the task. This cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

/**
 * Automation step removal - shared by the builder's step config drawer footer
 * and the spine node's kebab menu, both of which remove the same in-draft
 * step. `stepLabel` is the step type's display label (Wait/Text/Email/
 * Notify/"Stop if"), not a user-given name - steps have none.
 */
export function removeStepPrompt(stepLabel: string): ConfirmOptions {
  return {
    title: `Remove this ${stepLabel} step?`,
    description: 'It comes out of the automation. This cannot be undone.',
    confirmLabel: 'Remove',
    tone: 'danger',
  };
}

/**
 * Automation (workflow) delete - the builder's header Delete control.
 * Matches the wording `AutomationsHomePage.tsx`'s own list-row delete dialog
 * already uses, so the two surfaces that can delete the same record agree.
 */
export function deleteWorkflowPrompt(name: string): ConfirmOptions {
  return {
    title: `Delete "${name}"?`,
    description: "Its activity history is removed too. This can't be undone.",
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

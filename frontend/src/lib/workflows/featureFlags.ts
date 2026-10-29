/**
 * featureFlags.ts — the "Send text" step's per-org authoring lock.
 *
 * Whether an org can author a SEND_TEXT step is a fact about that org, not a
 * global switch: has it connected CTM, cleared A2P, left its own kill switch
 * on, and is it entitled to `phone`. GET /api/workflows/catalog computes all
 * four (backend/src/controllers/workflow.controller.ts) and serves the result
 * as `capabilities.sms_available` (SERV10X-70). A catalog that hasn't loaded
 * yet, or a stale fixture missing the field, is treated as locked — fail
 * closed, never show a step the org can't actually run.
 */
import type { WorkflowCatalog, WorkflowStepType } from '@/lib/api/workflows';

/** Pill shown on a locked step row. */
export const SMS_LOCKED_BADGE = 'Not connected';

/** Hover/focus tooltip explaining the locked step. */
export const SMS_LOCKED_TOOLTIP =
  'Connect a phone number in Communication settings to text a customer or your team from an automation.';

/**
 * Badge + tooltip for a locked step.
 *
 * There was briefly a SECOND reason a step could be locked, and a `stepLockCopyFor(entity)`
 * to word it: Spec B locked SEND_TEXT on a task because a text could only reach the customer
 * and a task has none. Spec C widened the channel to every audience an email reaches, so the
 * subject has no say again and that copy described a rule that no longer exists.
 */
export interface StepLockCopy {
  badge: string;
  tooltip: string;
}

/** Conservative fallback for callers that don't yet know the org's capability. */
export const DEFAULT_LOCKED_STEP_TYPES: WorkflowStepType[] = ['SEND_TEXT'];

/** Its copy counterpart, and a stable identity so it can be a prop default. */
export const DEFAULT_STEP_LOCK_COPY: StepLockCopy = {
  badge: SMS_LOCKED_BADGE,
  tooltip: SMS_LOCKED_TOOLTIP,
};

/**
 * Step types the office cannot author, given the org's capabilities.
 *
 * One question again, and only one: has this organization connected texting. Spec B added a
 * second, per-SUBJECT clause here - a task workflow was locked whatever the org had connected,
 * because a text could only reach the customer and a task has none - and left a note saying
 * the set would empty when SMS reached staff at all. Spec C slice 8 is that landing, and
 * workflowValidation.ts's removed guard names this file as the place to do it. A task
 * workflow can now text its assignees, so the subject has nothing to say about the lock.
 */
export function lockedStepTypesFor(catalog: WorkflowCatalog | undefined): WorkflowStepType[] {
  return catalog?.capabilities?.sms_available ? [] : ['SEND_TEXT'];
}

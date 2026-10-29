/**
 * stopIf.ts — Stop-if predicate evaluator.
 *
 * The Stop-if step is v1's guard node: it TERMINATES an enrollment when a
 * business condition holds ("stop if the invoice is paid"). This module
 * evaluates those conditions against the `EntityState` snapshot that
 * context.ts already produces. PURE — no prisma, no I/O.
 *
 * These predicates are a projection of `stalenessReason()` in engine.ts
 * (lines 91-171) onto the multi-step world: the same "is this entity still
 * in the state the flow cares about" checks, expressed as named conditions
 * a builder step can select instead of being derived from the trigger type.
 */

import { STOP_IF_LABELS } from './workflowValidation';
import type { EntityState } from './context';
import { ESTIMATE_STATUS } from '../../constants/estimateStatus';

/**
 * Does `condition` hold for this entity state?
 * occurrenceKey: the enrollment's occurrence discriminator (ISO scheduled_start
 * for reschedule-scoped flows) — needed only by 'job_rescheduled'.
 * Unknown/illegal conditions return false (validation prevents them upstream;
 * the engine must never stop a flow on a condition it can't evaluate).
 */
export function stopIfHolds(
  condition: string,
  state: EntityState,
  occurrenceKey?: string | null,
): boolean {
  switch (condition) {
    case 'invoice_paid':
      return (
        state.invoiceStatus === 'PAID' ||
        (state.invoiceAmountDue !== undefined && state.invoiceAmountDue <= 0)
      );
    case 'invoice_not_open':
      return state.invoiceStatus !== undefined && !['SENT', 'PARTIAL'].includes(state.invoiceStatus);
    case 'estimate_answered':
      // D6 (2026-07-21): PENDING IS an answer — the customer approved and signed, only the
      // deposit is outstanding. SENT is the sole "still awaiting a response" status, so a
      // chase-for-approval sequence must stop the moment the estimate reaches PENDING.
      return state.estimateStatus !== undefined && state.estimateStatus !== 'SENT';
    case 'estimate_approved':
      return state.estimateStatus === ESTIMATE_STATUS.WON;
    case 'estimate_declined':
      return state.estimateStatus === 'DECLINED';
    case 'job_cancelled':
      return state.jobStatus === 'CANCELLED';
    case 'job_completed':
      return state.jobStatus === 'COMPLETED';
    case 'job_rescheduled':
      return Boolean(
        occurrenceKey && state.jobScheduledStart && state.jobScheduledStart.toISOString() !== occurrenceKey,
      );
    default:
      return false;
  }
}

/** Plain-English activity-log reason, e.g. 'Stopped — the invoice is paid'. */
export function stopIfReason(condition: string): string {
  const label = STOP_IF_LABELS[condition];
  return label ? `Stopped — ${label}` : 'Stopped — the stop condition was met';
}

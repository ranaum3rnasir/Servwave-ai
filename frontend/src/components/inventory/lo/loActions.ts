/**
 * Which buttons a logistic order gets: the one rule module both screens that list orders share (the job page's
 * Logistics tab and the Inventory page's Logistic Orders tab both open the same LODetailSheet, which asks only this).
 *
 * For an order that exists, the server's own list for this person decides (`detail.actions`, see
 * logisticOrderActions on the server): the screen never tests a switch against the order's status. For a brand new
 * order there is no record yet, so the list is what a draft would offer this person, worked from their ability.
 */
import type { AppAbility } from '@/lib/ability';
import type { LogisticOrderAction, LogisticOrderStatus } from '@/lib/api/logisticOrders';

export type LoLifecycleVerb = 'process' | 'submit' | 'approve';

/** What a new, empty draft would offer this person. Create mode only: an order that exists carries the server's list. */
export function newOrderActions(ability: AppAbility): LogisticOrderAction[] {
  const listed: LogisticOrderAction[] = [];
  if (ability.can('submit', 'LogisticOrder')) listed.push('submit');
  // A person who holds both Approve and Process carries an order straight through.
  if (ability.can('approve', 'LogisticOrder') && ability.can('process', 'LogisticOrder')) listed.push('process');
  return listed;
}

/**
 * The one forward button an order shows: a draft is processed (when the person may carry it straight through) or
 * submitted, a submitted order is approved, an approved order is processed. Nothing for a finished order.
 */
export function primaryLifecycle(
  status: LogisticOrderStatus,
  actions: readonly LogisticOrderAction[],
): { label: string; verb: LoLifecycleVerb } | null {
  if (status === 'DRAFT') {
    if (actions.includes('process')) return { label: 'Process', verb: 'process' };
    if (actions.includes('submit')) return { label: 'Submit for approval', verb: 'submit' };
    return null;
  }
  if (status === 'PENDING_APPROVAL') return actions.includes('approve') ? { label: 'Approve', verb: 'approve' } : null;
  if (status === 'APPROVED') return actions.includes('process') ? { label: 'Process', verb: 'process' } : null;
  return null;
}

/** The New logistic order button on a list: Create logistic orders. */
export function canStartNewOrder(ability: AppAbility): boolean {
  return ability.can('create', 'LogisticOrder');
}

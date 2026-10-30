import type { AppAbility } from '@/lib/ability';

/** The status verbs the Jobs list's "Change status" menu can run on every selected job. */
export type BulkStatusAction = 'arrive' | 'start' | 'complete' | 'cancel';

export const BULK_STATUS_MENU: { label: string; action: BulkStatusAction }[] = [
  { label: 'On site', action: 'arrive' },
  { label: 'In progress', action: 'start' },
  { label: 'Complete job', action: 'complete' },
  { label: 'Cancelled', action: 'cancel' },
];

/**
 * Each bulk action follows the switches of its single-job twin (Roles & Permissions S04.6):
 *
 *   On site      Mark arrived            AND Update any visit's status
 *   In progress  Start and finish visits AND Update any visit's status
 *   Complete job Complete jobs
 *   Cancelled    Cancel jobs
 *   Assign       Assign people to jobs   AND Assign work to other people
 *
 * The two visit steps stamp every selected job's current visit, so without Update any visit's status
 * the person would be stepping visits that may not be theirs; they use the per-visit buttons on the
 * job page instead. Bulk Assign replaces each job's crew and names other people, so it needs both
 * assign switches.
 */
export function allowedBulkStatusActions(ability: AppAbility): BulkStatusAction[] {
  const mayStepAnyVisit = ability.can('update_any_visit_status', 'Job');
  return BULK_STATUS_MENU.map((item) => item.action).filter((action) => {
    if (action === 'arrive' || action === 'start') return mayStepAnyVisit && ability.can(action, 'Job');
    return ability.can(action, 'Job');
  });
}

export function canBulkAssign(ability: AppAbility): boolean {
  return ability.can('assign', 'Job') && ability.can('assign', 'User');
}

/** Row checkboxes and the bulk bar exist only while at least one bulk action is left for the person. */
export function hasBulkAction(ability: AppAbility): boolean {
  return allowedBulkStatusActions(ability).length > 0 || canBulkAssign(ability);
}

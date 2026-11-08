/**
 * recipients.ts — the client mirror of the backend's `recipientsFor()`
 * (catalog.ts): which recipient keys are legal for a given trigger+action pair,
 * plus the humanized labels the drawer's recipient <Select> shows. Entity
 * narrowing is the one rule — `assigned_techs` only exists on job triggers.
 */

import type {
  AuthorableActionType,
  AutomationTriggerType,
  RecipientKey,
  WorkflowCatalog,
} from '@/lib/api/workflows';

/** Drawer-facing recipient labels (Title case, unlike the sentence "the customer"). */
export const RECIPIENT_FORM_LABELS: Record<RecipientKey, string> = {
  customer: 'Customer',
  assigned_techs: 'Assigned technicians',
  all_admins: 'All admins',
  all_dispatchers: 'All dispatchers',
  specific_user: 'A specific team member',
  custom: 'Custom email…',
};

/** Recipients valid for a trigger+action pair — mirrors backend recipientsFor(). */
export function recipientsFor(
  catalog: WorkflowCatalog | undefined,
  trigger: AutomationTriggerType,
  action: AuthorableActionType,
): RecipientKey[] {
  const base = catalog?.actions?.[action]?.recipients ?? [];
  const entity = catalog?.triggers?.[trigger]?.entity;
  return entity === 'job' ? base : base.filter((r) => r !== 'assigned_techs');
}

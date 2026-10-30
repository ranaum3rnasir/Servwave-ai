import { useCallback } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppSubject } from '@/lib/ability';

export type AttachmentChange = 'update' | 'delete';

/** The record a file hangs on, as the ability layer names it. */
const RECORD_SUBJECT: Record<string, AppSubject> = {
  job: 'Job',
  lead: 'Lead',
  invoice: 'Invoice',
  customer: 'Customer',
  task: 'Task',
};

/**
 * May this user rename (`update`) or remove (`delete`) a file on this record?
 *
 * Mirrors `attachment.controller.ts`'s `checkEntityEdit` exactly, so a control is offered only where the server would say
 * yes: uploads are the record's own data (P10), so the record's Edit (Edit jobs on a job, Edit leads on a lead, and so on)
 * renames and removes any file on it, another person's included, and there is no attachments switch. Read from CASL, never a
 * role name. The list answer's own per-file `can_rename` / `can_delete` is what the rows draw from; this is the fallback for
 * a row that carries none.
 */
export function useAttachmentChangePermission(entityType: string) {
  const ability = useAppAbility();
  const subject = RECORD_SUBJECT[entityType.toLowerCase()];

  return useCallback(
    // The action does not matter: renaming and removing are both the record's Edit.
    (_action: AttachmentChange, _uploaderId?: string | null): boolean => (subject ? ability.can('update', subject) : false),
    [ability, subject],
  );
}

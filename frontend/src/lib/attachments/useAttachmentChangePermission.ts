import { useCallback } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import { TASK_ATTACHMENT_ENTITY } from '@/lib/tasks/types';

export type AttachmentChange = 'update' | 'delete';

/**
 * May this user rename (`update`) or remove (`delete`) a given file on this entity?
 *
 * Mirrors `attachment.controller.ts`'s `mayChangeAttachment` exactly, so a control is offered
 * only where the server would say yes:
 *
 *   1. the CASL grant on `Attachment`, on every entity; or
 *   2. on a TASK only, the file is one the user uploaded themselves. A technician holds no
 *      update/delete grant, and without this arm could never fix or take back a photo they put
 *      on a task (slice 12 - no role grant is widened; the exception lives in code on both sides).
 *
 * Read from CASL and the session's own user id, never a role name - the same reasoning as
 * `useTaskDeletePermission`. False for the uploader arm while the session has not hydrated.
 */
export function useAttachmentChangePermission(entityType: string) {
  const ability = useAppAbility();
  const actorId = useAuthStore((s) => s.user?.id) ?? '';
  const onTask = entityType.toLowerCase() === TASK_ATTACHMENT_ENTITY;

  return useCallback(
    (action: AttachmentChange, uploaderId: string | null | undefined): boolean =>
      ability.can(action, 'Attachment') || (onTask && !!actorId && uploaderId === actorId),
    [ability, actorId, onTask],
  );
}

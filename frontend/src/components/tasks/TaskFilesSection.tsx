import { useCallback, type ReactNode } from 'react';

import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { TASK_ATTACHMENT_ENTITY } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';

/**
 * A task drawer's Files section: the task's own files - never the linked record's (slice 12).
 * It reports the loaded count to the tasks store so the card under the drawer follows it.
 * Shared by both task drawers; each passes its own section heading.
 */
export function TaskFilesSection({ taskId, heading }: { taskId: string; heading: ReactNode }) {
  const { setAttachmentCount } = useTasksStore();
  const reportFileCount = useCallback(
    (count: number) => setAttachmentCount(taskId, count),
    [taskId, setAttachmentCount],
  );
  return (
    <section aria-label="Files">
      {heading}
      <AttachmentSection
        key={taskId}
        entityType={TASK_ATTACHMENT_ENTITY}
        entityId={taskId}
        onCountChange={reportFileCount}
      />
    </section>
  );
}

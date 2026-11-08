import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { canAccessTask } from './visibility';

/**
 * The name-free wording of each file event. The attachment controller writes these same verbs
 * with ": <file name>" after them.
 */
const FILE_EVENT_WITHOUT_NAME: Record<string, string> = {
  ATTACHMENT_UPLOADED: 'File uploaded',
  ATTACHMENT_UPDATED: 'Attachment updated',
  ATTACHMENT_DELETED: 'Attachment deleted',
};

interface FeedEvent {
  event_type: string;
  entity_type: string;
  entity_id: string;
  description: string;
}

/**
 * A task's files are exactly as private as the task (slice 12: the TASK branch of the attachment
 * controller's `checkEntityAccess` - admin always, assignee or watcher always, anyone else only
 * through the linked record they can already open). An org-wide feed that carries every file
 * event's description would hand their names to a viewer that rule refuses, so for such a viewer
 * the event stays and the name goes. A task that no longer exists cannot be opened by anyone, so
 * its file names stay hidden too (admins pass `canAccessTask` without a row and see them).
 *
 * One batched, tenant-scoped read for the tasks the feed's file events point at.
 */
export async function hideUnopenableTaskFileNames<T extends FeedEvent>(req: Request, events: T[]): Promise<T[]> {
  const taskIds = [
    ...new Set(events.filter((e) => e.entity_type === 'TASK' && e.event_type in FILE_EVENT_WITHOUT_NAME).map((e) => e.entity_id)),
  ];
  if (taskIds.length === 0 || req.user!.role === 'ADMIN') return events;

  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, ...tenantWhere(req) },
    select: { id: true, assignee_ids: true, watcher_ids: true, linked_entity_type: true, linked_entity_id: true },
  });
  const openable = new Set<string>();
  for (const task of tasks) if (await canAccessTask(req, task)) openable.add(task.id);

  return events.map((e) =>
    e.entity_type === 'TASK' && e.event_type in FILE_EVENT_WITHOUT_NAME && !openable.has(e.entity_id)
      ? { ...e, description: FILE_EVENT_WITHOUT_NAME[e.event_type] }
      : e,
  );
}

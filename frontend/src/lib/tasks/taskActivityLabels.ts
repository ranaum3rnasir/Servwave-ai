/**
 * What each task activity entry reads as in a task drawer's Activity list. Both drawers - the
 * Tasks page's and the legacy one the job and lead Tasks tabs open - read this one table, so a new
 * activity type is named once. An unknown type falls back to its raw value at the call site.
 */
export const TASK_ACTIVITY_LABELS: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  status_changed: 'Status changed',
  priority_changed: 'Priority changed',
  due_changed: 'Due date changed',
  commented: 'Commented',
  nudged: 'Nudged',
  completed: 'Completed',
  cancelled: 'Cancelled',
  attachment_uploaded: 'File added',
  attachment_updated: 'File renamed',
  attachment_deleted: 'File removed',
};

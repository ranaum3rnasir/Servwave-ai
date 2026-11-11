import { useCallback, useEffect, useRef, useState } from 'react';

import { type ParsedTask } from '@/lib/tasks/taskAI';
import type { LinkedEntity, TaskCategoryRef, TaskPriority } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import { extractApiError } from '@/lib/utils';
import { useTaskAssignPermission } from '@/lib/tasks/useTaskAssignPermission';
import { useLinkedEntityAccess, useTaskRosterEditable } from '@/lib/tasks/useLinkedEntityAccess';
import { useTaskCreateFiles } from '@/lib/tasks/useTaskCreateFiles';

const ELLIPSIS = '…';

export interface CreateTaskFormOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParse?: ParsedTask | null;
  /** When opened from a Job/Lead the linked entity is preset and locked. */
  presetEntity?: LinkedEntity | null;
  /** The due field's value for a parsed draft's ISO instant. */
  dueFromIso: (iso: string | null) => string;
  /** The ISO instant the due field's value means, or null when empty. */
  dueToIso: (value: string) => string | null;
  /** Report a failed create: each dialog raises its own layer's toast. */
  onCreateError: (title: string, description: string) => void;
  /** Skip advisory entity access queries to optimize modal open latency */
  skipEntityAccess?: boolean;
  /** Callback fired with the created task on successful creation */
  onSuccess?: (task: any) => void;
  /** Notification override options (e.g. { in_app: false, email: false } when Bee handles its own alerts) */
  notify?: { in_app?: boolean; email?: boolean };
}

/**
 * The New Task form, shared by the legacy modal (components/tasks/CreateTaskModal) and the Tasks
 * page dialog (pages/v2/tasks/components/createTaskDialog): the fields, the create and close state
 * machine, the files step and the footer state. The two dialogs only draw it - with their own
 * layer's controls - and say how the due date reads (the legacy modal on the org's clock, the
 * Tasks page on the browser's, as each always has).
 *
 * The flow: Create adds the task, then uploads its queued files. When every file lands the dialog
 * closes. When one fails the task still exists, so the dialog stays open on the files step
 * (`files.taskId` set), naming the file with a Retry; it never undoes the task.
 */
export function useCreateTaskForm({
  open, onOpenChange, initialParse, presetEntity, dueFromIso, dueToIso, onCreateError, skipEntityAccess = false, onSuccess, notify,
}: CreateTaskFormOptions) {
  const addTask = useTasksStore((s) => s.addTask);
  // CASL `assign` on Task, never `role === 'ADMIN'` - see the hook's note.
  const { canAssignOthers, actorId } = useTaskAssignPermission();

  /**
   * A user WITHOUT `assign` can only ever create a task on themselves - the
   * server forces `[actorId]` and 403s anything else - so their disabled field
   * shows that outcome instead of an empty control that lies about what will
   * happen. A holder starts blank and picks.
   *
   * useCallback so the open-effect can depend on it honestly: the grant and the
   * actor arrive with the session, and a dialog opened before they land must
   * re-seed once they do rather than keeping a stale empty array.
   */
  const seedAssignees = useCallback((parsed?: string): string[] => {
    if (!canAssignOthers) return actorId ? [actorId] : [];
    return parsed ? [parsed] : [];
  }, [canAssignOthers, actorId]);

  const [title, setTitle] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  const [dueValue, setDueValue] = useState('');
  const [priority, setPriority] = useState<string>('MEDIUM');
  const [category, setCategory] = useState<TaskCategoryRef | null>(null);
  const [linkedEntity, setLinkedEntity] = useState<LinkedEntity | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // A second click can land before the disabled state paints; this is what makes it a no-op.
  const submittingRef = useRef(false);
  const files = useTaskCreateFiles();

  const effectiveEntity = presetEntity ?? linkedEntity;
  // Null while the dialog is shut, so the roster check costs one request per OPENING rather than
  // one per mount of a surface that presets an entity (the tasks tab always does), and null for a
  // reader who can change neither roster, who has nothing to do with the answer.
  const rosterEditable = useTaskRosterEditable('create');
  const entityAccess = useLinkedEntityAccess(
    open && rosterEditable && !skipEntityAccess ? effectiveEntity : null
  );

  const dueFromIsoRef = useRef(dueFromIso);
  useEffect(() => { dueFromIsoRef.current = dueFromIso; });

  useEffect(() => {
    if (!open) return;

    if (initialParse) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds seven fields the user then edits freely: it runs on open only (from the parsed draft, or blank below) and must NOT re-derive afterwards, which is exactly what deriving from the props during render would do
      setTitle(initialParse.title ?? '');
      if (initialParse.assignee_ids && initialParse.assignee_ids.length > 0) {
        setAssigneeIds(initialParse.assignee_ids);
      } else {
        setAssigneeIds(seedAssignees(initialParse.assignee_id));
      }
      if (initialParse.watcher_ids && initialParse.watcher_ids.length > 0) {
        setWatcherIds(initialParse.watcher_ids);
      } else {
        setWatcherIds([]);
      }
      setDueValue(dueFromIsoRef.current(initialParse.due_at));
      setPriority(initialParse.priority ?? 'MEDIUM');
      if (initialParse.category !== undefined) {
        setCategory(initialParse.category);
      } else {
        setCategory(null);
      }
      setLinkedEntity(presetEntity ?? initialParse.linked_entity ?? null);
      setDescription(initialParse.description ?? '');
    } else {
      setTitle('');
      setAssigneeIds(seedAssignees());
      setWatcherIds([]);
      setDueValue('');
      setPriority('MEDIUM');
      setCategory(null);
      setLinkedEntity(presetEntity ?? null);
      setDescription('');
    }
  }, [open, initialParse, presetEntity, seedAssignees]);

  function resetForm() {
    setTitle('');
    setAssigneeIds(seedAssignees());
    setWatcherIds([]);
    setDueValue('');
    setPriority('MEDIUM');
    setCategory(null);
    setLinkedEntity(presetEntity ?? null);
    setDescription('');
  }

  function close() {
    resetForm();
    files.reset();
    onOpenChange(false);
  }

  async function handleCreate() {
    if (!title.trim() || submittingRef.current) return;

    const dueAt = dueToIso(dueValue);

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const task = await addTask({
        title: title.trim(),
        description,
        status: 'TODO',
        priority: priority as TaskPriority,
        due_at: dueAt,
        linked_entity: effectiveEntity ? { type: effectiveEntity.type, id: effectiveEntity.id } : null,
        category_id: category?.id ?? null,
        // Omitted when empty: the server reads a missing key as "default to me",
        // which is the right outcome for a blank field and the only one a
        // non-holder is allowed.
        ...(assigneeIds.length > 0 ? { assignee_ids: assigneeIds } : {}),
        ...(watcherIds.length > 0 ? { watcher_ids: watcherIds } : {}),
        ...(notify ? { notify } : {}),
      });
      onSuccess?.(task);
      // The task exists now, whatever happens to its files. A file that fails keeps the
      // dialog open on the Files outcome, named, with a Retry; it never undoes the task.
      if (await files.uploadTo(task.id)) close();
    } catch (err) {
      onCreateError('Failed to create task', extractApiError(err, 'Something went wrong. Please try again.'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /**
   * Cancel, Done, Escape, the X and the backdrop all land here. Before create it discards the
   * queued files - nothing was sent, nothing is. While the task is being created, or a file is
   * going up, it does nothing: closing then would create the task and silently drop its files,
   * and the dialog is the only place a file's outcome is shown.
   */
  function handleClose() {
    if (submittingRef.current || files.uploading) return;
    close();
  }

  /** What the footer shows: Done on the files step, Cancel + Create before it. */
  const footer = files.taskId
    ? {
        step: 'files' as const,
        doneLabel: files.uploading ? `Uploading${ELLIPSIS}` : 'Done',
        doneDisabled: files.uploading,
      }
    : {
        step: 'form' as const,
        cancelDisabled: submitting,
        createLabel: submitting ? `Creating${ELLIPSIS}` : 'Create',
        createDisabled: !title.trim() || submitting,
      };

  return {
    title, setTitle,
    assigneeIds, setAssigneeIds,
    watcherIds, setWatcherIds,
    dueValue, setDueValue,
    priority, setPriority,
    category, setCategory,
    /** The preset entity when there is one (locked), else the picked one. */
    linkedEntity: effectiveEntity, setLinkedEntity,
    linkedEntityLocked: Boolean(presetEntity),
    description, setDescription,
    canAssignOthers,
    entityAccess,
    files,
    /** After create, when a file still needs attention: the dialog shows only the files. */
    onFilesStep: Boolean(files.taskId),
    footer,
    handleCreate,
    handleClose,
    /** For the Dialog's onOpenChange: every dismissal goes through handleClose. */
    onDialogOpenChange: (next: boolean) => { if (!next) handleClose(); },
  };
}

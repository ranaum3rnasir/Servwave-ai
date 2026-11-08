import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';

import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { useTasksStore } from '@/stores/tasksStore';
import { TASK_STATUSES, TASK_PRIORITIES, type TaskStatus, type TaskPriority } from '@/lib/tasks/types';
import { isOverdue, assessRisk } from '@/lib/tasks/tasks-logic';
import { formatExactInstant } from '@/lib/format-date';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';
import { TaskFilesSection } from '@/components/tasks/TaskFilesSection';
import { TASK_ACTIVITY_LABELS } from '@/lib/tasks/taskActivityLabels';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteSubtaskPrompt } from '@/lib/confirmPrompts';
import { useTaskAssignPermission } from '@/lib/tasks/useTaskAssignPermission';
import { useTaskDeletePermission } from '@/lib/tasks/useTaskDeletePermission';
import { useLinkedEntityAccess, useTaskRosterEditable } from '@/lib/tasks/useLinkedEntityAccess';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { toast } from '@/ui-kit/components/ui/sonner';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { DateTimePicker } from '../../_shared/dateTimePicker';
import { LinkedEntityChip, PriorityDot, RiskBadge, TaskStatusChip } from './atoms';
import { TaskCategoryPicker } from './taskCategoryPicker';
import { ELLIPSIS, EM_DASH } from './glyphs';


function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground mb-2 text-[11.5px] font-bold tracking-[0.06em] uppercase">
      {children}
    </p>
  );
}

/**
 * The task drawer, mounted ONCE by the hub and driven entirely by
 * `taskDetailStore.openTaskId`. Every id change re-fetches the rich detail row
 * (`GET /api/tasks/:id`) because list rows always come back with empty
 * subtasks/comments/activity/watchers.
 *
 * One quirk is reproduced deliberately rather than corrected: risk is computed
 * with `assigneeOpenCount: 0`, so the drawer's badge can disagree with the
 * board's, which feeds the real per-assignee count. It is logged in the gap
 * ledger's "observed but not fixed" table.
 *
 * The second gap listed there - "there is NO delete control, even though
 * `deleteTask` and `DELETE /api/tasks/:id` both exist" - is now CLOSED. It made
 * the endpoint's row-level escape hatch unreachable: a technician holds no
 * `delete` grant, so a todo item they opened for themselves could never be removed
 * (a task must always keep an assignee, so they could not unassign out of it
 * either). See `useTaskDeletePermission` for the two arms the control is gated on.
 *
 * Title and description commit on BLUR (never on keystroke), keyed by task id
 * so switching tasks re-seeds the uncontrolled inputs. Every accessible name
 * the specs key off - "Nudge assignee", "Delete subtask", "Add subtask" - is
 * carried over verbatim.
 */
export function TaskDetailDrawer() {
  const { openTaskId, close } = useTaskDetailStore();
  const {
    tasks, updateStatus, updateTask, fetchTaskDetail, addComment,
    addSubtask, toggleSubtask, deleteSubtask, deleteTask, setAssignees, setWatchers, nudge,
  } = useTasksStore();
  const { canAssignOthers } = useTaskAssignPermission();

  const task = openTaskId ? tasks.find((t) => t.id === openTaskId) ?? null : null;


  // Either the `delete` grant, or design §3's row-level escape hatch (creator AND
  // sole assignee). Same two arms the DELETE endpoint checks, so the control is
  // offered exactly where the server would say yes.
  const canDelete = useTaskDeletePermission(task);

  // Null for an unlinked task, for a shut drawer, and for a reader who can change neither the
  // assignee nor the watcher roster - none of the three has anything to do with the answer.
  const rosterEditable = useTaskRosterEditable('update');
  const entityAccess = useLinkedEntityAccess(rosterEditable ? task?.linked_entity ?? null : null);

  useEffect(() => {
    if (openTaskId) fetchTaskDetail(openTaskId);
  }, [openTaskId, fetchTaskDetail]);

  const [commentBody, setCommentBody] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [subtaskText, setSubtaskText] = useState('');
  const { confirm, confirmDialog } = useConfirm();

  const handleDeleteSubtask = async (taskId: string, subtaskId: string, subtaskLabel: string) => {
    if (!(await confirm(deleteSubtaskPrompt(subtaskLabel)))) return;
    deleteSubtask(taskId, subtaskId);
  };

  const handlePostComment = async () => {
    const body = commentBody.trim();
    if (!body || !task) return;
    setPostingComment(true);
    try {
      await addComment(task.id, body);
      setCommentBody('');
    } finally {
      setPostingComment(false);
    }
  };

  const handleAddSubtask = async () => {
    const text = subtaskText.trim();
    if (!text || !task) return;
    await addSubtask(task.id, text);
    setSubtaskText('');
  };

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * The store's `deleteTask` REJECTS on a 4xx (the server can still answer 403 -
   * the row it sees may not be the row this render was built from), so the await
   * is wrapped: an unhandled rejection here would leave the drawer open with no
   * explanation and the card still on the board. The drawer closes, the row
   * leaves the store, and the toast fires only on a real 204.
   */
  const handleDelete = async () => {
    if (!task) return;
    const label = task.task_number;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      setConfirmDeleteOpen(false);
      close();
      toast.success('Task deleted', {
        description: `${label} is gone, along with its comments, files and activity.`,
      });
    } catch (err) {
      setConfirmDeleteOpen(false);
      toast.error('Could not delete this task', {
        description: extractApiError(err, 'You do not have permission to delete this task.'),
      });
    } finally {
      setDeleting(false);
    }
  };

  const risk = task
    ? assessRisk(task, { now: new Date(), assigneeOpenCount: 0 })
    : { score: 0, reason: null, atRisk: false };

  const overdue = task ? isOverdue(task, new Date()) : false;
  const doneSubs = task ? task.subtasks.filter((s) => s.done).length : 0;
  const totalSubs = task ? task.subtasks.length : 0;

  const sortedActivity = task
    ? [...task.activity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    : [];

  return (
    <>
    <Sheet open={!!task} onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent side="right" className="w-[440px] sm:max-w-[440px]">
        {task && (
          <>
            <SheetDescription className="sr-only">
              Task detail for {task.task_number}
            </SheetDescription>

            <SheetHeader>
              <p className="text-subtle-foreground mb-1 font-mono text-[11.5px]">{task.task_number}</p>
              <SheetTitle asChild>
                {/* Reads as an editable heading, not a text box: the kit Input's
                    own border, surface and shadow are stripped so the title is
                    only boxed on hover and focus. Kit Input rather than a raw
                    <input> because the raw-tag ratchet is at its floor - and
                    the primitive brings the focus ring with it either way.
                    Commits on blur; Enter blurs. */}
                <Input
                  key={task.id + '-title'}
                  aria-label="Task title"
                  className="h-auto rounded-none border-0 border-b border-transparent bg-transparent px-0 pe-6 text-[15px] font-bold leading-snug shadow-none focus-visible:ring-0"
                  defaultValue={task.title}
                  onBlur={(e) => {
                    const val = e.currentTarget.value.trim();
                    if (val && val !== task.title) updateTask(task.id, { title: val });
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                />
              </SheetTitle>

              <div className="flex flex-wrap items-center gap-2">
                <TaskStatusChip status={task.status} />
                <PriorityDot priority={task.priority} />
                <TaskCategoryChip category={task.category} />
                <RiskBadge result={risk} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => nudge(task.id)}
                  aria-label="Nudge assignee"
                  className="ms-auto"
                >
                  Nudge
                </Button>
              </div>
            </SheetHeader>

            <SheetBody className="flex flex-col gap-6">
              <section>
                <SectionLabel>Quick actions</SectionLabel>
                <div className="flex items-center gap-2">
                  <SelectField
                    value={task.status}
                    onValueChange={(val) => updateStatus(task.id, val as TaskStatus)}
                    className="w-[160px]"
                    aria-label="Change status"
                    options={TASK_STATUSES.map((s) => ({
                      value: s,
                      label: STATUS_REGISTRY.task[s]?.label ?? s,
                    }))}
                  />
                  <span className="text-muted-foreground text-[12px]">Change status</span>
                </div>
              </section>

              <section>
                <SectionLabel>Details</SectionLabel>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[12px]">
                  <dt className="text-muted-foreground self-start pt-1 font-medium whitespace-nowrap">Assignees</dt>
                  <dd>
                    {/* Read-only for a caller without `assign` on Task: they may still
                        change status/priority/due on a task they can see, but any edit to
                        the assignee set is a 403. Showing the REAL set disabled (not their
                        own id) is the honest render for an existing task. */}
                    <MultiAssigneeSelect
                      id="task-assignees"
                      value={task.assignee_ids}
                      onChange={(ids) => setAssignees(task.id, ids)}
                      purpose="task"
                      disabled={!canAssignOthers}
                      eligibleFor="task"
                      // The task's OWN resolved names, so a chip stays labelled for a caller
                      // whose scoped roster is just themselves. `TaskPersonRef.name` is null for
                      // an id that no longer resolves - such a row is skipped, not blanked.
                      knownPeople={task.assignees}
                      flaggedIds={entityAccess.flaggedIds}
                      flagNote={entityAccess.note}
                      flagBadge={entityAccess.badge}
                    />
                  </dd>

                  <dt className="text-muted-foreground self-start pt-1 font-medium whitespace-nowrap">Watchers</dt>
                  <dd>
                    <MultiAssigneeSelect
                      id="task-watchers"
                      value={task.watcher_ids}
                      onChange={(ids) => setWatchers(task.id, ids)}
                      purpose="taskWatcher"
                      eligibleFor="task"
                      knownPeople={task.watchers}
                      flaggedIds={entityAccess.flaggedIds}
                      flagNote={entityAccess.note}
                      flagBadge={entityAccess.badge}
                    />
                  </dd>

                  <dt className="text-muted-foreground self-center font-medium whitespace-nowrap">Due</dt>
                  <dd className="flex items-center gap-1">
                    {/* The picker, not the native control: #430 (an OS popup a
                        modal Radix layer cannot dismiss) applies only to the
                        create Dialog, but the browser locale deciding the field
                        ORDER applies everywhere, and this is a US-only product.
                        Its value contract is the same 'YYYY-MM-DDTHH:MM' string,
                        so both expressions below are carried over verbatim and
                        the PATCH body is unchanged. */}
                    <DateTimePicker
                      aria-label="Due date"
                      stepMinutes={15}
                      className="h-8.5"
                      value={task.due_at ? new Date(task.due_at).toISOString().slice(0, 16) : ''}
                      onChange={(val) => {
                        updateTask(task.id, { due_at: val ? new Date(val).toISOString() : null });
                      }}
                    />
                    {overdue && <span className="text-status-red-emphasis font-medium">(overdue)</span>}
                  </dd>

                  <dt className="text-muted-foreground self-center font-medium whitespace-nowrap">Priority</dt>
                  <dd>
                    <SelectField
                      value={task.priority}
                      onValueChange={(v) => updateTask(task.id, { priority: v as TaskPriority })}
                      className="h-8.5"
                      aria-label="Priority"
                      options={TASK_PRIORITIES.map((p) => ({
                        value: p,
                        label: p.charAt(0) + p.slice(1).toLowerCase(),
                      }))}
                    />
                  </dd>

                  <dt className="text-muted-foreground self-center font-medium whitespace-nowrap">Category</dt>
                  <dd>
                    <TaskCategoryPicker
                      className="h-8.5"
                      value={task.category}
                      onChange={(category) => updateTask(task.id, { category })}
                    />
                  </dd>

                  <dt className="text-muted-foreground font-medium whitespace-nowrap">Linked</dt>
                  <dd>
                    {task.linked_entity
                      ? <LinkedEntityChip entity={task.linked_entity} />
                      : <span className="text-muted-foreground">{EM_DASH}</span>}
                  </dd>

                  <dt className="text-muted-foreground font-medium whitespace-nowrap">Created by</dt>
                  <dd>
                    {task.created_by_name ?? task.created_by}
                    <span className="text-muted-foreground ms-1">· {formatExactInstant(task.created_at)}</span>
                  </dd>

                  <dt className="text-muted-foreground font-medium whitespace-nowrap">Completed</dt>
                  <dd>
                    {task.completed_at
                      ? formatExactInstant(task.completed_at)
                      : <span className="text-muted-foreground">{EM_DASH}</span>}
                  </dd>
                </dl>
              </section>

              <section>
                <SectionLabel>Description</SectionLabel>
                <Textarea
                  key={task.id + '-desc'}
                  aria-label="Description"
                  className="min-h-[72px] resize-none"
                  defaultValue={task.description}
                  placeholder={`Add a description${ELLIPSIS}`}
                  rows={3}
                  onBlur={(e) => {
                    const val = e.currentTarget.value;
                    if (val !== task.description) updateTask(task.id, { description: val });
                  }}
                />
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-muted-foreground text-[11.5px] font-bold tracking-[0.06em] uppercase">Subtasks</p>
                  {totalSubs > 0 && (
                    <span className="text-muted-foreground text-[12px] tabular-nums">{doneSubs}/{totalSubs} done</span>
                  )}
                </div>
                {task.subtasks.length === 0 ? (
                  <p className="text-subtle-foreground text-[13px]">No subtasks.</p>
                ) : (
                  <ul className="mb-3 flex flex-col gap-2">
                    {task.subtasks.map((sub) => (
                      <li key={sub.id} className="flex items-center gap-2">
                        <Checkbox
                          checked={sub.done}
                          aria-label={sub.text}
                          onCheckedChange={() => toggleSubtask(task.id, sub.id, !sub.done)}
                        />
                        <span className={sub.done
                          ? 'text-muted-foreground flex-1 text-[13px] line-through'
                          : 'flex-1 text-[13px]'}
                        >
                          {sub.text}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDeleteSubtask(task.id, sub.id, sub.text)}
                          aria-label="Delete subtask"
                          className="shrink-0"
                        >
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    aria-label="New subtask"
                    value={subtaskText}
                    onChange={(e) => setSubtaskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddSubtask();
                      }
                    }}
                    placeholder={`Add subtask${ELLIPSIS}`}
                    className="h-8.5 flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddSubtask}
                    disabled={!subtaskText.trim()}
                    aria-label="Add subtask"
                    className="shrink-0"
                  >
                    Add subtask
                  </Button>
                </div>
              </section>

              <TaskFilesSection taskId={task.id} heading={<SectionLabel>Files</SectionLabel>} />

              <section>
                <SectionLabel>Activity</SectionLabel>
                {sortedActivity.length === 0 && task.comments.length === 0 ? (
                  <p className="text-subtle-foreground text-[13px]">No activity yet.</p>
                ) : (
                  <ol className="flex flex-col gap-3">
                    {sortedActivity.map((entry) => (
                      <li key={entry.id} className="flex items-start gap-2 text-[12px]">
                        <span className="bg-subtle-foreground mt-1.5 size-1.5 shrink-0 rounded-full" />
                        <div className="min-w-0">
                          <span className="font-medium">{TASK_ACTIVITY_LABELS[entry.type] ?? entry.type}</span>
                          {' '}
                          <span className="text-muted-foreground">by {entry.actor_name ?? entry.actor_id}</span>
                          <span className="text-subtle-foreground mt-0.5 block">
                            {new Date(entry.at).toLocaleString('en-US', {
                              month: 'short', day: 'numeric', year: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {task.comments.length > 0 && (
                  <div className="border-input mt-4 flex flex-col gap-3 border-t pt-4">
                    <SectionLabel>Comments</SectionLabel>
                    {task.comments.map((c) => (
                      <div key={c.id} className="border-input bg-muted rounded-md border p-3 text-[12px]">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-medium">{c.author_name ?? c.author_id}</span>
                          <span className="text-subtle-foreground">
                            {new Date(c.at).toLocaleString('en-US', {
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="leading-relaxed">{c.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-input mt-4 border-t pt-4">
                  <Label htmlFor="task-comment" className="mb-2">Add comment</Label>
                  <Textarea
                    id="task-comment"
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder={`Add a comment${ELLIPSIS}`}
                    rows={3}
                    className="mb-2 resize-none"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handlePostComment}
                    disabled={!commentBody.trim() || postingComment}
                  >
                    {postingComment ? `Posting${ELLIPSIS}` : 'Post'}
                  </Button>
                </div>
              </section>

              {/* Danger zone. Rendered only when the DELETE would actually be
                  allowed - the `delete` grant, or creator-and-sole-assignee. */}
              {canDelete && (
                <section className="border-input border-t pt-4">
                  <SectionLabel>Danger zone</SectionLabel>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmDeleteOpen(true)}
                    aria-label="Delete task"
                  >
                    <Trash2 />
                    Delete task
                  </Button>
                </section>
              )}
            </SheetBody>
          </>
        )}
      </SheetContent>
      {confirmDialog}
    </Sheet>

    {/* Sibling of the Sheet, not a child of it: a Dialog nested inside the
        sheet's own dismissable layer fights it for focus on close. */}
    <ConfirmDialog
      open={confirmDeleteOpen}
      onOpenChange={setConfirmDeleteOpen}
      destructive
      title={`Delete ${task?.task_number ?? 'this task'}?`}
      description={
        <>
          <span className="font-medium">{task?.title}</span> will be permanently
          removed, along with every comment, every file and its whole activity history. This
          cannot be undone.
        </>
      }
      confirmLabel="Delete permanently"
      cancelLabel="Keep task"
      isPending={deleting}
      onConfirm={() => { void handleDelete(); }}
    />
    </>
  );
}

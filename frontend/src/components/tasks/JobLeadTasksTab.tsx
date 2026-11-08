import { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, ClipboardList } from 'lucide-react';
import type { LinkedEntity, Task, TaskStatus } from '@/lib/tasks/types';
import { taskAI } from '@/lib/tasks/taskAI';
import { listTasks } from '@/lib/api/tasks';
import { useTasksStore } from '@/stores/tasksStore';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { TaskCard } from './TaskCard';
import { CreateTaskModal } from './CreateTaskModal';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import { useToast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

interface JobLeadTasksTabProps {
  entity: LinkedEntity;   // { type: 'JOB'|'LEAD'|'CUSTOMER'|'ESTIMATE', id, label }
  jobType?: string;       // used by "Generate tasks"; falls back to entity.label
  /**
   * Bumped by a page that creates tasks for this entity OUTSIDE the tab (the job header's New
   * Task), so the list re-reads exactly as it does when the tab's own create modal closes.
   */
  refreshKey?: number;
}

// Live tasks are grouped by status so the most active work reads first, and both closed
// groups sort last.
//
// Cancelled gets a group of its own rather than being hidden the way it is on the hub board
// (issue 03). This is the record's whole task list, not a board of work in flight: the count
// in the section header includes it, and a task that vanishes from the only surface that
// links it to this job is lost rather than closed.
const STATUS_GROUPS: { key: TaskStatus; label: string }[] = [
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'TODO', label: 'To do' },
  { key: 'BLOCKED', label: 'Blocked' },
  { key: 'DONE', label: 'Done' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

export function JobLeadTasksTab({ entity, jobType, refreshKey }: JobLeadTasksTabProps) {
  const [linked, setLinked] = useState<Task[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const addTask = useTasksStore((s) => s.addTask);
  const updateStatus = useTasksStore((s) => s.updateStatus);

  const fetchEntityTasks = useCallback(async () => {
    try {
      const tasks = await listTasks({
        linked_entity_type: entity.type,
        linked_entity_id: entity.id,
      });
      setLinked(tasks);
      setFetchError(null);
    } catch (err) {
      console.error('Failed to fetch entity tasks:', err);
      setFetchError(extractApiError(err, 'Failed to load tasks'));
    }
  }, [entity.type, entity.id]);

  useEffect(() => {
    fetchEntityTasks();
  }, [fetchEntityTasks, refreshKey]);

  // Refetch when the detail drawer stops showing a task (#1718's class).
  //
  // `linked` above is a LOCAL array fetched from the entity-filtered endpoint.
  // Everything the drawer edits - assignees, watchers, title, priority, due,
  // subtasks - goes through `useTasksStore`, which writes to `useTasksStore.tasks`,
  // a DIFFERENT array. Nothing connects the two, so before this the card under
  // the drawer kept rendering the pre-edit row (stale avatar stack, stale title)
  // until a full page reload.
  //
  // Refetching on close - the pattern this file already uses for CreateTaskModal
  // below - is the smallest fix that covers EVERY drawer edit at once, including
  // a delete, rather than one field at a time. It also keeps the row set exactly
  // as it was: the same `listTasks({ linked_entity_* })` call, so only tasks
  // linked to THIS entity can ever appear. Deriving the rows from the store
  // instead would have to re-filter a list holding every task in the org, and
  // would show nothing at all when the store was never hydrated (this tab does
  // not call `fetchTasks`).
  //
  // Keyed off the previous id, not just "is it null", so switching straight from
  // one task to another - which never passes through null - refreshes too.
  const openTaskId = useTaskDetailStore((s) => s.openTaskId);
  const prevOpenTaskId = useRef<string | null>(null);
  useEffect(() => {
    if (prevOpenTaskId.current !== null && prevOpenTaskId.current !== openTaskId) {
      void fetchEntityTasks();
    }
    prevOpenTaskId.current = openTaskId;
  }, [openTaskId, fetchEntityTasks]);

  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<{ title: string }[]>([]);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [adding, setAdding] = useState(false);

  function handleGenerate() {
    const items = taskAI.suggestTasks(jobType ?? entity.label);
    setSuggestions(items);
    setChecked(items.map(() => false));
    setShowSuggestions(true);
  }

  function toggleChecked(i: number) {
    setChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  }

  async function handleAddGenerated() {
    const selected = suggestions.filter((_, i) => checked[i]);
    if (selected.length === 0) return;

    setAdding(true);
    const failed: string[] = [];
    for (const item of selected) {
      try {
        await addTask({
          title: item.title,
          description: '',
          status: 'TODO',
          priority: 'MEDIUM',
          // No assignee_ids: the server defaults a generated task to the actor,
          // which is the only value a caller without `assign` may produce anyway.
          due_at: null,
          linked_entity: { type: entity.type, id: entity.id },
        });
      } catch (err) {
        failed.push(item.title);
        console.error('Failed to create generated task:', item.title, err);
      }
    }
    setAdding(false);

    if (failed.length > 0) {
      toast({
        title: `${failed.length} task${failed.length === 1 ? '' : 's'} failed to create`,
        description: extractApiError(null, `Could not save: ${failed.join(', ')}`),
        variant: 'destructive',
      });
    }

    // Refetch entity tasks so newly generated tasks appear immediately.
    await fetchEntityTasks();

    setShowSuggestions(false);
    setSuggestions([]);
    setChecked([]);
  }

  function handleDismiss() {
    setShowSuggestions(false);
    setSuggestions([]);
    setChecked([]);
  }

  const selectedCount = checked.filter(Boolean).length;

  return (
    <div className="space-y-5 p-5">
      {/* AI suggestion panel — lavender (AI surface) */}
      {showSuggestions && (
        <SectionCard
          tone="ai"
          title="Suggested tasks"
          icon={<Sparkles className="h-4 w-4 text-ai-600" />}
          meta={
            <span className="text-xs text-text-secondary">for {jobType ?? entity.label}</span>
          }
        >
          <div className="space-y-2">
            {suggestions.map((item, i) => (
              // Not converted to FormField: label WRAPS the checkbox + its own text, not a
              // caption sitting above the control - outside FormField's shape.
              <label key={i} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked[i] ?? false}
                  onChange={() => toggleChecked(i)}
                  className="rounded border-border accent-ai-600"
                />
                <span>{item.title}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="solid" tone="business"
              onClick={handleAddGenerated}
              disabled={selectedCount === 0 || adding}
            >
              {adding ? 'Adding…' : `Add ${selectedCount} task${selectedCount === 1 ? '' : 's'}`}
            </Button>
            <Button size="sm" variant="outline" onClick={handleDismiss} disabled={adding}>
              Cancel
            </Button>
          </div>
        </SectionCard>
      )}

      {/* Fetch error */}
      {fetchError && <p className="py-2 text-sm text-danger">{fetchError}</p>}

      {/* Tasks */}
      <SectionCard
        title="Tasks"
        icon={<ClipboardList className="h-4 w-4 text-text-secondary" />}
        titleSuffix={<span className="ml-1 font-normal text-text-secondary">({linked.length})</span>}
        meta={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              + New task
            </Button>
            <Button size="sm" variant="solid" tone="ai" onClick={handleGenerate}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Generate tasks
            </Button>
          </div>
        }
        bodyClassName={linked.length === 0 ? undefined : 'space-y-5'}
      >
        {linked.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <ClipboardList className="mb-2 h-8 w-8 text-text-secondary/30" />
            <p className="text-sm text-text-secondary">
              No tasks yet for this {entity.type.toLowerCase()}.
            </p>
          </div>
        ) : (
          STATUS_GROUPS.map(({ key, label }) => {
            const group = linked.filter((t) => t.status === key);
            if (group.length === 0) return null;
            return (
              <div key={key}>
                <SectionLabel>
                  {label} ({group.length})
                </SectionLabel>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      hideLinkedEntity
                      onStatusChange={(status) => {
                        void updateStatus(t.id, status).then(() => fetchEntityTasks());
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </SectionCard>

      {/* Create task modal — refetch entity list on close so new tasks appear */}
      <CreateTaskModal
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) fetchEntityTasks();
        }}
        presetEntity={entity}
      />

      {/* Task detail drawer */}
      <TaskDetailDrawer />
    </div>
  );
}

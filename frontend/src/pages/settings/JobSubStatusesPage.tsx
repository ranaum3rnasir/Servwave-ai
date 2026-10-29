import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/data/status-badge';
import { JOB_STATUSES } from '@/lib/filters/registries/jobs';
import {
  useJobSubStatuses,
  useCreateJobSubStatus,
  useUpdateJobSubStatus,
  useDeleteJobSubStatus,
  useReorderJobSubStatuses,
  type JobSubStatus,
} from '@/lib/api/jobSubStatuses';

/**
 * SRVW-112 - Settings > Job Sub-Statuses. One section per FIXED JobStatus parent; the parents
 * themselves are not editable (that enum is a contract - the copilot advertises it and every
 * report buckets on it). Each row saves immediately through its own endpoint, so this page does
 * NOT register with the settings save bar the way PaymentsListsPage does.
 */
export default function JobSubStatusesPage() {
  const { data: subStatuses } = useJobSubStatuses();
  const rows = subStatuses ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Job Sub-Statuses</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Add your own labels under each job status - for example "Need To Order Supplies" under In
          Progress. A sub-status is cleared automatically when the job moves to another status.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {JOB_STATUSES.map((parent) => (
          <ParentSection
            key={parent}
            parent={parent}
            items={rows.filter((s) => s.parent === parent)}
          />
        ))}
      </div>
    </div>
  );
}

function ParentSection({ parent, items }: { parent: string; items: JobSubStatus[] }) {
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const createSubStatus = useCreateJobSubStatus();
  const reorderSubStatuses = useReorderJobSubStatuses();

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    createSubStatus.mutate({ parent, label });
    setDraft('');
  };

  // Same id-list reorder as LineItemsTable's resolveDragReorder, keyed by row id instead of by
  // the option string (these rows have ids and are renameable).
  const handleDrop = (srcId: string, targetId: string) => {
    const from = items.findIndex((s) => s.id === srcId);
    const to = items.findIndex((s) => s.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const ids = arrayMove(items.map((s) => s.id), from, to);
    reorderSubStatuses.mutate({ parent, ordered_ids: ids });
  };

  return (
    <Card className="space-y-3">
      <StatusBadge domain="job" status={parent} />

      <div className="space-y-2">
        {items.length > 0 ? (
          items.map((item) => (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => {
                setDragging(item.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== item.id) {
                  e.preventDefault();
                  setOver(item.id);
                }
              }}
              onDragLeave={() => setOver((c) => (c === item.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain') || dragging;
                if (src && src !== item.id) handleDrop(src, item.id);
                setDragging(null);
                setOver(null);
              }}
              className={`flex items-center gap-2 rounded-md ${dragging === item.id ? 'opacity-40' : ''} ${
                over === item.id ? 'ring-2 ring-inset ring-primary/50' : ''
              }`}
            >
              <GripVertical
                aria-hidden
                className="h-4 w-4 shrink-0 cursor-grab text-text-secondary active:cursor-grabbing"
              />
              <SubStatusRow item={item} />
            </div>
          ))
        ) : (
          <EmptyState density="flush" title="No sub-statuses under this status yet." />
        )}
      </div>

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="New sub-status (press Enter or Add)"
          className="flex-1"
          maxLength={60}
        />
        <Button type="button" size="sm" onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
    </Card>
  );
}

/** One renameable row. Local draft so a rename commits on blur/Enter, not on every keystroke. */
function SubStatusRow({ item }: { item: JobSubStatus }) {
  const [label, setLabel] = useState(item.label);
  const updateSubStatus = useUpdateJobSubStatus();
  const deleteSubStatus = useDeleteJobSubStatus();

  const commit = () => {
    const next = label.trim();
    if (!next || next === item.label) {
      setLabel(item.label);
      return;
    }
    updateSubStatus.mutate({ id: item.id, label: next });
  };

  return (
    <>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Rename ${item.label}`}
        className="flex-1"
        maxLength={60}
      />
      {/* Governed Button, not a raw <button>: component-api-guard.test.ts ratchets raw-tag
          occurrences downward only, so a new call site must use the primitive. */}
      <Button
        type="button"
        variant="ghost"
        tone="danger"
        size="3xs"
        aria-label={`Remove ${item.label}`}
        onClick={() => deleteSubStatus.mutate(item.id)}
        className="shrink-0"
      >
        <X />
      </Button>
    </>
  );
}

import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical, X } from 'lucide-react';

import { JOB_STATUSES } from '@/lib/filters/registries/jobs';
import { StatusBadge } from '@/components/data/status-badge';
import {
  useJobSubStatuses,
  useCreateJobSubStatus,
  useUpdateJobSubStatus,
  useDeleteJobSubStatus,
  useReorderJobSubStatuses,
  type JobSubStatus,
} from '@/lib/api/jobSubStatuses';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { cn } from '@/ui-kit/lib/utils';

import { Section } from './components/section';

/**
 * SRVW-112 - Settings > Job Sub-Statuses. One section per FIXED JobStatus parent; the parents
 * themselves are not editable (that enum is a contract - the copilot advertises it and every
 * report buckets on it). Each row saves immediately through its own endpoint, so this page does
 * NOT register with the settings save bar the way PaymentsListsPage does.
 *
 * `StatusBadge` is the app's, not the kit's: it resolves a domain+status pair
 * against the shared status registry, and the kit's Badge only takes a colour
 * variant. Substituting one would move the job-status colour mapping into this
 * call site. Recorded in the ledger.
 */
export default function JobSubStatusesPage() {
  const { data: subStatuses } = useJobSubStatuses();
  const rows = subStatuses ?? [];

  return (
    <div className="space-y-5">
      {/* No page-level heading: the settings bar above already reads "Job
          Sub-Statuses", and printing it a second time made the page open on the
          same four words twice. Every sibling settings page leads with its
          intro copy alone, and this one was the outlier. */}
      <p className="text-muted-foreground max-w-prose text-sm">
        Add your own labels under each job status - for example &ldquo;Need To Order
        Supplies&rdquo; under In Progress. A sub-status is cleared automatically when the job
        moves to another status.
      </p>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {JOB_STATUSES.map((parent) => (
          <ParentSection key={parent} parent={parent} items={rows.filter((s) => s.parent === parent)} />
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
    // The badge goes in Section's TITLE slot, not into the body. Section's body
    // is a flex COLUMN, whose default cross-axis alignment is stretch, so a
    // badge dropped in as a child was pulled to the full width of the card - a
    // status pill rendered as a 460px bar. The title slot also gives each card
    // the heading it never had.
    <Section
      title={<StatusBadge domain="job" status={parent} />}
      action={
        items.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">{items.length}</span>
        ) : undefined
      }
      className="h-full"
    >
      <div className="space-y-1">
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
              className={cn(
                'group/row -mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-0.5',
                'transition-colors duration-150',
                dragging === item.id && 'opacity-40',
                // A drop target is drawn with a ring rather than a fill: the
                // row is mostly occupied by an input that has a fill of its
                // own, so a tint behind it barely reads.
                over === item.id ? 'ring-brand/50 bg-selected ring-2' : 'hover:bg-muted/60',
              )}
            >
              {/* The handle is always present, and only gains contrast on
                  hover. Revealing it from nothing on hover would leave the row
                  with no visible affordance at rest and shift the input 22px
                  sideways the moment the pointer arrived. */}
              <GripVertical
                aria-hidden
                className={cn(
                  'size-4 shrink-0 cursor-grab transition-colors duration-150 active:cursor-grabbing',
                  'text-border group-hover/row:text-muted-foreground',
                )}
              />
              <SubStatusRow item={item} />
            </div>
          ))
        ) : (
          // Not `EmptyState`: that primitive is a centred block sized for a
          // whole page or panel, and inside a 240px settings card it dwarfed
          // the two rows it was standing in for.
          <p className="text-muted-foreground px-1.5 py-1.5 text-xs">
            No sub-statuses yet.
          </p>
        )}
      </div>

      <div className="flex gap-2 border-t pt-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          aria-label={`New sub-status under ${parent}`}
          placeholder="New sub-status (press Enter or Add)"
          className="flex-1"
          maxLength={60}
        />
        <Button type="button" size="sm" onClick={add} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
    </Section>
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
      {/* A rename field, not a form control in a form - so it is drawn flat and
          only takes a visible border on hover/focus. Twelve bordered inputs
          stacked in two cards is a wall of boxes; the text is the content, the
          box is the affordance and it can wait until it is wanted. */}
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
        className="h-8 flex-1 border-transparent bg-transparent hover:border-border focus:bg-kit-card"
        maxLength={60}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove ${item.label}`}
        onClick={() => deleteSubStatus.mutate(item.id)}
        className="text-muted-foreground hover:text-destructive shrink-0"
      >
        <X />
      </Button>
    </>
  );
}

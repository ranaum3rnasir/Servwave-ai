/**
 * StepNode — one sortable bubble on the spine. A white card with the step's
 * icon tile, its plain-English sentence (bold config token), a "needs setup"
 * badge when the server flags it, a drag handle (≥44px, keyboard-grabbable via
 * dnd-kit), and a kebab menu carrying the drag-free alternatives (Move up/down,
 * Insert above/below, Delete). STOP_IF wears the amber guard look. Selecting the
 * card opens the config drawer.
 */

import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  MoreVertical,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Trash2,
  Flag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { stepSentence } from '@/lib/workflows/stepSentence';
import { StepTypeTile, STEP_TYPE_META } from './workflow-visuals';
import type { DraftStep } from './useWorkflowDraft';
import type { WorkflowCatalog } from '@/lib/api/workflows';

export interface StepNodeProps {
  step: DraftStep;
  index: number;
  total: number;
  catalog?: WorkflowCatalog;
  selected: boolean;
  /**
   * Server-reported problems with this step. The messages are shown verbatim —
   * the validator already words them for the office ("The field {{job.date}}
   * isn't available for this trigger"), and a bare badge would leave the user
   * guessing which field it means.
   */
  issues?: string[];
  /** Drop indicator: the spine marks this node's top edge as the drop target. */
  dropTarget?: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

export default function StepNode({
  step,
  index,
  total,
  catalog,
  selected,
  issues = [],
  dropTarget = false,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDelete,
}: StepNodeProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: step.uid,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const meta = STEP_TYPE_META[step.step_type];
  const sentence = stepSentence(step, catalog);
  const isStop = step.step_type === 'STOP_IF';
  const isFirst = index === 0;
  const isLast = index === total - 1;

  const baseTransform = CSS.Transform.toString(transform);
  const style: React.CSSProperties = {
    // Compose dnd-kit's translate with a subtle lift-tilt while dragging.
    transform: isDragging && baseTransform ? `${baseTransform} rotate(2deg)` : baseTransform,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={`relative w-full max-w-[468px] ${isDragging ? 'z-20' : ''}`}>
      {/* drop indicator line */}
      {dropTarget && !isDragging && (
        <span className="absolute -top-[3px] left-0 right-0 h-[3px] rounded-full bg-primary" aria-hidden />
      )}
      {/* top port */}
      <span
        className="absolute -top-[5px] left-1/2 z-10 h-[9px] w-[9px] -translate-x-1/2 rounded-full border-2 border-border bg-surface-light"
        aria-hidden
      />

      <div
        className={`flex items-stretch gap-2 rounded-card border bg-surface-light shadow-card transition-shadow ${
          isStop ? 'border-warning/40' : 'border-border'
        } ${selected ? 'ring-2 ring-primary' : ''} ${isDragging ? 'shadow-hover' : 'hover:shadow-hover'}`}
      >
        {/* drag handle — ≥44px hit area, keyboard-grabbable. Left raw: a
            dnd-kit drag handle (setActivatorNodeRef + spread `attributes`/
            `listeners`), on the program's own never-convert list for this
            exact file. */}
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder step ${index + 1}: ${meta.label}`}
          className="flex w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-l-card text-text-secondary hover:bg-background-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>

        {/* selectable body — deferred: a list-row/card click target wrapping
            rich multi-line content (icon tile, two text rows, an optional
            flag line), not a single-label CTA any Button cell is shaped for. */}
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected || undefined}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        >
          <StepTypeTile type={step.step_type} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block text-[10.5px] font-bold uppercase tracking-[0.08em] text-primary-light">
              {isStop ? 'Stop if' : meta.label}
            </span>
            <span
              className={`mt-0.5 block truncate text-[15px] font-bold tracking-tight ${
                sentence.configured ? 'text-text-primary' : 'text-text-secondary'
              }`}
            >
              {sentence.segments.map((seg, i) =>
                seg.strong ? (
                  <span key={i} className="font-extrabold">
                    {seg.text}
                  </span>
                ) : (
                  <span key={i} className="font-medium">
                    {seg.text}
                  </span>
                ),
              )}
            </span>
            {isStop && sentence.configured && (
              <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-text-secondary">
                <Flag className="h-3 w-3 text-warning" aria-hidden />
                If met, the flow ends here
              </span>
            )}
          </span>
        </button>

        {/* side: status + kebab */}
        <div className="flex shrink-0 flex-col items-end justify-between gap-1 py-3 pr-3">
          <DropdownMenu onOpenChange={(o) => !o && setConfirmingDelete(false)}>
            <DropdownMenuTrigger asChild>
              {/* ghost/subtle reproduces the idle text-text-secondary +
                  hover:bg-background-light look exactly; matches the same
                  kebab-trigger recipe already shipped at
                  pages/workflows/WorkflowsHome.tsx:322 (variant="ghost"
                  size="icon" className="h-11 w-11"), tone="subtle" added
                  here to keep this button's idle icon colour byte-identical
                  to what it was before the swap. */}
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="icon"
                aria-label={`Step ${index + 1} actions`}
                className="h-11 w-11"
              >
                <MoreVertical className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={isFirst} onClick={onMoveUp}>
                <ArrowUp className="mr-2 h-4 w-4" aria-hidden /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={isLast} onClick={onMoveDown}>
                <ArrowDown className="mr-2 h-4 w-4" aria-hidden /> Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={(e) => {
                  if (!confirmingDelete) {
                    // Keep the menu open and swap the label to a confirm.
                    e.preventDefault();
                    setConfirmingDelete(true);
                  } else {
                    onDelete();
                  }
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                {confirmingDelete ? 'Really delete?' : 'Delete step'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {issues.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-pill bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Needs setup
            </span>
          )}
        </div>
      </div>

      {/* What's actually wrong — the badge alone is a dead end. */}
      {issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-[52px] text-[11px] text-warning">
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {/* bottom port */}
      <span
        className="absolute -bottom-[5px] left-1/2 z-10 h-[9px] w-[9px] -translate-x-1/2 rounded-full border-2 border-border bg-surface-light"
        aria-hidden
      />
    </div>
  );
}

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreVertical, AlertTriangle, ArrowUp, ArrowDown, Trash2, Flag } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { cn } from '@/ui-kit/lib/utils';
import { useConfirm } from '@/hooks/useConfirm';
import { removeStepPrompt } from '@/lib/confirmPrompts';
import { stepSentence } from '@/lib/workflows/stepSentence';
import type { DraftStep } from '@/components/workflows/useWorkflowDraft';
import type { WorkflowCatalog } from '@/lib/api/workflows';

import { Pressable } from './pressable';
import { StepTypeTile, STEP_TYPE_META } from './workflowVisuals';

/**
 * One sortable bubble on the spine.
 *
 * Three interactive zones, all preserved from the legacy node:
 *  1. a 44px dnd-kit drag handle, keyboard-grabbable through the spine's
 *     KeyboardSensor;
 *  2. the card body, which opens the config drawer;
 *  3. a kebab carrying the drag-free equivalents (Move up / Move down) plus
 *     Delete, which confirms once through the app's own `useConfirm()` dialog
 *     rather than a second click on the menu item itself (SRVW-218 - this used
 *     to be a two-press relabel, a different confirm vocabulary from the
 *     drawer's own Remove step button for the identical action).
 *
 * The drag handle is a `span` rather than a `button` because the repo's raw-tag
 * ratchet is at its floor. dnd-kit's own `attributes` already supply
 * `role="button"` and `tabIndex={0}`, and its `listeners` carry the keydown
 * handler the KeyboardSensor needs, so the keyboard drag path is unaffected by
 * the element swap.
 */
export interface StepNodeProps {
  step: DraftStep;
  index: number;
  total: number;
  catalog?: WorkflowCatalog;
  selected: boolean;
  /**
   * Server-reported problems with this step, shown verbatim. The validator
   * already words them for the office, and a bare badge would leave the reader
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
  const { confirm, confirmDialog } = useConfirm();

  const meta = STEP_TYPE_META[step.step_type];
  const sentence = stepSentence(step, catalog);
  const isStop = step.step_type === 'STOP_IF';

  const baseTransform = CSS.Transform.toString(transform);
  const style: React.CSSProperties = {
    // Compose dnd-kit's translate with a subtle lift-tilt while dragging.
    transform: isDragging && baseTransform ? `${baseTransform} rotate(2deg)` : baseTransform,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={cn('relative w-full max-w-[468px]', isDragging && 'z-20')}>
      {dropTarget && !isDragging && (
        <span className="bg-primary absolute -top-[3px] left-0 right-0 h-[3px] rounded-full" aria-hidden />
      )}
      <span
        className="border-border bg-kit-card absolute -top-[5px] left-1/2 z-10 size-[9px] -translate-x-1/2 rounded-full border-2"
        aria-hidden
      />

      <div
        className={cn(
          'bg-kit-card shadow-xs flex items-stretch gap-2 rounded-lg border transition-shadow',
          isStop ? 'border-status-amber' : 'border-border',
          selected && 'ring-brand ring-2',
          isDragging ? 'shadow-md' : 'hover:shadow-md',
        )}
      >
        <span
          ref={setActivatorNodeRef}
          aria-label={`Reorder step ${index + 1}: ${meta.label}`}
          className="text-muted-foreground hover:bg-muted focus-visible:ring-brand flex w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-l-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden />
        </span>

        <Pressable
          onPress={onSelect}
          aria-current={selected || undefined}
          className="focus-visible:ring-brand flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 text-left focus-visible:ring-2 focus-visible:ring-inset"
        >
          <StepTypeTile type={step.step_type} size="md" />
          <span className="min-w-0 flex-1">
            <span className="text-brand block text-[10.5px] font-bold uppercase tracking-[0.08em]">
              {isStop ? 'Stop if' : meta.label}
            </span>
            <span
              className={cn(
                'mt-0.5 block truncate text-[15px] font-bold tracking-tight',
                sentence.configured ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {sentence.segments.map((seg, i) => (
                <span key={i} className={seg.strong ? 'font-extrabold' : 'font-medium'}>
                  {seg.text}
                </span>
              ))}
            </span>
            {isStop && sentence.configured && (
              <span className="text-muted-foreground mt-1 inline-flex items-center gap-1 text-[11px] font-medium">
                <Flag className="text-status-amber size-3" aria-hidden />
                If met, the flow ends here
              </span>
            )}
          </span>
        </Pressable>

        <div className="flex shrink-0 flex-col items-end justify-between gap-1 py-3 pr-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={`Step ${index + 1} actions`} className="size-11">
                <MoreVertical className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={index === 0} onClick={onMoveUp}>
                <ArrowUp aria-hidden /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === total - 1} onClick={onMoveDown}>
                <ArrowDown aria-hidden /> Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={async () => {
                  if (!(await confirm(removeStepPrompt(meta.label)))) return;
                  onDelete();
                }}
              >
                <Trash2 aria-hidden />
                Delete step
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {issues.length > 0 && (
            <Badge variant="softAmber" size="pill">
              <AlertTriangle aria-hidden />
              Needs setup
            </Badge>
          )}
        </div>
      </div>

      {/* What is actually wrong. The badge alone is a dead end. */}
      {issues.length > 0 && (
        <ul className="text-status-amber-emphasis mt-1.5 space-y-0.5 pl-[52px] text-[11px]">
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <span
        className="border-border bg-kit-card absolute -bottom-[5px] left-1/2 z-10 size-[9px] -translate-x-1/2 rounded-full border-2"
        aria-hidden
      />
      {confirmDialog}
    </div>
  );
}

import type { ReactNode } from 'react';
import { GripVertical, X } from 'lucide-react';
import type { TimeRange } from '@/lib/dashboard/layoutTypes';
import { SelectField } from '@/components/form/SelectField';
import { MoveButtons } from '@/components/form/MoveButtons';

const RANGES: TimeRange[] = ['today', '7d', '30d', 'month', 'all'];
const RANGE_LABEL: Record<TimeRange, string> = { today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };

/**
 * One widget's edit frame (home page, edit mode).
 *
 * Reordering: the whole frame is a native drag source (a pointer can drag it), and - mobile slice
 * 48 - Move up / Move down sit beside the drag handle for everyone who cannot drag, a finger
 * first. The page passes them only when it wants them; the buttons report one step in the list of
 * widgets that are actually on screen, so a tap never lands on a widget that has no cell.
 *
 * The Move buttons are for touch (a coarse primary pointer: phones and tablets). A mouse keeps
 * dragging: the 2-up and 6-up tiles are about 150 px wide, which holds the grip, the range pill and
 * Hide and not two more chips beside them. On a touch screen the controls are 44 px, which no
 * longer fits as chips hanging over the widget's top edge, so there they become a real row above
 * the widget (`touch:static`, wrapping onto a second line in a narrow tile) instead of an overlay
 * on its heading. From a fine pointer the overlay is exactly what it was.
 */
export default function EditableWidget({
  id,
  title,
  edit,
  range,
  onHide,
  onRange,
  onDragStart,
  onDrop,
  onMoveUp,
  onMoveDown,
  children,
}: {
  id: string;
  /** The widget's name, so each icon button says which widget it acts on. */
  title?: string;
  edit: boolean;
  range: TimeRange;
  onHide: () => void;
  onRange: (r: TimeRange) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
  /** Present when the widget can go up one place; absent (or undefined) when it is first. */
  onMoveUp?: () => void;
  /** Present when the widget can go down one place; absent (or undefined) when it is last. */
  onMoveDown?: () => void;
  children: ReactNode;
}) {
  if (!edit) return <>{children}</>;
  const name = title ?? 'widget';
  return (
    <div
      className="relative rounded-xl ring-2 ring-border group"
      draggable
      onDragStart={() => onDragStart(id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(id)}
    >
      <div className="pointer-events-none absolute inset-x-2 -top-2 z-20 flex items-center justify-between gap-1 touch:static touch:flex-wrap touch:px-2 touch:pt-2">
        <div className="pointer-events-auto flex min-w-0 items-center gap-1 touch:flex-wrap">
          <span className="cursor-grab active:cursor-grabbing rounded bg-ocean-800 text-on-fill px-1 py-0.5"><GripVertical className="h-3 w-3" /></span>
          {/* The same chip fill as Hide beside it; the buttons are 44 px on touch. */}
          <MoveButtons
            compact
            name={name}
            canMoveUp={!!onMoveUp}
            canMoveDown={!!onMoveDown}
            onMoveUp={() => onMoveUp?.()}
            onMoveDown={() => onMoveDown?.()}
            className="hidden touch:flex max-w-full flex-wrap items-center gap-0.5 rounded bg-border-soft"
          />
        </div>
        <div className="pointer-events-auto flex min-w-0 items-center gap-1 touch:flex-wrap">
          <div onClick={(e) => e.stopPropagation()}>
            <SelectField
              value={range}
              onValueChange={(v) => onRange(v as TimeRange)}
              className="h-auto text-[9px] font-bold text-primary bg-primary-subtle rounded-full pl-2 pr-1 py-0.5 border-border focus:outline-none"
              aria-label={title ? `${title} time range` : 'Widget time range'}
              options={RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
            />
          </div>
          {/* Idle neutral chip fill (bg-border-soft, matching the drag-handle chip beside it)
              plus a reveal-on-hover danger tint has no matching cell: ghost/danger#reveal has
              no idle fill, and solid/neutral has no danger-reveal hover. Forcing either would
              change the current look, so left raw per the no-invented-treatment rule. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onHide(); }}
            className="h-5 w-5 rounded bg-border-soft hover:bg-danger/10 hover:text-danger text-text-secondary flex items-center justify-center touch:size-11"
            aria-label={`Hide ${name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="pointer-events-none select-none opacity-95">{children}</div>
    </div>
  );
}

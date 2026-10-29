import { ExternalLink, PenLine, XCircle } from 'lucide-react';
import type { BoardEvent } from './scheduleModel';

interface ScheduleContextMenuProps {
  event: BoardEvent;
  x: number;
  y: number;
  onClose: () => void;
  onOpenDetails: (event: BoardEvent) => void;
  /** TG12 — opens the event editor (the per-person crew / reassign path). */
  onEdit?: (event: BoardEvent) => void;
  onCancel: (event: BoardEvent) => void;
  /** D9 read-only roles (TG13) — only the open-details row renders; edit/cancel hidden. */
  readOnly?: boolean;
}

const safeX = (x: number, w: number) => Math.min(x, window.innerWidth - w - 8);
const safeY = (y: number, h: number) => Math.min(y, window.innerHeight - h - 8);

// Menu height: up to 3 rows (~32px each) + separator (~1px) + padding (~8px) ≈ 105px
const MENU_HEIGHT = 112;
const MENU_WIDTH = 208;

export function ContextMenu({ event, x, y, onClose, onOpenDetails, onEdit, onCancel, readOnly = false }: ScheduleContextMenuProps) {
  const mx = safeX(x, MENU_WIDTH);
  const my = safeY(y, MENU_HEIGHT);

  const handleOpenDetails = () => {
    onOpenDetails(event);
    onClose();
  };

  const handleEdit = () => {
    onEdit?.(event);
    onClose();
  };

  const handleCancel = () => {
    onCancel(event);
    onClose();
  };

  return (
    <div
      className="fixed z-50 w-52 bg-surface-light border border-border rounded-xl shadow-hover py-1 overflow-hidden schedule-popup-enter"
      style={{ left: mx, top: my }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Raw by design: this whole file is a custom right-click context menu -
          every row here is a dropdown/context-menu item, not a Button. */}
      <button
        onClick={handleOpenDetails}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-primary hover:bg-background-light transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5 text-text-secondary" />
        {event.type === 'job' ? 'Open Job Details' : 'Open Lead'}
      </button>

      {/* D9 — read-only roles keep details navigation only; mutating affordances hide. */}
      {!readOnly && (
        <>
          {onEdit && (
            <button
              onClick={handleEdit}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-primary hover:bg-background-light transition-colors"
            >
              <PenLine className="h-3.5 w-3.5 text-text-secondary" />
              Edit crew &amp; schedule
            </button>
          )}

          <div className="my-1 border-t border-border" />

          <button
            onClick={handleCancel}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-secondary hover:bg-danger-surface transition-colors"
          >
            <XCircle className="h-3.5 w-3.5" />
            {event.type === 'job' ? 'Cancel Job' : 'Cancel Walkthrough'}
          </button>
        </>
      )}
    </div>
  );
}

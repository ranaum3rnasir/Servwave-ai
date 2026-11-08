import { ExternalLink, PenLine, XCircle } from 'lucide-react';

import { Separator } from '@/ui-kit/components/ui/separator';

import type { BoardEvent } from '@/components/schedule/scheduleModel';

import { MenuItem, MenuSurface } from './menuSurface';

interface ScheduleContextMenuProps {
  event: BoardEvent;
  x: number;
  y: number;
  onClose: () => void;
  onOpenDetails: (event: BoardEvent) => void;
  /** TG12 - opens the event editor (the per-person crew / reassign path). */
  onEdit?: (event: BoardEvent) => void;
  onCancel: (event: BoardEvent) => void;
  /** D9 read-only roles (TG13) - only the open-details row renders; edit/cancel hidden. */
  readOnly?: boolean;
}

const safeX = (x: number, w: number) => Math.min(x, window.innerWidth - w - 8);
const safeY = (y: number, h: number) => Math.min(y, window.innerHeight - h - 8);

// Menu height: up to 3 rows (~32px each) + separator (~1px) + padding (~8px).
// These two numbers are the clamp the e2e suite's position assertions ride on -
// do not "tidy" them to match the rendered height of the kit rows.
const MENU_HEIGHT = 112;
const MENU_WIDTH = 208;

/**
 * Right-click menu for an event on the standard calendar.
 *
 * Kept hand-positioned rather than handed to the kit's DropdownMenu: it opens at
 * raw viewport coordinates from a `contextmenu` event with no trigger element to
 * anchor to, and the PAGE owns its dismissal (a capturing, 100ms-delayed
 * `mousedown` listener that skips `[class*="fixed"][class*="z-["]`, plus the
 * global Escape handler). Radix would take both of those over. Only the surface
 * and the rows moved onto the kit - see `menuSurface.tsx`.
 *
 * `schedule-popup-enter` is the shared entry animation from the legacy
 * stylesheet, which this module imports rather than forks.
 */
export function ContextMenu({
  event, x, y, onClose, onOpenDetails, onEdit, onCancel, readOnly = false,
}: ScheduleContextMenuProps) {
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
    <MenuSurface
      className="w-52 schedule-popup-enter"
      style={{ left: mx, top: my }}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuItem onClick={handleOpenDetails}>
        <ExternalLink />
        {event.type === 'job' ? 'Open Job Details' : 'Open Lead'}
      </MenuItem>

      {/* D9 - read-only roles keep details navigation only; mutating affordances hide. */}
      {!readOnly && (
        <>
          {onEdit && (
            <MenuItem onClick={handleEdit}>
              <PenLine />
              Edit crew &amp; schedule
            </MenuItem>
          )}

          <Separator className="my-1" />

          <MenuItem danger onClick={handleCancel}>
            <XCircle />
            {event.type === 'job' ? 'Cancel Job' : 'Cancel Walkthrough'}
          </MenuItem>
        </>
      )}
    </MenuSurface>
  );
}

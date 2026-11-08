import * as React from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

export interface ScheduleConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  isLoading?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Detail block between the header and the footer. */
  children?: React.ReactNode;
  /**
   * Extra classes for the dialog surface. Exists for ONE case: a confirm raised over a
   * floating surface (z-100 popover) rather than over the page. Radix copies the popper
   * content's computed z-index onto its wrapper at MOUNT, so the popover underneath cannot
   * be lowered after the fact - the confirm has to come up instead.
   */
  contentClassName?: string;
}

/**
 * The plan-mode confirmations (one ghost, and all visible ghosts) on kit Dialog
 * primitives.
 *
 * The kit ships `ui/confirmDialog`, and it is NOT enough for these two: it
 * hardcodes an `AlertTriangle`, takes no icon, and has no slot for body content
 * between the description and the footer. Both of these dialogs exist precisely
 * to show that body - the crew, customer and location that are about to be
 * committed, and the scrollable list of drafts in view - so a confirmation that
 * dropped it would be asking the user to confirm something the dialog no longer
 * names. It also spells its in-flight prop `isPending`, where the schedule's two
 * call sites carry `confirmingGhostIds`.
 *
 * So this is the kit's own Dialog parts assembled with an icon slot and a body
 * slot. Filed as a `kit API` gap rather than a missing component: the right
 * component exists, its surface is one prop short.
 */
export function ScheduleConfirmDialog({
  open, onOpenChange, icon, title, description,
  confirmLabel, cancelLabel = 'Cancel', isLoading = false, onConfirm, children, contentClassName,
}: ScheduleConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      // An in-flight confirm must not be abandoned by Escape or a backdrop click -
      // the POSTs are already going out one ghost at a time.
      onOpenChange={(next) => { if (!isLoading) onOpenChange(next); }}
    >
      <DialogContent showClose={!isLoading} className={contentClassName}>
        <DialogHeader>
          <DialogIcon tone="brand">{icon}</DialogIcon>
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </DialogHeader>
        {children && <DialogBody>{children}</DialogBody>}
        <DialogFooter>
          <Button variant="ghost" disabled={isLoading} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button isLoading={isLoading} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

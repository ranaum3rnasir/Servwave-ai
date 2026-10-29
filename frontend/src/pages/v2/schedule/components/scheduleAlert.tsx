import * as React from 'react';

import {
  DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { useReturnFocus } from '@/ui-kit/hooks/useReturnFocus';

export interface ScheduleAlertContentProps {
  tone: 'brand' | 'danger' | 'warning';
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  /** Optional detail between the header and the buttons (the conflict rows). */
  children?: React.ReactNode;
  /** The footer buttons, least destructive first: it is the one that takes focus on open. */
  actions: React.ReactNode;
}

/**
 * The surface of the schedule's three confirmations (the 409 conflict, "Nobody is assigned" and
 * "Move to Unscheduled?"), on the kit Dialog. Render it inside the kit `<Dialog open>`.
 *
 * Mobile slice 16 (A11Y-04) moved them here from hand-rolled `fixed inset-0` divs. Those had no
 * focus trap: focus stayed on the card or the dialog behind them and Tab walked the board. On the
 * kit Dialog each one moves focus in (to its first button, the safe answer), keeps Tab inside,
 * answers Escape, makes the page behind inert, and gives focus back when it closes.
 *
 * WHY THE OLD REASON FOR HAND-ROLLING THEM NO LONGER HOLDS. Each confirm replaces another Radix
 * dialog on the same tick (the editor or the drop modal closes as it opens, and reopens on
 * Back/Cancel), and the fear was two Radix focus locks fighting through the closing dialog's
 * 200 ms exit animation. Radix keeps ONE focus-scope stack: the newly mounted scope pauses the
 * closing one, and when the closing one unmounts and tries to restore focus to its own opener,
 * the active scope pulls focus straight back. The fight that did happen was the other way round:
 * a plain div over a still-trapped Radix dialog. The page's gating (only one of the pair open at
 * a time) is kept, so a confirm never sits over a live dialog. The swaps are tested on the routed
 * board in `__tests__/confirmFocus.test.tsx`.
 *
 * An alert is answered, not brushed away: a tap outside does nothing (as before), Escape is the
 * same as the first button.
 */
export function ScheduleAlertContent({ tone, icon, title, description, children, actions }: ScheduleAlertContentProps) {
  // Radix returns focus only to a Dialog.Trigger, and these open from state. See the hook.
  const returnFocus = useReturnFocus();
  return (
    <DialogContent
      intent="choice"
      role="alertdialog"
      showClose={false}
      className="max-w-md"
      onPointerDownOutside={(e) => e.preventDefault()}
      onCloseAutoFocus={returnFocus}
    >
      <DialogHeader>
        <DialogIcon tone={tone}>{icon}</DialogIcon>
        <div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
      </DialogHeader>
      {children && <DialogBody>{children}</DialogBody>}
      <DialogFooter>{actions}</DialogFooter>
    </DialogContent>
  );
}

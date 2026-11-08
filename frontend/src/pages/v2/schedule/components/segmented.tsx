import * as React from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The schedule header's segmented toggles - Standard/Member and
 * Day/Week/Month - expressed once. (A third, Full day/Morning/Afternoon, used
 * this too until the board reclaimed that row.)
 *
 * The kit ships no toggle-group primitive (it is item 13 on the roll-up's BUILD
 * list and no module had reached it before this one), and the legacy page
 * carried all six cells as raw button elements with a comment deferring them
 * under the program's "non-Button-shape carve-out". That carve-out was about the
 * OLD Button always shipping `rounded-button` (14px); the kit's Button is
 * `rounded-md` at every size, so the shape objection is gone and each cell is a
 * real Button here. That matters beyond tidiness: the raw-tag ratchet is at its
 * floor, so a new file may not add a raw button element at all.
 *
 * `aria-pressed` is added - the legacy cells had no pressed state for assistive
 * tech, so a screen reader heard three identical unlabelled controls with no way
 * to tell which view was active. Naming the state of a control is not a
 * behaviour change.
 */
export function SegmentedGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="group"
      className={cn('flex items-center gap-0.5 rounded-lg border bg-muted p-0.5', className)}
      {...props}
    />
  );
}

export interface SegmentProps extends React.ComponentProps<typeof Button> {
  /** Is this the selected cell? Drives the raised treatment and `aria-pressed`. */
  active: boolean;
}

export function Segment({ active, className, ...props }: SegmentProps) {
  return (
    <Button
      type="button"
      // The raised cell is the kit's `outline` (card fill + hairline) sitting on
      // the group's muted track; the rest are `ghost` so only one cell reads as
      // a surface at a time.
      variant={active ? 'outline' : 'ghost'}
      size="sm"
      aria-pressed={active}
      className={cn('h-7 gap-1.5 px-2.5 text-[12px]', className)}
      {...props}
    />
  );
}

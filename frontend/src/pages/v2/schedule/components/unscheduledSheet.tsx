import type { ReactNode } from 'react';

import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';

/**
 * Mobile slice 70 - the unscheduled-jobs bucket and the schedule search, as a sheet.
 *
 * Below lg there is no side panel (it is not mounted at all, which is what keeps the page's DOM
 * small), so this is how work waiting to be scheduled is reached. `intent="content"` makes it a
 * full-screen reader on a phone and a phone held sideways, and the usual side sheet on a tablet.
 *
 * The page hands over what goes inside: the search box (it owns the jump-to-date handler) and the
 * bucket stack (it owns the cards' tap handler). Nothing here decides what a tap does.
 */
export function UnscheduledSheet({
  open,
  onOpenChange,
  search,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule search field, rendered above the list so its results are not clipped by it. */
  search: ReactNode;
  /** The bucket stack: it is the scroller. */
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" intent="content" aria-describedby={undefined} data-slot="unscheduled-sheet">
        <SheetHeader>
          <SheetTitle>Unscheduled jobs</SheetTitle>
        </SheetHeader>
        <div className="shrink-0 border-b p-2.5">{search}</div>
        {children}
      </SheetContent>
    </Sheet>
  );
}

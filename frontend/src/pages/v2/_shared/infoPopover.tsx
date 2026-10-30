import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';

/**
 * A small "?" that opens a short note on click, tap or keyboard activation (never on hover, so a
 * phone can read it too). For the one sentence a user must know that the label does not already
 * say; anything needed to finish the task stays on screen instead.
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`More about ${label}`} className="size-6 min-w-6 shrink-0 max-sm:size-11 touch:size-11">
          <CircleHelp />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="text-sm">{children}</PopoverContent>
    </Popover>
  );
}

import * as React from 'react';

import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * A thin wrapper over the ui-kit's auto-growing `Textarea` (`[field-sizing:content]` — the
 * only auto-grow primitive in the repo, see that file's header comment) that adds a growth cap
 * so the box does not run away unbounded on a long description: it grows with the content up
 * to `maxHeightClassName` (default `max-h-[40vh] overflow-y-auto`), then scrolls internally.
 *
 * `min-h-16` (64px) pins the resting height for an empty field to what the four call sites
 * this replaces already rendered (#2008) — the ui-kit primitive's own `min-h-19` (76px) would
 * otherwise make an empty description jump taller. `min-h-*` is only a floor and does not
 * defeat `field-sizing: content`; never widen this to a fixed `h-*`, which would.
 */
export interface AutoGrowTextareaProps extends React.ComponentProps<'textarea'> {
  /** Overrides the default growth-cap class. */
  maxHeightClassName?: string;
}

function AutoGrowTextarea({ className, maxHeightClassName, ...props }: AutoGrowTextareaProps) {
  return (
    <Textarea
      className={cn(maxHeightClassName ?? 'max-h-[40vh] overflow-y-auto', 'min-h-16', className)}
      {...props}
    />
  );
}

export { AutoGrowTextarea };

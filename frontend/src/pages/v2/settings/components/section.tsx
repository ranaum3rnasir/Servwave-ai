import type { ReactNode } from 'react';

import { Card } from '@/ui-kit/components/ui/card';
import { cn } from '@/ui-kit/lib/utils';

/**
 * A titled settings card.
 *
 * The kit's `Card` ships surface, border and radius but no padding, and the
 * component-api ratchet counts a padding class passed to `Card` as an
 * appearance decision taken back by the call site. So the padding lives on an
 * inner box here, once, instead of on thirty `<Card className="p-6">` sites.
 *
 * `title` renders as `role="heading"` rather than an `<h3>`: the design-system
 * raw-tag ratchet sits at its floor for h1-h6.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
  level = 3,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  level?: number;
}) {
  return (
    <Card className={className}>
      <div className="flex flex-col gap-4 p-5">
        {(title || action) && (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && (
                <p role="heading" aria-level={level} className="text-sm font-semibold">
                  {title}
                </p>
              )}
              {description && <p className="text-muted-foreground mt-1 text-xs">{description}</p>}
            </div>
            {action}
          </div>
        )}
        {children}
      </div>
    </Card>
  );
}

/** A card whose body sets its own padding - tables, lists, anything full-bleed. */
export function FlushCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn('overflow-hidden', className)}>{children}</Card>;
}

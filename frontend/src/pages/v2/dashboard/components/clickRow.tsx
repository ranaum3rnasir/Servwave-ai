import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

/**
 * A tile's row, stage or card: a kit Button when the server sent an address for it, and the same box as plain content
 * when it did not (PRD 9, "Where a tile links"). A row with no address is drawn, never greyed, and nothing about it
 * invites a click.
 */
export function ClickRow({
  onClick,
  variant = 'ghost',
  className,
  children,
}: {
  onClick: (() => void) | undefined;
  variant?: 'ghost' | null;
  className?: string;
  children: ReactNode;
}) {
  if (!onClick) return <div className={cn('flex items-center', className)}>{children}</div>;
  return (
    <Button type="button" variant={variant} size={null} onClick={onClick} className={className}>
      {children}
    </Button>
  );
}

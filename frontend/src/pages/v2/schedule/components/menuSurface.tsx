import * as React from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The page's two hand-positioned context menus - right-click a bucket card, and
 * right-click a plan-mode ghost - given the kit's popover surface treatment
 * without changing how they are positioned or dismissed.
 *
 * Deliberately NOT the kit's `DropdownMenu`. That primitive is anchored to a
 * trigger element; both of these open at raw viewport coordinates captured from
 * a `contextmenu` event, and both are dismissed by the page's own capturing,
 * 100ms-delayed `mousedown` listener - which skips targets matching
 * `[class*="fixed"][class*="z-["]`. Handing either menu to Radix would replace
 * that dismissal contract with Radix's own, and the page's Escape handler and
 * outside-click listener are written around it. So the positioning stays; only
 * the paint moves onto kit tokens and the rows become real kit Buttons.
 *
 * `data-schedule-overlay` is load-bearing, not decoration: it is what the
 * page's outside-click listener matches on to decide a click landed INSIDE an
 * overlay rather than on the board behind it. Keep it on the root. It replaced
 * a match on the `fixed` + `z-[...]` CLASS NAMES, which broke the moment those
 * utilities were renamed to a named layer.
 */
export function MenuSurface({ className, style, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-schedule-overlay=""
      className={cn(
        'fixed z-surface overflow-hidden rounded-xl border bg-kit-popover py-1 shadow-popover',
        className,
      )}
      style={style}
      {...props}
    />
  );
}

export interface MenuItemProps extends React.ComponentProps<typeof Button> {
  /** Paints the row as a destructive action. */
  danger?: boolean;
}

export function MenuItem({ danger = false, className, ...props }: MenuItemProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'h-auto w-full justify-start gap-2.5 rounded-none px-3 py-2 text-[12px] font-medium',
        danger && 'text-destructive hover:bg-status-red-subtle hover:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

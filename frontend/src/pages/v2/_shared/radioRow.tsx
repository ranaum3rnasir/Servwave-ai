import type { KeyboardEvent, ReactNode } from 'react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * A radio row built from primitives - the kit ships no RadioGroup. Extracted from the customer form (payments go-live
 * v7, C-46) so a second screen (the Payments > Documents "Upload document" dialog) reuses it instead of drawing
 * a look-alike. With only `label` it draws exactly what the customer form always drew.
 *
 * `description` is a muted second line, `trailing` sits at the right edge (an amount), and `className` lets a list of
 * 44px rows set its own padding and height.
 */
export function RadioRow({
  checked, onClick, label, description, trailing, className, tabIndex, disabled,
}: {
  checked: boolean;
  onClick: () => void;
  label: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  /** Roving focus inside a `RadioList`: only one row is a tab stop. */
  tabIndex?: number;
  /** A row that cannot be chosen: a disabled radio, left out of the Tab order and of arrow-key movement. */
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={checked}
      variant="ghost"
      size="sm"
      tabIndex={tabIndex}
      disabled={disabled}
      aria-disabled={disabled ? true : undefined}
      onClick={onClick}
      className={cn('h-auto justify-start gap-2.5 px-0 font-normal', className)}
    >
      <span className={checked ? 'border-brand grid size-4 shrink-0 place-items-center rounded-full border' : 'border-input grid size-4 shrink-0 place-items-center rounded-full border'}>
        {checked && <span className="bg-brand size-2 rounded-full" />}
      </span>
      {description === undefined && trailing === undefined ? (
        <span className={checked ? 'font-medium' : undefined}>{label}</span>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 flex-col items-start text-left">
            <span className={cn('max-w-full truncate', checked ? 'font-semibold' : 'font-medium')}>{label}</span>
            {description !== undefined && <span className="text-muted-foreground max-w-full truncate text-[13px] font-normal">{description}</span>}
          </span>
          {trailing !== undefined && <span className="shrink-0 tabular-nums">{trailing}</span>}
        </>
      )}
    </Button>
  );
}

/**
 * Arrow-key movement for a group of radio rows: Down/Right selects the next row, Up/Left the previous one, wrapping at
 * the ends, and focus follows. Put it on the element that has `role="radiogroup"`.
 */
export function onRadioGroupKeyDown(e: KeyboardEvent<HTMLElement>) {
  const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  if (!forward && !back) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'));
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r === document.activeElement);
  const next = rows[at < 0 ? 0 : (at + (forward ? 1 : rows.length - 1)) % rows.length]!;
  e.preventDefault();
  next.focus();
  next.click();
}

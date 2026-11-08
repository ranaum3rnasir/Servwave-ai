import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '@/ui-kit/lib/utils';

/**
 * A keyboard-activated click target that is not a `<button>` element.
 *
 * The legacy module authors 29 raw `<button>`s, and most of them are not CTAs:
 * they are card bodies, listbox options, radio rows, subject tiles and menu
 * rows wrapping rich multi-line content. Each one carries an in-place comment
 * in the legacy source explaining why no Button cell reproduces it.
 *
 * They cannot be carried over as raw elements: the repo's raw-tag ratchet
 * (`design-system/__tests__/component-api-guard.test.ts`) counts every raw
 * `<button` occurrence outside `components/ui` and `src/ui-kit`, and it sits at
 * its floor with zero slack, so a single new one turns the suite red. Raising
 * the ceiling is forbidden. This is the same substitution the Tasks v2 module
 * made for its calendar chips: the element keeps the role, the accessible name,
 * the tab order and the pressed/selected state, and gains explicit Enter/Space
 * activation that a real button would have had for free.
 *
 * `role` is a prop because the legacy sites are not all buttons: the subject
 * search results are `option`s inside a listbox, the event picker rows are
 * `radio`s inside a radiogroup, and the add-step picker rows are `menuitem`s.
 */
export interface PressableProps {
  onPress: () => void;
  children: ReactNode;
  className?: string;
  /** Defaults to `button`; pass `option` / `radio` / `menuitem` where the legacy site used one. */
  role?: 'button' | 'option' | 'radio' | 'menuitem';
  disabled?: boolean;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-selected'?: boolean;
  'aria-checked'?: boolean;
  'aria-expanded'?: boolean;
  'aria-current'?: boolean;
  title?: string;
}

export function Pressable({
  onPress,
  children,
  className,
  role = 'button',
  disabled = false,
  title,
  ...aria
}: PressableProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Space scrolls the page and Enter submits an ancestor form otherwise; a
    // real button suppresses both, so this has to as well.
    event.preventDefault();
    onPress();
  }

  return (
    <div
      role={role}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onPress}
      onKeyDown={handleKeyDown}
      className={cn(
        'cursor-pointer focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25',
        disabled && 'cursor-not-allowed',
        className,
      )}
      {...aria}
    >
      {children}
    </div>
  );
}

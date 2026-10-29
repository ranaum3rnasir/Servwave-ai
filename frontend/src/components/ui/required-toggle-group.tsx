import * as React from 'react';

import { ToggleGroup, type ToggleGroupProps } from '@/components/ui/toggle-group';

/* =============================================================================
   RequiredToggleGroup - a single-select ToggleGroup whose selection cannot be
   thrown away by a second click on the pill that is already active.
   -----------------------------------------------------------------------------
   THE RULE THIS MODULE ENCODES, and the whole of what it is for:

     Radix's single-select ToggleGroup emits `''` when the active item is
     re-clicked. A required group must never transition a NON-EMPTY value to
     empty. A value that is ALREADY empty stays allowed, because "not yet
     chosen" is a legitimate initial state.

   The second clause is why this is a component and not a one-line idiom at each
   call site. Where a field is seeded with a default it can never be empty, so
   `onValueChange={(v) => set(v || current)}` happens to be correct - but where
   the field legitimately STARTS empty (an unanswered required question), that
   fallback is wrong in the other direction: it would need a default to fall back
   to, and inventing one would answer the question on the user's behalf. The rule
   is therefore a TRANSITION GUARD, not a fallback: it blocks exactly the
   non-empty -> empty step and touches nothing else.

   The guard is easy to write and easy to get silently wrong. `?? ''` looks like
   it does this and does nothing at all - `??` fires on `null`/`undefined`, never
   on the empty string Radix actually emits - and the mistake type-checks,
   renders identically, and survives any test that merely mounts the component.
   Two rows of pills that look the same must not behave differently, so the rule
   lives in one place and both rows use it.

   Deliberately NOT deselectable-with-a-keyboard-escape-hatch and deliberately
   not "clearable": a required field has no empty state to return to once it has
   been answered. Where deselection IS meaningful, use `ToggleGroup` directly.
   The items are the shared `ToggleGroupItem`, unchanged and imported from there.
   ============================================================================= */

export interface RequiredToggleGroupProps {
  /** The selected item's `value`. The empty string means nothing is chosen yet. */
  value: string;
  /**
   * Called with the newly selected value. NEVER called with `''` once a value
   * has been chosen - see the rule above.
   */
  onValueChange: (value: string) => void;
  variant?: ToggleGroupProps['variant'];
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  children?: React.ReactNode;
}

const RequiredToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroup>,
  RequiredToggleGroupProps
>(({ value, onValueChange, ...props }, ref) => (
  <ToggleGroup
    ref={ref}
    type="single"
    value={value}
    onValueChange={(next) => {
      // The transition guard, and the only thing this wrapper adds.
      //
      // The `value !== ''` half is DEFENSIVE and deliberately untested: Radix
      // only emits '' when an ACTIVE item is re-clicked, so an already-empty
      // group cannot produce next === '' through the UI at all. It states the
      // rule for a future caller that drives this component some other way -
      // do not read its green tests as coverage of that branch, and do not
      // "simplify" the guard to `if (next === '') return`, which is equivalent
      // today only by accident of what Radix happens to emit.
      if (next === '' && value !== '') return;
      onValueChange(next);
    }}
    {...props}
  />
));
RequiredToggleGroup.displayName = 'RequiredToggleGroup';

export { RequiredToggleGroup };

"use client";

import * as React from "react";

import { Combobox, type ComboboxOption } from "@/ui-kit/components/form/combobox";
import { cn } from "@/ui-kit/lib/utils";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator,
  SelectTrigger, SelectValue,
} from "@/ui-kit/components/ui/select";
import { SEARCH_THRESHOLD } from "@/ui-kit/lib/selectThreshold";

/** The kit's own option shape - `hint`/`icon`/`group` come free from Combobox. */
export type SelectFieldOption = ComboboxOption;

export interface SelectFieldProps {
  options: SelectFieldOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Search box copy on the combobox branch; ignored by the select branch. */
  searchPlaceholder?: string;
  /** No-match copy on the combobox branch (a function receives the query); ignored by the select branch. */
  emptyMessage?: string | ((query: string) => string);
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  /** Mirrors `SelectTrigger`'s own prop - `sm` is h-8.5, `default` is h-10. */
  size?: React.ComponentProps<typeof SelectTrigger>["size"];
  /**
   * Both branches render `role="combobox"`, and that role takes its accessible
   * name from `aria-label`/`aria-labelledby` ONLY - it does not fall back to the
   * trigger's text. A call site with no adjacent `<Label htmlFor>` needs this.
   */
  "aria-label"?: string;
  /**
   * Escape hatch for §4.2 in either direction: `true` forces the searchable
   * branch below the threshold, `false` forces the plain select above it. It is
   * expected to have no callers - if overrides start accumulating, the number is
   * wrong and the number should move, in the one place it is written.
   */
  searchable?: boolean;
  /**
   * Panel placement, forwarded to whichever branch §4.2 picks.
   *
   * These four exist because a menu inside a short (~340px) filter popover must
   * stay attached to its own trigger: Radix otherwise flips the panel upward
   * near the bottom of the viewport, which reads as the menu belonging to the
   * control above it. `side="bottom" avoidCollisions={false}` is the call sites'
   * fix, and it has to survive the list growing past ten.
   *
   * They forward safely because both families' content types extend the SAME
   * `PopperContentProps` from `@radix-ui/react-popper` - `@radix-ui/react-select`'s
   * `SelectPopperPositionProps extends PopperContentProps`, and
   * `@radix-ui/react-popover`'s `PopoverContentImplProps extends
   * Omit<PopperContentProps, 'onPlaced'>`. Same names, same types, same
   * semantics on both sides of the threshold.
   *
   * THE ONE EXCEPTION IS `position`, which is deliberately NOT a prop here.
   * `position?: 'item-aligned' | 'popper'` belongs to `SelectContent` alone;
   * Popover has no equivalent because it is always popper-positioned. Offering
   * it would mean a prop that changes the control when the count crosses ten,
   * which is the one thing this component exists to prevent. Nothing is lost:
   * the kit's own `SelectContent` already defaults `position` to `"popper"`, so
   * a converted call site that used to write `position="popper"` explicitly
   * gets byte-identical markup by omitting it. `item-aligned` has no path
   * through this component at all - a call site that genuinely needs it must
   * hand-compose a `Select` and accept that §4.2 cannot see it.
   */
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  avoidCollisions?: boolean;
  collisionPadding?: number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  /**
   * The list can be added to: a fixed create row is pinned below the options, there before and
   * during a search and on no match - see the kit `Combobox`'s own `onCreate`. A creatable field
   * is always the combobox branch, whatever its option count, because only that branch can pin
   * the row outside the list and hand over what was typed as the new name.
   */
  onCreate?: (query: string) => void;
  /** The create row's constant wording - see the kit `Combobox`. */
  createLabel?: string;
}

/** Wraps in the open list, even a label with no spaces (`anywhere`, unlike
 *  `break-word`, lowers the min-content width); truncates inside the trigger
 *  (see `renderItem`). */
const WRAP_IN_LIST = "[overflow-wrap:anywhere] [[data-slot=select-trigger]_&]:truncate";
/** The hint is a second line: the open list shows it, the one-line trigger does not. */
const LIST_ONLY = "[[data-slot=select-trigger]_&]:hidden";

/**
 * DESIGN_SYSTEM.md §4.2 - "the 10-option rule". Ten or more options renders the
 * searchable `Combobox`; fewer renders the plain `Select`.
 *
 * THE CALL SITE DECLARES NOTHING. `options.length` is read here, at render time,
 * against `SEARCH_THRESHOLD` from `@/ui-kit/lib/selectThreshold` - the one place
 * the number is written. That is the whole mechanism: the rule is retroactive
 * (every dropdown obeys it the moment it goes through this component), automatic
 * over the customer's data (a vendor picker is a select at six vendors and a
 * combobox at sixty, same code, same day), and automatic over time (a fixed list
 * that grows to ten becomes searchable on the commit that adds the tenth).
 *
 * WHY THIS EXISTS SEPARATELY FROM `@/components/form/SelectField`. The app has
 * two Select families with different implementations and different design
 * tokens: `@/components/ui/select` (the app family, which that component wraps)
 * and `@/ui-kit/components/ui/select` (this one). Routing the 41 kit call sites
 * through the app-family entry point would visibly restyle most of the v2 app,
 * so the rule needs an entry point per family. It lives inside `ui-kit/` because
 * nothing under `ui-kit/` may import out of it - the app may import the kit, not
 * the reverse - and the shared threshold sits in `ui-kit/lib` for the same
 * reason.
 *
 * The select branch below emits exactly the `Select`/`SelectTrigger`/
 * `SelectValue`/`SelectContent`/`SelectItem` tree the kit call sites hand-compose
 * today, so migrating a short one is a visual no-op. `size` goes straight through
 * to whichever branch renders, and the two agree on height, padding and font-size
 * at both values - so a `size="sm"` filter bar whose list grows past ten keeps
 * its exact metrics on the commit that grows it. An option
 * that carries no `icon`, `hint` or `group` - which is every option at every one
 * of those call sites - renders a bare string child, byte for byte what it
 * renders now; the three richer fields only add markup when a caller uses them,
 * so the shared `ComboboxOption` type is not promising something one branch
 * silently drops.
 */
function SelectField({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled,
  invalid,
  className,
  id,
  size,
  searchable,
  "aria-label": ariaLabel,
  side,
  align,
  avoidCollisions,
  collisionPadding,
  onCreate,
  createLabel,
}: SelectFieldProps) {
  const useCombobox = searchable ?? (options.length >= SEARCH_THRESHOLD || !!onCreate);

  // Empty string falls back with the rest: an option that asks for a trigger word and has nothing
  // to put there wants its label, not a blank control.
  const selectedTriggerLabel =
    options.find((option) => option.value === value)?.triggerLabel || undefined;

  // Same grouping Combobox does, so the two branches agree on order and headings.
  // `null` when no option carries a `group` - i.e. at every current kit call site
  // - because <SelectGroup> is a real DOM node (role="group") and wrapping an
  // ungrouped list in one would change the markup those call sites emit today.
  const groups = React.useMemo(() => {
    if (!options.some((option) => option.group)) return null;
    const map = new Map<string, SelectFieldOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(option);
    }
    return [...map.entries()];
  }, [options]);

  // `index` so a rule never opens a group with nothing above it - see `separatorBefore`.
  const renderItem = (option: SelectFieldOption, index: number) => (
    <React.Fragment key={option.value}>
    {option.separatorBefore && index > 0 && <SelectSeparator />}
    <SelectItem value={option.value} disabled={option.disabled}>
      {option.icon || option.hint || option.emphasis ? (
        // Radix copies the selected option's markup into the trigger, so one node
        // serves both: in the open list a long label wraps (it must fit a phone
        // screen); in the one-line trigger it truncates and the hint drops out.
        // The row is what keeps the icon beside the label in both places - Radix's
        // own text <span> lays its children out inline, so a bare icon followed by
        // the block-level label column put the icon on a line of its own, and in
        // the trigger the value overflowed the control top and bottom.
        <span className="flex min-w-0 items-center gap-2.5 [&>svg]:size-4 [&>svg]:shrink-0">
          {option.icon}
          <span className="flex min-w-0 flex-col">
            <span className={cn(WRAP_IN_LIST, option.emphasis && "font-semibold")}>{option.label}</span>
            {option.hint && (
              <span className={cn("text-subtle-foreground text-[11.5px] font-normal", WRAP_IN_LIST, LIST_ONLY)}>
                {option.hint}
              </span>
            )}
          </span>
        </span>
      ) : (
        // The plain case, and the one all but one kit call site hits: a bare string
        // child, so the emitted markup is unchanged. `emphasis` joins `icon`/`hint`
        // in the branch above rather than wrapping here, so an option that declares
        // none of the three still emits exactly what it emitted before.
        option.label
      )}
    </SelectItem>
    </React.Fragment>
  );

  if (useCombobox) {
    return (
      <Combobox
        options={options}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        searchPlaceholder={searchPlaceholder}
        emptyMessage={emptyMessage}
        disabled={disabled}
        invalid={invalid}
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={className}
        side={side}
        align={align}
        avoidCollisions={avoidCollisions}
        collisionPadding={collisionPadding}
        onCreate={onCreate}
        createLabel={createLabel}
      />
    );
  }

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        className={className}
        aria-invalid={invalid}
        aria-label={ariaLabel}
      >
        {/* Children only when the selected option asks for a different trigger word. Radix
            renders `SelectValue`'s children when it has any and otherwise portals the selected
            item's own text into this node, so `undefined` leaves every existing call site's
            markup exactly as it was - `React.Children.count(undefined)` is 0. */}
        <SelectValue placeholder={placeholder}>{selectedTriggerLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent
        side={side}
        align={align}
        avoidCollisions={avoidCollisions}
        collisionPadding={collisionPadding}
      >
        {groups
          ? groups.map(([group, items]) => (
              <SelectGroup key={group}>
                {group && <SelectLabel>{group}</SelectLabel>}
                {items.map(renderItem)}
              </SelectGroup>
            ))
          : options.map(renderItem)}
      </SelectContent>
    </Select>
  );
}

export { SelectField };

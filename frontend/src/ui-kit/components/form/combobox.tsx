"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { DEFAULT_CREATE_LABEL, tidyQuery } from "@/ui-kit/lib/createQuery";
import { Button } from "@/ui-kit/components/ui/button";
import { defaultFilter } from "cmdk";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from "@/ui-kit/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui-kit/components/ui/popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line - an address, an email, a role. */
  hint?: string;
  icon?: React.ReactNode;
  group?: string;
  disabled?: boolean;
  /**
   * Renders this option's label in semibold, on BOTH sides of the 10-option rule.
   *
   * For the one kind of option that is not a thing you are choosing but an ACTION that asks for
   * more input - "Other", which opens an address form rather than naming a place. Without it that
   * item sits in the list looking exactly like the locations above it and reads as a location
   * called "Other" (Ran, 2026-09-15).
   *
   * A boolean rather than a `className`, deliberately: a free-form class on an option is a way to
   * restyle one row of a kit control from a call site, and the next one would not match this one.
   * `label` stays a plain `string` for the same reason it always has - `CommandItem`'s search
   * `value` interpolates it, and a ReactNode there stringifies to "[object Object]" and silently
   * breaks search above ten options.
   */
  emphasis?: boolean;
  /**
   * Draws a divider immediately ABOVE this option, on both sides of the 10-option rule.
   *
   * The companion to `emphasis`, and it answers the half `emphasis` cannot: weight says "this row
   * is a different KIND of thing", a rule says "the list of things ends here". An action item
   * pinned below the data it is an alternative to wants both.
   *
   * Ignored on the first option of a group - a rule with nothing above it is a stray line.
   */
  separatorBefore?: boolean;
  /**
   * What the TRIGGER shows while this option is selected, when that differs from what the LIST
   * should call it. Defaults to `label`.
   *
   * For an option whose name is an instruction rather than a value: "Other" is the right word to
   * pick FROM a list and the wrong word to read back OUT of a closed control, where the honest
   * answer is the address the person went on to type. Closed, a control should state its value;
   * open, it should state its choices.
   *
   * Empty or absent falls back to `label`, so a one-off with nothing typed yet still reads as
   * "Other" rather than as a blank control.
   */
  triggerLabel?: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** The no-match line; a function receives the tidied query to name it. */
  emptyMessage?: string | ((query: string) => string);
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  /**
   * Trigger metrics, named and valued to match `SelectTrigger`'s own `size`
   * exactly - `sm` is h-8.5, `default` is h-10, both at text-sm.
   *
   * It exists so `@/ui-kit/components/form/selectField` can hand the same `size`
   * to whichever branch §4.2 picks. A `size="sm"` filter bar whose list grows
   * past ten must not change height or type size on the commit that grows it;
   * without this the trigger silently jumped 8.5 -> 10 tall, because the
   * underlying <Button> falls back to its own default size.
   */
  size?: "sm" | "default";
  /**
   * `role="combobox"` (below) computes its accessible name from `aria-label`/
   * `aria-labelledby` ONLY - unlike a plain button, it does NOT fall back to the trigger's
   * own text content (ARIA's `nameFrom: author` for this role). A caller with no adjacent
   * `<Label htmlFor>` needs this or the control is unlabelled to assistive tech even though
   * the placeholder is visibly right there.
   */
  "aria-label"?: string;
  /**
   * Panel placement, forwarded verbatim to `PopoverContent`.
   *
   * These four names, types and semantics are shared with Radix's
   * `SelectContent` - both `@radix-ui/react-popover`'s and
   * `@radix-ui/react-select`'s content extend the same `PopperContentProps`
   * (`side`, `align`, `avoidCollisions`, `collisionPadding`). That is what lets
   * `@/ui-kit/components/form/selectField` hand the same placement to whichever
   * branch §4.2 picks: a caller that pins a menu below its trigger inside a
   * short filter panel keeps that pin on the commit its list grows past ten.
   */
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  avoidCollisions?: boolean;
  collisionPadding?: number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  /**
   * The list can be ADDED to. When given, one fixed `+ <createLabel>` row is pinned at the bottom
   * of the panel, below a divider and OUTSIDE the scrolling, filtered area (DESIGN_SYSTEM.md
   * §4.2): it is there the moment the panel opens, stays - same row, same label - while the user
   * searches, and stays when nothing matches. Picking it hands over the tidied search text
   * (possibly `""`) so whatever was typed pre-fills the new record, and closes the panel; it
   * never calls `onValueChange`, because nothing exists yet to be the value. Whether a name is a
   * duplicate is for whoever finishes the record to say, not this row.
   */
  onCreate?: (query: string) => void;
  /** The create row's constant wording - it never changes with the query. Defaults to "Create new". */
  createLabel?: string;
}

/**
 * Searchable single-select.
 *
 * WHETHER THIS OR A PLAIN <Select> RENDERS IS NOT DECIDED HERE, and is not a
 * judgement call: DESIGN_SYSTEM.md §4.2, "the 10-option rule" - ten or more
 * options is a combobox, fewer is a select, and nothing else is considered.
 * `@/ui-kit/components/form/selectField` is the entry point that applies it: it
 * reads `options.length` at render time and picks this or the kit `Select`.
 * Call that, not this, unless you genuinely need the bare primitive.
 *
 * Width follows the kit SelectContent policy: min-w-[8rem] and min-w of the
 * trigger width, both MINIMUMS, so the panel grows past a narrow trigger to
 * fit its longest row rather than truncating it. A fixed w-[trigger-width]
 * would mean a control crossing the §4.2 threshold could no longer show its
 * own option text. It still never narrows as results filter.
 */
function Combobox({
  options, value, onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No results found.",
  disabled, invalid, className, id, size = "default", "aria-label": ariaLabel,
  side, align = "start", avoidCollisions, collisionPadding, onCreate,
  createLabel = DEFAULT_CREATE_LABEL,
}: ComboboxProps) {
  const [open, setOpenState] = React.useState(false);
  // Controlled only so `onCreate` can read what was typed; cmdk still does the filtering.
  const [search, setSearch] = React.useState("");
  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) setSearch("");
  };
  const query = tidyQuery(search);
  const selected = options.find((o) => o.value === value);
  const wheelCleanupRef = React.useRef<(() => void) | null>(null);

  /**
   * Wheel-scroll fix (SERV10X QA finding: the "Add team member…" list in the New
   * Event dialog opened but a mouse wheel over it did nothing).
   *
   * Root cause: the popover portals to `document.body` (Radix default), which
   * places it OUTSIDE the DOM subtree a modal <Dialog> registers as its
   * scroll-lock shard (`react-remove-scroll` only exempts `DialogContent`
   * itself - see `@radix-ui/react-dialog`'s `shards: [context.contentRef]`).
   * Any wheel event outside that shard gets `preventDefault()`'d by a
   * `document`-level capture listener the Dialog installs, so the list's own
   * `overflow-y-auto` (already correct on `CommandList`) never gets a native
   * scroll to run. Keyboard arrows still work because cmdk drives those with
   * `scrollIntoView`, not a wheel event - which is why this reads as "opens
   * fine, arrows work, mouse wheel does nothing."
   *
   * Driving `scrollTop` ourselves sidesteps the lock entirely, since it never
   * depends on the browser's native scroll running. That has to happen from a
   * real, non-passive `addEventListener('wheel', …)` rather than the JSX
   * `onWheel` prop: React always attaches its own delegated wheel listener as
   * `{ passive: true }` when the browser supports it, and that is not
   * configurable per element - `preventDefault()` called from inside a React
   * `onWheel` handler can never take effect, and only logs "Unable to
   * preventDefault inside passive event listener invocation" on every tick.
   * `preventDefault` here keeps this from double-scrolling when the combobox
   * is NOT nested inside a modal (native scroll would otherwise also fire on
   * the same event).
   *
   * A callback ref, not a `useEffect` keyed on `open`: Radix's Popover mounts
   * `PopoverContent` through its own Presence/Popper machinery, which does not
   * necessarily land in the DOM within the same commit our `open` state flips
   * in (position has to be measured first). An effect keyed on `[open]` can
   * run before that content exists and then never re-run once it does. A
   * callback ref sidesteps that entirely - React calls it exactly when this
   * div is actually inserted into (or removed from) the DOM, whatever that
   * timing turns out to be, and by then every one of its children (including
   * `CommandList`) is already present in its subtree.
   */
  const setListContainer = React.useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!node) return;

    // With a pinned create row the options scroll in their own area inside the list; that area,
    // not the list, is what the wheel has to move.
    const list =
      node.querySelector<HTMLElement>('[data-slot="combobox-options"]') ??
      node.querySelector<HTMLElement>('[data-slot="command-list"]');
    if (!list) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      list.scrollTop += event.deltaY;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => list.removeEventListener("wheel", onWheel);
  }, []);

  const groups = React.useMemo(() => {
    const map = new Map<string, ComboboxOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(option);
    }
    return [...map.entries()];
  }, [options]);

  // The searchable, filterable part of the panel - every option, and the no-match line.
  const optionRows = (
    <>
      <CommandEmpty>{typeof emptyMessage === "function" ? emptyMessage(query) : emptyMessage}</CommandEmpty>
      {groups.map(([group, items]) => (
        <CommandGroup key={group} heading={group || undefined}>
          {items.map((option, i) => (
            <React.Fragment key={option.value}>
            {/* `i > 0` so a rule never opens a group with nothing above it. cmdk hides
                its own separators while a search is typed, which is what we want here
                too: filtered results are no longer "the places, then the alternative". */}
            {option.separatorBefore && i > 0 && <CommandSeparator />}
            <CommandItem
              // Search the hint too - people look up a site by address
              // as often as by customer name.
              value={`${option.label} ${option.hint ?? ""}`}
              disabled={option.disabled}
              /**
               * Re-selecting the option that is ALREADY selected is a
               * no-op that closes the panel - it does NOT clear the
               * field. This is single-select; the toggle-off it used to
               * do emitted `""` and silently made "crossing ten options"
               * change what the control emits, which is the one thing
               * §4.2 promises it does not.
               *
               * The reference is the branch this one replaces above the
               * threshold. A CONTROLLED Radix `Select` routes its item
               * selection through `useControllableState`, whose
               * `setValue` calls `onChange` only `if (value !== prop)` -
               * so re-picking the current item fires no
               * `onValueChange` at all and just closes. Staying silent
               * here (rather than re-emitting the same value) is
               * therefore exact parity, not merely "not destructive":
               * a call site that counts changes, resets a page index,
               * or refetches on every emit behaves the same on both
               * sides of ten.
               *
               * A future deselect affordance belongs in an explicit
               * `clearable` prop that renders its own control, not in
               * the select gesture - no current caller wants one (see
               * `pages/v2/schedule/components/participantsField.tsx`,
               * which pins `value=""` and never matches a real option).
               */
              onSelect={() => {
                if (option.value !== value) onValueChange?.(option.value);
                setOpen(false);
              }}
            >
              {option.icon}
              <span className="flex min-w-0 flex-col">
                <span className={cn("[overflow-wrap:anywhere]", option.emphasis && "font-semibold")}>
                  {option.label}
                </span>
                {option.hint && (
                  <span className="text-subtle-foreground text-[11.5px] font-normal [overflow-wrap:anywhere]">
                    {option.hint}
                  </span>
                )}
              </span>
              <Check className={cn("text-brand ml-auto size-4 stroke-[3]", option.value !== value && "opacity-0")} />
            </CommandItem>
            </React.Fragment>
          ))}
        </CommandGroup>
      ))}
    </>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            // px-3 and text-sm restate SelectTrigger's own base metrics over the
            // Button variant's (px-4/px-3, text-[13.5px]/text-[13px]), so the two
            // branches of §4.2 are the same control at both sizes rather than
            // only the same height. tailwind-merge drops the variant's values.
            "w-full justify-between px-3 text-sm font-normal",
            !selected && "text-subtle-foreground",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon}
            {/* Emphasis is a property of the ROW, and it only reaches the trigger while the
                trigger is still showing that row's own word. Once `triggerLabel` has supplied a
                real value - an address the person typed - the weight would be claiming that
                VALUE is unusual, which it is not. This is also what keeps the two branches
                identical: on the Select branch a trigger showing the item's own text gets the
                item's own markup, and one showing `triggerLabel` gets plain children. */}
            <span className={cn("truncate", selected?.emphasis && !selected.triggerLabel && "font-semibold")}>
              {(selected?.triggerLabel || selected?.label) ?? placeholder}
            </span>
          </span>
          <ChevronsUpDown className="text-subtle-foreground size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] w-auto p-0"
        side={side}
        align={align}
        avoidCollisions={avoidCollisions}
        // Spread conditionally rather than passed straight through: kit
        // `PopoverContent` writes its own `collisionPadding={10}` BEFORE its
        // `{...props}`, so handing it an explicit `undefined` would win over
        // that default and silently drop the panel to Radix's 0.
        {...(collisionPadding !== undefined ? { collisionPadding } : {})}
      >
        {/* Plain host div, not another ui-kit wrapper: it exists solely so
            `setListContainer` above has an unambiguous DOM node to query
            `[data-slot="command-list"]` from, scoped to this one popover
            instance. */}
        <div ref={setListContainer}>
          {/* cmdk's own scorer, fed the TIDIED query (createQuery): a trailing or doubled space
              no longer hides an option, and the filter reads the same text a create hands over. */}
          <Command filter={(itemValue, typed, keywords) => defaultFilter(itemValue, tidyQuery(typed), keywords)}>
            <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
            {onCreate ? (
              /* A list the user can add to: the options scroll and filter in their own area, and
                 the create row sits below it, outside that area, so it can never scroll away or
                 be filtered out. It stays INSIDE `CommandList` all the same - cmdk walks the arrow
                 keys over the items in there, and the list is the `listbox` the row belongs to. */
              <CommandList className="max-h-none overflow-visible p-0">
                <div
                  data-slot="combobox-options"
                  className="max-h-64 scroll-py-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1.5"
                >
                  {optionRows}
                </div>
                {/* `alwaysRender`: cmdk hides a separator while a search is typed, and this one
                    has to stay with the row it introduces. */}
                <CommandSeparator alwaysRender className="mx-0 my-0" />
                <CommandGroup forceMount className="p-1.5">
                  <CommandItem
                    forceMount
                    // Constant: the row is the same whatever was typed, and never "matches" a query.
                    value="__combobox_create__"
                    onSelect={() => {
                      onCreate(query);
                      setOpen(false);
                    }}
                    className="text-brand font-semibold"
                  >
                    <Plus className="size-4" />
                    <span className="truncate">{createLabel}</span>
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            ) : (
              <CommandList>{optionRows}</CommandList>
            )}
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };

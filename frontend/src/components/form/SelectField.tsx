import * as React from 'react';

import { Combobox } from '@/components/ui/combobox';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SEARCH_THRESHOLD } from '@/ui-kit/lib/selectThreshold';

export interface SelectFieldOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Per-option class on the rendered row. Honoured on BOTH branches, so a
   * dense list (TaskDetailDrawer's `text-xs` status rows) keeps its type size
   * when it crosses ten.
   *
   * It is deliberately per-option rather than derived from the trigger's
   * `size`: three of the four `size="xs"` call sites (PODetailDialog,
   * ReceiptCard x2) do NOT shrink their option rows, so deriving row density
   * from the trigger rung would change what they render.
   */
  className?: string;
  /**
   * Section heading this option sits under. Groups render in first-seen order,
   * and NOTHING is emitted unless some option actually carries one - see the
   * note on `groups` below.
   */
  group?: string;
}

/**
 * A trailing row that is NOT a choice: it opens a dialog, or swaps the whole
 * control for a text input. A flat `options` array cannot express it, and
 * modelling it as an option would fire `onValueChange` with a value that is
 * not a value.
 *
 * It is PINNED on both branches - on the searchable branch it survives
 * filtering, so a user whose query matches nothing can still reach
 * "+ Add new category…". Selecting it calls `onSelect` and never
 * `onValueChange`.
 *
 * `label` is rendered verbatim; every current call site already writes its own
 * "+ " prefix, so no icon is synthesised on either branch.
 */
export interface SelectFieldAction {
  label: string;
  onSelect: () => void;
  /** Rule above the row. Only VendorCategoryPicker had one; the tax pickers did not. */
  separator?: boolean;
}

/**
 * The action row's internal option value on the select branch. Radix Select
 * has no concept of a non-selecting row, so the action IS a `SelectItem` -
 * which is exactly what the three call sites hand-composed - and this sentinel
 * is intercepted here so `onValueChange` never sees it. Namespaced so it
 * cannot collide with a real option value.
 */
const ACTION_VALUE = '__select_field_action__';

export interface SelectFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectFieldOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Lands on the trigger, which is the real labelable control - `Select` is
   * Radix's context root and renders no DOM of its own. Without this, a
   * `FormField` render-prop call site converting to `SelectField` would
   * silently drop its `<label htmlFor>` association.
   */
  id?: string;
  /** Mirrors `SelectTrigger`'s own rungs: `xs` | `sm` | `md` | `lg`. */
  size?: React.ComponentProps<typeof SelectTrigger>['size'];
  /** Mirrors `SelectTrigger`'s own `tone` - the sage-tinted deposit box treatment. */
  tone?: React.ComponentProps<typeof SelectTrigger>['tone'];
  'aria-label'?: string;
  /** Forwarded raw, as `FormField`'s render prop hands it over. */
  'aria-describedby'?: string;
  /**
   * Forwarded raw as the ATTRIBUTE, deliberately not mapped onto
   * `SelectTrigger`'s `invalid` prop: `invalid` also paints `border-danger`,
   * and the three `FormField` call sites that spread this today get no border
   * treatment. Mapping it would be a rendered change dressed up as a
   * pass-through.
   */
  'aria-invalid'?: boolean;
  /** A pinned trailing row that is not a choice - see `SelectFieldAction`. */
  action?: SelectFieldAction;
  /**
   * Escape hatch for DESIGN_SYSTEM.md §4.2 in either direction: `true` forces
   * the searchable branch below the threshold, `false` forces the plain select
   * above it. It is expected to have no callers - if overrides start
   * accumulating, the number is wrong and the number should move, in the one
   * place it is written.
   */
  searchable?: boolean;
  /**
   * The list can be added to: a fixed create row is pinned below the options, there before and
   * during a search and on no match - the searchable branch's `onCreate` (see `Combobox`). A
   * creatable field is always the searchable branch, whatever its option count, because only
   * that branch can pin the row outside the list and hand over what was typed as the new name.
   */
  onCreate?: (query: string) => void;
  /** The create row's constant wording - see `Combobox`. */
  createLabel?: string;
  /** The searchable branch's no-match line (a function receives the query). Defaults to `No results for "<query>"`. */
  emptyText?: string | ((query: string) => string);
}

export function SelectField({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  id,
  size,
  tone,
  action,
  searchable,
  onCreate,
  createLabel,
  emptyText,
  ...rest
}: SelectFieldProps) {
  // The call site declares nothing. The count is read here, at render time, so
  // a list that grows to ten becomes searchable on the commit that grows it.
  // The action row is NOT counted: it is not one of the choices the rule is
  // about, and letting it tip a nine-option list over the line would mean the
  // same nine choices got search on one surface and not another.
  const useCombobox = searchable ?? (options.length >= SEARCH_THRESHOLD || !!onCreate);

  /**
   * `null` when no option carries a `group` - which is every call site that
   * does not ask for grouping. `SelectGroup` renders a real `role="group"`
   * node, so wrapping an ungrouped list in one would change the markup every
   * existing call site emits today. Same rule the kit entry point follows.
   */
  const groups = React.useMemo(() => {
    if (!options.some((option) => option.group)) return null;
    const map = new Map<string, SelectFieldOption[]>();
    for (const option of options) {
      const key = option.group ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(option);
    }
    return [...map.entries()];
  }, [options]);

  const handleValueChange = (next: string) => {
    if (action && next === ACTION_VALUE) {
      action.onSelect();
      return;
    }
    onValueChange(next);
  };

  if (useCombobox) {
    return (
      <Combobox
        value={value}
        onValueChange={onValueChange}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        id={id}
        size={size}
        tone={tone}
        action={action}
        onCreate={onCreate}
        createLabel={createLabel}
        emptyText={emptyText}
        aria-label={rest['aria-label']}
        aria-describedby={rest['aria-describedby']}
        aria-invalid={rest['aria-invalid']}
      />
    );
  }

  const renderItem = (option: SelectFieldOption) => (
    <SelectItem
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      className={option.className}
    >
      {option.label}
    </SelectItem>
  );

  return (
    <Select value={value} onValueChange={handleValueChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        tone={tone}
        className={className}
        aria-label={rest['aria-label']}
        aria-describedby={rest['aria-describedby']}
        aria-invalid={rest['aria-invalid']}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups
          ? groups.map(([group, items]) => (
              <SelectGroup key={group}>
                {group && <SelectLabel>{group}</SelectLabel>}
                {items.map(renderItem)}
              </SelectGroup>
            ))
          : options.map(renderItem)}
        {action && (
          <>
            {action.separator && <SelectSeparator />}
            <SelectItem value={ACTION_VALUE}>{action.label}</SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * SelectField (kit family) - DESIGN_SYSTEM.md §4.2, "the 10-option rule".
 *
 * Ten or more options renders the searchable Combobox; fewer renders the kit's
 * plain Radix Select. The count is read inside the component, never at the call
 * site - that is what makes the rule retroactive, automatic over the customer's
 * data, and automatic over time.
 *
 * This mirrors `components/form/__tests__/select-field.test.tsx`, which pins the
 * same rule for the OTHER Select family. Two entry points exist because the app
 * has two Select implementations with different tokens; both read one shared
 * `SEARCH_THRESHOLD`, and that file's last describe block is what stops a second
 * copy of the number appearing here or anywhere else.
 *
 * Lives beside the component rather than in a `__tests__/` dir, matching
 * `combobox.test.tsx` next door.
 */
import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SelectField, type SelectFieldOption } from './selectField';
import { SEARCH_THRESHOLD } from '@/ui-kit/lib/selectThreshold';

const optionsOf = (count: number): SelectFieldOption[] =>
  Array.from({ length: count }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));

const NINE = optionsOf(SEARCH_THRESHOLD - 1);
const TEN = optionsOf(SEARCH_THRESHOLD);

function setup(props: Partial<React.ComponentProps<typeof SelectField>> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <SelectField
      options={NINE}
      onValueChange={onValueChange}
      placeholder="Pick one"
      aria-label="Picker"
      {...props}
    />,
  );
  return { onValueChange, ...utils };
}

const trigger = () => screen.getByRole('combobox', { name: 'Picker' });

/**
 * Both branches put `role="combobox"` on their trigger - the kit's Radix Select
 * trigger carries it too - so the role alone cannot tell them apart. The
 * discriminator is the search box, which only the Combobox's popover owns. It
 * needs the panel open, which is the honest test anyway: the whole user-visible
 * difference between the branches is whether you can type to filter.
 */
async function openAndProbe() {
  const user = userEvent.setup();
  await user.click(trigger());
  return { user, searchInput: screen.queryByPlaceholderText('Search…') };
}

describe('§4.2 - below the threshold stays the kit Select', () => {
  it('renders no search input at 9 options', async () => {
    setup();
    const { searchInput } = await openAndProbe();
    expect(searchInput).toBeNull();
  });

  it('emits the kit Select tree the call sites hand-compose today', () => {
    setup({ className: 'w-44', size: 'sm', id: 'picker' });
    const el = trigger();

    // The kit trigger, not the Combobox's <Button>: its data-slot, its size
    // attribute, its placeholder state. A migrated short call site must not move.
    expect(el.getAttribute('data-slot')).toBe('select-trigger');
    expect(el.getAttribute('data-size')).toBe('sm');
    expect(el.getAttribute('id')).toBe('picker');
    expect(el).toHaveClass('w-44');
    expect(el.hasAttribute('data-placeholder')).toBe(true);
    expect(el).toHaveTextContent('Pick one');
  });

  it('renders each option as a bare label, with no extra wrapper markup', async () => {
    setup();
    const { user } = await openAndProbe();
    void user;

    const items = screen.getAllByRole('option');
    expect(items).toHaveLength(9);
    // An option with no icon/hint/group must produce exactly the text child the
    // hand-composed call sites produce - no <span> scaffolding, no <SelectGroup>.
    expect(items[0]?.querySelector('span.flex.flex-col')).toBeNull();
    expect(document.querySelector('[data-slot="select-content"] [role="group"]')).toBeNull();
  });

  it('selects on the Select branch', async () => {
    const { onValueChange } = setup();
    const { user } = await openAndProbe();

    await user.click(screen.getByRole('option', { name: 'Option 3' }));

    expect(onValueChange).toHaveBeenCalledWith('v3');
  });
});

describe('§4.2 - at and above the threshold it becomes the searchable Combobox', () => {
  it('renders a search input at exactly 10 options', async () => {
    setup({ options: TEN });
    const { searchInput } = await openAndProbe();
    expect(searchInput).not.toBeNull();
  });

  it('and keeps rendering it above the threshold', async () => {
    setup({ options: optionsOf(50) });
    const { searchInput } = await openAndProbe();
    expect(searchInput).not.toBeNull();
  });

  it('passes placeholder, disabled state, class and label through', () => {
    setup({ options: TEN, disabled: true, className: 'w-44' });
    const el = trigger();
    expect(el).toBeDisabled();
    expect(el).toHaveClass('w-44');
    expect(el).toHaveAccessibleName('Picker');
    expect(el).toHaveTextContent('Pick one');
  });

  it('filters and selects on the Combobox branch', async () => {
    const { onValueChange } = setup({ options: TEN });
    const { user, searchInput } = await openAndProbe();

    await user.type(searchInput!, 'Option 7');
    await user.click(screen.getByText('Option 7'));

    expect(onValueChange).toHaveBeenCalledWith('v7');
  });
});

/**
 * The metrics the two branches must agree on, read off whichever trigger
 * rendered.
 *
 * They cannot be compared as raw class strings, because the two express the same
 * thing differently: the kit `SelectTrigger` always carries BOTH
 * `data-[size=default]:h-10` and `data-[size=sm]:h-8.5` and picks between them
 * with a `data-size` attribute, while the Combobox's <Button> resolves its size
 * at render and emits a plain `h-8.5`. So the variant prefix is stripped and the
 * branch that does not apply at this size is dropped - what is left is what the
 * browser actually paints.
 */
const SIZE_VARIANT = /^data-\[size=(sm|default)\]:(.*)$/;
const FONT_SIZE_VALUE = /^(?:xs|sm|base|lg|xl|\[[\d.]+px\])$/;
const LENGTH_VALUE = /^[\d.]+$/;

/**
 * Split on the first hyphen and compare the prefix as a whole word, rather than
 * writing one regex with a hyphen-terminated `text` fragment in it:
 * `scripts/check-unresolved-classes.mjs` scans this file for class candidates and
 * reads such a fragment as an unresolvable class name, turning that gate red.
 */
const isMetric = (cls: string): boolean => {
  const dash = cls.indexOf('-');
  if (dash < 0) return false;
  const prefix = cls.slice(0, dash);
  const value = cls.slice(dash + 1);
  if (prefix === 'h' || prefix === 'px') return LENGTH_VALUE.test(value);
  if (prefix === 'text') return FONT_SIZE_VALUE.test(value);
  return false;
};

const metricsOf = (el: Element, size: 'sm' | 'default'): string[] => {
  const out: string[] = [];
  for (const cls of el.className.split(/\s+/)) {
    const variant = SIZE_VARIANT.exec(cls);
    if (variant && variant[1] !== size) continue; // a variant for the other size
    const bare = variant ? variant[2]! : cls;
    if (isMetric(bare)) out.push(bare);
  }
  return out.sort();
};

describe('§4.2 - crossing the threshold does not resize the control', () => {
  it.each(['sm', 'default'] as const)(
    'renders identical height, padding and font-size at size="%s" on both branches',
    (size) => {
      setup({ options: NINE, size });
      const select = metricsOf(trigger(), size);
      cleanup();

      setup({ options: TEN, size });
      const combobox = metricsOf(trigger(), size);

      // The whole point of the rule being automatic over data and over time: a
      // list that grows past ten must not move the layout on the commit that
      // grows it. Height alone is not enough - a type-size jump is just as
      // visible in a filter bar.
      expect(combobox).toEqual(select);
      // ...and pinned absolutely too, so the pair agreeing on the WRONG metrics
      // (both drifting together after a variant edit) still fails.
      expect(select).toEqual(size === 'sm' ? ['h-8.5', 'px-3', 'text-sm'] : ['h-10', 'px-3', 'text-sm']);
    },
  );
});

describe('§4.2 - `searchable` overrides the count in either direction', () => {
  it('searchable={true} forces the combobox at 3 options', async () => {
    setup({ options: optionsOf(3), searchable: true });
    const { searchInput } = await openAndProbe();
    expect(searchInput).not.toBeNull();
  });

  it('searchable={false} forces the plain select at 50 options', async () => {
    setup({ options: optionsOf(50), searchable: false });
    const { searchInput } = await openAndProbe();
    expect(searchInput).toBeNull();
  });
});

describe('§4.2 - a list the user can add to (`onCreate`)', () => {
  it('is the combobox at 3 options, with the fixed create row there before anything is typed', async () => {
    const onCreate = vi.fn();
    setup({ options: optionsOf(3), onCreate, createLabel: 'Create option' });
    const { user, searchInput } = await openAndProbe();

    expect(searchInput).not.toBeNull();
    expect(searchInput).toHaveValue('');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent?.trim())).toEqual(['Option 0', 'Option 1', 'Option 2', 'Create option']);

    await user.click(screen.getByRole('option', { name: 'Create option' }));
    expect(onCreate).toHaveBeenCalledWith('');
  });

  it('without onCreate, the same 3 options stay the plain select, with no create row', async () => {
    setup({ options: optionsOf(3) });
    const { searchInput } = await openAndProbe();

    expect(searchInput).toBeNull();
    expect(screen.queryByRole('option', { name: /^Create/ })).not.toBeInTheDocument();
  });
});

/**
 * §4.2 says the control is the SAME control above and below ten, only
 * searchable. That has to hold for what it EMITS, not just how it looks -
 * otherwise a list quietly growing past ten changes the data the call site
 * receives, which is the one failure mode this component exists to prevent.
 *
 * Both cases below are run against both branches from one table, so neither can
 * be fixed in isolation. The second is the one that was broken: the Combobox
 * treated a click on the already-selected row as a toggle-OFF and emitted `''`,
 * so above ten options re-picking the active department on the schedule filter
 * CLEARED it. A controlled Radix `Select` never does that - `useControllableState`
 * calls `onChange` only `if (value !== prop)` - so the fixed Combobox stays
 * silent too rather than re-emitting.
 */
describe('§4.2 - both branches emit the same thing for the same gesture', () => {
  const branches = [
    ['below the threshold (Select)', NINE],
    ['at the threshold (Combobox)', TEN],
  ] as const;

  it.each(branches)('picking a different option emits its value - %s', async (_name, options) => {
    const { onValueChange } = setup({ options, value: 'v0' });
    const { user } = await openAndProbe();

    await user.click(screen.getByRole('option', { name: 'Option 3' }));

    expect(onValueChange).toHaveBeenCalledWith('v3');
  });

  it.each(branches)('re-picking the SELECTED option emits nothing - %s', async (_name, options) => {
    const { onValueChange } = setup({ options, value: 'v3' });
    const { user } = await openAndProbe();

    await user.click(screen.getByRole('option', { name: 'Option 3' }));

    // Not `''`, and not `'v3'` either: silence, exactly as the Select branch.
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it.each(branches)('and the panel closes either way - %s', async (_name, options) => {
    setup({ options, value: 'v3' });
    const { user } = await openAndProbe();

    await user.click(screen.getByRole('option', { name: 'Option 3' }));

    expect(screen.queryByRole('option', { name: 'Option 3' })).toBeNull();
  });
});

/**
 * Placement, forwarded to whichever branch renders.
 *
 * The four filter-panel call sites pin their menu below its own trigger
 * (`side="bottom" avoidCollisions={false}`) because Radix otherwise flips it
 * upward near the viewport bottom, detaching it from its control inside a
 * ~340px panel. Both families' content types extend the same
 * `PopperContentProps`, so the pin has to survive the count crossing ten - a
 * category list is exactly the kind that grows past it.
 *
 * `position` is NOT among these on purpose: `'item-aligned' | 'popper'` is
 * Select-only (Popover is always popper-positioned), so offering it would be a
 * prop that changes the control at the threshold. The kit `SelectContent`
 * already defaults to `"popper"`, so a converted call site loses nothing.
 */
describe('§4.2 - placement props reach both branches', () => {
  it.each([
    ['below the threshold (Select)', NINE, '[data-slot="select-content"]'],
    ['at the threshold (Combobox)', TEN, '[data-slot="popover-content"]'],
    // `side="top"` rather than the call sites' `"bottom"`: bottom is Radix's
    // own default on BOTH branches, so a build that forwards nothing would
    // still read "bottom" and the assertion would prove nothing.
  ] as const)('side is forwarded to the rendered content - %s', async (_name, options, slot) => {
    setup({ options, side: 'top', avoidCollisions: false });
    await openAndProbe();

    expect(document.querySelector(slot)?.getAttribute('data-side')).toBe('top');
  });

  it('SelectFieldProps has no `position` - it is Select-only and would break the threshold', () => {
    // A type-level assertion, compiled not asserted: if `position` is ever
    // added, `never` stops being assignable and this file fails to build.
    type HasPosition = 'position' extends keyof React.ComponentProps<typeof SelectField>
      ? 'position'
      : never;
    const pinned: HasPosition = undefined as never;
    expect(pinned).toBeUndefined();
  });
});

/**
 * `emphasis` - the one option in a list that is an ACTION, not a thing you are choosing.
 *
 * Ran, 2026-09-15, on the visit-location picker: "Other" opens an address form rather than naming
 * a place, and set in the same weight as the locations above it, it read as a location called
 * "Other". The call site declares `emphasis`, not a class, so every such row in the product looks
 * the same as every other.
 *
 * BOTH BRANCHES, for the reason §4.2 exists at all: this very picker crosses the threshold on an
 * organisation with nine locations, and an emphasis that only rendered below ten would silently
 * vanish on exactly the accounts with the longest list to read.
 */
describe('§4.2 - `emphasis` renders on both sides of the threshold', () => {
  const withEmphasis = (base: SelectFieldOption[]): SelectFieldOption[] => [
    ...base,
    { value: 'other', label: 'Other', emphasis: true },
  ];

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD - 1)],
  ] as const)('the emphasised option is bold and its siblings are not - %s', async (_name, base) => {
    setup({ options: withEmphasis(base) });
    await openAndProbe();

    // The class lands on the element holding the words, wherever the branch puts it - asserting
    // on the option node itself would pass on a build that bolded the whole row, and on a build
    // that bolded every row.
    const emphasised = await screen.findByRole('option', { name: 'Other' });
    expect(emphasised.querySelector('.font-semibold')?.textContent).toBe('Other');

    const plain = await screen.findByRole('option', { name: 'Option 0' });
    expect(plain.querySelector('.font-semibold')).toBeNull();
  });
});

/**
 * `separatorBefore` and `triggerLabel` - the other two halves of "this row is not one of the
 * things you are choosing", both pinned on both sides of the threshold for the same reason
 * `emphasis` is: the picker that needs them crosses ten options on a real organisation.
 */
describe('§4.2 - `separatorBefore` and `triggerLabel` on both sides of the threshold', () => {
  const action = (extra: Partial<SelectFieldOption>): SelectFieldOption => ({
    value: 'other', label: 'Other', separatorBefore: true, ...extra,
  });

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2), '[data-slot="select-separator"]'],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD - 1), '[data-slot="command-separator"]'],
  ] as const)('a rule is drawn above the flagged option - %s', async (_name, base, slot) => {
    setup({ options: [...base, action({})] });
    await openAndProbe();

    expect(document.querySelectorAll(slot)).toHaveLength(1);
  });

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD - 1)],
  ] as const)('no rule when nothing asks for one - %s', async (_name, base) => {
    setup({ options: base });
    await openAndProbe();

    expect(
      document.querySelectorAll('[data-slot="select-separator"], [data-slot="command-separator"]'),
    ).toHaveLength(0);
  });

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD - 1)],
  ] as const)('the trigger shows `triggerLabel` over `label` once there is one - %s', async (_name, base) => {
    setup({ options: [...base, action({ triggerLabel: '12 Harbor St, Asheville, NC' })], value: 'other' });

    expect(trigger()).toHaveTextContent('12 Harbor St, Asheville, NC');
    expect(trigger()).not.toHaveTextContent('Other');
  });

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD - 1)],
  ] as const)('an EMPTY triggerLabel falls back to the label, never a blank control - %s', async (_name, base) => {
    setup({ options: [...base, action({ triggerLabel: '' })], value: 'other' });

    expect(trigger()).toHaveTextContent('Other');
  });

  // The regression this pair guards: `SelectValue` gained children, and Radix only portals the
  // selected item's own text into that node when it has NONE. An ordinary option - every option
  // at every other kit call site - must still read its own label back out of the trigger.
  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 1)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD)],
  ] as const)('an option with no triggerLabel still shows its label in the trigger - %s', async (_name, options) => {
    setup({ options, value: 'v0' });

    expect(trigger()).toHaveTextContent('Option 0');
  });
});

/**
 * On a phone a list with long option labels ran past the screen edge (seen on
 * the Caller ID "Organization default" select): Radix sizes the list to its
 * widest row, with no cap. Both branches now cap the panel to the width Radix
 * measures as available on screen, and a long label or hint WRAPS onto a second
 * line rather than being cut off. jsdom has no layout, so this pins the classes
 * that do the capping and the wrapping; the real-browser check is a screenshot.
 */
describe('a long option fits the screen - it wraps, never runs off the edge or gets cut off', () => {
  const LONG_LABEL = '(555) 201-4410 · The main office line that rings the front desk first';
  const LONG_HINT = 'Calls only, texts go out from a different number';
  const withLong = (base: SelectFieldOption[]): SelectFieldOption[] => [
    ...base,
    { value: 'long', label: LONG_LABEL, hint: LONG_HINT },
  ];

  it.each([
    ['below the threshold (Select)', 'select-content', '--radix-select-content-available-width', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', 'popover-content', '--radix-popover-content-available-width', optionsOf(SEARCH_THRESHOLD)],
  ] as const)('%s caps the open list to the width available on screen', async (_name, slot, widthVar, base) => {
    setup({ options: withLong(base) });
    await openAndProbe();

    const panel = document.querySelector(`[data-slot="${slot}"]`);
    expect(panel).not.toBeNull();
    expect(panel!.className.split(/\s+/)).toContain(`max-w-[var(${widthVar})]`);
  });

  it.each([
    ['below the threshold (Select)', optionsOf(SEARCH_THRESHOLD - 2)],
    ['at the threshold (Combobox)', optionsOf(SEARCH_THRESHOLD)],
  ] as const)('%s wraps a long label and hint instead of truncating them', async (_name, base) => {
    setup({ options: withLong(base) });
    await openAndProbe();

    for (const text of [LONG_LABEL, LONG_HINT]) {
      const el = screen.getByText(text);
      const classes = el.className.split(/\s+/);
      expect(classes).not.toContain('truncate');
      // `anywhere`, not `break-word`: only it lowers the min-content width, so
      // a label with no spaces (an email address) wraps too.
      expect(classes).toContain('[overflow-wrap:anywhere]');
    }
  });
});

/**
 * The selected option, as the plain select's TRIGGER shows it. Radix copies the
 * selected item's markup into the trigger's value <span>, so one node serves
 * both the open list and the one-line trigger. Seen in QA: an option with an
 * icon AND a hint, once picked, put the icon on a line of its own and the label
 * and hint on two more, so the value ran out of the top and bottom of the
 * control. In the trigger the icon and label share one row, the label ends in an
 * ellipsis, and the hint (a second line) stays in the open list. jsdom has no
 * layout, so this pins the markup and classes that do it; the real-browser
 * check is a screenshot.
 */
describe('a picked option with an icon and a hint stays inside the trigger', () => {
  const LONG_LABEL = '(555) 201-4410 · The main office line that rings the front desk first';
  const LONG_HINT = 'Calls only, texts go out from a different number';
  const options: SelectFieldOption[] = [
    { value: 'a', label: 'Short' },
    {
      value: 'long',
      label: LONG_LABEL,
      hint: LONG_HINT,
      icon: <svg data-testid="option-icon" />,
    },
  ];
  const inTrigger = (text: string) =>
    [...trigger().querySelectorAll('span')].find((el) => el.textContent === text && el.children.length === 0)!;
  const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

  it('the label is cut off with an ellipsis inside the trigger, never wrapped', () => {
    setup({ options, value: 'long' });

    const label = inTrigger(LONG_LABEL);
    expect(label).toBeDefined();
    expect(classesOf(label)).toContain('[[data-slot=select-trigger]_&]:truncate');
  });

  it('the icon and the label share one row in the trigger', () => {
    setup({ options, value: 'long' });

    const icon = trigger().querySelector('[data-testid="option-icon"]')!;
    const label = inTrigger(LONG_LABEL);
    const row = icon.parentElement!;
    // One element holds both, laid out as a row - not the value <span>, whose
    // inline flow put a block-level label column on a line below the icon.
    expect(row.contains(label)).toBe(true);
    // Radix's own value <span> carries an inline `pointer-events: none`; ours
    // carries no style, so this tells our row apart from the value span.
    expect(row.getAttribute('style') ?? '').not.toContain('pointer-events');
    expect(classesOf(row)).toEqual(expect.arrayContaining(['flex', 'items-center', 'min-w-0']));
    expect(classesOf(row)).not.toContain('flex-col');
  });

  it('the hint is a second line, so it shows in the open list and not in the trigger', async () => {
    setup({ options, value: 'long' });

    expect(classesOf(inTrigger(LONG_HINT))).toContain('[[data-slot=select-trigger]_&]:hidden');

    await openAndProbe();
    const listHint = [...document.querySelectorAll('[data-slot="select-content"] span')].find(
      (el) => el.textContent === LONG_HINT,
    )!;
    expect(listHint).toBeDefined();
    // The class is scoped to the trigger; in the list nothing hides the hint.
    expect(classesOf(listHint).filter((c) => /(^|:)hidden$/.test(c) && !c.includes('select-trigger'))).toEqual([]);
  });
});

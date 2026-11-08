/**
 * SelectField - DESIGN_SYSTEM.md §4.2, "the 10-option rule".
 *
 * A dropdown with 10 or more options renders the searchable Combobox; fewer
 * than 10 renders the plain Radix Select. The count is read inside the
 * primitive, so no call site declares anything - that is what makes the rule
 * retroactive, automatic over the customer's data, and automatic over time.
 *
 * Four things are pinned here, and the FIRST is the load-bearing one:
 *
 *   1. At 9 options the emitted Select markup is byte-identical to what the
 *      component shipped before the rule existed. That frozen string is the
 *      proof that the 43 statically-short call sites and every short runtime
 *      site did not move. A refactor that perturbs the select branch - a
 *      reordered class, a stray attribute, a wrapper - fails here and nowhere
 *      else.
 *   2. At 10 options the Combobox renders. Together with (1) the boundary is
 *      pinned on BOTH sides, so `>` can never be silently reintroduced in
 *      place of `>=`.
 *   3. `searchable` overrides the count in either direction.
 *   4. The threshold literal exists exactly once in the tree - now in
 *      `ui-kit/lib/selectThreshold.ts`, which BOTH family entry points import
 *      (this one and `ui-kit/components/form/selectField.tsx`). One number, two
 *      Select families; a second declaration anywhere fails this file.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectField } from '@/components/form/SelectField';
import type { SelectFieldOption } from '@/components/form/SelectField';

afterEach(cleanup);

const optionsOf = (count: number): SelectFieldOption[] =>
  Array.from({ length: count }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));

const NINE = optionsOf(9);
const TEN = optionsOf(10);

/**
 * Every attribute the 9-option trigger carried BEFORE the rule landed - names
 * and values, in the order Radix and React emit them - captured against the
 * unmodified component on this branch's parent commit. The whole set, not a
 * subset, because the point is to catch a perturbation and a subset check
 * cannot see an addition.
 *
 * `w-full` is absent from the class value on purpose: tailwind-merge drops it
 * in favour of the caller's `w-64`. Freezing the merged result rather than the
 * source string is exactly what makes this assertion meaningful.
 *
 * The chevron's own SVG markup is deliberately NOT frozen here, and its
 * presentation attributes are not even named in this comment: they are
 * hyphenated tokens that `scripts/check-unresolved-classes.mjs` reads as
 * class candidates, so a frozen copy - or a mention - turns that guard red on
 * this file. The trigger's children are pinned by shape below instead.
 */
const NINE_TRIGGER_ATTRIBUTES: [string, string][] = [
  ['type', 'button'],
  ['role', 'combobox'],
  ['aria-expanded', 'false'],
  ['aria-autocomplete', 'none'],
  ['dir', 'ltr'],
  ['data-state', 'closed'],
  ['data-placeholder', ''],
  [
    'class',
    'flex h-10 items-center justify-between rounded border border-border bg-surface-light px-3 py-2 text-sm ring-offset-surface-light data-[placeholder]:text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 w-64',
  ],
  ['aria-label', 'Nine'],
];

const attributesOf = (el: Element): [string, string][] =>
  Array.from(el.attributes).map((a) => [a.name, a.value]);

const renderField = (props: Partial<React.ComponentProps<typeof SelectField>> = {}) =>
  render(
    <SelectField
      value=""
      onValueChange={() => {}}
      options={NINE}
      placeholder="Pick one"
      className="w-64"
      aria-label="Nine"
      {...props}
    />
  );

/**
 * Both branches render `role="combobox"` on their trigger - the Radix Select
 * trigger carries it too - so the role alone cannot tell them apart. The
 * discriminator is the search input, which only the Combobox's popover owns,
 * and (cheaper, no interaction needed) the `aria-haspopup` the Combobox sets
 * and Radix Select does not.
 */
const isCombobox = () => screen.getByRole('combobox').getAttribute('aria-haspopup') === 'listbox';

describe('§4.2 - 9 options stays the plain Radix Select', () => {
  it('renders the Select branch', () => {
    renderField();
    expect(isCombobox()).toBe(false);
  });

  it('emits markup byte-identical to what it shipped before the rule', () => {
    renderField();
    const trigger = screen.getByRole('combobox');

    // The trigger's whole attribute set, in order, values included.
    expect(attributesOf(trigger)).toEqual(NINE_TRIGGER_ATTRIBUTES);

    // ...and its children by shape: the value span, then the chevron. A
    // wrapper element or a third child fails here.
    expect(trigger.children).toHaveLength(2);
    const [label, chevron] = Array.from(trigger.children);
    expect(label?.tagName).toBe('SPAN');
    expect(label?.textContent).toBe('Pick one');
    expect(label?.getAttribute('style')).toBe('pointer-events: none;');
    expect(chevron?.tagName).toBe('svg');
    expect(chevron?.getAttribute('class')).toBe('lucide lucide-chevron-down h-4 w-4 opacity-50');
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('§4.2 - 10 options becomes the searchable Combobox', () => {
  it('renders the Combobox branch at exactly the threshold', () => {
    renderField({ options: TEN });
    expect(isCombobox()).toBe(true);
  });

  it('and keeps rendering it above the threshold', () => {
    renderField({ options: optionsOf(50) });
    expect(isCombobox()).toBe(true);
  });

  it('passes the placeholder, disabled state, class and label through', () => {
    renderField({ options: TEN, disabled: true });
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveClass('w-64');
    expect(trigger).toHaveAccessibleName('Nine');
    expect(trigger).toHaveTextContent('Pick one');
  });
});

describe('§4.2 - `searchable` overrides the count in either direction', () => {
  it('searchable={true} forces the combobox at 3 options', () => {
    renderField({ options: optionsOf(3), searchable: true });
    expect(isCombobox()).toBe(true);
  });

  it('searchable={false} forces the plain select at 50 options', () => {
    renderField({ options: optionsOf(50), searchable: false });
    expect(isCombobox()).toBe(false);
  });
});

describe('§4.2 - a list the user can add to (`onCreate`)', () => {
  it('is the combobox at 3 options, with the fixed create row there before anything is typed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    renderField({ options: optionsOf(3), onCreate, createLabel: 'Create option' });
    expect(isCombobox()).toBe(true);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('textbox', { name: 'Search options' })).toHaveValue('');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual([
      'Option 0', 'Option 1', 'Option 2', 'Create option',
    ]);

    await user.click(screen.getByRole('option', { name: 'Create option' }));
    expect(onCreate).toHaveBeenCalledWith('');
  });

  it('without onCreate, the same 3 options stay the plain select', () => {
    renderField({ options: optionsOf(3) });
    expect(isCombobox()).toBe(false);
  });
});

describe('§4.2 - the threshold is written down exactly once', () => {
  it('one declaration in frontend/src, and it is 10', () => {
    // Built at runtime so this file's own source can never satisfy the regex.
    const declaration = new RegExp(`const\\s+${'SEARCH_THRESHOLD'}\\s*=\\s*(\\d+)`, 'g');
    // Vitest's root is `frontend/`, so the whole source tree is one join away.
    const root = join(process.cwd(), 'src');
    // The single home of the number. It moved out of `components/form/SelectField.tsx`
    // when the kit gained its own entry point: the app family may import from
    // `@/ui-kit/...` and the kit may not import back out, so the one shared
    // declaration has to live on the kit side of that boundary.
    const home = join(root, 'ui-kit/lib/selectThreshold.ts');
    expect(statSync(home).isFile()).toBe(true);
    const hits: { file: string; value: string }[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        for (const match of readFileSync(full, 'utf8').matchAll(declaration)) {
          hits.push({ file: full, value: match[1] ?? '' });
        }
      }
    };
    walk(root);

    expect(hits.map((h) => h.file)).toEqual([home]);
    expect(hits[0]?.value).toBe('10');
  });
});

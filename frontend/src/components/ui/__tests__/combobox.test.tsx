/**
 * Combobox - the searchable branch of DESIGN_SYSTEM.md §4.2 ("10 or more
 * options is a combobox; fewer than 10 is a plain select").
 *
 * §4.2 is explicit that filtering alone reads as unfinished, and every clause
 * it adds on top is behaviour a user can feel rather than a class string. This
 * file pins those clauses, one describe block each:
 *
 *   1. typing narrows the list;
 *   2. a query matches across EVERY field `searchFields` names, not the label
 *      alone - the inventory case, where one row has to be reachable by SKU,
 *      by name and by brand;
 *   3. the current selection survives a query that excludes it (the user must
 *      always be able to see what is chosen);
 *   4. the whole keyboard path - open, arrow, Enter selects, Esc closes and
 *      restores focus to the trigger;
 *   5. the empty state is named, not a blank panel;
 *   6. `onCreate` renders ONE fixed create row pinned below the list: there
 *      before anything is typed, the same row with the same label while
 *      searching and on no match, outside the scrolling area, and it hands
 *      over the (tidied) query - possibly the empty string.
 *
 * Case 6 replaced a row that only appeared after a user typed a name that did
 * not exist yet, which nobody discovered (Ran, 2026-10-01): a list the user
 * can add to always says so.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Combobox } from '@/components/ui/combobox';
import type { SelectFieldOption } from '@/components/form/SelectField';

afterEach(cleanup);

/** A real inventory shape: the SKU and the brand are not in the label. */
interface Item {
  value: string;
  label: string;
  sku: string;
  brand: string;
}

const ITEMS: Item[] = [
  { value: 'i1', label: 'Door Closer', sku: '241CRL91723001', brand: 'CRL' },
  { value: 'i2', label: 'Panic Bar', sku: '990VON55510', brand: 'Von Duprin' },
  { value: 'i3', label: 'Pivot Hinge', sku: '117JAC22004', brand: 'Jackson' },
];

const byValue = new Map(ITEMS.map((i) => [i.value, i]));
const itemSearchFields = (o: SelectFieldOption): string[] => {
  const item = byValue.get(o.value);
  return item ? [item.label, item.sku, item.brand] : [o.label];
};

const OPTIONS: SelectFieldOption[] = ITEMS.map(({ value, label }) => ({ value, label }));

/** Ten plain options - the smallest list §4.2 sends down this branch. */
const TEN: SelectFieldOption[] = Array.from({ length: 10 }, (_, i) => ({
  value: `v${i}`,
  label: `Option ${i}`,
}));

function Harness({
  initial = '',
  onChangeSpy,
  ...props
}: Partial<ComponentProps<typeof Combobox>> & {
  initial?: string;
  onChangeSpy?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Combobox
      aria-label="Item"
      placeholder="Select item..."
      options={OPTIONS}
      {...props}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChangeSpy?.(v);
      }}
    />
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Item' });
const searchBox = () => screen.getByRole('textbox', { name: 'Search options' });
const optionLabels = () =>
  screen.getAllByRole('option').map((el) => el.textContent?.trim() ?? '');
/** The DOM id of the nth rendered option - what aria-activedescendant points at. */
const optionIdAt = (index: number) => screen.getAllByRole('option')[index]?.id ?? '';

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return searchBox();
}

describe('1 - typing narrows the list', () => {
  it('renders every option before a query and only the matches after one', async () => {
    const user = userEvent.setup();
    render(<Harness options={TEN} />);
    const input = await open(user);

    expect(screen.getAllByRole('option')).toHaveLength(10);

    await user.type(input, 'Option 3');
    expect(optionLabels()).toEqual(['Option 3']);
  });

  it('matches case-insensitively', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await open(user);

    await user.type(input, 'door closer');
    expect(optionLabels()).toEqual(['Door Closer']);
  });
});

describe('2 - the query matches across every searchField, not the label alone', () => {
  it.each([
    ['the SKU', '241CRL91723001'],
    ['the brand', 'CRL'],
    ['the label', 'Door Closer'],
  ])('finds the same row by %s', async (_name, query) => {
    const user = userEvent.setup();
    render(<Harness searchFields={itemSearchFields} />);
    const input = await open(user);

    await user.type(input, query);
    expect(optionLabels()).toEqual(['Door Closer']);
  });

  it('matches the label alone when no searchFields is given, so the SKU finds nothing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await open(user);

    await user.type(input, '241CRL91723001');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});

describe('3 - the current selection survives a query that excludes it', () => {
  it('keeps the selected row rendered and marked selected', async () => {
    const user = userEvent.setup();
    render(<Harness initial="i1" searchFields={itemSearchFields} />);
    const input = await open(user);

    // "Panic Bar" cannot match "Door Closer" on any of its three fields.
    await user.type(input, 'Panic');

    const labels = optionLabels();
    expect(labels).toContain('Door Closer');
    expect(labels).toContain('Panic Bar');

    const pinned = screen.getAllByRole('option').find((el) => within(el).queryByText('Door Closer'));
    expect(pinned).toHaveAttribute('aria-selected', 'true');
  });

  it('does not duplicate the selection when the query DOES match it', async () => {
    const user = userEvent.setup();
    render(<Harness initial="i1" searchFields={itemSearchFields} />);
    const input = await open(user);

    await user.type(input, 'Door');
    expect(optionLabels()).toEqual(['Door Closer']);
  });
});

describe('4 - the keyboard path', () => {
  it('focuses the input on open, arrows to an option, Enter selects it, Esc closes and restores trigger focus', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);

    const triggerEl = trigger();
    await user.click(triggerEl);
    expect(triggerEl).toHaveAttribute('aria-expanded', 'true');

    const input = searchBox();
    expect(input).toHaveFocus();

    // The first option is active on open; one ArrowDown moves to the second.
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      optionIdAt(0)
    );
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      optionIdAt(1)
    );
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      optionIdAt(0)
    );

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChangeSpy).toHaveBeenCalledWith('i2');
    expect(trigger()).toHaveTextContent('Panic Bar');
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    // Re-open, then dismiss with Esc.
    await user.click(trigger());
    expect(searchBox()).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
  });

  it('resets the query on close, so re-opening shows the whole list again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await open(user);

    await user.type(input, 'Panic');
    expect(optionLabels()).toEqual(['Panic Bar']);

    await user.keyboard('{Escape}');
    await user.click(trigger());

    expect(searchBox()).toHaveValue('');
    expect(optionLabels()).toHaveLength(3);
  });
});

describe('5 - the empty state is named, never a blank panel', () => {
  it('renders the default No results text with the query in it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await open(user);

    await user.type(input, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No results for "zzz"')).toBeInTheDocument();
  });

  it('renders the caller\'s emptyText instead when one is given', async () => {
    const user = userEvent.setup();
    render(<Harness emptyText="No vendors match that name" />);
    const input = await open(user);

    await user.type(input, 'zzz');
    expect(screen.getByText('No vendors match that name')).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });
});

describe('6 - onCreate: one fixed create row, pinned below the list', () => {
  it('is there the moment the list opens - nothing typed - after every option', async () => {
    const user = userEvent.setup();
    render(<Harness onCreate={vi.fn()} createLabel="Create item" />);
    await open(user);

    expect(optionLabels()).toEqual(['Door Closer', 'Panic Bar', 'Pivot Hinge', 'Create item']);
  });

  it('stays - the same row, the same label - while searching and when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness onCreate={vi.fn()} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, 'Panic');
    expect(optionLabels()).toEqual(['Panic Bar', 'Create item']);

    await user.clear(input);
    await user.type(input, 'Astragal');
    expect(screen.getByText('No results for "Astragal"')).toBeInTheDocument();
    expect(optionLabels()).toEqual(['Create item']);
  });

  it('sits outside the scrolling list, so it can never scroll away or be filtered out', async () => {
    const user = userEvent.setup();
    render(<Harness options={TEN} onCreate={vi.fn()} createLabel="Create item" />);
    await open(user);

    const row = screen.getByRole('option', { name: 'Create item' });
    const scroller = screen.getByTestId('combobox-options');
    expect(scroller).toContainElement(screen.getByRole('option', { name: 'Option 0' }));
    expect(scroller).not.toContainElement(row);
    // Still a row of the one listbox, so a screen reader hears it as one of the choices.
    expect(screen.getByRole('listbox')).toContainElement(row);
  });

  it('with nothing typed, hands over the empty string and closes the list', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onChangeSpy = vi.fn();
    render(<Harness onCreate={onCreate} onChangeSpy={onChangeSpy} createLabel="Create item" />);
    await open(user);

    await user.click(screen.getByRole('option', { name: 'Create item' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('');
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('after typing, hands over the query tidied - even a name that already exists', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, '  Astragal   kit ');
    await user.click(screen.getByRole('option', { name: 'Create item' }));
    expect(onCreate).toHaveBeenLastCalledWith('Astragal kit');

    // The row does not judge the name; whoever finishes the record refuses a duplicate.
    const again = await open(user);
    await user.type(again, 'panic bar');
    expect(optionLabels()).toEqual(['Panic Bar', 'Create item']);
    await user.click(screen.getByRole('option', { name: 'Create item' }));
    expect(onCreate).toHaveBeenLastCalledWith('panic bar');
  });

  it('reads "Create new" when the caller names nothing', async () => {
    const user = userEvent.setup();
    render(<Harness onCreate={vi.fn()} />);
    await open(user);

    expect(screen.getByRole('option', { name: 'Create new' })).toBeInTheDocument();
  });

  it('offers no create row when the caller passed no onCreate', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await open(user);

    expect(optionLabels()).toEqual(['Door Closer', 'Panic Bar', 'Pivot Hinge']);
    await user.type(input, 'Astragal');
    expect(screen.getByText('No results for "Astragal"')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('filters on the tidied query, so extra spaces still find an option', async () => {
    const user = userEvent.setup();
    render(<Harness onCreate={vi.fn()} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, '  panic   bar ');
    expect(optionLabels()).toEqual(['Panic Bar', 'Create item']);
  });

  it('the create row is a keyboard option: arrows reach it with nothing typed, and Enter creates', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onChangeSpy = vi.fn();
    render(<Harness onCreate={onCreate} onChangeSpy={onChangeSpy} createLabel="Create item" />);
    const input = await open(user);

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Create item' }).id);
    await user.keyboard('{Enter}');

    expect(onCreate).toHaveBeenCalledWith('');
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('when nothing matches, Enter creates with what was typed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness onCreate={onCreate} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, 'Astragal');
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Astragal');
  });

  it('with only the pinned selection on screen, Enter creates instead of re-picking it', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onChangeSpy = vi.fn();
    render(<Harness initial="i1" onCreate={onCreate} onChangeSpy={onChangeSpy} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, 'Astragal');
    await user.keyboard('{Enter}');

    expect(onCreate).toHaveBeenCalledWith('Astragal');
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('names the query in a caller\'s no-match line', async () => {
    const user = userEvent.setup();
    render(<Harness emptyText={(q) => `Nothing called "${q}"`} />);
    const input = await open(user);

    await user.type(input, ' Astragal ');
    expect(screen.getByText('Nothing called "Astragal"')).toBeInTheDocument();
  });

  it('a query that only re-finds the pinned current selection is still a no-match', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness initial="i1" searchFields={itemSearchFields} onCreate={onCreate} createLabel="Create item" />);
    const input = await open(user);

    await user.type(input, 'Astragal');

    // The selection is still visible (clause 3) ...
    expect(optionLabels()).toEqual(['Door Closer', 'Create item']);
    // ... but it is not a MATCH, so the no-match line still names the query.
    expect(screen.getByText('No results for "Astragal"')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Create item' }));
    expect(onCreate).toHaveBeenCalledWith('Astragal');
  });
});

describe('the trigger is indistinguishable from SelectTrigger', () => {
  it('renders the shared selectTriggerVariants class string', async () => {
    render(<Harness />);
    const cls = trigger().getAttribute('class') ?? '';
    for (const token of ['h-10', 'rounded', 'border-border', 'bg-surface-light', 'px-3', 'text-sm']) {
      expect(cls.split(' ')).toContain(token);
    }
  });

  it('carries data-placeholder while nothing is selected, and drops it once something is', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(trigger()).toHaveAttribute('data-placeholder');
    expect(trigger()).toHaveTextContent('Select item...');

    await open(user);
    await user.click(screen.getByRole('option', { name: /Panic Bar/ }));

    expect(trigger()).not.toHaveAttribute('data-placeholder');
    expect(trigger()).toHaveTextContent('Panic Bar');
  });
});

describe('a caller can observe the list and mark a row (slice 07, MultiAssigneeSelect)', () => {
  it('reports every open and close through onOpenChange - including a close by picking', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await open(user);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole('option', { name: /Panic Bar/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('renders renderOptionSuffix on the row, not in the label the trigger or the filter read', async () => {
    const user = userEvent.setup();
    render(
      <Harness renderOptionSuffix={(o) => (o.value === 'i2' ? <span>Flagged</span> : null)} />,
    );

    await open(user);
    expect(screen.getByRole('option', { name: /Panic Bar/ })).toHaveTextContent('Flagged');
    expect(screen.getByRole('option', { name: /Door Closer/ })).not.toHaveTextContent('Flagged');

    await user.type(searchBox(), 'flagged');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('does not stop a click outside from reaching its target - the list is not modal', async () => {
    const user = userEvent.setup();
    const onOutside = vi.fn();
    render(
      <>
        <Harness />
        <button type="button" onClick={onOutside}>Save</button>
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save' });

    await open(user);
    await user.click(save);

    expect(onOutside).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});

describe('the arrow keys open the list from the focused trigger (standard combobox pattern)', () => {
  it.each(['{ArrowDown}', '{ArrowUp}'])('%s on the trigger opens the list with the search box focused', async (key) => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();

    await user.keyboard(key);

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(searchBox()).toHaveFocus();
    expect(optionLabels()).toEqual(['Door Closer', 'Panic Bar', 'Pivot Hinge']);
  });

  it('then picks with the same keys as always: ArrowDown moves, Enter commits', async () => {
    const user = userEvent.setup();
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    trigger().focus();

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChangeSpy).toHaveBeenCalledWith('i2');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a disabled trigger does not open on an arrow key', async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    trigger().focus();

    await user.keyboard('{ArrowDown}');

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});

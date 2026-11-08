/**
 * SelectField - the props that let an app-family call site through the §4.2
 * door at all, pinned on BOTH branches.
 *
 * §4.2's promise is that crossing ten changes whether the list is searchable
 * and NOTHING else. Every prop this file covers was added because a real call
 * site could not convert without it, and each one is asserted twice - once at
 * nine options (the plain Radix Select) and once at ten (the Combobox) - because
 * a prop honoured on one branch only would make the tenth option visibly
 * restyle the control, which is exactly the thing the rule promises cannot
 * happen.
 *
 *   A. `id` / `aria-describedby` / `aria-invalid` - FormField's render-prop
 *      escape hatch spreads all three onto the trigger. Without `id` the
 *      `<label htmlFor>` association silently breaks, which no existing test
 *      would have caught.
 *   B. `size` - `xs` is `h-8 text-xs`, so the rung carries a FONT change as
 *      well as a height one. Forwarding only the height would still restyle
 *      the trigger.
 *   C. `tone` - the sage deposit-box treatment (ReceiptCard).
 *   D. per-option `className` - TaskDetailDrawer's dense `text-xs` rows.
 *   E. `group` - InboxDirectory's Groups/People, StageDetailDialog's four
 *      location types. Nothing is emitted when no option carries one.
 *   F. `action` - a pinned trailing row that is NOT a choice. It must fire
 *      `onSelect`, must NOT fire `onValueChange`, and on the searchable branch
 *      must survive a query that matches nothing.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectField, type SelectFieldOption } from '@/components/form/SelectField';

afterEach(cleanup);

const optionsOf = (count: number, extra: Partial<SelectFieldOption> = {}): SelectFieldOption[] =>
  Array.from({ length: count }, (_, i) => ({ value: `v${i}`, label: `Option ${i}`, ...extra }));

/** Nine is the plain Select; ten is the Combobox. Both, every time. */
const BRANCHES: [string, number][] = [
  ['select branch (9 options)', 9],
  ['combobox branch (10 options)', 10],
];

const trigger = () => screen.getByRole('combobox', { name: 'Field' });

const renderField = (props: Partial<React.ComponentProps<typeof SelectField>>) =>
  render(
    <SelectField
      value=""
      onValueChange={() => {}}
      aria-label="Field"
      placeholder="Pick one"
      options={optionsOf(9)}
      {...props}
    />
  );

/**
 * Opens whichever branch rendered. The Radix trigger and the Combobox trigger
 * are the same role, and a click opens both, so the callers below do not have
 * to know which one they got.
 */
const openList = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(trigger());
  return screen.findAllByRole('option');
};

describe.each(BRANCHES)('%s', (_name, count) => {
  const base = optionsOf(count);

  describe('A - the FormField render-prop attributes land on the trigger', () => {
    it('forwards id, aria-describedby and aria-invalid', () => {
      renderField({
        options: base,
        id: 'field-1',
        'aria-describedby': 'field-1-hint',
        'aria-invalid': true,
      });
      const el = trigger();
      expect(el).toHaveAttribute('id', 'field-1');
      expect(el).toHaveAttribute('aria-describedby', 'field-1-hint');
      expect(el).toHaveAttribute('aria-invalid', 'true');
    });

    it('emits none of the three when they are not passed', () => {
      renderField({ options: base });
      const el = trigger();
      expect(el).not.toHaveAttribute('aria-describedby');
      expect(el).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('B - `size` carries height AND font', () => {
    it('xs is h-8 text-xs', () => {
      renderField({ options: base, size: 'xs' });
      expect(trigger()).toHaveClass('h-8', 'text-xs');
    });

    it('the default rung is h-10 text-sm, unchanged', () => {
      renderField({ options: base });
      expect(trigger()).toHaveClass('h-10', 'text-sm');
      expect(trigger()).not.toHaveClass('h-8');
    });
  });

  describe('C - `tone`', () => {
    it('sage paints the deposit-box border and text', () => {
      renderField({ options: base, tone: 'sage' });
      expect(trigger()).toHaveClass('border-sage-200', 'text-sage-700');
    });

    it('default paints neither', () => {
      renderField({ options: base });
      expect(trigger()).not.toHaveClass('border-sage-200');
    });
  });

  describe('D - per-option `className`', () => {
    it('lands on the option row', async () => {
      const user = userEvent.setup();
      renderField({ options: optionsOf(count, { className: 'text-xs' }) });
      const options = await openList(user);
      for (const option of options) expect(option).toHaveClass('text-xs');
    });

    it('is absent when no option asks for it', async () => {
      const user = userEvent.setup();
      renderField({ options: base });
      const options = await openList(user);
      expect(options[0]).not.toHaveClass('text-xs');
    });
  });

  describe('E - option grouping', () => {
    const grouped = base.map((o, i) => ({ ...o, group: i % 2 === 0 ? 'Groups' : 'People' }));

    it('renders a headed section per group, in first-seen order', async () => {
      const user = userEvent.setup();
      renderField({ options: grouped });
      await openList(user);

      const sections = screen.getAllByRole('group');
      expect(sections).toHaveLength(2);
      expect(sections[0]).toHaveTextContent('Groups');
      expect(sections[1]).toHaveTextContent('People');
      // Every option is inside one of the two sections - none escaped.
      expect(
        sections.flatMap((s) => within(s).getAllByRole('option')).length
      ).toBe(count);
    });

    it('emits NO group node when no option carries a group', async () => {
      const user = userEvent.setup();
      renderField({ options: base });
      await openList(user);
      expect(screen.queryAllByRole('group')).toHaveLength(0);
    });
  });

  describe('F - the pinned `action` row', () => {
    const action = (onSelect: () => void) => ({ label: '+ Add new…', onSelect });

    it('renders last, fires onSelect and never onValueChange', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onValueChange = vi.fn();
      renderField({ options: base, onValueChange, action: action(onSelect) });

      const options = await openList(user);
      expect(options).toHaveLength(count + 1);
      expect(options[count]).toHaveTextContent('+ Add new…');

      await user.click(options[count]!);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('picking a real option still calls onValueChange, not onSelect', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const onValueChange = vi.fn();
      renderField({ options: base, onValueChange, action: action(onSelect) });

      const options = await openList(user);
      await user.click(options[0]!);
      expect(onValueChange).toHaveBeenCalledWith('v0');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('adds no extra row when no action is given', async () => {
      const user = userEvent.setup();
      renderField({ options: base });
      expect(await openList(user)).toHaveLength(count);
    });
  });
});

/**
 * The action row is not one of the choices §4.2 counts. If it were, nine real
 * choices plus an "+ Add tax rate" row would get search here and stay a plain
 * select on the surface next door - the rule would stop being about the number
 * of things the user is choosing between.
 */
describe('F - the action row is not counted against the threshold', () => {
  it('nine options plus an action is still the plain select', () => {
    renderField({ options: optionsOf(9), action: { label: '+ Add new…', onSelect: () => {} } });
    // Only the Combobox trigger sets aria-haspopup - see select-field.test.tsx.
    expect(trigger()).not.toHaveAttribute('aria-haspopup', 'listbox');
  });
});

/**
 * The half of `action` that only the searchable branch can be asked about, and
 * the reason "pinned" is the word in its contract: a user who types a query
 * matching nothing must STILL be able to reach "+ Add new category…" - that is
 * the whole point of VendorCategoryPicker's row.
 */
describe('F (combobox only) - the action row survives filtering', () => {
  it('stays reachable under a query that matches nothing', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onValueChange = vi.fn();
    renderField({
      options: optionsOf(10),
      onValueChange,
      action: { label: '+ Add new…', onSelect },
    });

    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'zzzzz');

    // Nothing matched...
    expect(screen.getByText('No results for "zzzzz"')).toBeInTheDocument();
    // ...and the action is the only row left.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('+ Add new…');

    await user.click(options[0]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('is reachable from the keyboard past the last option', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderField({ options: optionsOf(10), action: { label: '+ Add new…', onSelect } });

    await user.click(trigger());
    const input = screen.getByRole('textbox', { name: 'Search options' });
    // Ten options, then the action row: eleven ArrowDowns from the top row
    // wraps back to the top, so ten lands exactly on the action.
    for (let i = 0; i < 10; i += 1) await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      screen.getAllByRole('option')[10]?.id
    );

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

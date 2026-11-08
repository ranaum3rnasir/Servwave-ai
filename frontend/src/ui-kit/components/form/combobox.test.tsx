/**
 * Combobox - the dropdown list must stay scrollable by mouse wheel even when the
 * combobox is opened inside a modal <Dialog> (SERV10X calendar-entries QA finding:
 * the "Add team member…" list in the New Event dialog opened but a mouse wheel over
 * it did nothing).
 *
 * Root cause (traced through @radix-ui/react-dialog + react-remove-scroll source, not
 * guessed): a modal Dialog wraps its content in `RemoveScroll` with
 * `shards: [context.contentRef]` - i.e. it only exempts the Dialog's own content node
 * from its scroll lock. The Popover this Combobox renders portals to `document.body`
 * by default (Radix's default Portal container), which puts it OUTSIDE that shard.
 * `react-remove-scroll` installs a `document`-level, capture-phase `wheel` listener
 * that calls `preventDefault()` on any wheel event whose target isn't inside the
 * Dialog's shard - so the list's own `overflow-y-auto` (present and correctly bounded
 * already) never gets a chance to run its native scroll. Keyboard arrows still work
 * because cmdk drives those via `scrollIntoView`, not a wheel event - which is exactly
 * why QA saw "opens fine, arrows work, wheel does nothing."
 *
 * First pass drove `scrollTop` from the JSX `onWheel` prop and called
 * `event.preventDefault()` there. Real-browser QA caught that this is dead code: React
 * always attaches its own delegated `wheel` listener as `{ passive: true }` when the
 * browser supports it (not configurable per element), so `preventDefault()` inside a
 * React `onWheel` handler can never take effect - it only logged "Unable to
 * preventDefault inside passive event listener invocation" once per tick. The fix
 * attaches a real listener directly to the list node with `addEventListener('wheel',
 * …, { passive: false })` in a `useEffect`, which is the only way to make
 * `preventDefault()` actually take effect.
 *
 * jsdom does not run real layout or perform real scrolling, so a test cannot prove the
 * wheel visibly moves the list on screen - a human confirms that in a browser. What
 * these tests assert instead is the structural fix: the list is a bounded, overflow-y
 * scrollable region (unchanged - it was never the problem); a wheel event drives
 * `scrollTop` directly; and - the part that actually matters after the browser
 * finding - the handler reaches the DOM through a genuine non-passive
 * `addEventListener` call, not the JSX prop React forces passive.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Combobox, type ComboboxOption } from './combobox';

const OPTIONS: ComboboxOption[] = [
  { value: 'alice', label: 'Alice Anders' },
  { value: 'bob', label: 'Bob Baker' },
  { value: 'cara', label: 'Cara Chu' },
];

function setup(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <Combobox
      options={OPTIONS}
      onValueChange={onValueChange}
      aria-label="Add team member"
      {...props}
    />,
  );
  return { onValueChange, ...utils };
}

async function openList() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Add team member' }));
  return user;
}

describe('Combobox', () => {
  it('renders the list as a bounded, overflow-y scrollable region', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]');
    expect(list).toBeInTheDocument();
    // max-h-64 + overflow-y-auto is what makes the list a scroll container at
    // all once its content outgrows the bound - both were already present
    // before this fix and are not what QA's bug was about.
    expect(list?.className).toMatch(/max-h-64/);
    expect(list?.className).toMatch(/overflow-y-auto/);
  });

  it('drives scrollTop from a wheel event instead of relying only on native scroll', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true });

    fireEvent.wheel(list, { deltaY: 40 });

    // This is the mechanism that survives an ancestor modal's scroll-lock
    // calling preventDefault() on the same event: the list moves via a JS
    // assignment we own, not via the browser's native wheel-scroll action,
    // which is exactly what a Dialog's react-remove-scroll shard check can
    // (and here, does) suppress.
    expect(list.scrollTop).toBe(40);
  });

  it('wires the scroll handler as a real, non-passive addEventListener call - not the JSX onWheel prop React forces passive', async () => {
    const calls: { target: EventTarget; type: string; options: unknown }[] = [];
    const original = EventTarget.prototype.addEventListener;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      handler: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      calls.push({ target: this, type, options });
      return original.call(this, type, handler, options);
    });

    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;

    // The bug QA found is specifically that a JSX `onWheel` prop's preventDefault()
    // is dead code, because React always registers ITS OWN delegated wheel listener
    // as passive. Proving the fix means proving the list's own scroll handler is a
    // separate, real DOM listener explicitly opted out of that - not that some
    // "wheel" listener merely exists somewhere.
    const wheelListener = calls.find(
      (call) => call.target === list && call.type === 'wheel',
    );
    expect(wheelListener).toBeDefined();
    expect(wheelListener?.options).toMatchObject({ passive: false });
  });

  it('actually prevents the wheel event default through that listener', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;
    const event = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent;
    Object.defineProperty(event, 'deltaY', { value: 40 });

    list.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('keyboard navigation and selection still work unchanged', async () => {
    const { onValueChange } = setup();
    const user = await openList();

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('bob');
  });

  it('type-ahead filtering still narrows the list', async () => {
    setup();
    const user = await openList();

    await user.type(screen.getByPlaceholderText('Search…'), 'Cara');

    expect(screen.getByText('Cara Chu')).toBeInTheDocument();
    expect(screen.queryByText('Alice Anders')).not.toBeInTheDocument();
  });
});

/**
 * Re-selecting the option that is already selected.
 *
 * This used to emit `''` - a toggle-off - which made the control DELETE the
 * value on a gesture the plain `Select` treats as a no-op. That is not a
 * styling difference: it means crossing ten options changes what the control
 * emits, and §4.2 promises the opposite ("the same control, just searchable").
 * Above ten departments, re-picking the active department on the schedule
 * filter cleared the filter.
 *
 * The reference behaviour is a CONTROLLED Radix `Select`: its item selection
 * runs through `useControllableState`, whose `setValue` calls `onChange` only
 * `if (value !== prop)`. So the right answer is silence, not a re-emit - the
 * cross-branch half of this is pinned in `selectField.test.tsx`.
 */
describe('Combobox - selecting the option that is already selected', () => {
  it('does not clear the value', async () => {
    const { onValueChange } = setup({ value: 'bob' });
    const user = await openList();

    // By role, not by text: with `value='bob'` the trigger shows "Bob Baker"
    // too, so a bare text query matches the button as well as the row.
    await user.click(screen.getByRole('option', { name: 'Bob Baker' }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('still closes the panel', async () => {
    setup({ value: 'bob' });
    const user = await openList();

    await user.click(screen.getByRole('option', { name: 'Bob Baker' }));

    expect(screen.queryByPlaceholderText('Search…')).toBeNull();
  });

  it('and a DIFFERENT option still emits its own value', async () => {
    const { onValueChange } = setup({ value: 'bob' });
    const user = await openList();

    await user.click(screen.getByRole('option', { name: 'Cara Chu' }));

    expect(onValueChange).toHaveBeenCalledWith('cara');
  });
});

/**
 * Placement props forwarded to `PopoverContent`.
 *
 * `@radix-ui/react-popover`'s content and `@radix-ui/react-select`'s content
 * both extend the same `PopperContentProps`, so `side`/`align`/
 * `avoidCollisions`/`collisionPadding` mean the same thing on both branches of
 * §4.2 - which is what lets a filter-panel call site keep its "always open
 * downward" pin when its list grows past ten.
 */
describe('Combobox - placement', () => {
  // `side="top"`, not the call sites' `"bottom"`: Radix's own default IS
  // bottom, so asserting bottom would pass just as well on a build that
  // forwards nothing at all.
  it('forwards side to the popover content', async () => {
    setup({ side: 'top', avoidCollisions: false });
    await openList();

    expect(
      document.querySelector('[data-slot="popover-content"]')?.getAttribute('data-side'),
    ).toBe('top');
  });

  it('defaults to align="start" when the caller says nothing', async () => {
    setup();
    await openList();

    expect(
      document.querySelector('[data-slot="popover-content"]')?.getAttribute('data-align'),
    ).toBe('start');
  });

  it('honours an explicit align', async () => {
    setup({ align: 'end' });
    await openList();

    expect(
      document.querySelector('[data-slot="popover-content"]')?.getAttribute('data-align'),
    ).toBe('end');
  });
});

describe('Combobox - onCreate (a list the user can add to always shows one fixed create row)', () => {
  const OPTIONS = [
    { value: 'a', label: 'Follow-up' },
    { value: 'b', label: 'Part order' },
  ];
  const optionLabels = () => screen.getAllByRole('option').map((el) => el.textContent?.trim() ?? '');

  it('shows the row the moment the list opens - nothing typed - after every option', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} onCreate={vi.fn()} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(optionLabels()).toEqual(['Follow-up', 'Part order', 'Create category']);
  });

  it('keeps the same row, with the same label, while searching and when nothing matches', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={OPTIONS}
        onCreate={vi.fn()}
        createLabel="Create category"
        emptyMessage={(q) => `No category matches "${q}"`}
        aria-label="Category"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const search = screen.getByPlaceholderText('Search…');

    await user.type(search, 'Part');
    expect(optionLabels()).toEqual(['Part order', 'Create category']);
    expect(screen.queryByText(/^No category matches/)).not.toBeInTheDocument();

    // An exact name changes nothing either: the row does not judge what was typed.
    await user.clear(search);
    await user.type(search, '  part   ORDER ');
    expect(optionLabels()).toEqual(['Part order', 'Create category']);

    await user.clear(search);
    await user.type(search, 'Warranty');
    expect(screen.getByText('No category matches "Warranty"')).toBeInTheDocument();
    expect(optionLabels()).toEqual(['Create category']);
  });

  it('sits outside the scrolling area, below a divider, so it never scrolls away', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} onCreate={vi.fn()} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const row = screen.getByRole('option', { name: 'Create category' });
    const option = screen.getByRole('option', { name: 'Follow-up' });
    // The options' own scroll container does not hold the row.
    const scroller = option.closest('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller).not.toContainElement(row);
    // Still one of the listbox's options, so assistive tech hears it with the choices.
    expect(screen.getByRole('listbox')).toContainElement(row);
    // The divider sits between the list and the row.
    const separator = document.querySelector('[data-slot="command-separator"]');
    expect(separator).not.toBeNull();
    expect(separator!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator!.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('with nothing typed, hands over the empty string, closes, and never picks a value', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onValueChange = vi.fn();
    render(<Combobox options={OPTIONS} onValueChange={onValueChange} onCreate={onCreate} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByRole('option', { name: 'Create category' }));

    expect(onCreate).toHaveBeenCalledWith('');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('after typing, hands over the query tidied', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Combobox options={OPTIONS} onCreate={onCreate} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(screen.getByPlaceholderText('Search…'), ' Warranty   claim ');
    await user.click(screen.getByRole('option', { name: 'Create category' }));
    expect(onCreate).toHaveBeenCalledWith('Warranty claim');
  });

  it('reads "Create new" when the caller names nothing', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} onCreate={vi.fn()} aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(screen.getByRole('option', { name: 'Create new' })).toBeInTheDocument();
  });

  it('is keyboard reachable: arrow down past the options to it, Enter creates', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onValueChange = vi.fn();
    render(<Combobox options={OPTIONS} onValueChange={onValueChange} onCreate={onCreate} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const row = screen.getByRole('option', { name: 'Create category' });
    for (let i = 0; i < OPTIONS.length && row.getAttribute('aria-selected') !== 'true'; i += 1) {
      await user.keyboard('{ArrowDown}');
    }
    expect(row).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(onCreate).toHaveBeenCalledWith('');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('when nothing matches, Enter creates with what was typed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Combobox options={OPTIONS} onCreate={onCreate} createLabel="Create category" aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(screen.getByPlaceholderText('Search…'), 'Warranty');
    await user.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Warranty');
  });

  it('wheel-scrolls the options area, not the panel, when the row is pinned below it', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} onCreate={vi.fn()} aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const scroller = screen.getByRole('option', { name: 'Follow-up' }).closest('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });
    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(scroller.scrollTop).toBe(40);
  });

  it('filters on the tidied query, so a spacing variant of a name still finds it', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} onCreate={vi.fn()} aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const search = screen.getByPlaceholderText('Search…');
    for (const typed of ['Part order ', '  part   ORDER']) {
      await user.clear(search);
      await user.type(search, typed);
      expect(screen.getByRole('option', { name: 'Part order' })).toBeInTheDocument();
    }
  });

  it('names the query in a caller\'s no-match line', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} emptyMessage={(q) => `No category matches "${q}"`} aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(screen.getByPlaceholderText('Search…'), ' Warranty ');
    expect(screen.getByText('No category matches "Warranty"')).toBeInTheDocument();
  });

  it('offers nothing to create without onCreate', async () => {
    const user = userEvent.setup();
    render(<Combobox options={OPTIONS} aria-label="Category" />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(optionLabels()).toEqual(['Follow-up', 'Part order']);
    expect(document.querySelector('[data-slot="command-separator"]')).toBeNull();
    await user.type(screen.getByPlaceholderText('Search…'), 'Part');
    expect(optionLabels()).toEqual(['Part order']);
  });
});

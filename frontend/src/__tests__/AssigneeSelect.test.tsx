/**
 * Regression guard for #514 — Owner field keyboard typeahead auto-assigns wrong user.
 *
 * The old AssigneeSelect wrapped a Radix Select whose closed-trigger typeahead
 * committed the first prefix-matching item on a single keystroke (typing "S"
 * instantly assigned "Sherry Dispatcher", making "Sagiv" unreachable). The fix
 * replaces it with a Popover + search Input combobox that only commits on an
 * explicit item click. These tests lock that behavior in.
 *
 * AssigneeSelect is now a thin adapter over `components/ui/combobox` (§4.2's
 * searchable branch), which was itself built from this file's original hand-
 * rolled composition. Everything above still has to hold through the primitive
 * - that is most of what these tests are for now. The second half of the file
 * covers the part the ADAPTER still owns and the primitive cannot know about:
 * the `{ value, label, group }` mapping, the department order baked into it,
 * and the assignee-specific empty text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { type AssignableUser } from '@/lib/api/users';

const MOCK_USERS: AssignableUser[] = [
  { id: 'sherry', first_name: 'Sherry', last_name: 'Dispatcher', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
  { id: 'sagiv', first_name: 'Sagiv', last_name: 'Peker', role: 'ADMIN', is_active: true, has_login: true, department: null },
];

// Mutable so a single test can swap the pool; the factory body never
// dereferences it (the arrow is called at render time), so there is no TDZ
// problem with vi.mock's hoisting. Named `mock*` per vitest's hoisting rule.
let mockUsers: AssignableUser[] = MOCK_USERS;

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: mockUsers, isLoading: false })),
}));

beforeEach(() => {
  mockUsers = MOCK_USERS;
});

describe('AssigneeSelect (#514 keyboard typeahead)', () => {
  it('does NOT auto-assign anyone on initial render', () => {
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} purpose="task" eligibleFor="task" />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens a dropdown listing all matching users when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Sherry Dispatcher'))).toBe(true);
    expect(labels.some((l) => l.includes('Sagiv Peker'))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters by search text without committing a selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'Sa');

    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Sagiv Peker'))).toBe(true);
    expect(labels.some((l) => l.includes('Sherry Dispatcher'))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits exactly once, with the clicked user id, only on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'Sa');
    await user.click(screen.getByRole('option', { name: /Sagiv Peker/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('sagiv');
  });
});

describe('AssigneeSelect option list scrolling inside a Dialog', () => {
  // The list container is the primitive's (`combobox-options`) since the
  // conversion; the assertions below are unchanged, and still worth keeping
  // HERE - AssigneeSelect is the surface that actually mounts inside a Dialog
  // (TeamCard's dispatcher dialog), which is the bug this locks down.
  it('keeps wheel and touchmove events from reaching the document scroll lock', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} purpose="task" eligibleFor="task" />);
    await user.click(screen.getByRole('combobox'));

    const list = screen.getByTestId('combobox-options');
    // react-remove-scroll (used by Dialog) listens on `document` and
    // preventDefault()s any wheel/touchmove outside DialogContent. If either
    // event reaches the document, the list cannot scroll.
    const onDocumentWheel = vi.fn();
    const onDocumentTouchMove = vi.fn();
    document.addEventListener('wheel', onDocumentWheel);
    document.addEventListener('touchmove', onDocumentTouchMove);
    try {
      list.dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('wheel', onDocumentWheel);
      document.removeEventListener('touchmove', onDocumentTouchMove);
    }

    expect(onDocumentWheel).not.toHaveBeenCalled();
    expect(onDocumentTouchMove).not.toHaveBeenCalled();
  });

  it('caps the option list height so it scrolls instead of overflowing the popover', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} purpose="task" eligibleFor="task" />);
    await user.click(screen.getByRole('combobox'));

    const list = screen.getByTestId('combobox-options');
    expect(list.className).toContain('max-h-60');
    expect(list.className).toContain('overflow-y-auto');
  });
});

/* -----------------------------------------------------------------------------
   What the ADAPTER owns after the conversion.

   The primitive is tested once, in components/ui/__tests__/combobox.test.tsx.
   What it cannot know is how a user becomes an option: the label the query is
   matched against, the department heading, the order those headings come in,
   and the empty text. Each test below fails on a different single edit to
   AssigneeSelect.tsx, which is the point of splitting them out.
   -------------------------------------------------------------------------- */

const GROUPED_USERS: AssignableUser[] = [
  // Deliberately NOT in the rendered order: insertion order is Sales, then no
  // department, then Admin, so a test that passes on this fixture is reading
  // the comparator rather than the fetch order.
  { id: 'zed', first_name: 'Zed', last_name: 'Sales', role: 'STAFF', is_active: true, has_login: true, department: { id: 'd-sales', name: 'Sales' } },
  { id: 'amy', first_name: 'Amy', last_name: 'Nobody', role: 'STAFF', is_active: true, has_login: true, department: null },
  { id: 'bob', first_name: 'Bob', last_name: 'Ops', role: 'STAFF', is_active: true, has_login: true, department: { id: 'd-admin', name: 'Admin' } },
];

describe('AssigneeSelect department grouping (adapter-owned)', () => {
  it('heads each user with their department, alphabetical and "No department" last', async () => {
    const user = userEvent.setup();
    mockUsers = GROUPED_USERS;
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));

    // The headings are the primitive's role="group" aria-labels, so this reads
    // the rendered sections rather than a class-name-shaped div.
    const headings = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(headings).toEqual(['Admin', 'Sales', 'No department']);
  });

  it('still lists every user exactly once under the headings', async () => {
    const user = userEvent.setup();
    mockUsers = GROUPED_USERS;
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));

    const labels = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
    expect(labels).toEqual(['Bob Ops', 'Zed Sales', 'Amy Nobody']);
  });

  it('commits the user under the heading the arrow keys walk to, not the fetch order', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockUsers = GROUPED_USERS;
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    // Row 0 is Bob (Admin, sorted first) - ArrowDown once lands on Zed (Sales).
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('zed');
  });
});

describe('AssigneeSelect empty state (adapter-owned)', () => {
  it('says "No users found", not the primitive\'s generic default', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} purpose="task" eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'zzzz');

    expect(screen.getByText('No users found')).toBeInTheDocument();
    // The default the primitive would have shown had this file not overridden it.
    expect(screen.queryByText('No results for "zzzz"')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
   The single-select half of "names come from the record, not the roster".

   `Combobox` derives its trigger label from `options`, so a `value` the SCOPED
   roster does not contain renders as nothing at all - the dispatcher currently
   on a job vanishes from the control for a viewer without `assign User`. Only
   the person matching `value` is adopted from `knownPeople`, so this widens the
   label and never the list of people who may be chosen.
   -------------------------------------------------------------------------- */

describe('AssigneeSelect - labelling a value the scoped roster does not contain', () => {
  it('shows the record\'s name on the trigger instead of nothing', () => {
    mockUsers = [];
    renderWithProviders(
      <AssigneeSelect
        value="gone"
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[{ id: 'gone', first_name: 'Dana', last_name: 'Dispatcher' }]}
      />,
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Dana Dispatcher');
  });

  it('adopts ONLY the current value, never the rest of the record\'s people', async () => {
    const user = userEvent.setup();
    mockUsers = [];
    renderWithProviders(
      <AssigneeSelect
        value="gone"
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[
          { id: 'gone', first_name: 'Dana', last_name: 'Dispatcher' },
          { id: 'other', first_name: 'Otto', last_name: 'Other' },
        ]}
      />,
    );

    await user.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
    expect(options).toEqual(['Dana Dispatcher']);
  });

  it('leaves the roster alone when it already knows the value', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AssigneeSelect
        value="sagiv"
        onChange={vi.fn()}
        purpose="jobCrew"
        knownPeople={[{ id: 'sagiv', first_name: 'Stale', last_name: 'Copy' }]}
      />,
    );

    await user.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
    // Two rows, not three: the record's copy is not appended alongside the roster's.
    expect(options).toEqual(['Sherry Dispatcher', 'Sagiv Peker']);
    expect(screen.queryByText('Stale Copy')).not.toBeInTheDocument();
  });
});

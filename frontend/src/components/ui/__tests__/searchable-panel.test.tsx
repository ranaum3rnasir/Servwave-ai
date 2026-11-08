/**
 * SearchablePanel - the entity-filter pill family (DESIGN_SYSTEM.md §4.2,
 * "entity-filter pills are always searchable").
 *
 * Every clause this pins is behaviour a user can feel, not a class string:
 *
 *   1. the search box is there at ANY row count - six locations get it, and so
 *      does an empty list. There is no threshold to be off-by-one against;
 *   2. typing narrows the rows;
 *   3. a query matches the SUBTITLE as well as the label - "Brooklyn" has to
 *      find "Mike's Van", whose label contains neither;
 *   4. the pinned footer CTA SURVIVES a query that matches nothing, and still
 *      fires. This is the load-bearing one: no-match is exactly the moment the
 *      user wants "+ Add category", so a footer inside the filtered list
 *      would remove the affordance precisely when it is needed;
 *   5. so does the reset row - "show me everything again" is never filtered
 *      away;
 *   6. no-match says so by name, and is a different state from having no rows
 *      at all;
 *   7. the query does not survive the panel closing.
 *
 * Clauses 4 and 5 are asserted through the real `CategorySelector` as well as
 * through the primitive, because "the call site declares nothing" is the whole
 * claim and only a real call site can test it.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchablePanel, type SearchablePanelRow } from '@/components/ui/searchable-panel';
import { CategorySelector } from '@/components/inventory/CategorySelector';
import { StagingAreaPicker } from '@/components/inventory/StagingAreaPicker';
import type { Category, Item, Location } from '@/lib/api/inventory';

afterEach(cleanup);

/** The real Location shape: the label carries none of the subtitle's words. */
const VANS = [
  { id: 'v1', name: "Mike's Van", sub: 'Brooklyn HQ · Mike Alvarez · Ford Transit · BX-4421' },
  { id: 'v2', name: "Jose's Van", sub: 'Brooklyn HQ · Jose Ramirez · Ford Transit · BX-5108' },
  { id: 'v3', name: "Carlos's Van", sub: 'Queens Branch · Carlos Tran · Mercedes Sprinter · QN-9920' },
  { id: 'v4', name: 'Main Warehouse', sub: 'Brooklyn HQ · Warehouse' },
  { id: 'v5', name: 'Queens Warehouse', sub: 'Queens Branch · Warehouse' },
  { id: 'v6', name: 'Counter Shop', sub: 'Brooklyn HQ · Counter' },
];

function rowsFrom(source: typeof VANS): SearchablePanelRow[] {
  return source.map((l) => ({
    key: l.id,
    label: l.name,
    subtitle: l.sub,
    render: (
      <div data-testid="row">
        <span>{l.name}</span>
        <span>{l.sub}</span>
      </div>
    ),
  }));
}

function Harness({
  source = VANS,
  onAdd = () => {},
  onReset = () => {},
}: {
  source?: typeof VANS;
  onAdd?: () => void;
  onReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SearchablePanel
      open={open}
      onOpenChange={setOpen}
      trigger={<button type="button">All Locations</button>}
      rows={rowsFrom(source)}
      resetRow={
        <button type="button" onClick={onReset}>
          All Locations reset
        </button>
      }
      emptyState={<p>No locations configured yet.</p>}
      footer={
        <button type="button" onClick={onAdd}>
          Add Location / Van
        </button>
      }
    />
  );
}

async function openPanel(name: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name }));
  return user;
}

describe('the search box is unconditional - there is no row-count gate', () => {
  it('renders for six rows, which no ten-option threshold would reach', async () => {
    render(<Harness />);
    await openPanel(/^All Locations$/);
    expect(screen.getAllByTestId('row')).toHaveLength(6);
    expect(screen.getByRole('textbox', { name: 'Search options' })).toBeInTheDocument();
  });

  it('renders for a single row, and for none at all', async () => {
    const { unmount } = render(<Harness source={[VANS[0]!]} />);
    await openPanel(/^All Locations$/);
    expect(screen.getByRole('textbox', { name: 'Search options' })).toBeInTheDocument();
    unmount();

    render(<Harness source={[]} />);
    await openPanel(/^All Locations$/);
    expect(screen.getByRole('textbox', { name: 'Search options' })).toBeInTheDocument();
    expect(screen.getByText('No locations configured yet.')).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('narrows the rows to what the query matches', async () => {
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'warehouse');
    const rows = screen.getAllByTestId('row');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Main Warehouse'),
      expect.stringContaining('Queens Warehouse'),
    ]);
  });

  it('matches the SUBTITLE, not the label alone - "Brooklyn" finds the vans', async () => {
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'Brooklyn');
    // Four Brooklyn HQ rows; NONE of them has "Brooklyn" in its label, so a
    // label-only matcher scores zero here.
    expect(screen.getAllByTestId('row')).toHaveLength(4);
    expect(screen.queryByText("Carlos's Van")).not.toBeInTheDocument();
  });

  it('matches a plate buried at the end of the subtitle, case-insensitively', async () => {
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'bx-4421');
    expect(screen.getAllByTestId('row')).toHaveLength(1);
    expect(screen.getByText("Mike's Van")).toBeInTheDocument();
  });

  it('names the no-match state, and distinguishes it from having no rows', async () => {
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'zzz');
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
    expect(screen.getByText('No results for "zzz"')).toBeInTheDocument();
    // The no-ROWS empty state is a different sentence and must not appear.
    expect(screen.queryByText('No locations configured yet.')).not.toBeInTheDocument();
  });

  it('forgets the query when the panel closes and reopens', async () => {
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'warehouse');
    expect(screen.getAllByTestId('row')).toHaveLength(2);

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^All Locations$/ }));
    expect(screen.getByRole('textbox', { name: 'Search options' })).toHaveValue('');
    expect(screen.getAllByTestId('row')).toHaveLength(6);
  });
});

describe('the pinned rows survive filtering - the reason they are pinned', () => {
  it('keeps the footer CTA and the reset row on screen when NOTHING matches', async () => {
    const onAdd = vi.fn();
    const onReset = vi.fn();
    render(<Harness onAdd={onAdd} onReset={onReset} />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'zzz');
    expect(screen.queryAllByTestId('row')).toHaveLength(0);

    // Still there, and still working - a user who searched for a van that does
    // not exist is exactly the user who needs to add it.
    await user.click(screen.getByRole('button', { name: 'Add Location / Van' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('keeps the reset row reachable under a no-match query', async () => {
    const onReset = vi.fn();
    render(<Harness onReset={onReset} />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'zzz');
    await user.click(screen.getByRole('button', { name: 'All Locations reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('never filters the pinned rows even when the query WOULD match them', async () => {
    // "All Locations reset" contains "locations"; so does the empty-state copy.
    // Neither is a row, so neither participates in the row count either way -
    // asserted so a future refactor cannot quietly fold them into `rows`.
    render(<Harness />);
    const user = await openPanel(/^All Locations$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'reset');
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'All Locations reset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Location / Van' })).toBeInTheDocument();
  });
});

/* -----------------------------------------------------------------------------
   Through a real call site. "The call site declares nothing about search" is
   the claim the whole primitive exists to make, so it is asserted against a
   shipped component that passes no search prop of any kind.
   -------------------------------------------------------------------------- */

const CATEGORIES: Category[] = [
  { id: 'c1', name: 'Cylinders', description: 'Mortise and rim cylinders' },
  { id: 'c2', name: 'Electric Strikes', description: 'Fail-safe and fail-secure' },
  { id: 'c3', name: 'Door Closers', description: 'Surface and concealed' },
];

describe('CategorySelector inherits search without declaring it', () => {
  function renderSelector(onAddNew = vi.fn()) {
    return {
      onAddNew,
      ...render(
        <CategorySelector
          categories={CATEGORIES}
          items={[] as Item[]}
          activeName="all"
          onChange={vi.fn()}
          onAddNew={onAddNew}
          // #2043 - the footer "Add category" CTA now gates on canAdd
          // (create PriceBook); this suite is about search, not the gate.
          canAdd
        />,
      ),
    };
  }

  it('gets a search box for three categories, and matches the DESCRIPTION', async () => {
    renderSelector();
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Filter items by category'));

    const box = screen.getByRole('textbox', { name: 'Search categories' });
    await user.type(box, 'concealed');
    // Reached by its description alone - "concealed" is not in "Door Closers".
    expect(screen.getByRole('button', { name: /Door Closers/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cylinders/ })).not.toBeInTheDocument();
  });

  it('keeps "Add category" clickable when the query matches nothing', async () => {
    const { onAddNew } = renderSelector();
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Filter items by category'));
    await user.type(screen.getByRole('textbox', { name: 'Search categories' }), 'qqq');

    expect(screen.getByText('No results for "qqq"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add category/ }));
    expect(onAddNew).toHaveBeenCalledTimes(1);
  });

  it('still shows the "All Categories" reset row under a no-match query', async () => {
    renderSelector();
    const user = userEvent.setup();
    await user.click(screen.getByTitle('Filter items by category'));
    await user.type(screen.getByRole('textbox', { name: 'Search categories' }), 'qqq');

    // Two buttons say "All Categories" under a no-match query: the trigger
    // (which is the current selection) and the reset row still pinned above the
    // emptied list. One would mean the reset row was filtered away.
    const all = screen.getAllByRole('button', { name: /All Categories/ });
    expect(all).toHaveLength(2);
    expect(within(all[1]!).getByText('All Categories')).toBeInTheDocument();
  });
});

/* -----------------------------------------------------------------------------
   `header` - the pinned slot ABOVE the search box.

   The primitive already pinned a reset row and a footer; `header` exists
   because a panel's create affordance is not always at the bottom. The clauses
   are the same ones clause 4 makes about the footer, asserted at the top of the
   panel instead: it is never filtered, it stays clickable under a no-match
   query, and it renders BEFORE the search box rather than after it.
   -------------------------------------------------------------------------- */

describe('the header slot is pinned above the search box and never filtered', () => {
  function HeaderHarness({ onCreate = () => {} }: { onCreate?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <SearchablePanel
        open={open}
        onOpenChange={setOpen}
        trigger={<button type="button">Pick one</button>}
        rows={rowsFrom(VANS)}
        header={
          <button type="button" onClick={onCreate}>
            Add new thing
          </button>
        }
      />
    );
  }

  it('renders the header BEFORE the search box in DOM order', async () => {
    render(<HeaderHarness />);
    await openPanel(/^Pick one$/);
    const header = screen.getByRole('button', { name: 'Add new thing' });
    const box = screen.getByRole('textbox', { name: 'Search options' });
    // Node.compareDocumentPosition: 4 = "box FOLLOWS header". Asserted rather
    // than eyeballed, because "top-pinned" is the whole reason the slot exists
    // and a footer would satisfy every other clause here.
    expect(header.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('survives a query that matches nothing, and still fires', async () => {
    const onCreate = vi.fn();
    render(<HeaderHarness onCreate={onCreate} />);
    const user = await openPanel(/^Pick one$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'zzz');
    expect(screen.queryAllByTestId('row')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Add new thing' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('is not filtered even when the query WOULD match its own text', async () => {
    render(<HeaderHarness />);
    const user = await openPanel(/^Pick one$/);
    await user.type(screen.getByRole('textbox', { name: 'Search options' }), 'Add new');
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add new thing' })).toBeInTheDocument();
  });
});

/* -----------------------------------------------------------------------------
   Through the StagingAreaPicker call site - the panel whose create affordance
   is pinned at the TOP, and which until now hand-rolled its own portalled
   surface (and so had no search at all).
   -------------------------------------------------------------------------- */

const WAREHOUSE: Location = {
  id: 'loc_wh_main',
  name: 'Main Warehouse',
  type: 'warehouse',
  branch: 'Brooklyn HQ',
  stagingAreas: [
    'Zone A — Receiving Dock',
    'Zone B — Pickup Shelf',
    'Zone C — Bulk Aisle',
    'Counter Pickup Shelf',
    'Backroom Holding',
    'Loading Dock',
  ],
};

describe('StagingAreaPicker inherits search without declaring it', () => {
  function renderPicker(props: Partial<React.ComponentProps<typeof StagingAreaPicker>> = {}) {
    const onChange = vi.fn();
    // A fresh copy per test: `saveCustom` deliberately mutates the parent
    // location's array (documented in the component), so a shared fixture
    // would leak a new preset into the next test.
    const parent: Location = { ...WAREHOUSE, stagingAreas: [...WAREHOUSE.stagingAreas!] };
    return {
      onChange,
      parent,
      ...render(<StagingAreaPicker parentLocation={parent} onChange={onChange} {...props} />),
    };
  }

  async function open() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Pick a staging area/ }));
    return user;
  }

  it('gets a search box for six areas - no threshold reaches that', async () => {
    renderPicker();
    await open();
    expect(screen.getByRole('textbox', { name: 'Search staging areas' })).toBeInTheDocument();
    expect(screen.getByRole('listbox').querySelectorAll('button')).toHaveLength(6);
  });

  it('narrows the areas to what the query matches, and names the no-match state', async () => {
    renderPicker();
    const user = await open();
    const box = screen.getByRole('textbox', { name: 'Search staging areas' });

    await user.type(box, 'pickup');
    expect(screen.getByRole('button', { name: /Zone B — Pickup Shelf/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Counter Pickup Shelf/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bulk Aisle/ })).not.toBeInTheDocument();

    await user.clear(box);
    await user.type(box, 'qqq');
    expect(screen.getByText('No results for "qqq"')).toBeInTheDocument();
  });

  it('picks the row the query left behind', async () => {
    const { onChange } = renderPicker();
    const user = await open();
    await user.type(screen.getByRole('textbox', { name: 'Search staging areas' }), 'bulk');
    await user.click(screen.getByRole('button', { name: /Zone C — Bulk Aisle/ }));
    expect(onChange).toHaveBeenCalledWith('Zone C — Bulk Aisle');
  });

  it('keeps "Add new staging area" - pinned ABOVE the list - alive under a no-match query', async () => {
    const { parent, onChange } = renderPicker();
    const user = await open();
    await user.type(screen.getByRole('textbox', { name: 'Search staging areas' }), 'Mezzanine');
    expect(screen.getByText('No results for "Mezzanine"')).toBeInTheDocument();

    // The create row is exactly what a user wants at this moment, so it is
    // still there AND still works: type the area that did not exist, save it.
    await user.click(screen.getByRole('button', { name: /Add new staging area/ }));
    // By placeholder, not by label: the create row's <label> is a bare label
    // with no htmlFor (a documented "Not converted to FormField" decision in
    // the picker), so it names nothing accessibly.
    await user.type(screen.getByPlaceholderText('e.g. Mezzanine Bin 4'), 'Mezzanine Bin 4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledWith('Mezzanine Bin 4');
    expect(parent.stagingAreas).toContain('Mezzanine Bin 4');
  });

  it('keeps "Clear staging area" alive under a no-match query', async () => {
    const { onChange } = renderPicker({ value: 'Zone A — Receiving Dock' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Zone A — Receiving Dock/ }));
    await user.type(screen.getByRole('textbox', { name: 'Search staging areas' }), 'qqq');
    expect(screen.getByText('No results for "qqq"')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear staging area' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('lists a custom current value alongside the presets, and finds it by typing', async () => {
    renderPicker({ value: 'Mezzanine Bin 4' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Mezzanine Bin 4/ }));
    await user.type(screen.getByRole('textbox', { name: 'Search staging areas' }), 'mezz');
    const rows = screen.getByRole('listbox').querySelectorAll('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Mezzanine Bin 4');
  });

  it('forgets the query when the panel closes', async () => {
    renderPicker();
    const user = await open();
    await user.type(screen.getByRole('textbox', { name: 'Search staging areas' }), 'bulk');
    expect(screen.getByRole('listbox').querySelectorAll('button')).toHaveLength(1);

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Pick a staging area/ }));
    expect(screen.getByRole('textbox', { name: 'Search staging areas' })).toHaveValue('');
    expect(screen.getByRole('listbox').querySelectorAll('button')).toHaveLength(6);
  });
});

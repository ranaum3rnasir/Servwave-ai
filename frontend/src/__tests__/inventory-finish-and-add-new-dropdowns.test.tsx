// Finish field + "add a new one" on every entity-backed inventory dropdown.
//
// Contract under test:
//   • the Add Item dialog exposes a Finish dropdown, and a save ships finishId
//   • Finish, Brand, Location and Unit of Measure each offer "+ Add new …"
//   • the unit list comes from the server, not the old hardcoded array
//   • Item Kind deliberately does NOT offer add-new: it is a closed vocabulary
//     that downstream branching switches on
//
// Seam hooks are mocked with stable resolved data (the sanctioned jsdom
// seed-loop pattern - see price-book-persistence.test.tsx). The dropdowns are
// Radix Selects, so options exist only while the trigger is open - hence the
// open-then-read helper rather than a native <select> lookup.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AddItemDialog } from '@/components/inventory/AddItemDialog';
import { toPriceBookBody } from '@/lib/api/inventory';

// Fixtures live inside vi.hoisted because the vi.mock factory below is hoisted
// above every top-level const and would otherwise read them before init.
const h = vi.hoisted(() => {
  const state = {
    FINISHES: [] as { id: string; name: string; code?: string; isActive?: boolean }[],
    LOCATIONS: [{ id: 'loc_1', name: 'Main Warehouse', type: 'warehouse', branchId: 'br_1' }],
    reset() {
      state.FINISHES = [
        { id: 'fin_1', name: 'Satin Chrome', code: '626', isActive: true },
        { id: 'fin_2', name: 'Oil Rubbed Bronze', code: '10B', isActive: true },
        { id: 'fin_3', name: 'Retired Finish', isActive: false },
      ];
    },
    // The upserts APPEND to these lists, standing in for the server write plus
    // the ['inventory'] invalidation refetch that follows it. That is what makes
    // the duplicate-option defect reproducible: a dialog that ALSO keeps its own
    // local copy of the created row renders it twice, and Radix then paints both
    // matching labels into the trigger ("BOXBOX").
    upsertFinish: vi.fn(async (p: { name: string }) => {
      const saved = { id: 'fin_srv_1', name: p.name, isActive: true };
      state.FINISHES.push(saved);
      return saved;
    }),
    // Delete mirrors the upsert: it mutates the same list a refetch would.
    // fin_1 stands in for the server's in-use guard, which 400s a finish that
    // still has items pointing at it - the case the manage dialog exists for.
    deleteFinish: vi.fn(async ({ id }: { id: string }) => {
      if (id === 'fin_1') {
        throw { response: { data: { error: 'Cannot delete finish with items' } } };
      }
      state.FINISHES = state.FINISHES.filter((f) => f.id !== id);
      return { message: 'Finish deleted' };
    }),
  };
  state.reset();
  return state;
});

const BRANDS = [{ id: 'brd_1', name: 'Mul-T-Lock', isActive: true }];

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  // Read through on every render, not captured once - these two lists grow when
  // the mocked upsert runs, the way a refetch would.
  const live =
    <T,>(read: () => T) =>
    () => ({ data: read(), isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useLocations: stable(h.LOCATIONS),
    useBranches: stable([{ id: 'br_1', name: 'HQ' }]),
    useFinishes: live(() => h.FINISHES),
    useUpsertFinish: () => ({ mutate: vi.fn(), mutateAsync: h.upsertFinish, isPending: false }),
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useDeleteFinish: () => ({ mutate: vi.fn(), mutateAsync: h.deleteFinish, isPending: false }),
    useDeleteBrand: mutation,
    useDeleteCategory: mutation,
  };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { default_inventory_location_id: 'loc_1' }, isLoading: false }),
}));

function renderDialog(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  renderWithProviders(
    <AddItemDialog
      open
      onClose={vi.fn()}
      onSave={onSave}
      vendors={[]}
      onAddVendor={vi.fn()}
      categories={[]}
      onAddCategory={vi.fn()}
      brands={BRANDS}
      {...overrides}
    />,
  );
  return { onSave };
}

/** Radix renders its items only while the trigger is open. Open it, read the
 *  option labels, then close so the next assertion starts from a clean tree. */
async function optionsOf(ariaLabel: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: ariaLabel }));
  const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

async function pick(ariaLabel: string, optionName: RegExp | string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: ariaLabel }));
  await user.click(await screen.findByRole('option', { name: optionName }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe('Finish field on the Add Item dialog', () => {
  it('renders a Finish dropdown listing the org finishes', async () => {
    renderDialog();
    const labels = await optionsOf('Finish');
    expect(labels).toEqual(expect.arrayContaining(['Satin Chrome', 'Oil Rubbed Bronze']));
  });

  it('hides an archived finish, matching how Brand filters isActive', async () => {
    renderDialog();
    const labels = await optionsOf('Finish');
    expect(labels).not.toContain('Retired Finish');
  });

  it('ships finishId on save', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();
    await user.type(screen.getByLabelText(/Item Name/i), 'Mortise Cylinder');
    // SKU is required since the 2026-08-12 restructure - it used to be minted
    // silently from the name on save.
    await user.type(screen.getByLabelText(/^SKU/), 'MORT-1');
    await pick('Finish', 'Satin Chrome');
    await user.click(screen.getByRole('button', { name: /save item/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].finishId).toBe('fin_1');
  });

  it('prefills the finish when editing an item that has one', async () => {
    renderDialog({
      editItem: {
        id: 'itm_1', sku: 'LOCK-1', name: 'Lock', category: 'Locks', trade: 'locksmith',
        kind: 'material', uom: 'EA', sellPrice: 10, serialized: false, hazmat: false,
        status: 'active', vendor: '', stock: [], updatedAt: '2026-01-01', finishId: 'fin_2',
      },
    });
    expect(
      screen.getByRole('combobox', { name: 'Finish' }).textContent,
    ).toContain('Oil Rubbed Bronze');
  });
});

describe('toPriceBookBody carries the finish', () => {
  it('maps finishId onto finish_id', () => {
    expect(toPriceBookBody({ name: 'X', finishId: 'fin_1' }).finish_id).toBe('fin_1');
  });
});

// Unit of Measure went the OPPOSITE way to the other catalogs on 2026-08-12:
// it was a per-org table with add/edit/delete, and is now a fixed list. A unit
// is not per-business vocabulary the way a brand or a finish is, and letting
// each org invent its own is how the demo org ended up with both BX and BOX.
describe('Unit of Measure is a fixed list', () => {
  it('offers exactly the six shipped units, with no add and no manage', async () => {
    renderDialog();
    const labels = await optionsOf('Unit of measure');

    expect(labels).toEqual([
      'EA · Each',
      'FT · Foot',
      'IN · Inch',
      'GAL · Gallon',
      'LB · Pound',
      'MTR · Meter',
    ]);
    expect(labels.some((l) => /add new/i.test(l))).toBe(false);
    expect(labels.some((l) => /manage/i.test(l))).toBe(false);
  });

  it('does not offer the near-duplicate BX/BOX pair that started this', async () => {
    // The per-org table let the demo org create BOX alongside the seeded BX, so
    // the dropdown carried two codes for one thing. Neither survives the cut.
    renderDialog();
    const labels = await optionsOf('Unit of measure');
    expect(labels.some((l) => /^(BX|BOX)\b/.test(l))).toBe(false);
  });

  it.each(['KIT', 'BOX', 'ROLL', 'CYL', 'HR'])(
    'still shows %s, a stored code the cut to six dropped',
    (orphan) => {
      // These five are the real orphans: one staging item each as of
      // 2026-08-12 (prod is 601 items, all EA, so prod has none). Blanking the
      // trigger would look like the item lost its unit, so an unrecognised
      // stored value is appended to the options and shown as itself. It cannot
      // be re-picked once changed - that is the accepted cost of the short list.
      renderDialog({
        editItem: {
          id: 'itm_1', sku: 'LOCK-1', name: 'Lock', category: 'Locks', trade: 'locksmith',
          kind: 'material', uom: orphan, sellPrice: 10, serialized: false, hazmat: false,
          status: 'active', vendor: '', stock: [], updatedAt: '2026-01-01',
        },
      });

      expect(
        screen.getByRole('combobox', { name: 'Unit of measure' }).textContent,
      ).toContain(orphan);
    },
  );
});

describe('every entity-backed dropdown offers "add a new one"', () => {
  it.each([
    ['Brand', /add new brand/i],
    ['Finish', /add new finish/i],
    ['Starting stock location', /add new location/i],
  ])('%s has an add-new option', async (ariaLabel, wording) => {
    renderDialog();
    const labels = await optionsOf(ariaLabel as string);
    expect(labels.some((t) => (wording as RegExp).test(t))).toBe(true);
  });

  it('leaves Item Kind alone - a closed vocabulary', async () => {
    renderDialog();
    const labels = await optionsOf('Item kind');
    expect(labels.some((t) => /add new/i.test(t))).toBe(false);
  });

  // ─── Regressions from the first live pass on staging (2026-08-12) ─────────

  it('lists a newly created finish ONCE, not twice', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pick('Finish', /add new finish/i);
    await user.type(await screen.findByLabelText(/Finish Name/i), 'Brushed Nickel');
    await user.click(screen.getByRole('button', { name: /save finish/i }));

    await waitFor(() => expect(h.upsertFinish).toHaveBeenCalled());
    const labels = await optionsOf('Finish');
    expect(labels.filter((l) => l === 'Brushed Nickel')).toHaveLength(1);
  });

  it('refuses a finish name that already exists, without calling the server', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pick('Finish', /add new finish/i);
    await user.type(await screen.findByLabelText(/Finish Name/i), 'satin chrome');
    await user.click(screen.getByRole('button', { name: /save finish/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(h.upsertFinish).not.toHaveBeenCalled();
  });

  it('offers exactly one route to each creator - no separate + button', () => {
    renderDialog();

    expect(screen.queryByRole('button', { name: /^Add new category$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add new vendor$/i })).toBeNull();
  });

  it('has no Price Book group - brand and finish are ordinary fields', () => {
    // The tinted "Price Book — Brand · Visibility" card is gone. It implied
    // brand and visibility were a separate subsystem, boxed a segmented toggle
    // that is now one checkbox, and left Finish stranded directly above it
    // belonging to neither. All three are plain fields in Classification now.
    renderDialog();

    expect(screen.queryByText(/Price Book/i)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Finish' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Brand' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /show in customer catalog/i })).toBeInTheDocument();
  });

  it('groups the working fields under Classification, Pricing and Starting Stock', () => {
    // Name and SKU are a full-width band above the photo rail rather than a
    // labelled section - they need no heading to be found.
    renderDialog();

    for (const band of ['Classification', 'Pricing', 'Starting Stock']) {
      expect(screen.getByText(band)).toBeInTheDocument();
    }
  });

  it('labels the SKU helper "Generate", with no icon', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suggest/i })).toBeNull();
  });

  it('refuses to save without a SKU instead of minting one silently', async () => {
    // The old behaviour built a SKU from the item name on save, so an item
    // could acquire a code nobody chose and nobody saw until it turned up on a
    // purchase order. Both fields are required now.
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByLabelText(/Item Name/i), 'Mortise Cylinder');
    await user.click(screen.getByRole('button', { name: /save item/i }));

    expect(await screen.findByText(/SKU is required/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses to save without an item name', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByLabelText(/^SKU/), 'ONLY-SKU');
    await user.click(screen.getByRole('button', { name: /save item/i }));

    expect(await screen.findByText(/Item name is required/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Generate fills the SKU, which then satisfies the requirement', async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    await user.type(screen.getByLabelText(/Item Name/i), 'Mortise Cylinder');
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    // Read the value BEFORE saving - a successful save resets the form, so
    // re-reading the input afterwards yields "".
    const generated = (screen.getByLabelText(/^SKU/) as HTMLInputElement).value;
    expect(generated).toMatch(/^ITM-/);

    await user.click(screen.getByRole('button', { name: /save item/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ sku: generated });
  });

  it('drops the helper strings that restated their own labels', () => {
    renderDialog();

    expect(screen.queryByText(/Bills as/i)).toBeNull();
    expect(screen.queryByText(/ship in Phase B/i)).toBeNull();
    expect(screen.queryByText(/deducts stock when added to/i)).toBeNull();
    expect(screen.queryByText(/caps auto-replenish suggestions/i)).toBeNull();
    expect(screen.queryByText(/Manufacturer part number/i)).toBeNull();
  });

  it('offers Material and Service as the only item kinds', () => {
    renderDialog();

    // Retired: labor, bundle and fee. All three already billed as SERVICE, and
    // the Stock > Items grid hid bundle and fee outright.
    const kind = screen.getByRole('combobox', { name: 'Item kind' });
    expect(kind.textContent).toMatch(/Material/i);
  });

  it('opens the finish creator when "+ Add new finish" is picked', async () => {
    renderDialog();
    await pick('Finish', /add new finish/i);
    await waitFor(() =>
      // The dialog's own title, not the "+ Add new finish…" option (which
      // unmounts with the Radix popover when the selection closes it).
      expect(screen.getByText('Add New Finish')).toBeInTheDocument(),
    );
  });
});

// Deleting a catalog row. The endpoints and the useDelete* hooks already
// existed; until now nothing in the UI reached them, so a unit or finish added
// by mistake was permanent.
describe('deleting a catalog row', () => {
  it('offers "Manage …" only where a delete endpoint exists', async () => {
    renderDialog();

    for (const [field, plural] of [
      ['Finish', /manage finishes/i],
      ['Brand', /manage brands/i],
      ['Category', /manage categories/i],
    ] as const) {
      const labels = await optionsOf(field);
      expect(labels.some((l) => plural.test(l))).toBe(true);
    }

    // Vendors and locations have no delete route, so the entry would open a
    // dialog that could only refuse.
    for (const field of ['Vendor / Source', 'Starting stock location']) {
      const labels = await optionsOf(field);
      expect(labels.some((l) => /manage/i.test(l))).toBe(false);
    }
  });

  it('deletes a row after the confirm, and it leaves the dropdown', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pick('Finish', /manage finishes/i);
    await screen.findByText('Manage Finishes');

    await user.click(screen.getByRole('button', { name: 'Delete Oil Rubbed Bronze' }));
    // Two-step: the trash arms a confirm rather than deleting on first click.
    expect(h.deleteFinish).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(h.deleteFinish).toHaveBeenCalledWith({ id: 'fin_2' }));

    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(async () => {
      expect(await optionsOf('Finish')).not.toContain('Oil Rubbed Bronze');
    });
  });

  it('shows the server reason when a row is still in use', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pick('Finish', /manage finishes/i);
    await screen.findByText('Manage Finishes');

    await user.click(screen.getByRole('button', { name: 'Delete Satin Chrome' }));
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));

    // The whole point of a manage surface: a refusal has somewhere to be read.
    await waitFor(() =>
      expect(screen.getByText(/Cannot delete finish with items/i)).toBeInTheDocument(),
    );
    // And the row survives.
    expect(screen.getByText('Satin Chrome')).toBeInTheDocument();
  });
});

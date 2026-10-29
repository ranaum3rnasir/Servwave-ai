// GAP G7 - a part number, model number, finish, brand or vendor the operator
// CLEARS must stay cleared.
//
// Contract under test: on EDIT the Add/Edit Item dialog ships an explicit
// `null` for an identifier the operator emptied, and leaves every field they
// did not touch carrying its current value.
//
// Why null and not "omit the key": the price-book PATCH handler copies only the
// keys that are `!== undefined`, so an absent key reads as "leave unchanged".
// An emptied field that shipped as `undefined` was silently discarded and the
// old value came back on the next refetch - the operator could not delete a
// wrong part number at all.
//
// Why the untouched half matters just as much: over-sending nulls would wipe
// data the operator never touched, which is worse than the bug being fixed.
//
// On CREATE there is nothing to clear, so a blank field still ships nothing
// rather than a null.
//
// Vendor is the one field held to a stricter rule. Every other identifier is
// seeded straight off the item, but the API serializes only `vendor` (a NAME)
// on an item, never `vendor_id`, so edit recovers the id by matching that name
// against the vendor list - and seeds EMPTY when the list has not landed yet.
// A null there would wipe a vendor nobody touched, so vendor only clears once
// the operator has actually used the select.
//
// Mounted on the dialog itself (the shared component both routed v2 inventory
// pages hand their payload straight to), with the seam hooks mocked as stable
// resolved data - the sanctioned jsdom pattern, see
// inventory-finish-and-add-new-dropdowns.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AddItemDialog } from '@/components/inventory/AddItemDialog';
import { toPriceBookBody } from '@/lib/api/inventory';
import type { Brand, Item, Vendor } from '@/lib/api/inventory';

const h = vi.hoisted(() => ({
  FINISH_ID: 'ccccccc7-0000-4000-8000-00000000000f',
  LOC_ID: 'ccccccc7-0000-4000-8000-000000000001',
  ITEM_ID: 'ccccccc7-0000-4000-8000-000000000002',
  BRAND_ID: 'ccccccc7-0000-4000-8000-000000000003',
  VENDOR_ID: 'ccccccc7-0000-4000-8000-000000000004',
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useLocations: stable([{ id: h.LOC_ID, name: 'Main Warehouse', type: 'warehouse' }]),
    useBranches: stable([]),
    useFinishes: stable([{ id: h.FINISH_ID, name: 'Satin Chrome', code: '626', isActive: true }]),
    useUpsertFinish: mutation,
    useUpsertBrand: mutation,
    useUpsertLocation: mutation,
    useUpsertBranch: mutation,
    useDeleteFinish: mutation,
    useDeleteBrand: mutation,
    useDeleteCategory: mutation,
  };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({
    data: { id: 'org-1', default_inventory_location_id: h.LOC_ID },
    isLoading: false,
    isError: false,
  }),
}));

const NAME_PLACEHOLDER = 'e.g. Dual Run Capacitor 45/5 MFD 440V';

const BRAND: Brand = { id: h.BRAND_ID, name: 'Mul-T-Lock', isActive: true };

// The item points at its vendor by NAME, so the list is what makes the id
// recoverable - `VENDORS: []` is the "list has not landed yet" case.
const VENDOR: Vendor = {
  id: h.VENDOR_ID,
  name: 'Acme Supply',
  category: 'hardware',
  paymentTerms: 'NET30',
  leadTimeDays: 3,
  transmitMethod: 'email',
};

const EXISTING: Item = {
  id: h.ITEM_ID,
  sku: 'LOCK-100',
  mpn: '114',
  modelNumber: 'MT5+',
  finishId: h.FINISH_ID,
  brandId: h.BRAND_ID,
  name: 'Deadbolt',
  category: 'Hardware',
  trade: 'locksmith',
  kind: 'material',
  uom: 'EA',
  unitCost: 20,
  sellPrice: 45,
  serialized: false,
  hazmat: false,
  status: 'active',
  vendor: 'Acme Supply',
  stock: [{ locationId: h.LOC_ID, onHand: 4 }],
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function renderDialog(
  editItem?: Item,
  { vendors = [] as Vendor[], brands = [] as Brand[] } = {},
) {
  const onSave = vi.fn();
  renderWithProviders(
    <AddItemDialog
      open
      onClose={vi.fn()}
      onSave={onSave}
      vendors={vendors}
      onAddVendor={vi.fn()}
      categories={[]}
      onAddCategory={vi.fn()}
      brands={brands}
      editItem={editItem}
    />,
  );
  return { onSave };
}

/** Radix renders its options only while the trigger is open. */
async function pick(comboboxName: string, optionName: RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: comboboxName }));
  await userEvent.click(await screen.findByRole('option', { name: optionName }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Clearing a manufacturer identifier persists the clear (GAP G7)', () => {
  it('an edit that empties all three ships explicit nulls, not absent keys', async () => {
    const { onSave } = renderDialog(EXISTING);

    await userEvent.clear(screen.getByLabelText('Part Number'));
    await userEvent.clear(screen.getByLabelText('Model Number'));
    // The none entry is the only way to unset a Radix-backed catalog field.
    await pick('Finish', /none/i);
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [payload, editId] = onSave.mock.calls[0];
    expect(editId).toBe(h.ITEM_ID);
    expect(payload.mpn).toBeNull();
    expect(payload.modelNumber).toBeNull();
    expect(payload.finishId).toBeNull();
  });

  it('an edit that empties only one leaves the other two carrying their values', async () => {
    const { onSave } = renderDialog(EXISTING);

    await userEvent.clear(screen.getByLabelText('Part Number'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0][0];
    expect(payload.mpn).toBeNull();
    expect(payload.modelNumber).toBe('MT5+');
    expect(payload.finishId).toBe(h.FINISH_ID);
  });

  it('a create leaves the blank identifiers off the payload rather than nulling them', async () => {
    const { onSave } = renderDialog();

    await userEvent.type(screen.getByPlaceholderText(NAME_PLACEHOLDER), 'New Deadbolt');
    await userEvent.type(screen.getByLabelText(/^SKU/), 'DEAD-3');
    await userEvent.click(screen.getByRole('button', { name: 'Save Item' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [payload, editId] = onSave.mock.calls[0];
    expect(editId).toBeUndefined();
    expect(payload.mpn).toBeUndefined();
    expect(payload.modelNumber).toBeUndefined();
    expect(payload.finishId).toBeUndefined();
    expect(payload.brandId).toBeUndefined();
    expect(payload.vendorId).toBeUndefined();
  });
});

// Brand and vendor sit either side of finish in the same payload and are unset
// through the same CatalogSelect none entry. `brand_id` and `vendor_id` are
// both `.nullable().optional()` on updateItemSchema, both truthy-guarded in the
// FK existence check and both `String?` columns, so an explicit null clears
// them rather than 500ing.
describe('Clearing brand or vendor persists the clear too (GAP G7)', () => {
  it('an edit that unsets the brand ships an explicit null', async () => {
    const { onSave } = renderDialog(EXISTING, { brands: [BRAND] });

    await pick('Brand', /none/i);
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].brandId).toBeNull();
  });

  it('an edit that leaves the brand alone keeps carrying its id', async () => {
    const { onSave } = renderDialog(EXISTING, { brands: [BRAND] });

    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].brandId).toBe(h.BRAND_ID);
  });

  it('an edit that unsets the vendor ships an explicit null', async () => {
    const { onSave } = renderDialog(EXISTING, { vendors: [VENDOR] });

    await pick('Vendor / Source', /select vendor/i);
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].vendorId).toBeNull();
  });

  it('a vendor the operator never touched is omitted, even when the seed could not resolve it', async () => {
    // No vendor list, so the name match misses and the select seeds empty
    // although the item does have a vendor. Nulling here would delete it.
    const { onSave } = renderDialog(EXISTING, { vendors: [] });

    await userEvent.clear(screen.getByLabelText('Part Number'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0][0];
    expect(payload.mpn).toBeNull();
    expect(payload.vendorId).toBeUndefined();
  });
});

describe('toPriceBookBody carries a cleared identifier to the wire', () => {
  it('maps nulls through rather than throwing on the FK guards', () => {
    const body = toPriceBookBody({
      id: h.ITEM_ID,
      name: 'Deadbolt',
      mpn: null,
      modelNumber: null,
      finishId: null,
      brandId: null,
      vendorId: null,
    });

    expect(body.mpn).toBeNull();
    expect(body.model_number).toBeNull();
    expect(body.finish_id).toBeNull();
    expect(body.brand_id).toBeNull();
    expect(body.vendor_id).toBeNull();
  });
});

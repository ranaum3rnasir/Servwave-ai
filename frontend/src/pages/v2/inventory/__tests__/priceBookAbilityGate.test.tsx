// #2009 — every write affordance on the ROUTED Price Book page
// (`pages/v2/inventory/PriceBookPage.tsx`) must be gated on the CASL ability
// for the `PriceBook` subject, never on a role name, and a requester without
// `update PriceBook` must still be able to open an item and SEE cost / sell
// price / GM (Ran's Decision - view, not hide).
//
// Prior art: `src/__tests__/repro-2009.test.tsx` (frozen - the seam-mock
// pattern and the readOnly/write ability pair are copied from there) and
// `src/__tests__/inventory-model-part-number.test.tsx` (`inventoryAbility()`
// -> `buildAbility([...])` fed to `renderWithProviders(..., { ability })`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import { buildAbility } from '@/lib/ability';

const h = vi.hoisted(() => ({
  ITEM_ID: 'bbbbbbb1-0000-4000-8000-000000002009',
  DUPE_ID: 'bbbbbbb1-0000-4000-8000-000000002010',
  BRAND_ID: 'bbbbbbb1-0000-4000-8000-0000000000b1',
  GROUP_ID: 'bbbbbbb1-0000-4000-8000-0000000000g1',
  CATEGORY_ID: 'bbbbbbb1-0000-4000-8000-0000000000c1',
  upsertItemMutateAsync: vi.fn(async (p: Record<string, unknown>) => ({
    id: 'bbbbbbb1-0000-4000-8000-000000002099',
    ...p,
  })),
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  const items = [
    {
      id: h.ITEM_ID,
      sku: 'QA2009-1',
      name: 'qa-2009-item',
      category: 'Hardware',
      trade: 'general',
      kind: 'material',
      type: 'MATERIAL',
      uom: 'EA',
      // Mirrors the fixture's unit cost 40 / sell price 178 - Ran's Decision
      // requires both to stay visible to a read-only requester.
      unitCost: 40,
      sellPrice: 178,
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      status: 'active',
      vendor: 'Acme Supply',
      stock: [],
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  const brands = [
    {
      id: h.BRAND_ID,
      name: 'Acme Locks',
      isActive: true,
    },
  ];
  const groups = [
    {
      id: h.GROUP_ID,
      name: 'Rekey Bundle',
      groupType: 'individual' as const,
      isActive: true,
      lines: [],
    },
  ];
  const categories = [
    {
      id: h.CATEGORY_ID,
      name: 'Cylinders',
    },
  ];
  return {
    ...actual,
    useInventoryItems: stable(items),
    useBrands: stable(brands),
    useItemGroups: stable(groups),
    useCategories: stable(categories),
    useVendors: stable([]),
    useLocations: stable([]),
    useFinishes: stable([]),
    useUpsertItem: () => ({
      mutate: vi.fn(),
      mutateAsync: h.upsertItemMutateAsync,
      isPending: false,
    }),
    useUpsertBrand: mutation,
    useUpsertItemGroup: mutation,
    useUpsertCategory: mutation,
    useUpsertVendor: mutation,
    useDeleteBrand: mutation,
    useDeleteItemGroup: mutation,
    useDeleteCategory: mutation,
    useSetThresholds: mutation,
  };
});

// #2009 AC10 - built from RULES only, no `role` field anywhere - this is what
// a custom role derived from SALES (or DISPATCHER, which the backend grants
// the identical `read PriceBook` + `read Pricing` pair - AC9) resolves to.
const readOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PriceBook' },
    { action: 'read', subject: 'Pricing' },
  ]);

const writeAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PriceBook' },
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
    { action: 'delete', subject: 'PriceBook' },
    { action: 'read', subject: 'Pricing' },
  ]);

function renderPriceBook(ability: ReturnType<typeof readOnlyAbility>) {
  return renderWithProviders(<PriceBookPage />, {
    initialEntries: ['/inventory/price-book'],
    ability,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2009 — Price Book ability gate (routed v2 page)', () => {
  describe('read-only ability (SALES-shaped: read PriceBook + read Pricing only)', () => {
    it('hides every write control on every tab, but keeps the read affordances', async () => {
      renderPriceBook(readOnlyAbility());
      await screen.findByText('qa-2009-item');

      // Items tab.
      expect(screen.queryByRole('button', { name: /Add Item/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Export/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Columns/i })).toBeInTheDocument();
      expect(screen.getByText('1 of 1 items')).toBeInTheDocument();

      // Brands tab.
      fireEvent.click(screen.getByRole('tab', { name: /Brands/i }));
      expect(await screen.findByText('Acme Locks')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Add Brand/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit Acme Locks/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete Acme Locks/i })).not.toBeInTheDocument();

      // Groups tab.
      fireEvent.click(screen.getByRole('tab', { name: /Groups/i }));
      expect(await screen.findByText('Rekey Bundle')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /New Bundle/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit Rekey Bundle/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete Rekey Bundle/i })).not.toBeInTheDocument();

      // Categories tab.
      fireEvent.click(screen.getByRole('tab', { name: /Categories/i }));
      expect(await screen.findByText('Cylinders')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^add category$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Edit Cylinders/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete Cylinders/i })).not.toBeInTheDocument();
    });

    it('still opens the item row read-only, with cost / sell price / GM visible and no Save', async () => {
      renderPriceBook(readOnlyAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      expect(row).not.toBeNull();
      fireEvent.click(row!);

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeInTheDocument();

      // Every field named in AC2 is on screen and disabled.
      expect(screen.getByPlaceholderText('e.g. Dual Run Capacitor 45/5 MFD 440V')).toHaveValue(
        'qa-2009-item',
      );
      const unitCostInput = screen.getByLabelText(/unit cost/i);
      // The Items-tab "No Price Set" stat tile also carries an aria-label
      // containing "sell price", so the query must be specific to the
      // MoneyInput's own accessible name.
      const sellPriceInput = screen.getByLabelText('Sell price in dollars');
      expect(unitCostInput).toHaveValue(40);
      expect(sellPriceInput).toHaveValue(178);
      expect(unitCostInput).toBeDisabled();
      expect(sellPriceInput).toBeDisabled();
      // GM: (178-40)/178 = 77.5% -> rounds to 78%.
      expect(screen.getByText('78% GM')).toBeInTheDocument();
      expect(screen.getByLabelText('Item Kind')).toBeDisabled();
      expect(screen.getByLabelText(/^Taxable$/)).toBeDisabled();
      expect(screen.getByLabelText(/show in customer catalog/i)).toBeDisabled();

      // No Save, no Delete - only Close.
      expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save Item' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
      // Two "Close" buttons: the Modal's own X (always present) plus the
      // footer's dismiss control - which reads "Close", not "Cancel".
      expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    });

    it('disables the photo rail - Upload, Camera and the drop zone are inert', async () => {
      renderPriceBook(readOnlyAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      fireEvent.click(row!);
      await screen.findByRole('dialog');

      const uploadBtn = screen.getByRole('button', { name: 'Upload' });
      const cameraBtn = screen.getByRole('button', { name: 'Camera' });
      expect(uploadBtn).toBeDisabled();
      expect(cameraBtn).toBeDisabled();

      // The drop-zone label carries no pointer cursor and no live drag
      // handlers when read-only - visual review's required change (#2009).
      const dropZone = screen.getByText('No photo').closest('label');
      expect(dropZone).not.toBeNull();
      expect(dropZone).not.toHaveClass('cursor-pointer');
      fireEvent.dragOver(dropZone!);
      expect(dropZone).not.toHaveClass('border-primary');

      // No photo is loaded, so there is nothing to remove - but the control
      // must also never render at all in read-only mode.
      expect(screen.queryByLabelText('Remove photo')).not.toBeInTheDocument();
    });

    // #2043 visual round - the SKU field's own "Generate" button rendered at
    // full emphasis while every neighbouring control was disabled; hidden
    // (not merely disabled) to match the photo rail's Remove-photo pattern.
    it('hides the SKU "Generate" button', async () => {
      renderPriceBook(readOnlyAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      fireEvent.click(row!);
      await screen.findByRole('dialog');

      expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    });
  });

  describe('DISPATCHER-shaped ability (identical read PriceBook + read Pricing pair, AC9)', () => {
    it('gets the same read-only result as SALES - the gate keys on the grant, not the role', async () => {
      // defaultGrants.ts gives DISPATCHER exactly the same pair as SALES; the
      // ability itself carries no role, which is the point (AC10).
      const dispatcherShapedAbility = buildAbility([
        { action: 'read', subject: 'PriceBook' },
        { action: 'read', subject: 'Pricing' },
      ]);
      renderPriceBook(dispatcherShapedAbility);
      await screen.findByText('qa-2009-item');

      expect(screen.queryByRole('button', { name: /Add Item/i })).not.toBeInTheDocument();

      const row = screen.getByText('qa-2009-item').closest('tr');
      fireEvent.click(row!);
      const unitCostInput = await screen.findByLabelText(/unit cost/i);
      expect(unitCostInput).toHaveValue(40);
      expect(unitCostInput).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    });
  });

  describe('write ability (create + update + delete PriceBook)', () => {
    it('renders every write control on every tab', async () => {
      renderPriceBook(writeAbility());
      await screen.findByText('qa-2009-item');

      expect(screen.getByRole('button', { name: /Add Item/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: /Brands/i }));
      await screen.findByText('Acme Locks');
      expect(screen.getByRole('button', { name: /Add Brand/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Edit Acme Locks/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete Acme Locks/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: /Groups/i }));
      await screen.findByText('Rekey Bundle');
      expect(screen.getByRole('button', { name: /New Bundle/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Edit Rekey Bundle/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete Rekey Bundle/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: /Categories/i }));
      await screen.findByText('Cylinders');
      expect(screen.getByRole('button', { name: 'Add category' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Edit Cylinders/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete Cylinders/i })).toBeInTheDocument();
    });

    it('keeps the SKU "Generate" button', async () => {
      renderPriceBook(writeAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      fireEvent.click(row!);
      await screen.findByRole('dialog');

      expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    });

    it('opens the item row editable, with Save Changes enabled', async () => {
      renderPriceBook(writeAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      fireEvent.click(row!);

      const saveBtn = await screen.findByRole('button', { name: 'Save Changes' });
      expect(saveBtn).not.toBeDisabled();
      expect(screen.getByLabelText(/unit cost/i)).not.toBeDisabled();
    });

    it('a rejected save keeps the dialog open and surfaces the server message (regression for the swallowed rejection)', async () => {
      h.upsertItemMutateAsync.mockRejectedValueOnce({
        response: { data: { error: 'An item with this SKU already exists' } },
      });
      renderPriceBook(writeAbility());
      const row = (await screen.findByText('qa-2009-item')).closest('tr');
      fireEvent.click(row!);

      const saveBtn = await screen.findByRole('button', { name: 'Save Changes' });
      fireEvent.click(saveBtn);

      // The dialog is still on screen after the rejected save - this fails on
      // base, where PriceBookPage's onSave catches the rejection and
      // `return`s instead of rethrowing, so AddItemDialog's `reset(); onClose()`
      // runs unconditionally.
      await waitFor(() => {
        expect(screen.getByText(/An item with this SKU already exists/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    });
  });
});

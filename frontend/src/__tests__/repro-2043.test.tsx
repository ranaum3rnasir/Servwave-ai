// Repro for #2043 — the inventory module renders write controls without
// consulting the requester's ability, across six of its seven routed
// surfaces. The backend already 403s every one of these writes (Pass A: two
// live probes against the qa-2043 SALES fixture on prod, both 403
// "Insufficient permissions"); the defect is client-side only.
//
// Evidence (`md_files/plans/agents/runs/issue-2043/handoffs/reproduce-a.md`):
//   - InventoryPage.tsx (Stock toolbar, item edit dialog): unconditional.
//   - itemDetailPanel.tsx: takes no ability prop at all.
//   - assetsView.tsx, stagingView.tsx, PurchaseOrdersPage.tsx,
//     PODetailDialog.tsx, StageDetailDialog.tsx: 0 `ability.can` calls.
//   - VendorsPage.tsx / VendorDetailDialog.tsx: gated on the WRONG subject,
//     `ability.can('manage','Inventory')` instead of the `Vendor` subject.
//   - nav-registry.ts: the Purchase Orders / Vendors nav children are keyed
//     on subject `Inventory` too, so a role granted `read Inventory` alone
//     sees rows a narrower grant never earned.
//   - loList.tsx (Logistic Orders) is already correctly gated — out of
//     scope, not exercised here.
//
// Every surface below is asserted read-only (SALES-shaped ability: `read`
// only, on `Inventory` / `PurchaseOrder` / `Vendor`, no write verb) AND
// write-capable (an "ADMIN" ability holding every write verb on those three
// subjects), so a fix that over-corrects and hides controls from a real
// writer fails here too.
//
// Seams mocked at the axios layer (not the `@/lib/api/inventory` module) so
// every routed page/dialog runs its REAL hooks — same pattern as
// `stockBulkActions.test.tsx` / `stage-attachment-upload.test.tsx`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';

import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import PurchaseOrdersPage from '@/pages/v2/inventory/PurchaseOrdersPage';
import { VendorsPage } from '@/pages/v2/inventory/VendorsPage';
import { buildNavSections } from '@/pages/v2/buildNavSections';
import { NAV_SECTIONS } from '@/pages/v2/navSections';
import { DEFAULT_LAYOUT_KEYS, getDestination } from '@/components/layout/nav-registry';

import type { Item, Location, Vendor, PurchaseOrder, JobStage } from '@/lib/api/inventory';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
vi.mock('@/lib/axios');

// ─── Fixtures (prefixed qa-2043-, mirroring Pass A's prod fixture) ────────
const WAREHOUSE = 'a0000000-0000-0000-0000-0000000000w1';
const ITEM_ID = 'b0000000-0000-0000-0000-00000000b001';
const VENDOR_ID = 'e0000000-0000-0000-0000-0000000000e1';
const PO_ID = 'f0000000-0000-0000-0000-0000000000f1';
const ASSET_ID = 'c0000000-0000-0000-0000-0000000000c1';
const STAGE_AWAITING_ID = 'stg-2043-a';
const STAGE_COMPLETE_ID = 'stg-2043-b';

const LOCATIONS: Location[] = [
  { id: WAREHOUSE, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
];

const ITEMS: Item[] = [
  {
    id: ITEM_ID,
    sku: 'QA2043-1',
    name: 'qa-2043-item',
    category: 'Hardware',
    trade: 'general' as Item['trade'],
    kind: 'material',
    uom: 'EA',
    unitCost: 40,
    sellPrice: 178,
    serialized: false,
    hazmat: false,
    status: 'active',
    vendor: 'qa-2043-vendor',
    stock: [{ locationId: WAREHOUSE, onHand: 5, min: 2 }],
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
];

const ASSETS = [
  {
    id: ASSET_ID,
    name: 'qa-2043-asset',
    serial: 'SN-2043',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

const VENDORS: Vendor[] = [
  {
    id: VENDOR_ID,
    name: 'qa-2043-vendor',
    category: '',
    contactPersonName: 'Rep',
    status: 'active',
  },
];

function po(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: PO_ID,
    poNumber: 'PO-2043',
    vendor: 'qa-2043-vendor',
    vendorId: VENDOR_ID,
    status: 'draft',
    orderedAt: null,
    orderedBy: null,
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    lines: [
      { id: 'l1', itemSku: 'CAP-01', itemName: 'Run Capacitor', uom: 'ea', qtyOrdered: 4, qtyReceived: 0, unitCost: 12.5 },
    ],
    ...over,
  };
}
const PURCHASE_ORDERS: PurchaseOrder[] = [po()];

function stageLine(over: Partial<JobStage['items'][number]> = {}): JobStage['items'][number] {
  return {
    id: 'it-2043',
    itemSku: 'CAM-01',
    itemName: 'Dome Camera',
    uom: 'EA',
    qtyOrdered: 2,
    qtyReceived: 0,
    vendor: 'qa-2043-vendor',
    poNumber: 'PO-2043',
    serialized: false,
    ...over,
  };
}

const JOB_STAGES: JobStage[] = [
  {
    id: STAGE_AWAITING_ID,
    jobNumber: 'J-2043A',
    customer: 'qa-2043-customer',
    site: '1 Main St',
    trade: 'locksmith',
    status: 'awaiting',
    stagedLocationId: WAREHOUSE,
    items: [stageLine()],
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: STAGE_COMPLETE_ID,
    jobNumber: 'J-2043B',
    customer: 'qa-2043-customer',
    site: '1 Main St',
    trade: 'locksmith',
    status: 'complete',
    stagedLocationId: WAREHOUSE,
    items: [stageLine({ id: 'it-2043b', qtyReceived: 2 })],
    createdAt: '2026-07-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/inventory/items')) return { data: { data: ITEMS } };
    if (url.startsWith('/api/inventory/locations')) return { data: { locations: LOCATIONS } };
    if (url.startsWith('/api/inventory/assets')) return { data: { data: ASSETS, meta: { total: ASSETS.length } } };
    if (url.startsWith('/api/inventory/vendors')) return { data: { vendors: VENDORS } };
    if (url.startsWith('/api/inventory/purchase-orders')) return { data: { purchaseOrders: PURCHASE_ORDERS } };
    if (url.startsWith('/api/inventory/job-stages')) return { data: { jobStages: JOB_STAGES } };
    if (url.startsWith('/api/inventory/techs')) return { data: { techs: [] } };
    if (url.startsWith('/api/logistic-orders')) return { data: { data: [], page: 1, limit: 50, total: 0 } };
    if (url.startsWith('/api/users')) return { data: { users: [] } };
    return {
      data: {
        data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 1 },
        locations: [], vendors: [], categories: [], branches: [], brands: [],
        stages: [], assets: [], total: 0, jobStages: [], purchaseOrders: [],
        users: [], finishes: [], techs: [], itemGroups: [],
      },
    };
  });
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

// SALES-shaped, per Pass A's `GET /api/auth/me` capture: unconditional reads
// only, no create/update/delete/manage on any of the three subjects.
const readOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
  ]);

// Full write on all three subjects — the "must stay green" control.
const writeAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Inventory' },
    { action: 'create', subject: 'Inventory' },
    { action: 'update', subject: 'Inventory' },
    { action: 'delete', subject: 'Inventory' },
    { action: 'manage', subject: 'Inventory' },
    // Lead premise amendment (spec §gate table): item writes are PriceBook routes, not Inventory.
    { action: 'read', subject: 'PriceBook' },
    { action: 'create', subject: 'PriceBook' },
    { action: 'update', subject: 'PriceBook' },
    { action: 'delete', subject: 'PriceBook' },
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'PurchaseOrder' },
    { action: 'update', subject: 'PurchaseOrder' },
    { action: 'delete', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
    { action: 'create', subject: 'Vendor' },
    { action: 'update', subject: 'Vendor' },
    { action: 'delete', subject: 'Vendor' },
  ]);

function renderStock(ability = readOnlyAbility(), path = '/inventory') {
  return renderWithProviders(<InventoryPage />, { ability, initialEntries: [path] });
}

// ─── Stock toolbar ─────────────────────────────────────────────────────────
describe('#2043 — Stock toolbar', () => {
  it('hides Add Item / Restock / Transfer / Import CSV for a read-only ability', async () => {
    renderStock(readOnlyAbility());
    await screen.findByText('qa-2043-item');

    expect(screen.queryByRole('button', { name: /Add Item/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Restock$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Transfer$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import CSV/i })).not.toBeInTheDocument();
  });

  it('keeps Add Item for a write ability (must stay green)', async () => {
    renderStock(writeAbility());
    await screen.findByText('qa-2043-item');

    expect(screen.getByRole('button', { name: /Add Item/i })).toBeInTheDocument();
  });
});

// ─── Stock item detail panel ────────────────────────────────────────────────
describe('#2043 — Stock item detail panel', () => {
  it('hides Reserve levels and Delete item for a read-only ability', async () => {
    renderStock(readOnlyAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;
    fireEvent.click(row);

    await screen.findByLabelText('Close item details');
    expect(screen.queryByRole('button', { name: 'Reserve levels' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete item')).not.toBeInTheDocument();
  });

  it('keeps Reserve levels and Delete item for a write ability (must stay green)', async () => {
    renderStock(writeAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;
    fireEvent.click(row);

    await screen.findByLabelText('Close item details');
    expect(screen.getByRole('button', { name: 'Reserve levels' })).toBeInTheDocument();
    expect(screen.getByLabelText('Delete item')).toBeInTheDocument();
  });
});

// ─── Stock item edit dialog (AddItemDialog opened without readOnly) ───────
describe('#2043 — Stock item edit dialog', () => {
  it('opens with a live Save Changes control for a read-only ability (AddItemDialog supports readOnly since #2009, but the caller never sets it)', async () => {
    renderStock(readOnlyAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;
    fireEvent.click(row);
    await screen.findByLabelText('Close item details');

    // Lead premise amendment: a read-only requester is offered "View" (same dialog, readOnly), not "Edit".
    fireEvent.click(screen.getByRole('button', { name: /^(View|Edit)$/ }));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });

  it('keeps a live, enabled Save Changes control for a write ability (must stay green)', async () => {
    renderStock(writeAbility());
    const row = (await screen.findByText('qa-2043-item')).closest('tr')!;
    fireEvent.click(row);
    await screen.findByLabelText('Close item details');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');

    const saveBtn = screen.getByRole('button', { name: 'Save Changes' });
    expect(saveBtn).toBeInTheDocument();
    expect(saveBtn).not.toBeDisabled();
  });
});

// ─── Assets ─────────────────────────────────────────────────────────────────
describe('#2043 — Assets', () => {
  it('hides New Asset and the row menu Delete action for a read-only ability', async () => {
    renderStock(readOnlyAbility(), '/inventory/assets');
    await screen.findByText('qa-2043-asset');

    expect(screen.queryByRole('button', { name: /New Asset/i })).not.toBeInTheDocument();

    // Lead premise amendment (spec §D): when no menu entry survives the ability, the
    // "More actions" trigger itself is not rendered - so assert its absence; if a trigger
    // IS rendered (some entry survived), it must not offer Delete.
    const trigger = screen.queryByRole('button', { name: 'More actions for qa-2043-asset' });
    if (trigger) {
      await userEvent.click(trigger);
      const menu = within(await screen.findByRole('menu'));
      expect(menu.queryByRole('menuitem', { name: /Delete/i })).not.toBeInTheDocument();
    }
    expect(trigger).toBeNull();
  });

  it('keeps New Asset and the row menu Delete action for a write ability (must stay green)', async () => {
    renderStock(writeAbility(), '/inventory/assets');
    await screen.findByText('qa-2043-asset');

    expect(screen.getByRole('button', { name: /New Asset/i })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'More actions for qa-2043-asset' }),
    );
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: /Delete/i })).toBeInTheDocument();
  });
});

// A card's line items (and "Receive +1") only render once expanded; the
// first render always mounts collapsed here because `useJobStages` resolves
// asynchronously through the axios mock (documented in stagingView.tsx's
// `expandedId` comment), unlike `stagingView.test.tsx`'s direct module mock
// which resolves synchronously on the first render.
function expandStageCard(jobNumber: string) {
  const header = screen.getByRole('button', { name: jobNumber }).closest('[role="button"]');
  if (!header) throw new Error(`no card header found for ${jobNumber}`);
  fireEvent.click(header);
}

// ─── Staging list ───────────────────────────────────────────────────────────
describe('#2043 — Staging list', () => {
  it('hides New Pickup and Receive +1 for a read-only ability', async () => {
    renderStock(readOnlyAbility(), '/inventory/staging');
    await screen.findByText('J-2043A');

    expect(screen.queryByRole('button', { name: 'New Pickup' })).not.toBeInTheDocument();
    expandStageCard('J-2043A');
    expect(screen.queryByRole('button', { name: 'Receive +1' })).not.toBeInTheDocument();
  });

  it('keeps New Pickup and Receive +1 for a write ability (must stay green)', async () => {
    renderStock(writeAbility(), '/inventory/staging');
    await screen.findByText('J-2043A');

    expect(screen.getByRole('button', { name: 'New Pickup' })).toBeInTheDocument();
    expandStageCard('J-2043A');
    expect(screen.getByRole('button', { name: 'Receive +1' })).toBeInTheDocument();
  });
});

// ─── Staging detail dialog (StageDetailDialog) ─────────────────────────────
describe('#2043 — StageDetailDialog', () => {
  it('offers Edit Stage on a finished stage for a read-only ability', async () => {
    renderStock(readOnlyAbility(), '/inventory/staging');
    await screen.findByText('J-2043A');
    fireEvent.click(screen.getByRole('button', { name: 'J-2043B' }));

    await screen.findByText(/Staging entry/);
    expect(screen.queryByRole('button', { name: 'Edit Stage' })).not.toBeInTheDocument();
  });

  it('keeps Edit Stage on a finished stage for a write ability (must stay green)', async () => {
    renderStock(writeAbility(), '/inventory/staging');
    await screen.findByText('J-2043A');
    fireEvent.click(screen.getByRole('button', { name: 'J-2043B' }));

    await screen.findByText(/Staging entry/);
    expect(screen.getByRole('button', { name: 'Edit Stage' })).toBeInTheDocument();
  });
});

// ─── Purchase Orders page ──────────────────────────────────────────────────
describe('#2043 — PurchaseOrdersPage', () => {
  function renderPOs(ability: ReturnType<typeof readOnlyAbility>) {
    return renderWithProviders(<PurchaseOrdersPage />, {
      ability,
      initialEntries: ['/inventory/purchase-orders'],
    });
  }

  it('hides Create PO for a read-only ability', async () => {
    renderPOs(readOnlyAbility());
    await screen.findByText('PO-2043');

    expect(screen.queryByRole('button', { name: 'Create PO' })).not.toBeInTheDocument();
  });

  it('keeps Create PO for a write ability (must stay green)', async () => {
    renderPOs(writeAbility());
    await screen.findByText('PO-2043');

    expect(screen.getByRole('button', { name: 'Create PO' })).toBeInTheDocument();
  });
});

// ─── PO detail dialog ───────────────────────────────────────────────────────
describe('#2043 — PODetailDialog', () => {
  async function openDetail(ability: ReturnType<typeof readOnlyAbility>) {
    renderWithProviders(<PurchaseOrdersPage />, {
      ability,
      initialEntries: ['/inventory/purchase-orders'],
    });
    const row = (await screen.findByText('PO-2043')).closest('tr')!;
    fireEvent.click(row);
    await screen.findByRole('dialog');
  }

  it('offers Delete and Mark as ordered for a read-only ability', async () => {
    await openDetail(readOnlyAbility());

    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark as ordered/i })).not.toBeInTheDocument();
  });

  it('keeps Delete and Mark as ordered for a write ability (must stay green)', async () => {
    await openDetail(writeAbility());

    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark as ordered/i })).toBeInTheDocument();
  });
});

// ─── Vendors page (wrong subject: gated on `manage Inventory`) ────────────
describe('#2043 — VendorsPage (wrong subject)', () => {
  function renderVendors(ability: ReturnType<typeof readOnlyAbility>) {
    return renderWithProviders(<VendorsPage />, {
      ability,
      initialEntries: ['/inventory/vendors'],
    });
  }

  it('shows Add Vendor for an ability with manage Inventory but NOT create Vendor (must NOT — wrong subject)', async () => {
    const manageInventoryOnly = buildAbility([
      { action: 'read', subject: 'Inventory' },
      { action: 'manage', subject: 'Inventory' },
    ]);
    renderVendors(manageInventoryOnly);
    await screen.findByText('qa-2043-vendor');

    expect(screen.queryByRole('button', { name: /Add Vendor/i })).not.toBeInTheDocument();
  });

  it('hides Add Vendor for an ability with create Vendor but no manage Inventory (must show it)', async () => {
    const createVendorOnly = buildAbility([
      { action: 'read', subject: 'Vendor' },
      { action: 'create', subject: 'Vendor' },
    ]);
    renderVendors(createVendorOnly);
    await screen.findByText('qa-2043-vendor');

    expect(screen.getByRole('button', { name: /Add Vendor/i })).toBeInTheDocument();
  });

  it('keeps Add Vendor for the full write ability (must stay green)', async () => {
    renderVendors(writeAbility());
    await screen.findByText('qa-2043-vendor');

    expect(screen.getByRole('button', { name: /Add Vendor/i })).toBeInTheDocument();
  });
});

// ─── Vendor detail dialog (same wrong subject) ─────────────────────────────
describe('#2043 — VendorDetailDialog (wrong subject)', () => {
  async function openVendorDetail(ability: ReturnType<typeof readOnlyAbility>) {
    renderWithProviders(<VendorsPage />, { ability, initialEntries: ['/inventory/vendors'] });
    fireEvent.click((await screen.findByText('qa-2043-vendor')).closest('button')!);
    await screen.findByText(/Vendor ·/);
  }

  it('shows Edit / Archive / Delete for an ability with manage Inventory but NOT update/delete Vendor (must NOT — wrong subject)', async () => {
    const manageInventoryOnly = buildAbility([
      { action: 'read', subject: 'Inventory' },
      { action: 'manage', subject: 'Inventory' },
    ]);
    await openVendorDetail(manageInventoryOnly);

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });

  it('hides Edit / Archive / Delete for an ability with create Vendor (the upsert route gate) but no manage Inventory (must show them)', async () => {
    // Lead premise amendment: POST /api/inventory/vendors is an upsert gated create Vendor; edit/archive ride it.
    const vendorWriteOnly = buildAbility([
      { action: 'read', subject: 'Vendor' },
      { action: 'create', subject: 'Vendor' },
      { action: 'delete', subject: 'Vendor' },
    ]);
    await openVendorDetail(vendorWriteOnly);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
  });

  it('keeps Edit / Archive / Delete for the full write ability (must stay green)', async () => {
    await openVendorDetail(writeAbility());

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
  });
});

// ─── Nav registry: Purchase Orders / Vendors children (wrong subject) ─────
describe('#2043 — nav registry, Inventory group children (wrong subject)', () => {
  function rowsFor(sections: ReturnType<typeof buildNavSections>) {
    return sections.flatMap((s) => s.items.flatMap((item) => [item, ...(item.children ?? [])]));
  }

  function build(ability: ReturnType<typeof readOnlyAbility>) {
    return buildNavSections({
      keys: DEFAULT_LAYOUT_KEYS,
      sections: NAV_SECTIONS,
      getDestination,
      can: ability.can.bind(ability),
      isLocked: () => false,
      isFeatureLocked: () => false,
    });
  }

  it('shows Purchase Orders / Vendors nav rows to an ability with read Inventory but neither read PurchaseOrder nor read Vendor (must NOT — the child is keyed on the wrong subject)', () => {
    const inventoryOnly = buildAbility([{ action: 'read', subject: 'Inventory' }]);
    const labels = rowsFor(build(inventoryOnly)).map((r) => r.dest.label);

    expect(labels).not.toContain('Purchase Orders');
    expect(labels).not.toContain('Vendors');
  });

  it('keeps Purchase Orders / Vendors nav rows for a full read ability (must stay green)', () => {
    const fullRead = buildAbility([
      { action: 'read', subject: 'Inventory' },
      { action: 'read', subject: 'PurchaseOrder' },
      { action: 'read', subject: 'Vendor' },
    ]);
    const labels = rowsFor(build(fullRead)).map((r) => r.dest.label);

    expect(labels).toContain('Purchase Orders');
    expect(labels).toContain('Vendors');
  });
});

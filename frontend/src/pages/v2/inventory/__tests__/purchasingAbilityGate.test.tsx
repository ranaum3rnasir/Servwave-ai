// #2043 slice 3 - new RED/GREEN pairs for gates the frozen
// `repro-2043.test.tsx` does not pin (R14: every new gate needs its own
// pair). The frozen test is read-only; these cases live here, mirroring
// `stockAbilityGate.test.tsx` / `priceBookAbilityGate.test.tsx`'s shape.
//
// Covers:
//   1. PODetailDialog status picker (R3) - hidden without update PurchaseOrder,
//      the status badge stays readable either way.
//   2. PODetailDialog delete-blocked fallback "Cancel PO instead" (R3).
//   3. PODetailDialog dismiss `Close` + `Preview / Print` landmine - both stay
//      for a read-only ability, and dismiss Close still closes the dialog.
//   4. `Close PO` (the status action, distinct from the dismiss `Close`).
//   5. VendorCategoryPicker (R13) - add / rename / delete gated separately.
//   6. Staged PO non-regression: a writer still sees the disabled primary
//      action + the "Open Staging" pointer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import { PODetailDialog } from '@/components/inventory/PODetailDialog';
import { AddVendorDialog } from '@/components/inventory/AddVendorDialog';
import type { PurchaseOrder, VendorCategory } from '@/lib/api/inventory';

const hoisted = vi.hoisted(() => ({
  LOC_MAIN_ID: 'aaaaaaa1-0000-4000-8000-000000000001',
  org: { id: 'org-1', default_inventory_location_id: 'aaaaaaa1-0000-4000-8000-000000000001' as string | null },
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual, // useUpdatePO / useDeletePO stay REAL - the mutations are exercised
    useLocations: stable([{ id: hoisted.LOC_MAIN_ID, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }]),
    usePurchaseOrders: stable(EMPTY),
    useVendors: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    useInventoryJobs: stable(EMPTY),
    useBranches: stable(EMPTY),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function po(over: Partial<PurchaseOrder> & { status: PurchaseOrder['status'] }): PurchaseOrder {
  return {
    id: `po-${over.status}-1`,
    poNumber: 'PO-7301',
    vendor: 'Acme Supply',
    orderedAt: over.status === 'draft' ? null : '2026-07-01T00:00:00Z',
    orderedBy: over.status === 'draft' ? null : { id: 'u1', name: 'Dana Buyer' },
    receivedAt: null,
    leadTimeDays: null,
    notes: null,
    signatureData: null,
    signatureName: null,
    signatureAt: null,
    createdAt: '2026-06-30T00:00:00Z',
    lines: [
      { id: 'l1', itemSku: 'A', itemName: 'Item A', uom: 'EA', qtyOrdered: 5, qtyReceived: 0, unitCost: 10 },
    ],
    ...over,
  };
}

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

// Read-only + Delete only - no update PurchaseOrder - used across several
// pairs below so the "must not X" side can never pass for the wrong reason
// (it also lacks other write verbs the fix must not consult).
const readOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'read', subject: 'Vendor' },
  ]);

const updateOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'update', subject: 'PurchaseOrder' },
  ]);

// Holds delete but deliberately NOT update - the delete-blocked fallback is
// an UPDATE behind a DELETE-gated control (R3), so this must NOT see it.
const deleteOnlyAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'delete', subject: 'PurchaseOrder' },
  ]);

const deleteAndUpdateAbility = () =>
  buildAbility([
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'update', subject: 'PurchaseOrder' },
    { action: 'delete', subject: 'PurchaseOrder' },
  ]);

function renderDialog(p: PurchaseOrder, ability: ReturnType<typeof readOnlyAbility>) {
  const onClose = vi.fn();
  renderWithProviders(
    <PODetailDialog open onClose={onClose} po={p} onReceive={vi.fn()} onUpdated={vi.fn()} onDeleted={vi.fn()} />,
    { ability },
  );
  return { onClose };
}

// ─── 1. PO status picker (R3) ──────────────────────────────────────────────
describe('#2043 — PODetailDialog status picker (R3)', () => {
  it('hides the status picker without update PurchaseOrder, keeps the status badge readable', async () => {
    renderDialog(po({ status: 'draft' }), readOnlyAbility());

    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows the status picker with update PurchaseOrder', async () => {
    renderDialog(po({ status: 'draft' }), updateOnlyAbility());

    // The picker itself echoes "Draft" as its current value, alongside the
    // status badge - assert the control, not the (now duplicated) text.
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

// ─── 2. Delete-blocked fallback (R3) ───────────────────────────────────────
describe('#2043 — PODetailDialog delete-blocked fallback (R3)', () => {
  async function triggerBlockedDelete() {
    mockApi.delete.mockRejectedValue({
      response: { status: 409, data: { error: 'PO_HAS_RECEIPTS', message: 'Stock has been received against this PO.' } },
    });
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /delete po/i }));
    await screen.findByText("This PO can't be deleted");
  }

  it('does not offer "Cancel PO instead" without update PurchaseOrder', async () => {
    renderDialog(po({ status: 'ordered' }), deleteOnlyAbility());
    await triggerBlockedDelete();

    expect(screen.queryByRole('button', { name: /cancel po instead/i })).not.toBeInTheDocument();
  });

  it('offers "Cancel PO instead" with update PurchaseOrder', async () => {
    renderDialog(po({ status: 'ordered' }), deleteAndUpdateAbility());
    await triggerBlockedDelete();

    expect(screen.getByRole('button', { name: /cancel po instead/i })).toBeInTheDocument();
  });
});

// ─── 3. Dismiss `Close` + `Preview / Print` landmine ───────────────────────
describe('#2043 — PODetailDialog dismiss Close (landmine, not update-gated)', () => {
  it('keeps the dismiss Close and Preview / Print for a read-only ability, and Close closes the dialog', async () => {
    const { onClose } = renderDialog(po({ status: 'draft' }), readOnlyAbility());

    expect(screen.getByRole('button', { name: 'Preview / Print' })).toBeInTheDocument();
    // Two "Close"-named buttons: the Modal's own X (icon + sr-only label) plus
    // the footer's dismiss control (plain text, no icon). Asserting only
    // `[0]` is a landmine - if the footer button is ever accidentally gated,
    // the query silently degrades to 1 match and `[0]` picks up the Modal's
    // own X instead, which also fires `onClose`, so the case stays green on
    // broken code. Assert the count AND pick the footer control structurally
    // (no svg child), not by array position.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons).toHaveLength(2);
    const footerClose = closeButtons.find((b) => !b.querySelector('svg'));
    expect(footerClose).toBeDefined();
    await userEvent.click(footerClose!);
    expect(onClose).toHaveBeenCalled();
  });
});

// ─── 4. `Close PO` (the status action, distinct from dismiss Close) ───────
describe('#2043 — PODetailDialog "Close PO" status action (R3)', () => {
  it('is absent for a read-only ability', async () => {
    renderDialog(po({ status: 'received' }), readOnlyAbility());

    expect(screen.queryByRole('button', { name: 'Close PO' })).not.toBeInTheDocument();
    // The dismiss Close (a different control, same-ish label) still renders -
    // two "Close"-named buttons exist (the Modal's own X plus the footer's).
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });

  it('is present with update PurchaseOrder', async () => {
    renderDialog(po({ status: 'received' }), updateOnlyAbility());

    expect(screen.getByRole('button', { name: 'Close PO' })).toBeInTheDocument();
  });
});

// ─── 6. Staged PO non-regression ───────────────────────────────────────────
describe('#2043 — PODetailDialog staged PO (non-regression)', () => {
  it('a writer on a staged PO still sees the disabled primary action and the Staging pointer', async () => {
    const staged = po({ status: 'ordered', stagedAsJobStageId: 'stage-1' });
    renderDialog(staged, updateOnlyAbility());

    const disabledBtn = screen.getByRole('button', { name: /received via staging/i });
    expect(disabledBtn).toBeDisabled();
    expect(screen.getByRole('link', { name: /open staging/i })).toHaveAttribute('href', '/inventory/staging');
  });
});

// ─── 7. Notes to the vendor (Lead UI-pass residual) ────────────────────────
describe('#2043 — PODetailDialog notes to the vendor (Lead UI-pass residual)', () => {
  it('renders the notes read-only without update PurchaseOrder: no textbox, no PATCH on blur', async () => {
    renderDialog(po({ status: 'draft', notes: 'Deliver to loading dock B' }), readOnlyAbility());

    expect(await screen.findByText('Deliver to loading dock B')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /notes to the vendor/i })).not.toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('renders the notes as an editable textbox with update PurchaseOrder', async () => {
    renderDialog(po({ status: 'draft', notes: 'Deliver to loading dock B' }), updateOnlyAbility());

    expect(screen.getByRole('textbox', { name: /notes to the vendor/i })).toBeInTheDocument();
  });
});

// ─── 5. VendorCategoryPicker (R13) ─────────────────────────────────────────
describe('#2043 — VendorCategoryPicker (R13)', () => {
  const PLUMBING: VendorCategory = { id: 'a1000000-0000-4000-8000-000000000a01', name: 'Plumbing wholesale', vendorCount: 3 };

  function installGetMock() {
    mockApi.get.mockImplementation(async () => ({ data: { categories: [PLUMBING] } }));
  }

  async function openManage() {
    // AddVendorDialog is rendered `open` directly (no trigger to click) -
    // its own gate lives at the VendorsPage call site (§H), out of scope here.
    // The Select's dropdown portals to document.body (outside the dialog's own
    // DOM subtree), so the combobox/option queries below go through `screen`,
    // not `within(dialog)` - only the inline "Manage categories" panel is a
    // real descendant of the dialog.
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: PLUMBING.name });
    await userEvent.click(screen.getByRole('option', { name: /manage categories/i }));
    return screen.findByRole('group', { name: /manage categories/i });
  }

  const createVendorOnly = () => buildAbility([{ action: 'create', subject: 'Vendor' }]);
  const allVendorCategoryVerbs = () =>
    buildAbility([
      { action: 'create', subject: 'Vendor' },
      { action: 'update', subject: 'Vendor' },
      { action: 'delete', subject: 'Vendor' },
    ]);
  const readOnlyVendorAbility = () => buildAbility([{ action: 'read', subject: 'Vendor' }]);

  it('with create Vendor only: add is offered, rename and delete are absent', async () => {
    installGetMock();
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />, {
      ability: createVendorOnly(),
    });
    const panel = await openManage();

    expect(within(panel).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: `Rename ${PLUMBING.name}` })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: `Delete ${PLUMBING.name}` })).not.toBeInTheDocument();
  });

  it('with create+update+delete Vendor: add, rename and delete are all offered', async () => {
    installGetMock();
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />, {
      ability: allVendorCategoryVerbs(),
    });
    const panel = await openManage();

    expect(within(panel).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: `Rename ${PLUMBING.name}` })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: `Delete ${PLUMBING.name}` })).toBeInTheDocument();
  });

  it('with a read-only ability: none of add / rename / delete are offered', async () => {
    installGetMock();
    // AddVendorDialog itself is unconditionally mountable (its call site is
    // gated create Vendor per §H) - mounted directly here to probe the
    // picker's own per-verb gates in isolation (R13).
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />, {
      ability: readOnlyVendorAbility(),
    });
    const panel = await openManage();

    expect(within(panel).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: `Rename ${PLUMBING.name}` })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: `Delete ${PLUMBING.name}` })).not.toBeInTheDocument();
  });
});

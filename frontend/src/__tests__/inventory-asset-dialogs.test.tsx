// Inventory P4 — Asset dialogs (create/edit + action verbs).
//
// Contract under test:
//   • Create submit fires useCreateAsset().mutateAsync with the EXACT
//     {name, serial, price_book_item_id, notes} body (payload-shape assert).
//   • Duplicate-serial WARN is client-side and NON-blocking (QA-38): the
//     amber helper appears, the submit button stays enabled, and submitting
//     still fires the mutation — the server never enforces uniqueness.
//   • Photo chosen on create → entity-first ordering: after create resolves
//     with {id}, useUploadAssetPhoto fires with that id + the File.
//   • Assign dialog lists only is_active users; submit sends
//     {id, action:'assign', user_id, note}; transfer mode hides the holder.
//   • Retire on an assigned asset shows the "also returns it" copy; confirm
//     sends {id, action:'retire'}.
//
// Seam hooks are mocked directly with stable resolved data (jsdom seed-loop
// learning; template: purchase-orders-deeplink.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AssetDialog } from '@/components/inventory/assets/AssetDialog';
import { AssetActionDialog } from '@/components/inventory/assets/AssetActionDialog';
import type { Asset } from '@/lib/api/inventory';

const h = vi.hoisted(() => {
  const EXISTING_ASSET = {
    id: 'a0000000-0000-0000-0000-00000000a001',
    name: 'DeWalt Hammer Drill',
    serial: 'SN-100',
    status: 'ACTIVE' as const,
    notes: null,
    photo_url: null,
    price_book_item: null,
    assigned_user: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
  const ASSETS_RESP = {
    data: { data: [EXISTING_ASSET], meta: { total: 1 } },
    isLoading: false,
    isError: false,
  };
  const userRow = (
    id: string, first: string, last: string, role: string, active: boolean,
  ) => ({
    id, email: `${first.toLowerCase()}@x.com`, first_name: first, last_name: last,
    role, is_active: active, has_login: true, phone: null, phone_ext: null,
    department_id: null, department: null,
    enforce_clock_in_location: false, can_approve_clock_overrides: false,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  return {
    EXISTING_ASSET,
    ASSETS_RESP,
    USERS: [
      userRow('u0000000-0000-0000-0000-00000000u001', 'John', 'Tech', 'TECHNICIAN', true),
      userRow('u0000000-0000-0000-0000-00000000u002', 'Sara', 'Dispatch', 'DISPATCHER', true),
      userRow('u0000000-0000-0000-0000-00000000u003', 'Bob', 'Old', 'TECHNICIAN', false),
    ],
    createSpy: vi.fn(async (body: Record<string, unknown>) => ({
      id: 'a0000000-0000-0000-0000-00000000anew',
      ...body,
    })),
    updateSpy: vi.fn(async (body: Record<string, unknown>) => body),
    uploadSpy: vi.fn(async () => ({})),
    actionSpy: vi.fn(async () => ({})),
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  return {
    ...actual,
    useAssets: () => h.ASSETS_RESP,
    useInventoryItems: () => ({ data: EMPTY, isLoading: false, isError: false }),
    useCreateAsset: () => ({ mutateAsync: h.createSpy, isPending: false }),
    useUpdateAsset: () => ({ mutateAsync: h.updateSpy, isPending: false }),
    useUploadAssetPhoto: () => ({ mutateAsync: h.uploadSpy, isPending: false }),
    useAssetAction: () => ({ mutateAsync: h.actionSpy, isPending: false }),
  };
});

vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>();
  return {
    ...actual,
    useUsers: () => ({ data: h.USERS, isLoading: false, isError: false }),
  };
});

const ASSIGNED_ASSET: Asset = {
  ...h.EXISTING_ASSET,
  id: 'a0000000-0000-0000-0000-00000000a002',
  name: 'Makita Jigsaw',
  serial: 'SN-300',
  assigned_user: {
    id: 'u0000000-0000-0000-0000-00000000u001',
    first_name: 'John',
    last_name: 'Tech',
  },
};

beforeEach(() => {
  h.createSpy.mockClear();
  h.updateSpy.mockClear();
  h.uploadSpy.mockClear();
  h.actionSpy.mockClear();
});

describe('AssetDialog — create/edit (P4)', () => {
  it('create submit calls useCreateAsset with the exact body shape', async () => {
    renderWithProviders(
      <AssetDialog open onClose={vi.fn()} editAsset={null} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Asset name'), {
      target: { value: 'Makita Driver' },
    });
    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: 'SN-900' },
    });
    fireEvent.change(screen.getByLabelText('Asset notes'), {
      target: { value: 'Purchased 2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create asset/ }));

    await waitFor(() => expect(h.createSpy).toHaveBeenCalledTimes(1));
    expect(h.createSpy).toHaveBeenCalledWith({
      name: 'Makita Driver',
      serial: 'SN-900',
      price_book_item_id: null,
      notes: 'Purchased 2026',
    });
    expect(h.uploadSpy).not.toHaveBeenCalled();
  });

  it('duplicate serial shows the amber warning but never blocks submit (QA-38)', async () => {
    renderWithProviders(
      <AssetDialog open onClose={vi.fn()} editAsset={null} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Asset name'), {
      target: { value: 'Second Drill' },
    });
    // Case-insensitive + trimmed match against the loaded assets list.
    fireEvent.change(screen.getByLabelText('Serial number'), {
      target: { value: '  sn-100 ' },
    });

    expect(
      await screen.findByText(/already has this serial/),
    ).toHaveTextContent('Another asset ("DeWalt Hammer Drill") already has this serial');

    const submit = screen.getByRole('button', { name: /Create asset/ });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(h.createSpy).toHaveBeenCalledTimes(1));
    expect(h.createSpy).toHaveBeenCalledWith({
      name: 'Second Drill',
      serial: 'sn-100',
      price_book_item_id: null,
      notes: null,
    });
  });

  it('photo chosen on create uploads AFTER create resolves, with the new id + File', async () => {
    renderWithProviders(
      <AssetDialog open onClose={vi.fn()} editAsset={null} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText('Asset name'), {
      target: { value: 'Bosch Grinder' },
    });
    const file = new File(['png-bytes'], 'grinder.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Asset photo'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create asset/ }));

    await waitFor(() => expect(h.uploadSpy).toHaveBeenCalledTimes(1));
    expect(h.createSpy).toHaveBeenCalledTimes(1);
    expect(h.uploadSpy).toHaveBeenCalledWith({
      id: 'a0000000-0000-0000-0000-00000000anew',
      file,
    });
  });
});

describe('AssetActionDialog — verbs (P4)', () => {
  it('assign lists only active users and submits {id, action, user_id, note}', async () => {
    const unassigned = h.EXISTING_ASSET as Asset;
    renderWithProviders(
      <AssetActionDialog
        open
        mode="assign"
        asset={unassigned}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    // Active users only — the inactive one never renders as an option. The
    // picker is the design-system SelectField now (DESIGN_SYSTEM.md §4.2), so
    // the options live in a Radix portal that only exists while it is open.
    await userEvent.click(screen.getByRole('combobox', { name: 'Assign to' }));
    expect(
      await screen.findByRole('option', { name: /John Tech/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Sara Dispatch/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Bob Old/ }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('option', { name: /John Tech/ }));
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'take the charger too' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign Asset' }));

    await waitFor(() => expect(h.actionSpy).toHaveBeenCalledTimes(1));
    expect(h.actionSpy).toHaveBeenCalledWith({
      id: unassigned.id,
      action: 'assign',
      user_id: 'u0000000-0000-0000-0000-00000000u001',
      note: 'take the charger too',
    });
  });

  it('transfer mode excludes the current holder from the picker', async () => {
    renderWithProviders(
      <AssetActionDialog
        open
        mode="transfer"
        asset={ASSIGNED_ASSET}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'Transfer to' }));
    expect(
      await screen.findByRole('option', { name: /Sara Dispatch/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /John Tech/ }),
    ).not.toBeInTheDocument();
  });

  it('retire on an assigned asset shows the "also returns it" copy and submits {id, action}', async () => {
    renderWithProviders(
      <AssetActionDialog
        open
        mode="retire"
        asset={ASSIGNED_ASSET}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByText(/retiring\s+also returns it/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retire Asset' }));

    await waitFor(() => expect(h.actionSpy).toHaveBeenCalledTimes(1));
    expect(h.actionSpy).toHaveBeenCalledWith({
      id: ASSIGNED_ASSET.id,
      action: 'retire',
    });
  });
});

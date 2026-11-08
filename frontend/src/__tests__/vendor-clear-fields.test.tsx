/**
 * Vendor saves that actually save (V1–V4).
 *
 * All four defects lived on the write path out of `VendorDetailDialog` and the
 * page that hosts it, and three of them shared one failure mode: the write was
 * discarded or rejected and the UI reported success anyway.
 *
 *   V1  clearing an optional field emitted `undefined`, which JSON.stringify
 *       drops outright, so the server's `!== undefined` guard never saw the key
 *   V2  removing the last additional contact emitted `undefined` rather than
 *       `[]`, and an absent `additionalContacts` means "leave contacts alone"
 *   V3  no mutation carried an `onError`, so a rejected write kept its
 *       optimistic local row and raised a success toast
 *   V4  a blanked Name or Category 400ed with nothing on screen to say so
 *
 * Driven through `pages/v2/inventory/VendorsPage` — the page `/inventory/vendors`
 * actually routes to (`pages/v2/routes/inventory.routes.tsx:67`). The legacy
 * the legacy v1 Vendors page was deleted in PR 1 of the purchasing audit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, inventoryWriteAbility } from './helpers';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';

// The routed page reports through the kit's sonner toaster, which App.tsx mounts
// at the root and renderWithProviders does not. Spying on the call is how the
// toast copy — and its TONE, which is the whole of V3 — stays asserted without
// standing a toaster up per test.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

const mockToast = vi.mocked(toast);

const hoisted = vi.hoisted(() => ({
  VENDOR: {
    id: 'ddddddd1-0000-4000-8000-000000000001',
    name: 'ADI / Anixter',
    category: 'Security',
    categoryId: 'a1000000-0000-4000-8000-000000000a01',
    status: 'active' as const,
    contactPersonName: 'Marcus Patel',
    contactEmail: 'ny-orders@adiglobal.com',
    accountNumber: 'ADI-88213',
    notes: 'Ask for the will-call counter after 4pm.',
    additionalContacts: [
      { id: 'vc_1', name: 'Dana Ruiz', email: 'ap@adiglobal.com', role: 'AP' },
    ],
  },
}));

// The seam's QUERY hooks are stubbed with already-resolved stable data (the
// pattern the other inventory page tests use — an unstable `[]` default would
// re-fire the seed effect forever and hang jsdom). The upsert MUTATION hook
// stays REAL so the axios spy sees the actual request body.
vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const EMPTY: never[] = [];
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useVendors: stable([hoisted.VENDOR]),
    usePurchaseOrders: stable(EMPTY),
    useInventoryItems: stable(EMPTY),
    // S4.1: the picker and the page read the company's real category list.
    useVendorCategories: stable([
      { id: hoisted.VENDOR.categoryId, name: 'Security', vendorCount: 1 },
      { id: 'a1000000-0000-4000-8000-000000000a02', name: 'Locks', vendorCount: 0 },
    ]),
  };
});

const { VendorsPage } = await import('@/pages/v2/inventory/VendorsPage');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// #2043 - was `manage Inventory` (the wrong-subject gate this fix removes);
// converted to the module's write ability (R14).
const inventoryAdmin = () => inventoryWriteAbility();

let postSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  postSpy = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { vendor: hoisted.VENDOR } });
});

/** Open the vendor's detail dialog and put it into edit mode. */
async function openEditor() {
  renderWithProviders(<VendorsPage />, {
    ability: inventoryAdmin(),
    initialEntries: ['/inventory/vendors'],
  });
  await userEvent.click(await screen.findByText('ADI / Anixter'));
  await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
}

async function save() {
  await userEvent.click(await screen.findByRole('button', { name: /save changes/i }));
}

/** The body of the single POST /api/inventory/vendors this test provoked. */
function upsertBody(): Record<string, unknown> {
  const call = postSpy.mock.calls.find((c) => c[0] === '/api/inventory/vendors');
  expect(call, 'expected a POST /api/inventory/vendors').toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe('vendor save — clearing an optional field (V1)', () => {
  it('sends notes: null, and the key survives JSON.stringify', async () => {
    await openEditor();

    const notes = await screen.findByPlaceholderText(/special handling, rep notes/i);
    await userEvent.clear(notes);
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = upsertBody();
    expect(body.notes).toBeNull();
    // The whole point of V1: `undefined` would vanish here and the column would
    // keep its old value while the UI claimed the save worked.
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('notes', null);
  });

  it('leaves a field the operator never touched off the patch entirely', async () => {
    await openEditor();

    const notes = await screen.findByPlaceholderText(/special handling, rep notes/i);
    await userEvent.clear(notes);
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = upsertBody();
    // A patch is a patch: an untouched column must not be clobbered with null.
    expect(body).not.toHaveProperty('accountNumber');
    expect(body).not.toHaveProperty('website');
    expect(body).not.toHaveProperty('pickupAddress');
  });
});

describe('vendor save — removing the last additional contact (V2)', () => {
  it('sends additionalContacts: [] so the server runs its delete-and-replace', async () => {
    await openEditor();

    await userEvent.click(await screen.findByRole('button', { name: /remove contact/i }));
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = upsertBody();
    expect(body.additionalContacts).toEqual([]);
    // `undefined` here means "leave contacts alone" server-side — the exact
    // reason removing the only contact used to be a silent no-op.
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('additionalContacts', []);
  });
});

describe('vendor save — required-field guard (V4)', () => {
  it('refuses a blanked name, says why, and fires no mutation', async () => {
    await openEditor();

    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.clear(name);
    await save();

    expect(await screen.findByRole('alert')).toHaveTextContent(/vendor name is required/i);
    expect(postSpy).not.toHaveBeenCalledWith('/api/inventory/vendors', expect.anything());
  });

  it('offers no "+ Add new category…" row - the picker lists the real categories plus Uncategorized (S1.2, S4.1)', async () => {
    await openEditor();

    // Several comboboxes are on screen in edit mode; this one is the category
    // picker in the "Vendor identity" panel. Before S1.2 its last row swapped
    // the control for a free-text input whose value was stored nowhere, and
    // opening it blanked the category - the one UI path to a 400 on save.
    const identity = (await screen.findByText('Vendor identity')).closest('div')!;
    await userEvent.click(within(identity).getByRole('combobox'));

    expect(await screen.findByRole('option', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Locks' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Uncategorized' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /add new category/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /type a new category/i })).not.toBeInTheDocument();
  });

  it('still lets a valid edit through', async () => {
    await openEditor();

    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.clear(name);
    await userEvent.type(name, 'ADI Global');
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(upsertBody().name).toBe('ADI Global');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('vendor save — category is a row reference (S4.1)', () => {
  it('picking another category sends its id AND name; picking Uncategorized sends null and ""', async () => {
    await openEditor();

    const identity = (await screen.findByText('Vendor identity')).closest('div')!;
    await userEvent.click(within(identity).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Locks' }));
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(upsertBody()).toMatchObject({
      categoryId: 'a1000000-0000-4000-8000-000000000a02',
      category: 'Locks',
    });
  });

  it('Uncategorized is a legal save: categoryId null, category "", and the key survives JSON', async () => {
    await openEditor();

    const identity = (await screen.findByText('Vendor identity')).closest('div')!;
    await userEvent.click(within(identity).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Uncategorized' }));
    await save();

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const body = upsertBody();
    expect(body).toMatchObject({ categoryId: null, category: '' });
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty('categoryId', null);
    // No "Category is required" refusal any more.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('vendor save — a rejected write is visible and reversible (V3)', () => {
  it('restores the previous values and raises an error toast when the upsert fails', async () => {
    postSpy.mockRejectedValue({ response: { status: 400, data: { error: 'ValidationError' } } });

    await openEditor();

    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed Vendor');
    await save();

    // The optimistic rename is rolled back...
    await waitFor(() =>
      expect(screen.getByText('ADI / Anixter')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Renamed Vendor')).not.toBeInTheDocument();
    // ...and the failure is stated as a FAILURE, not disguised as a success.
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not save "ADI \/ Anixter"/i),
      ),
    );
  });

  it('rolls the row back to active when archiving is rejected', async () => {
    postSpy.mockRejectedValue({ response: { status: 500 } });

    renderWithProviders(<VendorsPage />, {
      ability: inventoryAdmin(),
      initialEntries: ['/inventory/vendors'],
    });
    await userEvent.click(await screen.findByText('ADI / Anixter'));
    await userEvent.click(await screen.findByRole('button', { name: /^archive$/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not archive "ADI \/ Anixter"/i),
      ),
    );
    // The row is back to active — the control still offers Archive, not
    // Reactivate, which it would if the optimistic flip had stuck.
    expect(await screen.findByRole('button', { name: /^archive$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reactivate/i })).not.toBeInTheDocument();
    // And NO success toast: the archive toast used to fire beside the mutation,
    // so a rejected archive announced itself green and was contradicted in red a
    // moment later.
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/archived/i));
  });

  it('toasts the archive success only after the server accepts it', async () => {
    renderWithProviders(<VendorsPage />, {
      ability: inventoryAdmin(),
      initialEntries: ['/inventory/vendors'],
    });
    await userEvent.click(await screen.findByText('ADI / Anixter'));
    await userEvent.click(await screen.findByRole('button', { name: /^archive$/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/archived ADI \/ Anixter/i),
      ),
    );
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

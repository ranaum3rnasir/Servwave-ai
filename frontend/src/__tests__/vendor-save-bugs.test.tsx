/**
 * Vendor save bugs (Purchasing Audit Verdict PR 4, S4.2 / B11).
 *
 * The verdict named three defects on the vendor write path:
 *
 *   (a) a cleared optional field kept its old value
 *   (b) cancelling the category picker wiped the category
 *   (c) save errors were swallowed
 *
 * Reproduced against the tree before this slice: (a) was closed by #1979 (the
 * patch now carries an explicit `null`) and (b) went away with the picker's
 * "+ Add new category…" inline mode (removed in PR 1, rebuilt as a Manage list
 * in S4.1) - both are pinned here so they cannot come back. (c) still
 * reproduced in part: the page DID raise an error toast, but a generic one, it
 * ALSO raised the "updated" success toast, and the dialog had already left
 * edit mode and thrown the draft away - so the operator lost their edits and
 * saw two contradictory toasts. The save now awaits the server: success leaves
 * edit mode and toasts once; failure keeps the dialog open with the draft,
 * shows the server's reason inline and toasts it.
 *
 * Driven through `pages/v2/inventory/VendorsPage`, the page `/inventory/vendors`
 * routes to, so the page's optimistic mirror and rollback are under test too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, inventoryWriteAbility } from './helpers';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';

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
    website: 'https://www.adiglobal.com',
    notes: 'Ask for the will-call counter after 4pm.',
  },
}));

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

const VALIDATION_400 = {
  response: {
    status: 400,
    data: {
      error: 'Validation failed',
      details: [{ field: 'name', message: 'String must contain at most 200 character(s)' }],
    },
  },
};

let postSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  postSpy = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { vendor: hoisted.VENDOR } });
});

function renderPage() {
  renderWithProviders(<VendorsPage />, {
    ability: inventoryAdmin(),
    initialEntries: ['/inventory/vendors'],
  });
}

/** Open the vendor's detail dialog and put it into edit mode. */
async function openEditor() {
  renderPage();
  await openVendor();
  await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
}

async function openVendor() {
  await userEvent.click(await screen.findByText('ADI / Anixter'));
  await screen.findByText('Vendor · ADI / Anixter');
}

/** The footer's Close button (the Modal also has an X icon named "Close"). */
async function closeVendor() {
  const buttons = screen.getAllByRole('button', { name: /^close$/i });
  await userEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(screen.queryByText('Vendor · ADI / Anixter')).not.toBeInTheDocument());
}

async function save() {
  await userEvent.click(await screen.findByRole('button', { name: /save changes/i }));
}

function saveButton() {
  return screen.getByRole('button', { name: /save changes/i });
}

/** The category picker's trigger inside the "Vendor identity" panel. */
async function categoryTrigger() {
  const identity = (await screen.findByText('Vendor identity')).closest('div')!;
  return within(identity).getByRole('combobox');
}

/** Bodies of every POST /api/inventory/vendors this test provoked. */
function upsertBodies(): Record<string, unknown>[] {
  return postSpy.mock.calls
    .filter((c) => c[0] === '/api/inventory/vendors')
    .map((c) => c[1] as Record<string, unknown>);
}

describe('S4.2 (a) - a cleared field is saved as empty and stays empty', () => {
  it('clearing the website sends website: null and the reopened vendor has no website', async () => {
    // The server's honest reply: `toVendorDto` omits a null column outright.
    const { website: _dropped, ...saved } = hoisted.VENDOR;
    void _dropped;
    postSpy.mockResolvedValue({ data: { vendor: saved } });

    await openEditor();
    const website = await screen.findByPlaceholderText('https://www.vendor.com');
    expect(website).toHaveValue('https://www.adiglobal.com');
    await userEvent.clear(website);
    await save();

    await waitFor(() => expect(upsertBodies()).toHaveLength(1));
    expect(upsertBodies()[0]).toHaveProperty('website', null);
    // Save succeeded: the dialog is back in read mode.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument(),
    );

    // Close and reopen - the old value must not come back from the mirror.
    await closeVendor();
    await openVendor();
    expect(screen.queryByText(/adiglobal\.com/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(await screen.findByPlaceholderText('https://www.vendor.com')).toHaveValue('');
  });
});

describe('S4.2 (b) - cancelling the category picker leaves the category alone', () => {
  it('Escape out of the open picker changes nothing and Save stays disabled', async () => {
    await openEditor();

    const trigger = await categoryTrigger();
    expect(trigger).toHaveTextContent('Security');
    await userEvent.click(trigger);
    await screen.findByRole('option', { name: 'Locks' });
    await userEvent.keyboard('{Escape}');

    expect(await categoryTrigger()).toHaveTextContent('Security');
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAttribute('title', 'No changes to save');

    // A later, unrelated edit must not drag a category change into the patch.
    const notes = await screen.findByPlaceholderText(/special handling, rep notes/i);
    await userEvent.type(notes, ' Closed Fridays.');
    await save();
    await waitFor(() => expect(upsertBodies()).toHaveLength(1));
    expect(upsertBodies()[0]).not.toHaveProperty('categoryId');
    expect(upsertBodies()[0]).not.toHaveProperty('category');
  });

  it('opening Manage categories… and pressing Done changes nothing', async () => {
    await openEditor();

    await userEvent.click(await categoryTrigger());
    await userEvent.click(await screen.findByRole('option', { name: /manage categories/i }));
    const manage = await screen.findByRole('group', { name: /manage categories/i });
    await userEvent.click(within(manage).getByRole('button', { name: /^done$/i }));

    expect(screen.queryByRole('group', { name: /manage categories/i })).not.toBeInTheDocument();
    expect(await categoryTrigger()).toHaveTextContent('Security');
    expect(saveButton()).toBeDisabled();
    expect(postSpy).not.toHaveBeenCalledWith('/api/inventory/vendors', expect.anything());
  });
});

describe('S4.2 (c) - a rejected save is loud and keeps the draft', () => {
  it('shows the server reason in a toast and inline, stays in edit mode with the typed value, and raises no success toast', async () => {
    postSpy.mockRejectedValue(VALIDATION_400);

    await openEditor();
    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed Vendor');
    await save();

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not save "ADI \/ Anixter".*at most 200/i),
      ),
    );
    // The dialog is STILL editing, with the operator's value intact...
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Renamed Vendor')).toBeInTheDocument();
    // ...the reason sits next to the form...
    expect(await screen.findByRole('alert')).toHaveTextContent(/at most 200/);
    // ...and nothing claimed success.
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/updated/i));
    // The page's optimistic rename is rolled back on the record itself.
    expect(screen.getByText('Vendor · ADI / Anixter')).toBeInTheDocument();
  });

  it('a 500 with a bare error code is still readable', async () => {
    postSpy.mockRejectedValue({ response: { status: 500, data: { error: 'Internal server error' } } });

    await openEditor();
    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.type(name, ' Inc');
    await save();

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/internal server error/i)),
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('ADI / Anixter Inc')).toBeInTheDocument();
  });

  it('the retry after a failure succeeds, toasts once, and leaves edit mode', async () => {
    postSpy
      .mockRejectedValueOnce(VALIDATION_400)
      .mockResolvedValue({ data: { vendor: { ...hoisted.VENDOR, name: 'ADI Global' } } });

    await openEditor();
    const name = await screen.findByDisplayValue('ADI / Anixter');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed Vendor');
    await save();
    await screen.findByRole('alert');

    await userEvent.clear(screen.getByDisplayValue('Renamed Vendor'));
    await userEvent.type(screen.getByRole('textbox', { name: /vendor name/i }), 'ADI Global');
    await save();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/ADI \/ Anixter updated/i));
    expect(upsertBodies()).toHaveLength(2);
    expect(upsertBodies()[1]).toMatchObject({ name: 'ADI Global' });
  });

  it('the success toast waits for the server', async () => {
    let release!: (v: unknown) => void;
    postSpy.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    await openEditor();
    await userEvent.type(await screen.findByDisplayValue('ADI / Anixter'), ' Inc');
    await save();

    await waitFor(() => expect(upsertBodies()).toHaveLength(1));
    expect(mockToast).not.toHaveBeenCalled();
    // The in-flight save cannot be double-submitted.
    expect(saveButton()).toBeDisabled();

    release({ data: { vendor: { ...hoisted.VENDOR, name: 'ADI / Anixter Inc' } } });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/updated/i)));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument(),
    );
  });
});

describe('S4.2 (c) - Add Vendor: a rejected create keeps the dialog and the draft', () => {
  it('shows the server reason inline, toasts it, and leaves the form filled', async () => {
    postSpy.mockRejectedValue(VALIDATION_400);

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /add vendor/i }));
    const name = await screen.findByPlaceholderText(/ADI, Ferguson, Winsupply/i);
    await userEvent.type(name, 'S4.2 New Vendor');
    await userEvent.click(screen.getByRole('button', { name: /save vendor/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringMatching(/could not add "S4\.2 New Vendor".*at most 200/i),
      ),
    );
    // Still open, draft intact, reason shown.
    expect(screen.getByText('Add New Vendor')).toBeInTheDocument();
    expect(screen.getByDisplayValue('S4.2 New Vendor')).toBeInTheDocument();
    expect(screen.getByText(/at most 200/)).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/added/i));
    // The optimistic card is rolled back out of the directory.
    expect(screen.queryByText('S4.2 New Vendor', { selector: 'h3, h4, span, p' })).not.toBeInTheDocument();
  });
});
